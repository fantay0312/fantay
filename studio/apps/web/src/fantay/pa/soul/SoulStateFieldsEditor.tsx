// SPDX-License-Identifier: AGPL-3.0-only
// 状态栏 of the profile editor (Soul UI spec 7.1): master–detail inside the section, never a nested modal. A hairline
// list of the character's story-state fields on top, the selected field's form in a group below. The validation is
// exported so the editor can mark the 状态与玩法 section and hold 保存 while a field is invalid.
import { Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { PA_RESERVED_STATE_KEYS, SOUL_LIMITS } from '@open-design/contracts/soul';
import type { PaStateField } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import {
  Button,
  Icon,
  IconButton,
  Input,
  Label,
  PlusIcon,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  VisuallyHidden,
  cn,
} from '../../ui';
import modalStyles from '../PaModals.module.css';
import { SoulTag, SoulTagInput } from './SoulPrimitives';
import styles from './SoulProfileModal.module.css';

const L = SOUL_LIMITS;
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const KINDS = ['number', 'text', 'enum', 'list'] as const;
type Kind = (typeof KINDS)[number];

export const STATE_KIND_LABEL = {
  number: 'pa.soul.editor.play.kind.number',
  text: 'pa.soul.editor.play.kind.text',
  enum: 'pa.soul.editor.play.kind.enum',
  list: 'pa.soul.editor.play.kind.list',
} as const;

const ERR = {
  key: 'pa.soul.editor.play.error.key',
  keyTaken: 'pa.soul.editor.play.error.keyTaken',
  labelTaken: 'pa.soul.editor.play.error.labelTaken',
  range: 'pa.soul.editor.play.error.range',
  initial: 'pa.soul.editor.play.error.initial',
  option: 'pa.soul.editor.play.error.option',
} as const;

/** A problem with a message, or `invalid` (a required value is empty or a text is over its limit: the control is
 *  marked, no sentence is needed). */
export type StateIssue = (typeof ERR)[keyof typeof ERR] | 'invalid';
export type StateFieldIssues = Partial<Record<'label' | 'key' | 'initial' | 'range' | 'options' | 'hint', StateIssue>>;

function labelKey(label: string): string {
  return label.trim().normalize('NFKC').toLowerCase();
}

/** The schema rules of `paStateSchemaSchema`, field by field, so each problem shows on its own control. */
export function stateFieldIssues(fields: readonly PaStateField[]): StateFieldIssues[] {
  const keys = new Map<string, number>();
  const labels = new Map<string, number>();
  for (const field of fields) {
    keys.set(field.key.toLowerCase(), (keys.get(field.key.toLowerCase()) ?? 0) + 1);
    labels.set(labelKey(field.label), (labels.get(labelKey(field.label)) ?? 0) + 1);
  }
  return fields.map((field) => {
    const issues: StateFieldIssues = {};
    const label = field.label.trim();
    if (!label || label.length > L.stateLabel) issues.label = 'invalid';
    else if ((labels.get(labelKey(label)) ?? 0) > 1) issues.label = ERR.labelTaken;
    if (!KEY_PATTERN.test(field.key) || PA_RESERVED_STATE_KEYS.has(field.key.toLowerCase())) issues.key = ERR.key;
    else if ((keys.get(field.key.toLowerCase()) ?? 0) > 1) issues.key = ERR.keyTaken;
    if (field.hint.length > L.stateHint) issues.hint = 'invalid';
    if (field.kind === 'number') {
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) issues.range = ERR.range;
      else if ((field.min !== undefined && field.initial < field.min) || (field.max !== undefined && field.initial > field.max))
        issues.initial = ERR.initial;
    } else if (field.kind === 'text') {
      if (field.initial.length > L.stateText) issues.initial = 'invalid';
    } else if (field.kind === 'enum') {
      if (field.options.length === 0) issues.options = 'invalid';
      else if (!field.options.includes(field.initial)) issues.initial = ERR.option;
    }
    return issues;
  });
}

export function hasStateIssues(list: readonly StateFieldIssues[]): boolean {
  return list.some((issues) => Object.keys(issues).length > 0);
}

/** A key from the ASCII words of a name (`Gold coins` → `goldCoins`), else `field1`, `field2`, …; never a reserved
 *  or taken key (`taken` holds lower-cased keys). */
export function suggestStateKey(label: string, taken: ReadonlySet<string>): string {
  const parts = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts
    .map((part, index) => (index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join('')
    .replace(/^[0-9]+/, '')
    .slice(0, 30);
  if (KEY_PATTERN.test(joined) && !PA_RESERVED_STATE_KEYS.has(joined.toLowerCase())) {
    if (!taken.has(joined.toLowerCase())) return joined;
    for (let n = 2; ; n += 1) if (!taken.has(`${joined}${n}`.toLowerCase())) return `${joined}${n}`;
  }
  for (let n = 1; ; n += 1) if (!taken.has(`field${n}`)) return `field${n}`;
}

/** Changing the kind resets the kind-specific values (spec 7.1). */
function withKind(field: PaStateField, kind: Kind): PaStateField {
  const common = { key: field.key, label: field.label, hint: field.hint, writable: field.writable };
  switch (kind) {
    case 'number':
      return { ...common, kind, initial: 0 };
    case 'text':
      return { ...common, kind, initial: '' };
    case 'enum':
      return { ...common, kind, initial: '', options: [] };
    case 'list':
      return { ...common, kind, initial: [] };
  }
}

type NumberField = Extract<PaStateField, { kind: 'number' }>;

/** Sets or clears min, max or the per-turn step (a step must be positive). A bar needs both bounds, so clearing one
 *  turns a bar back into a plain value. */
function withNumberPart(field: NumberField, part: 'min' | 'max' | 'maxStep', next: number | undefined): NumberField {
  const copy: NumberField = { ...field };
  if (next === undefined || (part === 'maxStep' && next <= 0)) delete copy[part];
  else copy[part] = next;
  if ((copy.min === undefined || copy.max === undefined) && copy.render === 'bar') copy.render = 'value';
  return copy;
}

function initialText(field: PaStateField): string {
  if (field.kind === 'list') return field.initial.join(' · ');
  return String(field.initial);
}

/* ── number input ─────────────────────────────────────────────────────────────────────────── */

export interface SoulNumberInputProps {
  id?: string;
  value: number | undefined;
  onChange(next: number | undefined): void;
  /** Without it an empty box keeps the last number. */
  allowEmpty?: boolean;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  /** `end` (default) for values in a row of numbers; `start` when the box mostly shows a placeholder. */
  align?: 'start' | 'end';
  'aria-label'?: string;
}

/** A mono number box that keeps what is being typed (`-`, `1.`) and commits each finite number as it appears. */
export function SoulNumberInput({
  id,
  value,
  onChange,
  allowEmpty = true,
  placeholder,
  invalid,
  disabled,
  className,
  align = 'end',
  'aria-label': ariaLabel,
}: SoulNumberInputProps) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const committed = useRef(value);
  if (committed.current !== value) {
    committed.current = value;
    const parsed = draft.trim() === '' ? undefined : Number(draft);
    if (parsed !== value) setDraft(value === undefined ? '' : String(value));
  }
  return (
    <Input
      id={id}
      variant="mono"
      inputMode="decimal"
      autoComplete="off"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      className={cn(align === 'end' && styles.number, className)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const trimmed = text.trim();
        if (trimmed === '') {
          if (!allowEmpty) return;
          committed.current = undefined;
          onChange(undefined);
          return;
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return;
        committed.current = parsed;
        onChange(parsed);
      }}
      onBlur={() => setDraft(value === undefined ? '' : String(value))}
    />
  );
}

/* ── the editor ───────────────────────────────────────────────────────────────────────────── */

export interface SoulStateFieldsEditorProps {
  value: PaStateField[];
  onChange(next: PaStateField[]): void;
  /** Extra messages by field index (shown under that field's form). */
  errors?: Record<number, string>;
  /** The character's display name, for the English "{name} and me". */
  name?: string;
}

function issueText(issue: StateIssue | undefined, t: ReturnType<typeof useT>): string | undefined {
  return issue && issue !== 'invalid' ? t(issue) : undefined;
}

export function SoulStateFieldsEditor({ value, onChange, errors, name = '' }: SoulStateFieldsEditorProps) {
  const t = useT();
  const [selected, setSelected] = useState(value.length > 0 ? 0 : -1);
  const at = value.length === 0 ? -1 : Math.min(Math.max(selected, 0), value.length - 1);
  const field = at >= 0 ? value[at] : undefined;
  const issues = useMemo(() => stateFieldIssues(value), [value]);
  const labelRef = useRef<HTMLInputElement>(null);
  const focusLabel = useRef(false);
  const uid = useId();
  const ids = {
    label: `${uid}-label`,
    key: `${uid}-key`,
    initial: `${uid}-initial`,
    min: `${uid}-min`,
    max: `${uid}-max`,
    step: `${uid}-step`,
    options: `${uid}-options`,
    hint: `${uid}-hint`,
  };

  useEffect(() => {
    if (!focusLabel.current) return;
    focusLabel.current = false;
    labelRef.current?.focus();
  });

  const replace = (index: number, next: PaStateField) => onChange(value.map((item, i) => (i === index ? next : item)));
  const othersKeys = (index: number) => new Set(value.filter((_, i) => i !== index).map((item) => item.key.toLowerCase()));

  const add = () => {
    if (value.length >= L.stateFields) return;
    const next: PaStateField = {
      kind: 'number',
      key: suggestStateKey('', new Set(value.map((item) => item.key.toLowerCase()))),
      label: '',
      initial: 0,
      hint: '',
      writable: 'model',
    };
    onChange([...value, next]);
    setSelected(value.length);
    focusLabel.current = true;
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    setSelected((current) => (current > index ? current - 1 : current === index ? Math.max(0, index - 1) : current));
  };

  const fieldIssues = at >= 0 ? (issues[at] ?? {}) : {};

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="pa-state-fields">
      <div className={modalStyles.group} role="list" aria-label={t('pa.soul.editor.play.state')}>
        {value.length === 0 ? (
          <p className={styles.stateEmpty}>{t('pa.soul.editor.play.empty')}</p>
        ) : (
          value.map((item, index) => {
            const flagged = Object.keys(issues[index] ?? {}).length > 0 || Boolean(errors?.[index]);
            return (
              <div
                key={index}
                role="listitem"
                className={styles.pickRow}
                data-tall=""
                data-selected={index === at ? '' : undefined}
                data-testid="pa-state-field-row"
              >
                <Button variant="bare" className={styles.pickButton} aria-pressed={index === at} onClick={() => setSelected(index)}>
                  <span className={styles.pickName}>{item.label.trim() || '—'}</span>
                  <SoulTag className={styles.kindTag}>{t(STATE_KIND_LABEL[item.kind])}</SoulTag>
                  <span className={styles.pickText} data-empty={initialText(item) === '' ? '' : undefined}>
                    {initialText(item) || '—'}
                  </span>
                  {flagged ? (
                    <>
                      <span aria-hidden className={styles.navDot} />
                      <VisuallyHidden>{t('pa.soul.editor.nav.error')}</VisuallyHidden>
                    </>
                  ) : null}
                </Button>
                <IconButton size="xs" aria-label={t('pa.soul.editor.play.remove')} onClick={() => remove(index)}>
                  <Icon icon={Trash2} size="sm" />
                </IconButton>
              </div>
            );
          })
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" size="sm" disabled={value.length >= L.stateFields} onClick={add}>
          <PlusIcon size="sm" />
          {t('pa.soul.editor.play.add')}
        </Button>
        <span className={modalStyles.fieldHint}>{t('pa.soul.editor.play.caption')}</span>
      </div>

      {field ? (
        <div className={modalStyles.group} data-testid="pa-state-field-form">
          <div className={styles.stateDetail}>
            <div className={styles.grid2}>
              <div className="min-w-0">
                <Label variant="form" htmlFor={ids.label}>
                  {t('pa.soul.editor.play.field.label')}
                </Label>
                <Input
                  ref={labelRef}
                  id={ids.label}
                  value={field.label}
                  autoComplete="off"
                  aria-invalid={fieldIssues.label ? true : undefined}
                  onChange={(event) => {
                    const label = event.target.value;
                    const others = othersKeys(at);
                    const auto = field.key === suggestStateKey(field.label, others);
                    replace(at, { ...field, label, ...(auto ? { key: suggestStateKey(label, others) } : {}) });
                  }}
                />
                {issueText(fieldIssues.label, t) ? <p className={modalStyles.fieldError}>{issueText(fieldIssues.label, t)}</p> : null}
              </div>
              <div className="min-w-0">
                <Label variant="form" htmlFor={ids.key}>
                  {t('pa.soul.editor.play.field.key')}
                </Label>
                <Input
                  id={ids.key}
                  variant="mono"
                  value={field.key}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={fieldIssues.key ? true : undefined}
                  onChange={(event) => replace(at, { ...field, key: event.target.value.trim() })}
                />
                {issueText(fieldIssues.key, t) ? <p className={modalStyles.fieldError}>{issueText(fieldIssues.key, t)}</p> : null}
              </div>
            </div>

            <div>
              <Label variant="form" className={styles.segmentLabel}>
                {t('pa.soul.editor.play.field.kind')}
              </Label>
              <Segmented
                size="md"
                className="flex w-full"
                aria-label={t('pa.soul.editor.play.field.kind')}
                value={field.kind}
                onValueChange={(kind) => {
                  if (kind !== field.kind) replace(at, withKind(field, kind as Kind));
                }}
              >
                {KINDS.map((kind) => (
                  <SegmentedItem key={kind} value={kind} className="min-w-0 flex-1">
                    {t(STATE_KIND_LABEL[kind])}
                  </SegmentedItem>
                ))}
              </Segmented>
            </div>

            {field.kind === 'number' ? (
              <>
                <div className={styles.grid4}>
                  <div className="min-w-0">
                    <Label variant="form" htmlFor={ids.initial}>
                      {t('pa.soul.editor.play.field.initial')}
                    </Label>
                    <SoulNumberInput
                      id={ids.initial}
                      value={field.initial}
                      allowEmpty={false}
                      invalid={Boolean(fieldIssues.initial)}
                      onChange={(next) => replace(at, { ...field, initial: next ?? field.initial })}
                    />
                  </div>
                  {(['min', 'max', 'maxStep'] as const).map((part) => (
                    <div key={part} className="min-w-0">
                      <Label variant="form" htmlFor={part === 'maxStep' ? ids.step : ids[part]}>
                        {t(part === 'min' ? 'pa.soul.editor.play.field.min' : part === 'max' ? 'pa.soul.editor.play.field.max' : 'pa.soul.editor.play.field.step')}
                      </Label>
                      <SoulNumberInput
                        id={part === 'maxStep' ? ids.step : ids[part]}
                        value={field[part]}
                        invalid={part !== 'maxStep' && Boolean(fieldIssues.range)}
                        onChange={(next) => replace(at, withNumberPart(field, part, next))}
                      />
                    </div>
                  ))}
                </div>
                {issueText(fieldIssues.range ?? fieldIssues.initial, t) ? (
                  <p className={cn(modalStyles.fieldError, '-mt-2')}>{issueText(fieldIssues.range ?? fieldIssues.initial, t)}</p>
                ) : null}
                <div>
                  <Label variant="form" className={styles.segmentLabel}>
                    {t('pa.soul.editor.play.field.render')}
                  </Label>
                  <Segmented
                    size="md"
                    className="flex w-full"
                    aria-label={t('pa.soul.editor.play.field.render')}
                    value={field.render ?? 'value'}
                    onValueChange={(render) => replace(at, { ...field, render: render as 'bar' | 'value' })}
                  >
                    <SegmentedItem value="bar" className="min-w-0 flex-1" disabled={field.min === undefined || field.max === undefined}>
                      {t('pa.soul.editor.play.field.renderBar')}
                    </SegmentedItem>
                    <SegmentedItem value="value" className="min-w-0 flex-1">
                      {t('pa.soul.editor.play.field.renderValue')}
                    </SegmentedItem>
                  </Segmented>
                </div>
              </>
            ) : null}

            {field.kind === 'text' ? (
              <div className="min-w-0">
                <Label variant="form" htmlFor={ids.initial}>
                  {t('pa.soul.editor.play.field.initial')}
                </Label>
                <Input
                  id={ids.initial}
                  value={field.initial}
                  autoComplete="off"
                  aria-invalid={fieldIssues.initial ? true : undefined}
                  onChange={(event) => replace(at, { ...field, initial: event.target.value })}
                />
              </div>
            ) : null}

            {field.kind === 'enum' ? (
              <div className={styles.grid2}>
                <div className="min-w-0">
                  <Label variant="form" htmlFor={ids.options}>
                    {t('pa.soul.editor.play.field.options')}
                  </Label>
                  <SoulTagInput
                    id={ids.options}
                    value={field.options}
                    max={L.stateOptions}
                    maxLength={L.stateOption}
                    placeholder={t('pa.soul.editor.basic.tagsPlaceholder')}
                    onChange={(options) =>
                      replace(at, { ...field, options, initial: options.includes(field.initial) ? field.initial : (options[0] ?? '') })
                    }
                  />
                </div>
                <div className="min-w-0">
                  <Label variant="form" htmlFor={ids.initial}>
                    {t('pa.soul.editor.play.field.initial')}
                  </Label>
                  <Select
                    value={field.options.includes(field.initial) ? field.initial : ''}
                    disabled={field.options.length === 0}
                    onValueChange={(initial) => replace(at, { ...field, initial })}
                  >
                    <SelectTrigger id={ids.initial} className="w-full" aria-invalid={fieldIssues.initial ? true : undefined}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {issueText(fieldIssues.initial, t) ? <p className={modalStyles.fieldError}>{issueText(fieldIssues.initial, t)}</p> : null}
                </div>
              </div>
            ) : null}

            {field.kind === 'list' ? (
              <div className="min-w-0">
                <Label variant="form" htmlFor={ids.initial}>
                  {t('pa.soul.editor.play.field.initial')}
                </Label>
                <SoulTagInput
                  id={ids.initial}
                  value={field.initial}
                  max={L.stateListItems}
                  maxLength={L.stateListItem}
                  placeholder={t('pa.soul.editor.basic.tagsPlaceholder')}
                  onChange={(initial) => replace(at, { ...field, initial })}
                />
              </div>
            ) : null}

            <div className="min-w-0">
              <Label variant="form" htmlFor={ids.hint}>
                {t('pa.soul.editor.play.field.hint')}
              </Label>
              <Input
                id={ids.hint}
                value={field.hint}
                autoComplete="off"
                aria-invalid={fieldIssues.hint ? true : undefined}
                onChange={(event) => replace(at, { ...field, hint: event.target.value })}
              />
              <div className={modalStyles.fieldFoot}>
                <p className={modalStyles.fieldHint}>{t('pa.soul.editor.play.field.hintHint', { name })}</p>
                {field.hint.length > L.stateHint * 0.8 ? (
                  <span className={modalStyles.fieldMeta}>
                    <span data-over={field.hint.length > L.stateHint ? '' : undefined}>
                      {t('pa.soul.editor.counter', { n: field.hint.length, max: L.stateHint })}
                    </span>
                  </span>
                ) : null}
              </div>
            </div>

            <div>
              <Label variant="form" className={styles.segmentLabel}>
                {t('pa.soul.editor.play.field.writable')}
              </Label>
              <Segmented
                size="md"
                className="flex w-full"
                aria-label={t('pa.soul.editor.play.field.writable')}
                value={field.writable}
                onValueChange={(writable) => replace(at, { ...field, writable: writable as 'model' | 'user' })}
              >
                <SegmentedItem value="model" className="min-w-0 flex-1">
                  {t('pa.soul.editor.play.field.writableModel', { name })}
                </SegmentedItem>
                <SegmentedItem value="user" className="min-w-0 flex-1">
                  {t('pa.soul.editor.play.field.writableUser')}
                </SegmentedItem>
              </Segmented>
            </div>

            {errors?.[at] ? <p className={modalStyles.fieldError}>{errors[at]}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
