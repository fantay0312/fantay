// SPDX-License-Identifier: AGPL-3.0-only
// World-book editor forms (Soul UI spec §7.3): the entry form — six basics, everything else under one 高级
// disclosure, grouped in hairline blocks — and the 本书设置 form. Both edit the editor's local draft through
// `onChange`; nothing here talks to the daemon. Limits come from SOUL_LIMITS; numbers are kept valid in the draft
// (a half-typed or out-of-range number is marked, then clamped or restored on blur).
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { PaLoreEntry, PaLorebookDoc, PaNeedsReviewItem } from '@open-design/contracts';
import { SOUL_LIMITS, compileLoreKey, estimateTokens } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import {
  Field,
  Input,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
} from '../../ui';
import { PaSwitchRow } from '../PaAgentModal';
import { PaDisclosure } from '../PaDisclosure';
import modalStyles from '../PaModals.module.css';
import type { TFn } from '../pa-types';
import { SoulStepper, SoulTag, SoulTagInput } from './SoulPrimitives';
import styles from './SoulLorebookModal.module.css';

const L = SOUL_LIMITS;
type Key = Parameters<TFn>[0];

const LOGIC: ReadonlyArray<[PaLoreEntry['logic'], Key]> = [
  ['and_any', 'pa.soul.lore.entry.logic.andAny'],
  ['and_all', 'pa.soul.lore.entry.logic.andAll'],
  ['not_any', 'pa.soul.lore.entry.logic.notAny'],
  ['not_all', 'pa.soul.lore.entry.logic.notAll'],
];
const POSITIONS: ReadonlyArray<[PaLoreEntry['position'], Key]> = [
  ['before_char', 'pa.soul.lore.entry.position.before'],
  ['after_char', 'pa.soul.lore.entry.position.after'],
  ['at_depth', 'pa.soul.lore.entry.position.depth'],
];
const ROLES: ReadonlyArray<[PaLoreEntry['role'], Key]> = [
  ['system', 'pa.soul.lore.entry.role.system'],
  ['user', 'pa.soul.lore.entry.role.user'],
  ['assistant', 'pa.soul.lore.entry.role.assistant'],
];
type Tri = 'inherit' | 'yes' | 'no';
const TRI: ReadonlyArray<[Tri, Key]> = [
  ['inherit', 'pa.soul.lore.entry.tri.inherit'],
  ['yes', 'pa.soul.lore.entry.tri.yes'],
  ['no', 'pa.soul.lore.entry.tri.no'],
];
const KIND_KEY: Record<PaNeedsReviewItem['kind'], Key> = {
  script: 'pa.soul.lore.book.kind.script',
  regex: 'pa.soul.lore.book.kind.regex',
  html: 'pa.soul.lore.book.kind.html',
  remote: 'pa.soul.lore.book.kind.remote',
  other: 'pa.soul.lore.book.kind.other',
};
const ACTION_KEY: Record<PaNeedsReviewItem['action'], Key> = {
  quarantined: 'pa.soul.lore.book.action.quarantined',
  kept: 'pa.soul.lore.book.action.kept',
  disabled: 'pa.soul.lore.book.action.disabled',
  truncated: 'pa.soul.lore.book.action.truncated',
};

type TimerField = 'sticky' | 'cooldown' | 'delay';
const timerPatch = (field: TimerField, value: number): Partial<PaLoreEntry> =>
  field === 'sticky' ? { sticky: value } : field === 'cooldown' ? { cooldown: value } : { delay: value };

const triOf = (value: boolean | null): Tri => (value === null ? 'inherit' : value ? 'yes' : 'no');
const fromTri = (value: Tri): boolean | null => (value === 'inherit' ? null : value === 'yes');

/** Grouped digits for counts and token numbers (1,240), the same in both locales. */
export function loreNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** An entry the editor can save: every text field within its limit (keys, groups and numbers are held valid). */
export function loreEntryValid(entry: PaLoreEntry): boolean {
  return entry.title.length <= L.loreTitle && entry.content.length <= L.loreContent;
}

/* ── small pieces ─────────────────────────────────────────────────────────────────────── */

/** `{length}/{max}` once a field passes 80% of its limit; accent ink over it (spec §7 counters). */
function Counter({ length, max }: { length: number; max: number }) {
  if (length <= max * 0.8) return null;
  return (
    <span className={styles.counter} data-over={length > max ? '' : undefined}>
      {loreNumber(length)}/{loreNumber(max)}
    </span>
  );
}

function readInteger(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^[-+]?\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

interface LoreNumberProps {
  id?: string;
  value: number | null;
  onChange(next: number | null): void;
  min: number;
  max: number;
  /** Empty text means `null` (跟随本书). */
  nullable?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/** A mono integer field whose value in the draft is always valid: while the text is not a whole number within
 *  [min, max] it is marked invalid and the draft keeps the last good value; on blur it is clamped or restored. */
function LoreNumber({ id, value, onChange, min, max, nullable = false, placeholder, className, ...aria }: LoreNumberProps) {
  const show = (next: number | null) => (next === null ? '' : String(next));
  const [text, setText] = useState(() => show(value));
  useEffect(() => {
    setText((current) => (readInteger(current) === value ? current : show(value)));
  }, [value]);
  const accepts = (parsed: number | null | undefined): parsed is number | null =>
    parsed === null ? nullable : parsed !== undefined && parsed >= min && parsed <= max;
  const parsed = readInteger(text);
  const invalid = !accepts(parsed);
  return (
    <Input
      id={id}
      variant="mono"
      inputMode="numeric"
      autoComplete="off"
      className={cn(styles.number, className)}
      value={text}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      {...aria}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const read = readInteger(next);
        if (accepts(read) && read !== value) onChange(read);
      }}
      onBlur={() => {
        if (!invalid) return;
        if (parsed === undefined || parsed === null) {
          setText(show(value));
          return;
        }
        const clamped = Math.min(max, Math.max(min, parsed));
        setText(show(clamped));
        if (clamped !== value) onChange(clamped);
      }}
    />
  );
}

/** A group row: label (+ hint) at the start, one control at the end. */
function ValueRow({ label, htmlFor, hint, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={modalStyles.row}>
      <div className={modalStyles.rowText}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={modalStyles.rowLabel}>
            {label}
          </label>
        ) : (
          <span className={modalStyles.rowLabel}>{label}</span>
        )}
        {hint ? <div className={modalStyles.rowHint}>{hint}</div> : null}
      </div>
      <div className={modalStyles.rowControl}>{children}</div>
    </div>
  );
}

/** A group row whose control spans the row under its label (tag inputs, option rows). */
function StackRow({ label, htmlFor, hint, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.stackRow}>
      <div className={styles.stackHead}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={modalStyles.rowLabel}>
            {label}
          </label>
        ) : (
          <span className={modalStyles.rowLabel}>{label}</span>
        )}
        {hint ? <div className={modalStyles.rowHint}>{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A full-width option row of equal segments (owner rule O3). */
function OptionRow<V extends string>({
  label,
  value,
  options,
  onChange,
  tight = false,
}: {
  label: string;
  value: V;
  options: ReadonlyArray<[V, Key]>;
  onChange(next: V): void;
  tight?: boolean;
}) {
  const t = useT();
  return (
    <Segmented className="flex w-full" size="md" aria-label={label} value={value} onValueChange={(next) => onChange(next as V)}>
      {options.map(([option, key]) => (
        <SegmentedItem key={option} value={option} className={cn('min-w-0 flex-1', tight && 'px-1.5')}>
          {t(key)}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

/** Keys that do not compile, and valid regex keys outside the inline-safe subset (run by the local service only). */
function keyNotes(keys: readonly string[]): { invalid: boolean; daemonOnly: string[] } {
  let invalid = false;
  const daemonOnly: string[] = [];
  for (const key of keys) {
    const compiled = compileLoreKey(key);
    if (compiled.kind === 'invalid') invalid = true;
    else if (compiled.kind === 'regex' && !compiled.safe) daemonOnly.push(key.trim());
  }
  return { invalid, daemonOnly };
}

const validKey = (key: string) => compileLoreKey(key).kind !== 'invalid';

function KeyNotes({ keys, t }: { keys: readonly string[]; t: TFn }) {
  if (keys.length === 0) return null;
  return (
    <ul className={styles.keyNotes}>
      {keys.map((key) => (
        <li key={key} className={styles.keyNote}>
          <code className={styles.keyCode}>{key}</code>
          <span>{t('pa.soul.lore.reason.regexNeedsDaemon')}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── entry form ───────────────────────────────────────────────────────────────────────── */

export interface SoulLoreEntryFormProps {
  entry: PaLoreEntry;
  onChange(patch: Partial<PaLoreEntry>): void;
  advancedOpen: boolean;
  onAdvancedOpenChange(open: boolean): void;
  /** Focus the title (a just-created entry). */
  autoFocus?: boolean;
}

export function SoulLoreEntryForm({ entry, onChange, advancedOpen, onAdvancedOpenChange, autoFocus = false }: SoulLoreEntryFormProps) {
  const t = useT();
  const ids = {
    title: useId(),
    keys: useId(),
    content: useId(),
    order: useId(),
    secondary: useId(),
    scan: useId(),
    groups: useId(),
    weight: useId(),
    sticky: useId(),
    cooldown: useId(),
    delay: useId(),
    unit: useId(),
  };
  const primary = useMemo(() => keyNotes(entry.keys), [entry.keys]);
  const secondary = useMemo(() => keyNotes(entry.secondaryKeys), [entry.secondaryKeys]);
  const tokens = useMemo(() => estimateTokens(entry.content), [entry.content]);
  const titleOver = entry.title.length > L.loreTitle;
  const contentOver = entry.content.length > L.loreContent;

  return (
    <div className={styles.form} data-testid="pa-lore-entry-form">
      <Field label={t('pa.soul.lore.entry.title')} htmlFor={ids.title} labelVariant="form">
        <Input
          id={ids.title}
          value={entry.title}
          autoComplete="off"
          autoFocus={autoFocus}
          aria-invalid={titleOver || undefined}
          onChange={(event) => onChange({ title: event.target.value })}
        />
        {entry.title.length > L.loreTitle * 0.8 ? (
          <div className={styles.fieldMeta}>
            <Counter length={entry.title.length} max={L.loreTitle} />
          </div>
        ) : null}
      </Field>

      <div>
        <Field
          label={t('pa.soul.lore.entry.keys')}
          htmlFor={ids.keys}
          labelVariant="form"
          hint={t('pa.soul.lore.entry.keysHint')}
          error={primary.invalid ? t('pa.soul.lore.entry.keyInvalid') : undefined}
        >
          <SoulTagInput
            id={ids.keys}
            value={entry.keys}
            max={L.loreKeys}
            maxLength={L.loreKey}
            placeholder={t('pa.soul.lore.entry.keysPlaceholder')}
            validate={validKey}
            onChange={(keys) => onChange({ keys })}
          />
        </Field>
        <KeyNotes keys={primary.daemonOnly} t={t} />
      </div>

      <Field label={t('pa.soul.lore.entry.content')} htmlFor={ids.content} labelVariant="form">
        <Textarea
          id={ids.content}
          rows={8}
          className={styles.content}
          value={entry.content}
          aria-invalid={contentOver || undefined}
          onChange={(event) => onChange({ content: event.target.value })}
        />
        <div className={styles.fieldMeta}>
          <Counter length={entry.content.length} max={L.loreContent} />
          {tokens > 0 ? <span className={styles.tokens}>{t('pa.soul.lore.entry.tokens', { n: loreNumber(tokens) })}</span> : null}
        </div>
      </Field>

      <div className={modalStyles.group}>
        <PaSwitchRow label={t('pa.soul.lore.entry.enabled')} checked={entry.enabled} onChange={(enabled) => onChange({ enabled })} />
        <PaSwitchRow
          label={t('pa.soul.lore.entry.constant')}
          hint={t('pa.soul.lore.entry.constantHint')}
          checked={entry.constant}
          onChange={(constant) => onChange({ constant })}
        />
        <ValueRow label={t('pa.soul.lore.entry.order')} htmlFor={ids.order} hint={t('pa.soul.lore.entry.orderHint')}>
          <LoreNumber
            id={ids.order}
            className={styles.order}
            value={entry.order}
            min={-L.loreOrder}
            max={L.loreOrder}
            onChange={(order) => {
              if (order !== null) onChange({ order });
            }}
          />
        </ValueRow>
      </div>

      <PaDisclosure
        label={t('pa.soul.lore.entry.advanced')}
        open={advancedOpen}
        onOpenChange={onAdvancedOpenChange}
        className={modalStyles.sectionDisclosure}
      >
        <div className={styles.advanced} data-testid="pa-lore-advanced">
          <div className={modalStyles.group}>
            <StackRow label={t('pa.soul.lore.entry.secondary')} htmlFor={ids.secondary}>
              <SoulTagInput
                id={ids.secondary}
                value={entry.secondaryKeys}
                max={L.loreKeys}
                maxLength={L.loreKey}
                placeholder={t('pa.soul.lore.entry.keysPlaceholder')}
                validate={validKey}
                onChange={(secondaryKeys) => onChange({ secondaryKeys })}
              />
              {secondary.invalid ? <p className={styles.fieldError}>{t('pa.soul.lore.entry.keyInvalid')}</p> : null}
              <KeyNotes keys={secondary.daemonOnly} t={t} />
            </StackRow>
            <PaSwitchRow label={t('pa.soul.lore.entry.selective')} checked={entry.selective} onChange={(selective) => onChange({ selective })} />
            <StackRow label={t('pa.soul.lore.entry.logic')}>
              <OptionRow label={t('pa.soul.lore.entry.logic')} value={entry.logic} options={LOGIC} onChange={(logic) => onChange({ logic })} />
            </StackRow>
          </div>

          <div className={modalStyles.group}>
            <StackRow label={t('pa.soul.lore.entry.position')}>
              <OptionRow
                label={t('pa.soul.lore.entry.position')}
                value={entry.position}
                options={POSITIONS}
                tight
                onChange={(position) => onChange({ position })}
              />
            </StackRow>
            {entry.position === 'at_depth' ? (
              <>
                <ValueRow label={t('pa.soul.lore.entry.depth')}>
                  <SoulStepper
                    aria-label={t('pa.soul.lore.entry.depth')}
                    value={entry.depth}
                    min={0}
                    max={L.loreDepth}
                    onChange={(depth) => onChange({ depth })}
                  />
                </ValueRow>
                <ValueRow label={t('pa.soul.lore.entry.role')}>
                  <Select value={entry.role} onValueChange={(role) => onChange({ role: role as PaLoreEntry['role'] })}>
                    <SelectTrigger className={styles.roleSelect} aria-label={t('pa.soul.lore.entry.role')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map(([role, key]) => (
                        <SelectItem key={role} value={role}>
                          {t(key)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </ValueRow>
              </>
            ) : null}
          </div>

          <div className={modalStyles.group}>
            <ValueRow label={t('pa.soul.lore.entry.scan')} htmlFor={ids.scan}>
              <LoreNumber
                id={ids.scan}
                className={styles.numberWide}
                value={entry.scanDepth}
                nullable
                min={0}
                max={L.loreScanDepth}
                placeholder={t('pa.soul.lore.entry.tri.inherit')}
                onChange={(scanDepth) => onChange({ scanDepth })}
              />
            </ValueRow>
            <StackRow label={t('pa.soul.lore.entry.case')}>
              <OptionRow
                label={t('pa.soul.lore.entry.case')}
                value={triOf(entry.caseSensitive)}
                options={TRI}
                onChange={(next) => onChange({ caseSensitive: fromTri(next) })}
              />
            </StackRow>
            <StackRow label={t('pa.soul.lore.entry.whole')}>
              <OptionRow
                label={t('pa.soul.lore.entry.whole')}
                value={triOf(entry.matchWholeWords)}
                options={TRI}
                onChange={(next) => onChange({ matchWholeWords: fromTri(next) })}
              />
            </StackRow>
          </div>

          <div className={modalStyles.group}>
            <ValueRow label={t('pa.soul.lore.entry.probability')}>
              <SoulStepper
                aria-label={t('pa.soul.lore.entry.probability')}
                value={entry.probability}
                min={0}
                max={100}
                step={5}
                format={(value) => `${value}%`}
                onChange={(probability) => onChange({ probability })}
              />
            </ValueRow>
          </div>

          <div className={modalStyles.group}>
            <StackRow label={t('pa.soul.lore.entry.groups')} htmlFor={ids.groups}>
              <SoulTagInput
                id={ids.groups}
                value={entry.groups}
                max={L.loreGroups}
                maxLength={L.loreGroup}
                placeholder={t('pa.soul.lore.entry.keysPlaceholder')}
                onChange={(groups) => onChange({ groups })}
              />
            </StackRow>
            <ValueRow label={t('pa.soul.lore.entry.weight')} htmlFor={ids.weight}>
              <LoreNumber
                id={ids.weight}
                value={entry.groupWeight}
                min={1}
                max={L.loreGroupWeight}
                onChange={(groupWeight) => {
                  if (groupWeight !== null) onChange({ groupWeight });
                }}
              />
            </ValueRow>
            <PaSwitchRow label={t('pa.soul.lore.entry.override')} checked={entry.groupOverride} onChange={(groupOverride) => onChange({ groupOverride })} />
          </div>

          <div className={modalStyles.group}>
            <div className={styles.stackRow}>
              <div className={styles.timers}>
                {(
                  [
                    ['sticky', ids.sticky, 'pa.soul.lore.entry.sticky'],
                    ['cooldown', ids.cooldown, 'pa.soul.lore.entry.cooldown'],
                    ['delay', ids.delay, 'pa.soul.lore.entry.delay'],
                  ] as const
                ).map(([field, id, key]) => (
                  <div key={field} className={styles.timer}>
                    <label htmlFor={id} className={modalStyles.rowLabel}>
                      {t(key)}
                    </label>
                    <LoreNumber
                      id={id}
                      className={styles.numberFill}
                      value={entry[field]}
                      min={0}
                      max={L.loreTimer}
                      aria-describedby={ids.unit}
                      onChange={(next) => {
                        if (next !== null) onChange(timerPatch(field, next));
                      }}
                    />
                  </div>
                ))}
              </div>
              <div id={ids.unit} className={modalStyles.rowHint}>
                {t('pa.soul.lore.entry.timerUnit')}
              </div>
            </div>
          </div>

          <div className={modalStyles.group}>
            <PaSwitchRow
              label={t('pa.soul.lore.entry.excludeRecursion')}
              checked={entry.excludeRecursion}
              onChange={(excludeRecursion) => onChange({ excludeRecursion })}
            />
            <PaSwitchRow
              label={t('pa.soul.lore.entry.preventRecursion')}
              checked={entry.preventRecursion}
              onChange={(preventRecursion) => onChange({ preventRecursion })}
            />
            <PaSwitchRow
              label={t('pa.soul.lore.entry.recursionOnly')}
              checked={entry.recursionOnly}
              onChange={(recursionOnly) => onChange({ recursionOnly })}
            />
            <PaSwitchRow
              label={t('pa.soul.lore.entry.ignoreBudget')}
              checked={entry.ignoreBudget}
              onChange={(ignoreBudget) => onChange({ ignoreBudget })}
            />
          </div>
        </div>
      </PaDisclosure>
    </div>
  );
}

/* ── book settings form ───────────────────────────────────────────────────────────────── */

export interface SoulLoreBookFormProps {
  draft: PaLorebookDoc;
  onChange(patch: Partial<PaLorebookDoc>): void;
  /** An imported book's items that were not mapped (read-only). */
  review: readonly PaNeedsReviewItem[];
}

export function SoulLoreBookForm({ draft, onChange, review }: SoulLoreBookFormProps) {
  const t = useT();
  const ids = { description: useId(), budget: useId(), review: useId() };
  return (
    <div className={styles.form} data-testid="pa-lore-book-form">
      <h3 className={styles.formTitle}>{t('pa.soul.lore.book')}</h3>
      <Field label={t('pa.soul.lore.book.description')} htmlFor={ids.description} labelVariant="form">
        <Textarea
          id={ids.description}
          rows={3}
          value={draft.description}
          aria-invalid={draft.description.length > L.lorebookDescription || undefined}
          onChange={(event) => onChange({ description: event.target.value })}
        />
        {draft.description.length > L.lorebookDescription * 0.8 ? (
          <div className={styles.fieldMeta}>
            <Counter length={draft.description.length} max={L.lorebookDescription} />
          </div>
        ) : null}
      </Field>

      <div className={modalStyles.group}>
        <ValueRow label={t('pa.soul.lore.book.scan')}>
          <SoulStepper
            aria-label={t('pa.soul.lore.book.scan')}
            value={draft.scanDepth}
            min={0}
            max={L.loreScanDepth}
            onChange={(scanDepth) => onChange({ scanDepth })}
          />
        </ValueRow>
        <ValueRow label={t('pa.soul.lore.book.budget')} htmlFor={ids.budget} hint={t('pa.soul.lore.book.budgetHint')}>
          <LoreNumber
            id={ids.budget}
            className={styles.numberWide}
            value={draft.tokenBudget}
            min={L.loreBudgetMin}
            max={L.loreBudgetMax}
            onChange={(tokenBudget) => {
              if (tokenBudget !== null) onChange({ tokenBudget });
            }}
          />
        </ValueRow>
        <PaSwitchRow label={t('pa.soul.lore.book.recursive')} checked={draft.recursive} onChange={(recursive) => onChange({ recursive })} />
        <PaSwitchRow label={t('pa.soul.lore.book.case')} checked={draft.caseSensitive} onChange={(caseSensitive) => onChange({ caseSensitive })} />
        <PaSwitchRow
          label={t('pa.soul.lore.book.whole')}
          hint={t('pa.soul.lore.book.wholeHint')}
          checked={draft.matchWholeWords}
          onChange={(matchWholeWords) => onChange({ matchWholeWords })}
        />
        <PaSwitchRow label={t('pa.soul.lore.book.global')} checked={draft.global} onChange={(global) => onChange({ global })} />
      </div>

      {review.length > 0 ? (
        <section className={styles.reviewBlock} aria-labelledby={ids.review} data-testid="pa-lore-review">
          <h4 id={ids.review} className={modalStyles.sectionTitle}>
            {t('pa.soul.lore.book.review')}
          </h4>
          <ul className={cn(modalStyles.group, styles.reviewList)}>
            {review.map((item, index) => (
              <li key={`${index}:${item.kind}`} className={styles.reviewRow}>
                <SoulTag tone="outline">{t(KIND_KEY[item.kind])}</SoulTag>
                <span className={styles.reviewSummary}>{item.summary}</span>
                <span className={styles.reviewAction}>{t(ACTION_KEY[item.action])}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
