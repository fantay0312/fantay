// SPDX-License-Identifier: AGPL-3.0-only
// World-book editor (modal kind `lorebook`, Soul UI spec §7.3). A 2xl modal of fixed height: the entry list
// (search, the pinned 本书设置 row, one row per entry with its switch, pin and token count), the entry or book form
// in the centre, and the 触发测试 bench at the side — behind a two-segment switch when the modal is narrower than
// 900 px (a container query; the bench keeps running so the list keeps its firing marks). The whole book is one local
// draft saved by one 保存; an existing book sends only the fields that changed. A new book opened with `bindAgentId`
// is bound to that character after it is created; a new book can also start from a world file (导入文件), which the
// daemon imports and the editor then opens.
import { Pin, Settings2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PaLoreEntry, PaLorebook, PaLorebookDoc, PaLorebookPatch, PaLorebookSummary } from '@open-design/contracts';
import { SOUL_LIMITS, estimateTokens, paLoreEntrySchema, paLorebookInputSchema, parseWorldText, toLorebookInput } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import {
  Button,
  Callout,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Icon,
  Input,
  InputGroupClear,
  ModalSpacer,
  PlusIcon,
  SearchField,
  Segmented,
  SegmentedItem,
  Skeleton,
  Switch,
  VisuallyHidden,
  toast,
} from '../../ui';
import { PaModalFrame, paErrorText, usePaReload, usePaSubmit } from '../PaAgentModal';
import { usePa } from '../pa-context';
import modalStyles from '../PaModals.module.css';
import type { TFn } from '../pa-types';
import { characterOf } from './soul-model';
import { SOUL_MAX_UPLOAD_BYTES, downloadJson, readFileText } from './soul-files';
import { SoulLoreBookForm, SoulLoreEntryForm, loreEntryValid, loreNumber } from './SoulLoreEntryForm';
import { SoulLoreTestBench, useSoulLoreTest } from './SoulLoreTestBench';
import styles from './SoulLorebookModal.module.css';

const L = SOUL_LIMITS;

export interface SoulLorebookModalProps {
  open: boolean;
  onClose(): void;
  /** null: a new book. */
  lorebookId: string | null;
  entryId?: string;
  bindAgentId?: string;
}

type Selection = { kind: 'book' } | { kind: 'entry'; id: string } | null;
type Pane = 'entry' | 'test';
type Confirm = 'discard' | 'delete' | 'import' | null;
type BookField = keyof PaLorebookDoc;

/** Schema defaults for a new book (the name is required, so it is filled for the parse and emptied after). */
function emptyBook(): PaLorebookDoc {
  return { ...paLorebookInputSchema.parse({ name: '-' }), name: '' };
}

/** The book fields a summary already carries, so the header reads right while the document loads. */
function fromSummary(summary: PaLorebookSummary): PaLorebookDoc {
  return {
    name: summary.name,
    description: summary.description,
    scanDepth: summary.scanDepth,
    tokenBudget: summary.tokenBudget,
    recursive: summary.recursive,
    caseSensitive: summary.caseSensitive,
    matchWholeWords: summary.matchWholeWords,
    global: summary.global,
    entries: [],
  };
}

function newEntryId(entries: readonly PaLoreEntry[]): string {
  const taken = new Set(entries.map((entry) => entry.id));
  for (;;) {
    const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.has(id)) return id;
  }
}

function firstSelection(entries: readonly PaLoreEntry[], entryId?: string): Selection {
  if (entryId && entries.some((entry) => entry.id === entryId)) return { kind: 'entry', id: entryId };
  const first = entries[0];
  return first ? { kind: 'entry', id: first.id } : null;
}

/** The row title: the title, else the first key, else 未命名条目. */
function entryTitle(entry: PaLoreEntry, t: TFn): string {
  return entry.title.trim() || entry.keys[0]?.trim() || t('pa.soul.lore.untitled');
}

function matches(entry: PaLoreEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return (
    entry.title.toLocaleLowerCase().includes(needle) ||
    entry.keys.some((key) => key.toLocaleLowerCase().includes(needle)) ||
    entry.content.toLocaleLowerCase().includes(needle)
  );
}

/** Only the touched fields, each written out (no keyed copy of the draft). */
function patchOf(draft: PaLorebookDoc, touched: ReadonlySet<BookField>): PaLorebookPatch {
  const patch: PaLorebookPatch = {};
  if (touched.has('name')) patch.name = draft.name.trim();
  if (touched.has('description')) patch.description = draft.description;
  if (touched.has('scanDepth')) patch.scanDepth = draft.scanDepth;
  if (touched.has('tokenBudget')) patch.tokenBudget = draft.tokenBudget;
  if (touched.has('recursive')) patch.recursive = draft.recursive;
  if (touched.has('caseSensitive')) patch.caseSensitive = draft.caseSensitive;
  if (touched.has('matchWholeWords')) patch.matchWholeWords = draft.matchWholeWords;
  if (touched.has('global')) patch.global = draft.global;
  if (touched.has('entries')) patch.entries = draft.entries;
  return patch;
}

function fileStem(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'world';
}

/* ── one entry row ────────────────────────────────────────────────────────────────────── */

function LoreEntryRow({
  entry,
  selected,
  firing,
  invalid,
  t,
  onSelect,
  onToggle,
  onDuplicate,
  onRemove,
}: {
  entry: PaLoreEntry;
  selected: boolean;
  firing: boolean;
  invalid: boolean;
  t: TFn;
  onSelect(): void;
  onToggle(enabled: boolean): void;
  onDuplicate(): void;
  onRemove(): void;
}) {
  const titleId = useId();
  const keys = entry.keys.join(', ');
  const tokens = useMemo(() => estimateTokens(entry.content), [entry.content]);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={styles.row}
          data-testid="pa-lore-entry-row"
          data-entry={entry.id}
          data-selected={selected ? '' : undefined}
          data-off={entry.enabled ? undefined : ''}
          data-firing={firing ? '' : undefined}
        >
          <Switch
            size="sm"
            className={styles.rowSwitch}
            checked={entry.enabled}
            aria-label={t('pa.soul.lore.entry.enabled')}
            aria-describedby={titleId}
            onCheckedChange={onToggle}
          />
          <Button variant="bare" className={styles.rowMain} aria-current={selected || undefined} onClick={onSelect}>
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>
                {firing ? <span className={styles.fireDot} aria-hidden /> : null}
                <span id={titleId} className={styles.rowTitleText}>
                  {entryTitle(entry, t)}
                </span>
                {entry.constant ? <Icon icon={Pin} size={12} className={styles.pin} label={t('pa.soul.lore.entry.constant')} /> : null}
              </span>
              {keys ? <span className={styles.rowKeys}>{keys}</span> : null}
            </span>
            <span className={styles.rowEnd}>
              <span className={styles.rowTokens}>{loreNumber(tokens)}</span>
              {invalid ? <span className={styles.invalidDot} aria-hidden /> : null}
            </span>
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onDuplicate}>{t('pa.soul.lore.duplicate')}</ContextMenuItem>
        <ContextMenuItem tone="danger" onSelect={onRemove}>
          {t('pa.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/* ── the editor ───────────────────────────────────────────────────────────────────────── */

export function SoulLorebookModal({ open, onClose, lorebookId, entryId, bindAgentId }: SoulLorebookModalProps) {
  const t = useT();
  const { data, index, nav } = usePa();
  const summary = lorebookId ? (index.lorebooks.get(lorebookId) ?? null) : null;
  const creating = lorebookId === null;

  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>(creating ? 'ready' : 'loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [base, setBase] = useState<PaLorebook | null>(null);
  const [revision, setRevision] = useState(summary?.revision ?? 0);
  const [draft, setDraft] = useState<PaLorebookDoc>(() => (summary ? fromSummary(summary) : emptyBook()));
  const [touched, setTouched] = useState<ReadonlySet<BookField>>(() => new Set());
  const [selection, setSelection] = useState<Selection>(null);
  const [query, setQuery] = useState('');
  const [pane, setPane] = useState<Pane>('entry');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testText, setTestText] = useState('');
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const created = useRef<PaLorebookSummary | null>(null);
  const loadRun = useRef(0);
  const submit = usePaSubmit();
  const reload = usePaReload(summary, (latest) => setRevision(latest.revision));

  const loadBook = () => {
    if (!lorebookId) return;
    loadRun.current += 1;
    const run = loadRun.current;
    setLoad('loading');
    setLoadError(null);
    data.actions.loadLorebook(lorebookId).then(
      (book) => {
        if (run !== loadRun.current) return;
        setBase(book);
        setRevision(book.revision);
        setDraft(toLorebookInput(book));
        setTouched(new Set());
        setSelection(firstSelection(book.entries, entryId));
        setLoad('ready');
      },
      (error: unknown) => {
        if (run !== loadRun.current) return;
        setLoadError(paErrorText(error, t));
        setLoad('error');
      },
    );
  };

  useEffect(() => {
    if (open && lorebookId) loadBook();
    return () => {
      loadRun.current += 1;
    };
    // Loads once per opened book; the host re-keys the modal for another book.
  }, [open, lorebookId]);

  /* ── draft edits ── */

  const touch = (fields: readonly BookField[]) =>
    setTouched((current) => {
      if (fields.every((field) => current.has(field))) return current;
      const next = new Set(current);
      for (const field of fields) next.add(field);
      return next;
    });
  const patchBook = (patch: Partial<PaLorebookDoc>) => {
    setDraft((current) => ({ ...current, ...patch }));
    touch(Object.keys(patch) as BookField[]);
  };
  const editEntries = (edit: (entries: PaLoreEntry[]) => PaLoreEntry[]) => {
    setDraft((current) => ({ ...current, entries: edit(current.entries) }));
    touch(['entries']);
  };
  const patchEntry = (id: string, patch: Partial<PaLoreEntry>) =>
    editEntries((entries) => entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  const selectEntry = (id: string) => {
    setSelection({ kind: 'entry', id });
    setPane('entry');
    setFresh(null);
  };
  const addEntry = () => {
    if (draft.entries.length >= L.loreEntries) return;
    const entry = paLoreEntrySchema.parse({ id: newEntryId(draft.entries) });
    editEntries((entries) => [...entries, entry]);
    setQuery('');
    selectEntry(entry.id);
    setFresh(entry.id);
  };
  const duplicateEntry = (id: string) => {
    if (draft.entries.length >= L.loreEntries) return;
    const source = draft.entries.find((entry) => entry.id === id);
    if (!source) return;
    const copy: PaLoreEntry = { ...source, id: newEntryId(draft.entries), preserved: {} };
    editEntries((entries) => {
      const at = entries.findIndex((entry) => entry.id === id);
      return [...entries.slice(0, at + 1), copy, ...entries.slice(at + 1)];
    });
    selectEntry(copy.id);
  };
  const removeEntry = (id: string) => {
    const at = draft.entries.findIndex((entry) => entry.id === id);
    if (at < 0) return;
    if (selection?.kind === 'entry' && selection.id === id) {
      const neighbour = draft.entries[at + 1] ?? draft.entries[at - 1];
      setSelection(neighbour ? { kind: 'entry', id: neighbour.id } : null);
    }
    editEntries((entries) => entries.filter((entry) => entry.id !== id));
  };

  /* ── derived ── */

  const ready = load === 'ready';
  const dirty = touched.size > 0;
  const test = useSoulLoreTest(draft, testText, ready);
  const firing = useMemo(
    () => new Set(test.trace.filter((row) => row.status === 'included').map((row) => row.entryId)),
    [test.trace],
  );
  const invalidEntries = useMemo(() => new Set(draft.entries.filter((entry) => !loreEntryValid(entry)).map((entry) => entry.id)), [draft.entries]);
  const contentTotal = useMemo(() => draft.entries.reduce((sum, entry) => sum + entry.content.length, 0), [draft.entries]);
  const titles = useMemo(() => new Map(draft.entries.map((entry) => [entry.id, entryTitle(entry, t)])), [draft.entries, t]);
  const visible = useMemo(() => draft.entries.filter((entry) => matches(entry, query)), [draft.entries, query]);
  const constants = draft.entries.filter((entry) => entry.constant).length;
  const facts = ready
    ? { n: draft.entries.length, c: constants }
    : { n: summary?.entryCount ?? 0, c: summary?.constantCount ?? 0 };
  const name = draft.name.trim();
  const valid =
    name.length > 0 &&
    draft.name.length <= L.lorebookName &&
    draft.description.length <= L.lorebookDescription &&
    draft.entries.length <= L.loreEntries &&
    contentTotal <= L.loreContentTotal &&
    invalidEntries.size === 0;
  const selected =
    selection?.kind === 'entry' ? (draft.entries.find((entry) => entry.id === selection.id) ?? null) : null;
  const bound = lorebookId ? [...index.characters.values()].filter((character) => character.lorebookIds.includes(lorebookId)).length : 0;

  /* ── actions ── */

  const requestClose = () => {
    if (submit.busy) return;
    if (dirty) setConfirm('discard');
    else onClose();
  };

  const save = () => {
    if (!valid || !ready || submit.busy) return;
    if (lorebookId && !dirty) {
      onClose();
      return;
    }
    const held = revision;
    void submit
      .run(
        async () => {
          if (lorebookId) {
            await data.actions.saveLorebook(patchOf(draft, touched), { id: lorebookId, revision: held });
            return;
          }
          const input = { ...draft, name };
          const prior = created.current;
          const book = prior
            ? await data.actions.saveLorebook(input, { id: prior.id, revision: prior.revision })
            : await data.actions.saveLorebook(input);
          created.current = book;
          if (bindAgentId) {
            const current = characterOf(index, bindAgentId)?.lorebookIds ?? [];
            if (!current.includes(book.id)) await data.actions.saveCharacter(bindAgentId, { lorebookIds: [...current, book.id] });
          }
        },
        () => {
          if (lorebookId) reload.expect(held);
        },
      )
      .then((ok) => {
        if (!ok) return;
        toast({ tone: 'success', title: t('pa.soul.lore.saved') });
        onClose();
      });
  };

  const remove = () => {
    if (!lorebookId) return;
    const held = revision;
    void submit
      .run(
        () => data.actions.removeLorebook({ id: lorebookId, revision: held }),
        () => reload.expect(held),
      )
      .then((ok) => {
        if (ok) onClose();
      });
  };

  const exportBook = () => {
    if (!lorebookId) return;
    const stem = fileStem(base?.name ?? draft.name);
    data.actions.exportWorld(lorebookId).then(
      (world) => downloadJson(`${stem}.json`, world),
      (error: unknown) => submit.setError(paErrorText(error, t)),
    );
  };

  const importFile = async (file: File) => {
    submit.clear();
    if (file.size > SOUL_MAX_UPLOAD_BYTES) {
      submit.setError(t('pa.soul.lore.importError.tooLarge'));
      return;
    }
    let text: string;
    try {
      text = await readFileText(file);
    } catch (error) {
      submit.setError(paErrorText(error, t));
      return;
    }
    const preview = parseWorldText(text, { fileName: file.name });
    if (!preview.ok) {
      submit.setError(
        t(
          preview.error === 'bad-json'
            ? 'pa.soul.lore.importError.badJson'
            : preview.error === 'too-large'
              ? 'pa.soul.lore.importError.tooLarge'
              : 'pa.soul.lore.importError.notWorld',
        ),
      );
      return;
    }
    const world: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    await submit.run(async () => {
      const result = await data.actions.importWorld({ world, fileName: file.name, ...(bindAgentId ? { agentId: bindAgentId } : {}) });
      toast({ tone: 'success', title: t('pa.soul.lore.imported', { name: result.lorebook.name }) });
      nav.openModal({ kind: 'lorebook', lorebookId: result.lorebook.id });
    });
  };

  const pickFile = () => fileRef.current?.click();

  /* ── view ── */

  const title = (
    <span className={styles.head}>
      {creating ? <VisuallyHidden>{t('pa.soul.lore.titleNew')}</VisuallyHidden> : null}
      <Input
        variant="title"
        className={styles.name}
        value={draft.name}
        maxLength={L.lorebookName}
        placeholder={t('pa.soul.lore.namePlaceholder')}
        aria-label={t('pa.soul.lore.namePlaceholder')}
        autoComplete="off"
        autoFocus={creating}
        disabled={!ready}
        data-testid="pa-lore-name"
        onChange={(event) => patchBook({ name: event.target.value })}
      />
      <span className={styles.facts} data-testid="pa-lore-facts">
        {t('pa.soul.lore.facts', { n: loreNumber(facts.n), c: loreNumber(facts.c) })}
      </span>
    </span>
  );

  const footer = (
    <>
      {lorebookId ? (
        <>
          <Button variant="ghost" disabled={!ready || submit.busy} onClick={exportBook}>
            {t('pa.soul.lore.export')}
          </Button>
          <Button variant="ghost" className={modalStyles.dangerQuiet} disabled={!ready || submit.busy} onClick={() => setConfirm('delete')}>
            {t('pa.soul.lore.delete')}
          </Button>
        </>
      ) : (
        <Button variant="ghost" disabled={submit.busy} onClick={() => (dirty ? setConfirm('import') : pickFile())}>
          {t('pa.soul.lore.importFile')}
        </Button>
      )}
      <ModalSpacer />
      <Button variant="ghost" onClick={requestClose}>
        {t('pa.cancel')}
      </Button>
      <Button variant="primary" disabled={!valid || !ready} loading={submit.busy} onClick={save} data-testid="pa-lore-save">
        {t('pa.save')}
      </Button>
    </>
  );

  let centre: ReactNode = null;
  if (load === 'error') {
    centre = (
      <Callout tone="error" role="alert">
        <span className={styles.loadError}>
          {loadError}
          <Button variant="secondary" size="sm" onClick={loadBook}>
            {t('pa.state.retry')}
          </Button>
        </span>
      </Callout>
    );
  } else if (ready && selection?.kind === 'book') {
    centre = <SoulLoreBookForm draft={draft} review={base?.needsReview ?? []} onChange={patchBook} />;
  } else if (ready && selected) {
    centre = (
      <SoulLoreEntryForm
        key={selected.id}
        entry={selected}
        autoFocus={fresh === selected.id}
        advancedOpen={advancedOpen}
        onAdvancedOpenChange={setAdvancedOpen}
        onChange={(patch) => patchEntry(selected.id, patch)}
      />
    );
  } else if (ready && draft.entries.length === 0) {
    centre = <p className={styles.empty}>{t('pa.soul.lore.empty')}</p>;
  }

  return (
    <PaModalFrame
      open={open}
      onClose={requestClose}
      size="2xl"
      title={title}
      conflict={submit.conflict}
      error={submit.error}
      bodyClassName={styles.body}
      testId="pa-lorebook-modal"
      footer={footer}
    >
      <div className={styles.panes} data-pane={pane}>
        <aside className={styles.list} aria-label={t('pa.soul.lore.search')}>
          <div className={styles.listTop}>
            <SearchField
              variant="ring"
              value={query}
              placeholder={t('pa.soul.lore.search')}
              aria-label={t('pa.soul.lore.search')}
              disabled={!ready}
              onChange={(event) => setQuery(event.target.value)}
              trailing={query ? <InputGroupClear onClear={() => setQuery('')} /> : null}
            />
          </div>
          <Button
            variant="bare"
            className={styles.bookRow}
            data-selected={selection?.kind === 'book' ? '' : undefined}
            aria-current={selection?.kind === 'book' || undefined}
            disabled={!ready}
            data-testid="pa-lore-book-row"
            onClick={() => {
              setSelection({ kind: 'book' });
              setPane('entry');
            }}
          >
            <Icon icon={Settings2} size={14} className={styles.bookIcon} />
            <span>{t('pa.soul.lore.book')}</span>
          </Button>
          <div className={styles.listRule} aria-hidden />
          <div className={styles.listScroll}>
            {load === 'loading' ? (
              <div className={styles.skeletons}>
                {[0, 1, 2].map((at) => (
                  <Skeleton key={at} shape="row" index={at} />
                ))}
              </div>
            ) : (
              visible.map((entry) => (
                <LoreEntryRow
                  key={entry.id}
                  entry={entry}
                  t={t}
                  selected={selection?.kind === 'entry' && selection.id === entry.id}
                  firing={firing.has(entry.id)}
                  invalid={invalidEntries.has(entry.id)}
                  onSelect={() => selectEntry(entry.id)}
                  onToggle={(enabled) => patchEntry(entry.id, { enabled })}
                  onDuplicate={() => duplicateEntry(entry.id)}
                  onRemove={() => removeEntry(entry.id)}
                />
              ))
            )}
          </div>
          <div className={styles.listFoot}>
            <Button
              variant="secondary"
              block
              disabled={!ready || draft.entries.length >= L.loreEntries}
              data-testid="pa-lore-new-entry"
              onClick={addEntry}
            >
              <PlusIcon size="sm" />
              {t('pa.soul.lore.newEntry')}
            </Button>
          </div>
        </aside>

        <div className={styles.main}>
          <div className={styles.switch}>
            <Segmented
              className="flex w-full"
              size="md"
              aria-label={t('pa.soul.lore.test.title')}
              value={pane}
              onValueChange={(next) => setPane(next as Pane)}
            >
              <SegmentedItem value="entry" className="min-w-0 flex-1">
                {t('pa.soul.lore.seg.entry')}
              </SegmentedItem>
              <SegmentedItem value="test" className="min-w-0 flex-1">
                {t('pa.soul.lore.seg.test')}
              </SegmentedItem>
            </Segmented>
          </div>
          <div className={styles.formPane}>{centre}</div>
          <div className={styles.benchPane}>
            <SoulLoreTestBench
              text={testText}
              onTextChange={setTestText}
              state={test}
              titles={titles}
              selectedId={selected?.id ?? null}
              onSelect={selectEntry}
            />
          </div>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFile(file);
        }}
      />

      <ConfirmDialog
        open={confirm === 'discard' || confirm === 'import'}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        title={t('pa.soul.lore.confirm.discardTitle')}
        description={t('pa.soul.lore.confirm.discardBody')}
        confirmLabel={t('pa.soul.lore.confirm.discard')}
        cancelLabel={t('pa.cancel')}
        destructive
        onConfirm={() => {
          const then = confirm;
          setConfirm(null);
          if (then === 'import') pickFile();
          else onClose();
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        title={t('pa.soul.lore.confirm.title', { name: base?.name ?? name })}
        description={bound > 0 ? t('pa.soul.lore.confirm.body', { n: bound }) : undefined}
        confirmLabel={t('pa.delete')}
        cancelLabel={t('pa.cancel')}
        destructive
        onConfirm={() => {
          setConfirm(null);
          remove();
        }}
      />
    </PaModalFrame>
  );
}
