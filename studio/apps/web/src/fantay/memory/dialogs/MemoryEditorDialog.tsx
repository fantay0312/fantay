// SPDX-License-Identifier: AGPL-3.0-only
// 新建记忆 / 编辑记忆. Creating picks where the memory lives (a grouped list built from the overview) and
// says who will read it there. Editing never moves a memory: new text is stored as a new version and the
// earlier text stays in the history, which the dialog says before and after saving. Saving sends only the
// fields the person changed; after a 409 and 载入最新版本 the untouched fields show the latest values.
import { useId, useMemo, useRef, useState } from 'react';
import type {
  CreateMemoryItemRequest,
  MemoryConflict,
  MemoryItem,
  MemoryItemKind,
  MemoryOverviewResponse,
  MemoryScopeKind,
  MemoryScopeRef,
  UpdateMemoryItemRequest,
} from '@open-design/contracts';
import { memoryScopeKey, parseMemoryScopeKey } from '@open-design/contracts';

import {
  Button,
  Callout,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from '../../ui';
import { memoryApi } from '../api';
import { findScopeNode } from '../labels';
import {
  ErrorNotice,
  KIND_ORDER,
  ScopeSelect,
  dateInputValue,
  describeError,
  findScopeOption,
  parseDateInput,
  scopeOptionGroups,
  useMemoryLabels,
  useOverviewFallback,
  useSessionKey,
} from './dialog-kit';
import { MemoryDialogFrame } from './MemoryDialogFrame';
import frame from './MemoryDialogFrame.module.css';
import { useMemoryDialogT, type MemoryDialogKey } from './i18n';
import styles from './MemoryEditorDialog.module.css';

export type MemoryEditorMode = { kind: 'create'; scope?: MemoryScopeRef } | { kind: 'edit'; item: MemoryItem };

/** The editable fields as an untouched form shows them. */
interface FieldValues {
  content: string;
  kind: MemoryItemKind;
  due: string;
}

function fieldValues(item: MemoryItem): FieldValues {
  return { content: item.content, kind: item.kind, due: dateInputValue(item.dueAt) };
}

export interface MemoryEditorDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  overview: MemoryOverviewResponse | null;
  mode: MemoryEditorMode;
  onSaved(result: { item: MemoryItem; conflicts: MemoryConflict[] }): void;
}

const MAX_CHARS = 16000;
const COUNTER_FROM = 14000;

/** What a new memory in this kind of scope most often is. */
function defaultKind(scopeKind: MemoryScopeKind | undefined): MemoryItemKind {
  return scopeKind === 'profile' || scopeKind === 'persona' ? 'preference' : 'fact';
}

export function MemoryEditorDialog(props: MemoryEditorDialogProps) {
  const identity =
    props.mode.kind === 'edit' ? `edit:${props.mode.item.id}` : `create:${props.mode.scope ? memoryScopeKey(props.mode.scope) : ''}`;
  const sessionKey = useSessionKey(props.open, identity);
  return <EditorSession key={sessionKey} {...props} />;
}

function EditorSession({ open, onOpenChange, overview: givenOverview, mode, onSaved }: MemoryEditorDialogProps) {
  const { t, lang } = useMemoryDialogT();
  const labels = useMemoryLabels();
  const ids = { content: useId(), scope: useId(), kind: useId(), due: useId() };
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

  // Captured once per opening; the page may re-render with a fresh object meanwhile.
  const [initial] = useState(mode);
  const editing = initial.kind === 'edit';
  const [base, setBase] = useState<MemoryItem | null>(initial.kind === 'edit' ? initial.item : null);
  // What each field showed before the person touched it. A field still equal to it is untouched: a reload moves
  // it to the latest value, and saving leaves it out. A touched field keeps its draft through a reload.
  const [untouched, setUntouched] = useState<FieldValues | null>(() => (initial.kind === 'edit' ? fieldValues(initial.item) : null));
  // Fields the person changed that were also changed elsewhere, found by the last reload.
  const [overlap, setOverlap] = useState<MemoryDialogKey[]>([]);
  const [scopeKey, setScopeKey] = useState(() =>
    initial.kind === 'create' && initial.scope ? memoryScopeKey(initial.scope) : '',
  );
  const [kind, setKind] = useState<MemoryItemKind>(() =>
    initial.kind === 'edit' ? initial.item.kind : defaultKind(initial.scope?.kind),
  );
  const [kindTouched, setKindTouched] = useState(false);
  const [content, setContent] = useState(initial.kind === 'edit' ? initial.item.content : '');
  const [due, setDue] = useState(initial.kind === 'edit' ? dateInputValue(initial.item.dueAt) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloaded, setReloaded] = useState(false);
  const [reloading, setReloading] = useState(false);

  const fallback = useOverviewFallback(open && !editing, givenOverview);
  const groups = useMemo(() => (fallback.overview ? scopeOptionGroups(fallback.overview, t, labels) : []), [fallback.overview, t, labels]);
  const chosen = scopeKey ? findScopeOption(groups, scopeKey) : null;
  const chosenScope = scopeKey ? parseMemoryScopeKey(scopeKey) : null;

  const readOnly = base ? base.readOnly || base.backing === 'studio' : false;
  const redacted = base?.redacted ?? false;
  const trimmed = content.trim();
  const contentChanged = untouched ? trimmed !== untouched.content.trim() : true;
  const kindChanged = untouched ? kind !== untouched.kind : true;
  // Compared as day strings: a stored due time need not be local midnight. Leaving 约定 keeps the date.
  const dueTouched = untouched ? due !== untouched.due : false;
  const dueChanged = untouched ? kind === 'promise' && dueTouched : false;

  let blocked: string | null = null;
  if (readOnly) blocked = t('editor.need.readOnly');
  else if (redacted) blocked = t('editor.need.redacted');
  else if (!editing && !chosenScope) blocked = t('editor.need.scope');
  else if (!trimmed) blocked = t('editor.need.content');
  else if (editing && !contentChanged && !kindChanged && !dueChanged) blocked = t('editor.need.change');

  const close = () => onOpenChange(false);

  const pickScope = (key: string) => {
    setScopeKey(key);
    if (!kindTouched) setKind(defaultKind(parseMemoryScopeKey(key)?.kind));
  };

  const reloadBase = async () => {
    if (!base || !untouched) return;
    setReloading(true);
    try {
      const latest = (await memoryApi.getItem(base.id)).item;
      const next = fieldValues(latest);
      const both: MemoryDialogKey[] = [];
      if (!contentChanged) setContent(next.content);
      else if (next.content.trim() !== untouched.content.trim()) both.push('editor.content');
      if (!kindChanged) setKind(next.kind);
      else if (next.kind !== untouched.kind) both.push('editor.kind');
      if (!dueTouched) setDue(next.due);
      else if (next.due !== untouched.due) both.push('editor.field.due');
      setUntouched({
        content: contentChanged ? untouched.content : next.content,
        kind: kindChanged ? untouched.kind : next.kind,
        due: dueTouched ? untouched.due : next.due,
      });
      setOverlap(both);
      setBase(latest);
      setError(null);
      setReloaded(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setReloading(false);
    }
  };

  const save = async () => {
    if (blocked || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (base) {
        const patch: UpdateMemoryItemRequest = { revision: base.revision };
        if (contentChanged) patch.content = trimmed;
        if (kindChanged) patch.kind = kind;
        if (dueChanged) patch.dueAt = parseDateInput(due);
        const result = await memoryApi.updateItem(base.id, patch);
        toast({
          id: 'memory-editor-saved',
          tone: 'success',
          title: t('editor.toast.saved'),
          description: result.conflicts.length > 0 ? t('editor.toast.conflict') : contentChanged ? t('editor.toast.savedKept') : undefined,
        });
        onSaved({ item: result.item, conflicts: result.conflicts });
      } else if (chosenScope) {
        const body: CreateMemoryItemRequest = { scope: chosenScope, content: trimmed, kind };
        const dueAt = kind === 'promise' ? parseDateInput(due) : null;
        if (dueAt !== null) body.dueAt = dueAt;
        const result = await memoryApi.createItem(body);
        const where = labels.scope(chosenScope, chosen?.label);
        toast({
          id: 'memory-editor-saved',
          tone: 'success',
          title: result.created ? t('editor.toast.created') : t('editor.toast.exists'),
          description: result.conflicts.length > 0
            ? t('editor.toast.conflict')
            : result.created
              ? t('editor.toast.createdWhere', { scope: where })
              : t('editor.toast.existsBody'),
        });
        onSaved({ item: result.item, conflicts: result.conflicts });
      }
      close();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const staleError = error ? describeError(error, t, 'error.save').stale : false;
  // An item without a scope label (a Settings entry, an older answer) takes the navigator's name for its place.
  const baseNode = base && givenOverview ? findScopeNode(givenOverview, base.scope) : null;
  const baseScope = base ? labels.scope(base.scope, base.scopeLabel || baseNode?.label) : '';

  return (
    <MemoryDialogFrame
      open={open}
      onClose={close}
      size="lg"
      testId="memory-editor-dialog"
      title={editing ? t('editor.titleEdit') : t('editor.titleNew')}
      lede={editing ? t('editor.ledeEdit', { scope: baseScope }) : t('editor.ledeNew')}
      initialFocusRef={contentRef}
      onSubmit={() => void save()}
      footer={
        <>
          <Button variant="ghost" onClick={close} data-testid="memory-editor-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={blocked !== null}
            disabledReason={blocked ?? undefined}
            data-testid="memory-editor-submit"
          >
            {editing ? t('editor.save') : t('editor.create')}
          </Button>
        </>
      }
    >
      {readOnly ? (
        <Callout tone="neutral" role="status">
          {t('editor.readOnly')}
        </Callout>
      ) : null}
      {redacted ? (
        <Callout tone="neutral" role="status">
          {t('editor.redacted')}
        </Callout>
      ) : null}
      {error && staleError ? (
        <Callout tone="neutral" role="alert" className={frame.notice}>
          <span className={frame.noticeText}>{t('editor.stale')}</span>
          <Button size="sm" variant="ghost" loading={reloading} onClick={() => void reloadBase()} data-testid="memory-editor-reload">
            {t('editor.reload')}
          </Button>
        </Callout>
      ) : error ? (
        <ErrorNotice error={error} fallback="error.save" />
      ) : reloaded ? (
        <Callout tone="neutral" role="status" data-testid="memory-editor-reloaded">
          {t('editor.reloaded')}
          {overlap.length > 0
            ? `${lang === 'en' ? ' ' : ''}${t('editor.reloadedOverlap', {
                fields: overlap.map((key) => t(key)).join(t('common.listSeparator')),
              })}`
            : null}
        </Callout>
      ) : null}

      <Field
        label={t('editor.content')}
        htmlFor={ids.content}
        labelVariant="form"
        hint={
          trimmed.length >= COUNTER_FROM ? (
            <span className={styles.counter}>{t('editor.counter', { n: trimmed.length, max: MAX_CHARS })}</span>
          ) : editing ? (
            t('editor.contentHintEdit')
          ) : (
            t('editor.contentHint')
          )
        }
      >
        <Textarea
          ref={contentRef}
          id={ids.content}
          value={content}
          rows={6}
          maxLength={MAX_CHARS}
          disabled={readOnly || redacted}
          placeholder={t('editor.contentPlaceholder')}
          className={styles.content}
          data-testid="memory-editor-content"
          onChange={(event) => setContent(event.target.value)}
        />
      </Field>

      <div className={frame.fieldGrid}>
        {editing ? (
          <Field label={t('editor.scope')} labelVariant="form" hint={t('editor.scopeFixed')}>
            <p className={frame.fixedField} data-testid="memory-editor-scope-fixed">
              {baseScope}
            </p>
          </Field>
        ) : (
          <Field
            label={t('editor.scope')}
            htmlFor={ids.scope}
            labelVariant="form"
            hint={chosen ? labels.readers(chosen.node) : fallback.loading ? t('common.loading') : t('editor.scopeHint')}
          >
            {fallback.error && !fallback.overview ? (
              <ErrorNotice error={fallback.error} onRetry={fallback.retry} />
            ) : !chosen && chosenScope && fallback.overview ? (
              // The page asked for a scope the overview does not list: shown as text, still saved there.
              <p className={frame.fixedField} data-testid="memory-editor-scope-fixed">
                {labels.scope(chosenScope, undefined)}
              </p>
            ) : (
              <ScopeSelect
                id={ids.scope}
                groups={groups}
                value={scopeKey}
                disabled={groups.length === 0}
                placeholder={fallback.loading ? t('common.loading') : t('editor.scopePlaceholder')}
                testId="memory-editor-scope"
                onChange={pickScope}
              />
            )}
          </Field>
        )}

        <Field label={t('editor.kind')} htmlFor={ids.kind} labelVariant="form" hint={t(`kindHint.${kind}` as MemoryDialogKey)}>
          <Select
            value={kind}
            disabled={readOnly || redacted}
            onValueChange={(next) => {
              setKind(next as MemoryItemKind);
              setKindTouched(true);
            }}
          >
            <SelectTrigger id={ids.kind} className="w-full" data-testid="memory-editor-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_ORDER.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {labels.kind(entry)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {kind === 'promise' ? (
        <Field label={t('editor.due')} htmlFor={ids.due} labelVariant="form" hint={t('editor.dueHint')} className={styles.due}>
          <Input
            id={ids.due}
            type="date"
            value={due}
            disabled={readOnly || redacted}
            data-testid="memory-editor-due"
            onChange={(event) => setDue(event.target.value)}
          />
        </Field>
      ) : null}
    </MemoryDialogFrame>
  );
}

