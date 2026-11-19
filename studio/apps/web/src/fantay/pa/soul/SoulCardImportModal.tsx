// SPDX-License-Identifier: AGPL-3.0-only
// Card import (modal kind `cardImport`, Soul UI spec §7.2). Step 1 takes a PNG or JSON card (drop or picker); the file is
// parsed on this device with the engine (`readCardFile`: PNG chunks, size limit, the portrait re-encoded through a
// canvas) and nothing is sent before the user confirms. Step 2 shows what the card brings in three columns
// 可用 · 已保留 · 需另行处理, the editable name and the model, then 导入并开始聊天. With `agentId` the card overwrites that
// character (addendum item 9): the modal lists the fields that will change and the daemon replaces the definition.
// Stage 2 (spec §7.3): a CHARX archive (`.charx`, or any zip) is unpacked here too; its icon becomes the portrait, its
// emotion images the sprites (saved one by one through uploadAsset on confirm), and the archive files that are not
// imported are listed under 需另行处理 with their reasons.
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { SOUL_LIMITS, estimateTokens, importWorldInfo, resolveAppearance } from '@open-design/contracts/soul';
import type { CharxReportItem, PaCardImportPreview, PaEmotion } from '@open-design/contracts/soul';

import { useI18n } from '../../../i18n';
import { Button, Callout, EmptyState, Input, ModalSpacer, Spinner, cn, toast } from '../../ui';
import { PaModalFrame, usePaModalReset, usePaSubmit } from '../PaAgentModal';
import { PaModelPicker } from '../PaModelPicker';
import { paSoulAssetUrl } from '../pa-api';
import { usePa } from '../pa-context';
import type { PaActions, PaCharacterView, PaModel, PersonalAgent, TFn } from '../pa-types';
import { characterOf, displayName } from './soul-model';
import { imageToAsset, readCardFile, readFileText, type SoulCharxRead } from './soul-files';
import { soulFrameOf } from './soul-theme';
import { useSoulWorldImport } from './SoulLibraryTiles';
import { SoulPortrait } from './SoulPortrait';
import { SoulTag } from './SoulPrimitives';
import modalStyles from '../PaModals.module.css';
import styles from './SoulCardImportModal.module.css';

export interface SoulCardImportModalProps {
  open: boolean;
  onClose(): void;
  file?: File;
  /** Import onto this existing character (用角色卡覆盖…); the modal then shows which fields are replaced. */
  agentId?: string;
}

type ReadyPreview = Extract<PaCardImportPreview, { ok: true }>;
interface Loaded {
  preview: ReadyPreview;
  card: unknown;
  portrait: { mime: string; data: string } | null;
  fileName: string;
  /** What a CHARX archive brought besides the card (readCardFile). */
  charx?: SoulCharxRead;
}
type PickError =
  | { kind: 'badJson' | 'tooLarge' | 'noCard' | 'unsupported' | 'charxCorrupt' | 'charxNoCard' | 'charxZip64' }
  | { kind: 'world'; world: unknown; fileName: string };
type Step = 'pick' | 'reading' | 'preview';
type ImportResult = Awaited<ReturnType<PaActions['importCard']>>;
type DictKey = Parameters<TFn>[0];
type FieldKey =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'firstMessage'
  | 'openers'
  | 'examples'
  | 'systemPrompt'
  | 'postHistory'
  | 'note'
  | 'creatorNotes';

const ACCEPT = '.png,.json,.charx,image/png,application/json,application/zip';
const ACCEPTED_NAME = /\.(?:png|json|charx)$/i;
/** Zip MIME types a browser reports (macOS / Linux, Windows); readCardFile then takes the CHARX branch. */
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed']);
const CHARX_ERROR = { corrupt: 'charxCorrupt', 'no-card': 'charxNoCard', zip64: 'charxZip64' } as const;
/** Archive files listed by path under the 需另行处理 files row; the rest is counted in one closing line. */
const FILES_SHOWN = 20;
/** Keys a character card carries; a JSON object with `entries` and none of these is a world book. */
const CARD_KEYS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'char_name', 'char_persona', 'char_greeting'];

const ERROR_KEY: Record<Exclude<PickError['kind'], 'world'>, DictKey> = {
  badJson: 'pa.soul.library.import.error.badJson',
  tooLarge: 'pa.soul.library.import.error.tooLarge',
  noCard: 'pa.soul.library.import.error.noCard',
  unsupported: 'pa.soul.library.import.error.unsupported',
  charxCorrupt: 'pa.soul.library.charx.error.corrupt',
  charxNoCard: 'pa.soul.library.charx.error.noCard',
  charxZip64: 'pa.soul.library.charx.error.zip64',
};

const DRAFT_AGENT: PersonalAgent = {
  id: 'pa-draft-import',
  createdAt: 0,
  updatedAt: 0,
  revision: 1,
  name: '',
  role: '',
  avatar: '',
  enabled: true,
  tools: ['respond'],
  model: { runtime: 'claude', modelId: 'sonnet' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function acceptable(file: File): boolean {
  return ACCEPTED_NAME.test(file.name) || file.type === 'image/png' || file.type === 'application/json' || ZIP_TYPES.has(file.type);
}

/** A file read as an archive: its text is never a world-book JSON, so the world check is skipped. */
function archiveFile(file: File): boolean {
  return /\.charx$/i.test(file.name) || ZIP_TYPES.has(file.type);
}

/** The 需另行处理 files row: every skipped report item; the engine's `limit` item carries how many it left out. */
function charxFiles(report: readonly CharxReportItem[]): { count: number; rows: CharxReportItem[]; rest: number } {
  const skipped = report.filter((item) => item.action === 'skipped');
  const listed = skipped.filter((item) => item.reason !== 'limit');
  const limit = skipped.find((item) => item.reason === 'limit');
  const count = listed.length + (limit ? Number(limit.path) || 0 : 0);
  const rows = listed.slice(0, FILES_SHOWN);
  return { count, rows, rest: count - rows.length };
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** A JSON object shaped like a world book rather than a character card (the card parser alone would read a world
 *  file with a top-level `name` as an empty V1 card). */
function looksLikeWorld(json: unknown): boolean {
  if (!isRecord(json)) return false;
  if (json.spec === 'chara_card_v2' || json.spec === 'chara_card_v3') return false;
  if (!Object.hasOwn(json, 'entries') && json.spec !== 'lorebook_v3') return false;
  return !CARD_KEYS.some((key) => Object.hasOwn(json, key));
}

async function jsonOf(file: File): Promise<unknown> {
  try {
    const text = await readFileText(file);
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

/** The card with its name replaced, by spread (never by assignment with a foreign key). */
function withName(card: unknown, name: string): unknown {
  if (!isRecord(card)) return card;
  if ((card.spec === 'chara_card_v2' || card.spec === 'chara_card_v3') && isRecord(card.data)) return { ...card, data: { ...card.data, name } };
  if (typeof card.name === 'string') return { ...card, name };
  if (typeof card.char_name === 'string') return { ...card, char_name: name };
  return card;
}

const chars = (text: string) => Array.from(text).length;

interface ReadyRow {
  key: string;
  label: string;
  size: number | null;
}

/** The 可用 column: one row per non-empty mapped field, in the order of the profile editor. */
function readyRows(preview: ReadyPreview, t: TFn): ReadyRow[] {
  const c = preview.character;
  const rows: ReadyRow[] = [];
  const text = (key: FieldKey, value: string) => {
    if (value.trim()) rows.push({ key, label: t(`pa.soul.library.import.field.${key}`), size: chars(value) });
  };
  text('description', c.description);
  text('personality', c.personality);
  text('scenario', c.scenario);
  text('firstMessage', c.firstMessage);
  if (c.alternateGreetings.length > 0) {
    rows.push({
      key: 'alternates',
      label: t('pa.soul.library.import.field.alternates', { n: c.alternateGreetings.length }),
      size: c.alternateGreetings.reduce((sum, value) => sum + chars(value), 0),
    });
  }
  if (c.openers.length > 0) {
    rows.push({ key: 'openers', label: t('pa.soul.library.import.field.openers'), size: c.openers.reduce((sum, value) => sum + chars(value), 0) });
  }
  text('examples', c.exampleDialogue);
  text('systemPrompt', c.systemPrompt);
  text('postHistory', c.postHistoryInstructions);
  text('note', c.characterNote?.text ?? '');
  text('creatorNotes', c.creatorNotes);
  if (c.tags.length > 0) rows.push({ key: 'tags', label: t('pa.soul.library.import.field.tags', { n: c.tags.length }), size: null });
  if (c.stateSchema.length > 0) rows.push({ key: 'state', label: t('pa.soul.library.import.field.state', { n: c.stateSchema.length }), size: null });
  if (c.decks.length > 0) rows.push({ key: 'decks', label: t('pa.soul.library.import.field.decks', { n: c.decks.length }), size: null });
  if (preview.lorebook) rows.push({ key: 'lore', label: t('pa.soul.library.import.field.lore', { n: preview.lorebook.entries.length }), size: null });
  return rows;
}

/** The sum of the 可用 text fields, as the profile editor estimates them. */
function readyTokens(preview: ReadyPreview): number {
  const c = preview.character;
  const parts = [
    c.description,
    c.personality,
    c.scenario,
    c.firstMessage,
    ...c.alternateGreetings,
    ...c.openers,
    c.exampleDialogue,
    c.systemPrompt,
    c.postHistoryInstructions,
    c.characterNote?.text ?? '',
    c.creatorNotes,
  ];
  return parts.reduce((sum, part) => sum + estimateTokens(part), 0);
}

/** Overwrite mode: the labelled fields whose value the card changes on the existing character. `sprites` is the number
 *  of sprites a CHARX brings (they replace the character's whole set). */
function replacedFields(current: PaCharacterView | null, preview: ReadyPreview, t: TFn, sprites = 0): string[] {
  if (!current) return [];
  const next = preview.character;
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const field = (key: FieldKey) => t(`pa.soul.library.import.field.${key}`);
  const out: string[] = [];
  if (differs(current.description, next.description)) out.push(field('description'));
  if (differs(current.personality, next.personality)) out.push(field('personality'));
  if (differs(current.scenario, next.scenario)) out.push(field('scenario'));
  if (differs(current.firstMessage, next.firstMessage)) out.push(field('firstMessage'));
  if (differs(current.alternateGreetings, next.alternateGreetings)) {
    out.push(t('pa.soul.library.import.field.alternates', { n: next.alternateGreetings.length }));
  }
  if (differs(current.openers, next.openers)) out.push(field('openers'));
  if (differs(current.exampleDialogue, next.exampleDialogue)) out.push(field('examples'));
  if (differs(current.systemPrompt, next.systemPrompt)) out.push(field('systemPrompt'));
  if (differs(current.postHistoryInstructions, next.postHistoryInstructions)) out.push(field('postHistory'));
  if (differs(current.characterNote, next.characterNote)) out.push(field('note'));
  if (differs(current.creatorNotes, next.creatorNotes)) out.push(field('creatorNotes'));
  if (differs(current.tags, next.tags)) out.push(t('pa.soul.library.import.field.tags', { n: next.tags.length }));
  if (differs(current.stateSchema, next.stateSchema)) out.push(t('pa.soul.library.import.field.state', { n: next.stateSchema.length }));
  if (differs(current.decks, next.decks)) out.push(t('pa.soul.library.import.field.decks', { n: next.decks.length }));
  if (preview.lorebook) out.push(t('pa.soul.library.import.field.lore', { n: preview.lorebook.entries.length }));
  if (sprites > 0) out.push(t('pa.soul.library.charx.sprites', { n: sprites }));
  return out;
}

function ImportColumn({ title, count, empty, testId, children }: { title: string; count: number; empty: string; testId: string; children: ReactNode }) {
  return (
    <section className={styles.column} data-testid={testId}>
      <h3 className={styles.columnHead}>
        {title}
        <span className={styles.count}>{count}</span>
      </h3>
      {count > 0 ? <ul className={styles.list}>{children}</ul> : <div className={cn(styles.list, styles.none)}>{empty}</div>}
    </section>
  );
}

export function SoulCardImportModal({ open, onClose, file, agentId }: SoulCardImportModalProps) {
  const { data, index, nav } = usePa();
  const { t, locale } = useI18n();
  const submit = usePaSubmit();
  const importWorld = useSoulWorldImport();
  const modelId = useId();
  const [step, setStep] = useState<Step>(file ? 'reading' : 'pick');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<PickError | null>(null);
  const [name, setName] = useState('');
  const [model, setModel] = useState<PaModel | null>(null);
  const [over, setOver] = useState(false);
  const [worldBusy, setWorldBusy] = useState(false);
  /** While CHARX sprites are being saved on confirm: the image in progress and the total. */
  const [saving, setSaving] = useState<{ n: number; total: number } | null>(null);
  /** Sprite asset ids already saved for this archive, so a retry after a failed import does not save them again. */
  const savedSprites = useRef<{ from: Loaded; ids: Map<PaEmotion, string> } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const readToken = useRef(0);

  const overwrite = agentId !== undefined;
  const target = agentId ? (index.agents.get(agentId) ?? null) : null;
  const current = characterOf(index, agentId);
  const targetName = agentId && target ? displayName(index, agentId) : '';
  const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const defaultModel = useMemo<PaModel>(() => {
    if (index.fantay) return { runtime: index.fantay.model.runtime, modelId: index.fantay.model.modelId };
    const first = data.models.find((option) => option.available);
    return first ? { runtime: first.runtime, modelId: first.modelId } : DRAFT_AGENT.model;
  }, [index.fantay, data.models]);
  const chosenModel = model ?? defaultModel;
  const pickerAgent = useMemo<PersonalAgent>(() => ({ ...(index.fantay ?? DRAFT_AGENT), model: chosenModel }), [index.fantay, chosenModel]);

  const read = async (picked: File) => {
    readToken.current += 1;
    const token = readToken.current;
    submit.clear();
    setError(null);
    setLoaded(null);
    setStep('reading');
    const settle = (next: PickError) => {
      if (token !== readToken.current) return;
      setError(next);
      setStep('pick');
    };
    if (!acceptable(picked)) return settle({ kind: 'unsupported' });
    try {
      const out = await readCardFile(picked, Date.now());
      if (token !== readToken.current) return;
      if (out.charxError) return settle({ kind: CHARX_ERROR[out.charxError] });
      const preview = out.preview;
      if (preview.ok) {
        if (looksLikeWorld(out.card) && importWorldInfo(out.card, { fileName: out.fileName }).ok) {
          return settle({ kind: 'world', world: out.card, fileName: out.fileName });
        }
        setLoaded({ preview, card: out.card, portrait: out.portrait, fileName: out.fileName, ...(out.charx ? { charx: out.charx } : {}) });
        setName(preview.name);
        setStep('preview');
        return;
      }
      if (preview.error === 'too-large') return settle({ kind: 'tooLarge' });
      if (preview.error === 'bad-json') return settle({ kind: 'badJson' });
      const json = archiveFile(picked) ? undefined : await jsonOf(picked);
      if (json !== undefined && importWorldInfo(json, { fileName: out.fileName }).ok) {
        return settle({ kind: 'world', world: json, fileName: out.fileName });
      }
      return settle({ kind: preview.error === 'unsupported-format' ? 'unsupported' : 'noCard' });
    } catch {
      return settle({ kind: 'unsupported' });
    }
  };

  const restart = () => {
    readToken.current += 1;
    submit.clear();
    setError(null);
    setLoaded(null);
    setModel(null);
    setOver(false);
    setStep('pick');
  };

  usePaModalReset(open, `${agentId ?? 'new'}:${file ? `${file.name}:${file.size}:${file.lastModified}` : ''}`, () => {
    restart();
    if (file) void read(file);
  });

  // The file handed over by a drop or the ＋ menu is read once, when the modal mounts with it.
  useEffect(() => {
    if (file) void read(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event) || step === 'reading') return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (!over) setOver(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOver(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped && step !== 'reading') void read(dropped);
  };

  const confirm = () => {
    if (!loaded || submit.busy) return;
    const finalName = name.trim();
    if (!overwrite && !finalName) return;
    const card = overwrite || finalName === loaded.preview.name ? loaded.card : withName(loaded.card, finalName);
    const holder: { result: ImportResult | null; failed: number } = { result: null, failed: 0 };
    // CHARX sprites are saved first, in order (re-encoded like any portrait upload); one that cannot be saved does not
    // stop the import and is counted for the toast after it.
    const saveSprites = async (): Promise<Partial<Record<PaEmotion, string>>> => {
      const sprites = loaded.charx?.sprites ?? [];
      if (sprites.length === 0) return {};
      const ids = savedSprites.current?.from === loaded ? savedSprites.current.ids : new Map<PaEmotion, string>();
      savedSprites.current = { from: loaded, ids };
      holder.failed = 0;
      try {
        for (const [position, sprite] of sprites.entries()) {
          setSaving({ n: position + 1, total: sprites.length });
          if (ids.has(sprite.emotion)) continue;
          try {
            const { id } = await data.actions.uploadAsset(await imageToAsset(sprite.blob));
            ids.set(sprite.emotion, id);
          } catch {
            holder.failed += 1;
          }
        }
      } finally {
        setSaving(null);
      }
      return Object.fromEntries(ids) as Partial<Record<PaEmotion, string>>;
    };
    void submit
      .run(async () => {
        const sprites = await saveSprites();
        holder.result = await data.actions.importCard({
          card,
          fileName: loaded.fileName,
          ...(loaded.portrait ? { portrait: loaded.portrait } : {}),
          ...(Object.keys(sprites).length > 0 ? { sprites } : {}),
          ...(agentId ? { agentId, ...(current ? { revision: current.revision } : {}) } : { model: chosenModel }),
        });
      })
      .then((ok) => {
        const result = holder.result;
        if (!ok || !result) return;
        onClose();
        nav.openConversation(result.conversation.id);
        const review = result.report.needsReview.length > 0;
        toast({
          tone: 'success',
          title: t('pa.soul.library.import.done', { name: result.agent.name }),
          ...(review
            ? {
                action: {
                  label: t('pa.soul.library.import.doneView'),
                  onClick: () => nav.openModal({ kind: 'agent', agentId: result.agent.id, section: 'advanced' }),
                },
              }
            : {}),
        });
        if (holder.failed > 0) toast({ title: t('pa.soul.library.charx.spriteFailed', { n: holder.failed }) });
      });
  };

  const importAsWorld = (pending: Extract<PickError, { kind: 'world' }>) => {
    if (worldBusy) return;
    setWorldBusy(true);
    void importWorld(pending.world, pending.fileName).finally(() => setWorldBusy(false));
  };

  const preview = loaded?.preview ?? null;
  const ready = useMemo(() => (preview ? readyRows(preview, t) : []), [preview, t]);
  const tokens = useMemo(() => (preview ? readyTokens(preview) : 0), [preview]);
  const review = preview ? [...preview.meta.needsReview, ...(preview.lorebookMeta?.needsReview ?? [])] : [];
  const charx = loaded?.charx ?? null;
  const spriteCount = charx?.sprites.length ?? 0;
  const replaced = useMemo(
    () => (preview && overwrite ? replacedFields(current, preview, t, spriteCount) : []),
    [preview, overwrite, current, t, spriteCount],
  );
  // 头像 only when the archive's icon really became the portrait (a failed re-encode leaves the card's own, or none).
  const archivePortrait = Boolean(charx?.portrait && loaded?.portrait && loaded.portrait !== loaded.preview.portrait);
  const joiner = /^(?:zh|ja)/.test(locale) ? '、' : ', ';
  const spriteNames = charx ? charx.sprites.map((sprite) => t(`pa.soul.emotion.${sprite.emotion}`)).join(joiner) : '';
  const files = useMemo(() => (charx ? charxFiles(charx.report) : { count: 0, rows: [], rest: 0 }), [charx]);
  const readyCount = ready.length + (archivePortrait ? 1 : 0) + (spriteCount > 0 ? 1 : 0);
  const reviewCount = review.length + (files.count > 0 ? 1 : 0);
  const appearance = useMemo(() => resolveAppearance(preview?.character.appearance), [preview]);
  const portraitSrc = loaded?.portrait
    ? `data:${loaded.portrait.mime};base64,${loaded.portrait.data}`
    : overwrite
      ? paSoulAssetUrl(current?.portraitAssetId)
      : null;

  const title = overwrite ? t('pa.soul.library.import.replaceTitle', { name: targetName }) : t('pa.soul.library.import.title');

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="xl"
      title={title}
      lede={t('pa.soul.library.import.lede')}
      conflict={step === 'preview' && submit.conflict}
      error={step === 'preview' ? submit.error : null}
      onSubmit={step === 'preview' ? confirm : undefined}
      bodyClassName={styles.body}
      testId="pa-card-import"
      footer={
        <>
          {step === 'preview' ? (
            <Button variant="ghost" onClick={restart} disabled={submit.busy} data-testid="pa-card-import-reselect">
              {t('pa.soul.library.import.reselect')}
            </Button>
          ) : null}
          <ModalSpacer />
          <Button variant="ghost" onClick={onClose}>
            {t('pa.cancel')}
          </Button>
          {step === 'preview' ? (
            <Button
              type="submit"
              variant="primary"
              disabled={!overwrite && !name.trim()}
              loading={submit.busy && !saving}
              aria-busy={saving ? true : undefined}
              data-saving={saving ? '' : undefined}
              data-testid="pa-card-import-submit"
            >
              {saving ? (
                <>
                  <Spinner size="sm" />
                  {t('pa.soul.library.charx.uploading', { n: saving.n, total: saving.total })}
                </>
              ) : overwrite ? (
                t('pa.soul.library.import.replaceSubmit')
              ) : (
                t('pa.soul.library.import.submit')
              )}
            </Button>
          ) : null}
        </>
      }
    >
      {step !== 'preview' || !preview ? (
        <div className={styles.pick} onDragEnter={onDragOver} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
          {error ? (
            <Callout
              tone={error.kind === 'world' ? 'neutral' : 'error'}
              role={error.kind === 'world' ? 'status' : 'alert'}
              className={styles.callout}
              data-testid="pa-card-import-error"
              data-error={error.kind}
            >
              <span>{error.kind === 'world' ? t('pa.soul.library.import.error.world') : t(ERROR_KEY[error.kind])}</span>
              {error.kind === 'world' ? (
                <Button size="sm" variant="secondary" loading={worldBusy} onClick={() => importAsWorld(error)} data-testid="pa-card-import-as-world">
                  {t('pa.soul.library.import.asWorld')}
                </Button>
              ) : null}
            </Callout>
          ) : null}
          {step === 'reading' ? (
            <div className={cn(styles.zone, styles.reading)} role="status" data-testid="pa-card-import-reading">
              <Spinner size="md" />
              <span className={styles.readingText}>{t('pa.soul.library.import.reading')}</span>
            </div>
          ) : (
            <EmptyState
              variant="dashed"
              className={styles.zone}
              data-over={over ? '' : undefined}
              data-testid="pa-card-import-drop"
              title={t('pa.soul.library.import.dropTitle')}
              description={t('pa.soul.library.import.dropBody')}
              action={
                <Button variant="secondary" onClick={() => inputRef.current?.click()} data-testid="pa-card-import-choose">
                  {t('pa.soul.library.import.choose')}
                </Button>
              }
            />
          )}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className={styles.fileInput}
            tabIndex={-1}
            aria-hidden
            data-testid="pa-card-import-file"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = '';
              if (picked) void read(picked);
            }}
          />
        </div>
      ) : (
        <>
          <div className={styles.identity}>
            <SoulPortrait
              src={portraitSrc}
              name={overwrite ? targetName : name || preview.name}
              size={64}
              frame={soulFrameOf(appearance)}
              theme={appearance.theme}
            />
            <div className={styles.identityText}>
              {overwrite ? (
                <div className={styles.targetName}>{targetName}</div>
              ) : (
                <Input
                  variant="title"
                  inputSize="lg"
                  className={styles.nameInput}
                  value={name}
                  maxLength={SOUL_LIMITS.name}
                  required
                  autoComplete="off"
                  aria-label={t('pa.soul.library.import.name')}
                  aria-invalid={name.trim() ? undefined : true}
                  data-testid="pa-card-import-name"
                  onChange={(event) => setName(event.target.value)}
                />
              )}
              <div className={styles.identityMeta}>
                <SoulTag tone="outline">{t('pa.soul.library.import.format', { n: preview.format.slice(3) })}</SoulTag>
                <span className={styles.tokens}>{t('pa.soul.library.import.tokens', { n: numbers.format(tokens) })}</span>
              </div>
            </div>
          </div>

          <div className={styles.columns}>
            <ImportColumn
              title={t('pa.soul.library.import.col.ready')}
              count={readyCount}
              empty={t('pa.soul.library.import.none')}
              testId="pa-card-import-ready"
            >
              {ready.map((row) => (
                <li key={row.key} className={styles.item}>
                  <span className={styles.itemLabel}>{row.label}</span>
                  {row.size !== null ? <span className={styles.size}>{t('pa.soul.library.import.size', { n: numbers.format(row.size) })}</span> : null}
                </li>
              ))}
              {archivePortrait ? (
                <li className={styles.item} data-testid="pa-card-import-charx-portrait">
                  <span className={styles.itemLabel}>{t('pa.soul.library.charx.portrait')}</span>
                </li>
              ) : null}
              {spriteCount > 0 ? (
                <li className={cn(styles.item, styles.stacked)} data-testid="pa-card-import-charx-sprites">
                  <span className={styles.itemLabel}>{t('pa.soul.library.charx.sprites', { n: spriteCount })}</span>
                  <span className={styles.detail}>{spriteNames}</span>
                </li>
              ) : null}
            </ImportColumn>
            <ImportColumn
              title={t('pa.soul.library.import.col.preserved')}
              count={preview.preservedKeys.length}
              empty={t('pa.soul.library.import.none')}
              testId="pa-card-import-preserved"
            >
              {preview.preservedKeys.map((key) => (
                <li key={key} className={cn(styles.item, styles.key)}>
                  {key}
                </li>
              ))}
            </ImportColumn>
            <ImportColumn
              title={t('pa.soul.library.import.col.review')}
              count={reviewCount}
              empty={t('pa.soul.library.import.none')}
              testId="pa-card-import-review"
            >
              {review.map((item, position) => (
                <li key={`${item.key}:${position}`} className={cn(styles.item, styles.review)}>
                  <span className={styles.reviewHead}>
                    <SoulTag>{t(`pa.soul.library.import.kind.${item.kind}`)}</SoulTag>
                    <span className={styles.reviewAction}>{t(`pa.soul.library.import.action.${item.action}`)}</span>
                  </span>
                  <span className={styles.reviewSummary}>{item.summary}</span>
                </li>
              ))}
              {files.count > 0 ? (
                <li className={cn(styles.item, styles.stacked)} data-testid="pa-card-import-charx-files">
                  <span className={styles.itemLabel}>{t('pa.soul.library.charx.files', { n: files.count })}</span>
                  <ul className={styles.files}>
                    {files.rows.map((row, position) => (
                      <li key={`${row.path}:${position}`} className={styles.file}>
                        <span className={styles.filePath}>{row.path}</span>
                        {row.reason ? (
                          <>
                            {' '}
                            <span className={styles.fileReason}>· {t(`pa.soul.library.charx.reason.${row.reason}`)}</span>
                          </>
                        ) : null}
                      </li>
                    ))}
                    {files.rest > 0 ? (
                      <li className={styles.file}>
                        <span className={styles.filePath}>{numbers.format(files.rest)}</span>{' '}
                        <span className={styles.fileReason}>· {t('pa.soul.library.charx.reason.limit')}</span>
                      </li>
                    ) : null}
                  </ul>
                </li>
              ) : null}
            </ImportColumn>
          </div>
          <p className={styles.note}>{t('pa.soul.library.import.note')}</p>

          <div className={modalStyles.group}>
            {overwrite ? (
              <div className={modalStyles.row} data-testid="pa-card-import-replaced">
                <div className={modalStyles.rowText}>
                  <span className={modalStyles.rowLabel}>{t('pa.soul.library.import.replaceFields')}</span>
                  <div className={styles.replaced}>{replaced.length > 0 ? replaced.join(' · ') : t('pa.soul.library.import.none')}</div>
                  <div className={modalStyles.rowHint}>{t('pa.soul.library.import.replaceLede', { name: targetName })}</div>
                </div>
              </div>
            ) : (
              <div className={modalStyles.row}>
                <div className={modalStyles.rowText}>
                  <label htmlFor={modelId} className={modalStyles.rowLabel}>
                    {t('pa.soul.library.import.model')}
                  </label>
                </div>
                <div className={cn(modalStyles.rowControl, styles.modelControl)}>
                  <PaModelPicker id={modelId} agent={pickerAgent} variant="profile" onModelChange={(next) => setModel({ runtime: next.runtime, modelId: next.modelId })} />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </PaModalFrame>
  );
}
