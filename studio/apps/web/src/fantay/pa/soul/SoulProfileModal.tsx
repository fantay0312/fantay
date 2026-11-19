// SPDX-License-Identifier: AGPL-3.0-only
// The one profile editor for every agent (modal kind `agent`, Soul UI spec 7.1): a 2xl frame of fixed height, a list
// of sections beside one scrolling form, one 保存 for everything. It saves the agent record (name, 职责, model, the
// project and enabled switches) and then only the changed keys of the character definition. Fantay shows only its
// name, its model and 工作. Built on the frame, the submit hook and the model control of PaAgentModal.
//
// The top of this file also holds the small form helpers the persona, style and chat-settings modals share: the
// field with its hint, token estimate and length counter; the 放弃修改？ guard; and the portrait upload.
import { Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  SOUL_LIMITS,
  embedCard,
  estimateTokens,
  paCharacterInputSchema,
  resolveAppearance,
  toCharacterInput,
} from '@open-design/contracts/soul';
import type { PaCharacterDoc } from '@open-design/contracts/soul';

import { useI18n, useT } from '../../../i18n';
import {
  Button,
  CheckboxField,
  ChevronDownIcon,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Input,
  Label,
  ModalSpacer,
  PlusIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  VisuallyHidden,
  cn,
  toast,
} from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import { usePa } from '../pa-context';
import { isFantay } from '../pa-model';
import {
  PaModalFrame,
  PaSwitchRow,
  TEMPLATES,
  agentForm,
  defaultModel,
  modelKeyOf,
  paErrorText,
  usePaModalReset,
  usePaReload,
  usePaSubmit,
  type AgentForm,
} from '../PaAgentModal';
import { PaAvatar } from '../PaAvatar';
import { PaModelPicker } from '../PaModelPicker';
import { formatDay } from '../PaTaskModal';
import type { PaAgentInput, PaCharacterView, PaProfileSection, PersonalAgent } from '../pa-types';
import modalStyles from '../PaModals.module.css';
import { CropDialog } from '../../media-tools/components/CropDialog';
import { SOUL_MAX_UPLOAD_BYTES, charxArchive, cropImageBlob, downloadBytes, downloadJson, imageToAsset, portraitPngBytes } from './soul-files';
import { soulFrameOf } from './soul-theme';
import { SoulAppearancePicker } from './SoulAppearancePicker';
import { SoulDeckEditor, deckIssues, deckOverLimit } from './SoulDeckEditor';
import { SoulPortrait, SoulPortraitCover } from './SoulPortrait';
import { SoulStepper, SoulTag, SoulTagInput } from './SoulPrimitives';
import { SoulSpritesEditor } from './SoulSpritesEditor';
import { SoulStateFieldsEditor, hasStateIssues, stateFieldIssues } from './SoulStateFieldsEditor';
import { SoulVoiceField, voiceOverLimit } from './SoulVoiceField';
import styles from './SoulProfileModal.module.css';

const L = SOUL_LIMITS;

/* ── shared form helpers ──────────────────────────────────────────────────────────────────── */

export interface SoulFieldProps {
  id?: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** The text the counter measures (and the token estimate reads). */
  text?: string;
  /** The SOUL_LIMITS bound: the counter appears past 80% of it and turns red over it. */
  max?: number;
  /** Show 「约 {n} tokens」 for the text. */
  tokens?: boolean;
  className?: string;
  children: ReactNode;
}

/** A label, the control, then one foot line: the hint at the start, the token estimate and the counter at the end. */
export function SoulField({ id, label, hint, error, text = '', max, tokens = false, className, children }: SoulFieldProps) {
  const t = useT();
  const length = text.length;
  const counter = max !== undefined && length > max * 0.8 ? max : null;
  const estimate = tokens ? estimateTokens(text) : 0;
  const over = max !== undefined && length > max;
  return (
    <div className={cn('min-w-0', className)} data-invalid={error || over ? '' : undefined}>
      {label ? (
        <Label variant="form" htmlFor={id}>
          {label}
        </Label>
      ) : null}
      {children}
      {hint || counter !== null || estimate > 0 ? (
        <div className={modalStyles.fieldFoot}>
          {hint ? <p className={modalStyles.fieldHint}>{hint}</p> : null}
          {counter !== null || estimate > 0 ? (
            <span className={modalStyles.fieldMeta}>
              {estimate > 0 ? <span>{t('pa.soul.editor.tokens', { n: estimate.toLocaleString() })}</span> : null}
              {counter !== null ? (
                <span data-over={over ? '' : undefined}>
                  {t('pa.soul.editor.counter', { n: length.toLocaleString(), max: counter.toLocaleString() })}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className={modalStyles.fieldError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Runs `reset` once when the workspace data first arrives after the modal mounted (a deep link or a restored modal
 *  opens before the first snapshot), so the form starts from the real record instead of an empty one. */
export function useSoulArrival(ready: boolean, reset: () => void) {
  const seen = useRef(ready);
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (!ready || seen.current) return;
    seen.current = true;
    resetRef.current();
  }, [ready]);
}

/** Asks 放弃修改？ before a dirty form closes (or before `then` runs). */
export function useSoulDiscard(dirty: boolean, close: () => void) {
  const [asking, setAsking] = useState(false);
  const next = useRef(close);
  const guard = (then: () => void = close) => {
    if (!dirty) {
      then();
      return;
    }
    next.current = then;
    setAsking(true);
  };
  const dialog = {
    open: asking,
    onOpenChange: setAsking,
    onConfirm: () => {
      setAsking(false);
      next.current();
    },
  };
  return { guard, dialog };
}

export function SoulDiscardDialog({
  unit,
  open,
  onOpenChange,
  onConfirm,
}: {
  unit: 'editor' | 'manage';
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const t = useT();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(`pa.soul.${unit}.confirm.discardTitle`)}
      description={t(`pa.soul.${unit}.confirm.discardBody`)}
      confirmLabel={t(`pa.soul.${unit}.confirm.discard`)}
      cancelLabel={t('pa.cancel')}
      destructive
      onConfirm={onConfirm}
    />
  );
}

/** A hidden file input for a portrait or avatar: size check, canvas re-encode (`imageToAsset`), upload. While the
 *  upload runs, `preview` holds a local URL of the picked file so the well shows it at once. With `crop` (stage 2:
 *  portraits and persona avatars), the picked image first opens the media tools' crop dialog locked to 1:1 (render
 *  `dialog`); 使用这张 crops, re-encodes and uploads, 取消 uploads nothing. */
export function useSoulImageUpload(onUploaded: (assetId: string) => void, options?: { crop?: boolean }) {
  const t = useT();
  const { data } = usePa();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cropping, setCropping] = useState<{ file: File; url: string } | null>(null);
  const croppingRef = useRef(cropping);
  croppingRef.current = cropping;
  const finishing = useRef(false);
  const done = useRef(onUploaded);
  done.current = onUploaded;
  const crop = options?.crop === true;

  useEffect(
    () => () => {
      if (croppingRef.current) URL.revokeObjectURL(croppingRef.current.url);
    },
    [],
  );

  /** Re-encode and upload one image (the picked file, or its crop). */
  const send = async (image: Blob) => {
    const local = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(image) : null;
    setPreview(local);
    setBusy(true);
    try {
      let asset: { mime: string; data: string };
      try {
        asset = await imageToAsset(image);
      } catch (caught) {
        setError(caught instanceof Error && caught.message === 'image-too-large' ? t('pa.soul.editor.basic.tooLarge') : t('pa.error'));
        return;
      }
      const { id } = await data.actions.uploadAsset(asset);
      done.current(id);
    } catch (caught) {
      setError(paErrorText(caught, t));
    } finally {
      setBusy(false);
      setPreview(null);
      if (local) URL.revokeObjectURL(local);
    }
  };

  const take = async (file: File) => {
    setError(null);
    if (file.size > SOUL_MAX_UPLOAD_BYTES) {
      setError(t('pa.soul.editor.basic.tooLarge'));
      return;
    }
    if (crop && typeof URL.createObjectURL === 'function') {
      setCropping({ file, url: URL.createObjectURL(file) });
      return;
    }
    await send(file);
  };

  const endCrop = () => {
    const current = croppingRef.current;
    if (current) URL.revokeObjectURL(current.url);
    croppingRef.current = null;
    setCropping(null);
  };

  const cancel = () => {
    if (!finishing.current) endCrop();
  };

  const finish = async (rect: { x: number; y: number; width: number; height: number }) => {
    const current = croppingRef.current;
    if (!current || finishing.current) return;
    finishing.current = true;
    try {
      let image: Blob;
      try {
        image = await cropImageBlob(current.file, rect);
      } catch {
        setError(t('pa.error'));
        return;
      }
      await send(image);
    } finally {
      finishing.current = false;
      endCrop();
    }
  };

  const dialog = cropping ? (
    <CropDialog
      open
      imageUrl={cropping.url}
      lockPreset="1:1"
      title={t('pa.soul.editor.crop.title')}
      confirmLabel={t('pa.soul.editor.crop.confirm')}
      onClose={cancel}
      onConfirm={(rect) => finish(rect)}
    />
  ) : null;

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      tabIndex={-1}
      aria-hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void take(file);
      }}
    />
  );
  return { input, choose: () => inputRef.current?.click(), busy, error, preview, dialog };
}

/** Key-order independent equality for the plain JSON values of a form. */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The sentinel of a Select row that stands for `null` (Radix items cannot carry an empty value). */
export const SOUL_NONE = '__none__';

/* ── the profile editor ───────────────────────────────────────────────────────────────────── */

export interface SoulProfileModalProps {
  open: boolean;
  onClose(): void;
  agentId: string | null;
  section?: PaProfileSection;
  template?: string;
}

type Section = PaProfileSection;
const SECTIONS: readonly Section[] = ['basic', 'persona', 'greeting', 'examples', 'lore', 'style', 'look', 'sprites', 'play', 'work', 'advanced'];
const FANTAY_SECTIONS: readonly Section[] = ['basic', 'style', 'work'];
const TEMPLATE_INDEX: Readonly<Record<string, number>> = { researcher: 0, designer: 1, writer: 2, reviewer: 3 };
const ROLE_MAX = 4000;
const DEFAULT_DOC: PaCharacterDoc = paCharacterInputSchema.parse({});
const DRAFT_ENTITY = { id: 'pa-draft-agent', createdAt: 0, updatedAt: 0, revision: 1 };
const NOTE_ROLES = ['system', 'user', 'assistant'] as const;
const REVIEW_KIND = {
  script: 'pa.soul.editor.advanced.kind.script',
  regex: 'pa.soul.editor.advanced.kind.regex',
  html: 'pa.soul.editor.advanced.kind.html',
  remote: 'pa.soul.editor.advanced.kind.remote',
  other: 'pa.soul.editor.advanced.kind.other',
} as const;
const REVIEW_ACTION = {
  quarantined: 'pa.soul.editor.advanced.action.quarantined',
  kept: 'pa.soul.editor.advanced.action.kept',
  disabled: 'pa.soul.editor.advanced.action.disabled',
  truncated: 'pa.soul.editor.advanced.action.truncated',
} as const;

interface NoteDraft {
  text: string;
  depth: number;
  role: (typeof NOTE_ROLES)[number];
}

interface Draft {
  agent: AgentForm;
  doc: PaCharacterDoc;
  /** 角色便签 is edited as text + depth + role; an empty text saves `null`. */
  note: NoteDraft;
}

function draftOf(
  agent: PersonalAgent | null,
  character: PaCharacterView | null,
  models: Parameters<typeof agentForm>[1],
  template: string | undefined,
  t: ReturnType<typeof useT>,
): Draft {
  const form = agentForm(agent, models);
  const preset = !agent && template !== undefined ? TEMPLATES[TEMPLATE_INDEX[template] ?? -1] : undefined;
  const doc = character ? toCharacterInput(character) : DEFAULT_DOC;
  const note = doc.characterNote;
  return {
    agent: preset ? { ...form, name: t(preset.name), role: t(preset.role) } : form,
    doc,
    note: note ? { text: note.text, depth: note.depth, role: note.role } : { text: '', depth: 4, role: 'system' },
  };
}

/** The document a draft saves: empty alternates dropped, the note folded back. */
function finalDoc(draft: Draft): PaCharacterDoc {
  return {
    ...draft.doc,
    alternateGreetings: draft.doc.alternateGreetings.filter((text) => text.trim() !== ''),
    characterNote: draft.note.text.trim() ? { text: draft.note.text, depth: draft.note.depth, role: draft.note.role } : null,
  };
}

/** Only the keys that changed (for a new character: those that differ from the schema defaults). */
export function characterPatch(base: PaCharacterDoc, next: PaCharacterDoc): Partial<PaCharacterDoc> {
  const patch: Partial<Record<keyof PaCharacterDoc, unknown>> = {};
  for (const key of Object.keys(next) as Array<keyof PaCharacterDoc>) if (!sameJson(next[key], base[key])) patch[key] = next[key];
  return patch as Partial<PaCharacterDoc>;
}

function agentInput(form: AgentForm, held: PersonalAgent | null, role: string): PaAgentInput {
  return {
    name: form.name.trim(),
    role,
    avatar: held?.avatar ?? '',
    model: { runtime: form.model.runtime, modelId: form.model.modelId },
    enabled: form.enabled,
    tools: form.project ? ['respond', 'create_project'] : ['respond'],
  };
}

function agentDiffers(input: PaAgentInput, held: PersonalAgent): boolean {
  return (
    input.name !== held.name ||
    input.role !== held.role ||
    modelKeyOf(input.model) !== modelKeyOf(held.model) ||
    input.enabled !== held.enabled ||
    input.tools.includes('create_project') !== held.tools.includes('create_project')
  );
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

function fileBase(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'character';
}

export function SoulProfileModal({ open, onClose, agentId, section, template }: SoulProfileModalProps) {
  const t = useT();
  const { locale } = useI18n();
  const { data, index, nav, now } = usePa();
  const agentEntity = agentId ? (index.agents.get(agentId) ?? null) : null;
  const characterEntity = agentId ? (index.characters.get(agentId) ?? null) : null;
  const fantay = agentId ? isFantay(index, agentId) : false;
  const sections = fantay ? FANTAY_SECTIONS : SECTIONS;
  const firstSection = (): Section => {
    const wanted = section ?? (template !== undefined && agentId === null ? 'work' : 'basic');
    return sections.includes(wanted) ? wanted : 'basic';
  };

  const initial = useRef<Draft | null>(null);
  if (!initial.current) initial.current = draftOf(agentEntity, characterEntity, data.models, template, t);
  const [base, setBase] = useState({ agent: agentEntity, character: characterEntity });
  const [pristine, setPristine] = useState<Draft>(initial.current);
  const [draft, setDraft] = useState<Draft>(initial.current);
  const [active, setActive] = useState<Section>(firstSection);
  const [nameTouched, setNameTouched] = useState(false);
  const [altSelected, setAltSelected] = useState(0);
  const [loreSelected, setLoreSelected] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmCard, setConfirmCard] = useState(false);
  const [forgetMemories, setForgetMemories] = useState(true);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  const modelChosen = useRef(false);
  const created = useRef<PersonalAgent | null>(null);
  const savedId = useRef<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const submit = usePaSubmit();
  // A revision conflict keeps the user's values (spec 7): only the record the next save is checked against moves on.
  const reload = usePaReload(agentEntity, (latest) => setBase((current) => ({ ...current, agent: latest })));

  const resetForm = () => {
    const next = draftOf(agentEntity, characterEntity, data.models, template, t);
    setBase({ agent: agentEntity, character: characterEntity });
    setPristine(next);
    setDraft(next);
    setActive(firstSection());
    setNameTouched(false);
    setAltSelected(0);
    setLoreSelected(null);
    setConfirmDisable(false);
    setConfirmCard(false);
    modelChosen.current = false;
    created.current = null;
    submit.clear();
    reload.cancel();
  };
  usePaModalReset(open, `${agentId ?? 'new'}:${template ?? ''}`, resetForm);
  useSoulArrival(data.snapshot !== null && data.soul !== null, resetForm);

  useEffect(() => {
    if (open) void data.actions.refreshModels();
  }, [open, data.actions]);

  // A new agent takes the preferred model once the catalog arrives, until the user picks one.
  useEffect(() => {
    if (!open || agentId !== null || modelChosen.current) return;
    const preferred = defaultModel(data.models);
    const apply = (current: Draft): Draft =>
      modelKeyOf(current.agent.model) === modelKeyOf(preferred) ? current : { ...current, agent: { ...current.agent, model: preferred } };
    setDraft(apply);
    setPristine(apply);
  }, [open, agentId, data.models]);

  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [active]);

  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const patchAgent = (next: Partial<AgentForm>) => setDraft((current) => ({ ...current, agent: { ...current.agent, ...next } }));
  const patchDoc = (next: Partial<PaCharacterDoc>) => setDraft((current) => ({ ...current, doc: { ...current.doc, ...next } }));
  const patchNote = (next: Partial<NoteDraft>) => setDraft((current) => ({ ...current, note: { ...current.note, ...next } }));
  const upload = useSoulImageUpload((assetId) => patchDoc({ portraitAssetId: assetId }), { crop: true });

  /* ── derived state ── */

  const doc = useMemo(() => finalDoc(draft), [draft]);
  const baseDoc = useMemo(() => finalDoc(pristine), [pristine]);
  const patch = useMemo(() => (fantay ? {} : characterPatch(baseDoc, doc)), [fantay, baseDoc, doc]);
  const charChanged = Object.keys(patch).length > 0;
  const willHaveCharacter = !fantay && (Boolean(base.character) || charChanged);
  const name = draft.agent.name.trim();
  const displayName = draft.doc.nickname.trim() || name || base.agent?.name || '';
  const derivedRole = t('pa.soul.editor.work.roleDerived', { name, tagline: doc.tagline.trim() }).trim();
  const roleToSend = draft.agent.role.trim() || (willHaveCharacter ? derivedRole : '');
  const stateIssues = useMemo(() => stateFieldIssues(draft.doc.stateSchema), [draft.doc.stateSchema]);
  const decksBad = useMemo(() => {
    const decks = draft.doc.decks ?? [];
    return deckIssues(decks).length > 0 || deckOverLimit(decks);
  }, [draft.doc.decks]);
  const alternatesTotal = draft.doc.alternateGreetings.reduce((sum, text) => sum + text.length, 0);
  const agentDirty =
    draft.agent.name !== pristine.agent.name ||
    draft.agent.role !== pristine.agent.role ||
    draft.agent.enabled !== pristine.agent.enabled ||
    draft.agent.project !== pristine.agent.project ||
    modelKeyOf(draft.agent.model) !== modelKeyOf(pristine.agent.model);
  const dirty = agentDirty || charChanged;

  const nameMissing = name === '' && (agentId !== null || nameTouched);
  const roleMissing = roleToSend === '' && (agentId !== null || name !== '');
  const invalid = useMemo(() => {
    const bad = new Set<Section>();
    if (nameMissing || draft.agent.name.length > L.name || doc.nickname.length > L.nickname || doc.tagline.length > L.tagline) bad.add('basic');
    if (doc.description.length > L.description || doc.personality.length > L.personality || doc.scenario.length > L.scenario) bad.add('persona');
    if (
      doc.firstMessage.length > L.firstMessage ||
      draft.doc.alternateGreetings.length > L.alternateGreetings ||
      draft.doc.alternateGreetings.some((text) => text.length > L.firstMessage) ||
      alternatesTotal > L.alternateGreetingsTotal
    )
      bad.add('greeting');
    if (doc.exampleDialogue.length > L.exampleDialogue) bad.add('examples');
    if (doc.lorebookIds.length > L.lorebookIds) bad.add('lore');
    if (hasStateIssues(stateIssues)) bad.add('play');
    if (decksBad) bad.add('play');
    if (!fantay && voiceOverLimit(draft.doc.voice)) bad.add('style');
    if (roleMissing || draft.agent.role.length > ROLE_MAX) bad.add('work');
    if (
      doc.systemPrompt.length > L.systemPrompt ||
      doc.postHistoryInstructions.length > L.postHistoryInstructions ||
      draft.note.text.length > L.characterNote ||
      doc.creatorNotes.length > L.creatorNotes ||
      doc.creator.length > L.creator ||
      doc.characterVersion.length > L.characterVersion
    )
      bad.add('advanced');
    return bad;
  }, [nameMissing, roleMissing, draft, doc, stateIssues, decksBad, fantay, alternatesTotal]);
  const blocked = invalid.size > 0 || name === '' || roleToSend === '';
  /** Why 保存 is held: the sections that need a fix, as the nav dots mark them (a new deck starts with blank cards). */
  const heldBy = sections.filter(
    (item) => invalid.has(item) || (item === 'basic' && name === '') || (item === 'work' && roleToSend === ''),
  );
  const saveHeld =
    blocked && heldBy.length > 0
      ? [...heldBy.map((item) => t(`pa.soul.editor.nav.${item}`)), t('pa.soul.editor.nav.error')].join(' · ')
      : undefined;

  const appearance = resolveAppearance(draft.doc.appearance);
  const portraitSrc = upload.preview ?? paSoulAssetUrl(draft.doc.portraitAssetId);
  const previewAgent: PersonalAgent = {
    ...(base.agent ?? DRAFT_ENTITY),
    name: name || base.agent?.name || '',
    role: draft.agent.role,
    avatar: base.agent?.avatar ?? '',
    model: draft.agent.model,
    enabled: draft.agent.enabled,
    tools: draft.agent.project ? ['respond', 'create_project'] : ['respond'],
  };
  const hasFace = fantay || name !== '' || Boolean(portraitSrc);
  const savedCharacter = !fantay && agentId !== null && base.character !== null;
  const quarantined = Boolean(base.character?.needsReview.some((item) => item.action === 'quarantined'));
  const memoryCount = useMemo(
    () => (agentId ? [...index.memories.values()].filter((memory) => memory.scope === 'agent' && memory.scopeId === agentId).length : 0),
    [index, agentId],
  );

  /* ── actions ── */

  const close = useSoulDiscard(dirty, onClose);

  /** Saves the agent (when it changed or is new), then the changed character keys. `after` replaces the default
   *  ending (close; a new agent's chat opens). */
  const save = (after?: (savedAgentId: string) => void) => {
    if (blocked || submit.busy) return;
    const held = base.agent ?? created.current;
    const input = agentInput(draft.agent, held, roleToSend);
    const sendAgent = !held || agentDiffers(input, held);
    const sendPatch = charChanged ? patch : null;
    if (!sendAgent && !sendPatch && held) {
      if (after) after(held.id);
      else onClose();
      return;
    }
    savedId.current = held?.id ?? null;
    void submit
      .run(
        async () => {
          if (sendAgent) {
            const saved = await data.actions.saveAgent(input, held ?? undefined);
            if (!held) created.current = saved;
            savedId.current = saved.id;
          }
          if (sendPatch && savedId.current) await data.actions.saveCharacter(savedId.current, sendPatch);
        },
        () => {
          if (base.agent) reload.expect(base.agent.revision);
        },
      )
      .then((ok) => {
        const saved = savedId.current;
        if (!ok || !saved) return;
        toast({ tone: 'success', title: t('pa.soul.editor.saved') });
        if (after) {
          after(saved);
          return;
        }
        onClose();
        if (agentId === null) void nav.openAgent(saved);
      });
  };

  const openLorebook = (lorebookId: string | null) => {
    const go = (owner: string) =>
      nav.openModal(lorebookId ? { kind: 'lorebook', lorebookId } : { kind: 'lorebook', lorebookId: null, bindAgentId: owner });
    if (dirty || agentId === null) save(go);
    else go(agentId);
  };

  const exportAs = async (kind: 'json' | 'png' | 'charx' | 'jsonAll') => {
    if (!agentId || !base.character) return;
    try {
      const card = await data.actions.exportCard(agentId, kind === 'jsonAll');
      const fileName = fileBase(base.agent?.name ?? displayName);
      if (kind === 'charx') {
        // The saved pictures: like the card itself, an export never carries unsaved edits.
        downloadBytes(`${fileName}.charx`, await charxArchive(card, base.character), 'application/zip');
      } else if (kind === 'png') {
        const art = await portraitPngBytes(paSoulAssetUrl(base.character.portraitAssetId));
        downloadBytes(`${fileName}.png`, embedCard(art, card), 'image/png');
      } else {
        downloadJson(`${fileName}.json`, card);
      }
      toast({ tone: 'success', title: t('pa.soul.editor.export.done') });
    } catch (caught) {
      toast({ tone: 'danger', title: paErrorText(caught, t) });
    }
  };

  const removeCard = async () => {
    if (!agentId || removingRef.current) return;
    removingRef.current = true;
    setRemoving(true);
    try {
      await data.actions.removeCharacter(agentId, forgetMemories && memoryCount > 0);
      setConfirmCard(false);
      onClose();
    } catch (caught) {
      setConfirmCard(false);
      submit.setError(paErrorText(caught, t));
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  };

  /* ── sections ── */

  const textField = (
    key: 'description' | 'personality' | 'scenario' | 'firstMessage' | 'exampleDialogue' | 'systemPrompt' | 'postHistoryInstructions' | 'creatorNotes',
    label: string,
    max: number,
    rows: number,
    options: { hint?: string; tokens?: boolean; code?: boolean } = {},
  ) => (
    <SoulField id={id(key)} label={label} hint={options.hint} text={draft.doc[key]} max={max} tokens={options.tokens}>
      <Textarea
        id={id(key)}
        rows={rows}
        variant={options.code ? 'code' : 'default'}
        value={draft.doc[key]}
        aria-invalid={draft.doc[key].length > max || undefined}
        spellCheck={options.code ? false : undefined}
        onChange={(event) => {
          const next: Partial<PaCharacterDoc> = {};
          next[key] = event.target.value;
          patchDoc(next);
        }}
      />
    </SoulField>
  );

  const renderBasic = () => (
    <div className={fantay ? undefined : styles.basic}>
      {fantay ? null : (
        <div className={styles.portraitCol}>
          <Label variant="form">{t('pa.soul.editor.basic.portrait')}</Label>
          <div className={styles.well} data-busy={upload.busy ? '' : undefined}>
            <SoulPortraitCover src={portraitSrc} name={displayName} theme={appearance.theme} />
          </div>
          <Button variant="secondary" size="sm" block loading={upload.busy} onClick={upload.choose}>
            {t('pa.soul.editor.basic.change')}
          </Button>
          {draft.doc.portraitAssetId ? (
            <Button variant="bare" size="sm" block onClick={() => patchDoc({ portraitAssetId: null })}>
              {t('pa.soul.editor.basic.remove')}
            </Button>
          ) : null}
          {upload.error ? (
            <p role="alert" className={styles.portraitError}>
              {upload.error}
            </p>
          ) : null}
          {upload.input}
          {upload.dialog}
        </div>
      )}
      <div className={styles.fields}>
        <SoulField id={id('name')} label={t('pa.soul.editor.basic.name')} text={draft.agent.name} max={L.name}>
          <Input
            id={id('name')}
            value={draft.agent.name}
            required
            autoFocus={agentId === null}
            autoComplete="off"
            aria-invalid={nameMissing || draft.agent.name.length > L.name || undefined}
            onChange={(event) => {
              setNameTouched(true);
              patchAgent({ name: event.target.value });
            }}
          />
        </SoulField>
        {fantay ? null : (
          <>
            <SoulField
              id={id('nickname')}
              label={t('pa.soul.editor.basic.nickname')}
              hint={t('pa.soul.editor.basic.nicknameHint')}
              text={draft.doc.nickname}
              max={L.nickname}
            >
              <Input
                id={id('nickname')}
                value={draft.doc.nickname}
                autoComplete="off"
                aria-invalid={draft.doc.nickname.length > L.nickname || undefined}
                onChange={(event) => patchDoc({ nickname: event.target.value })}
              />
            </SoulField>
            <SoulField
              id={id('tagline')}
              label={t('pa.soul.editor.basic.tagline')}
              hint={t('pa.soul.editor.basic.taglineHint')}
              text={draft.doc.tagline}
              max={L.tagline}
            >
              <Input
                id={id('tagline')}
                value={draft.doc.tagline}
                autoComplete="off"
                aria-invalid={draft.doc.tagline.length > L.tagline || undefined}
                onChange={(event) => patchDoc({ tagline: event.target.value })}
              />
            </SoulField>
            <SoulField id={id('tags')} label={t('pa.soul.editor.basic.tags')}>
              <SoulTagInput
                id={id('tags')}
                value={draft.doc.tags}
                max={L.tags}
                maxLength={L.tag}
                placeholder={t('pa.soul.editor.basic.tagsPlaceholder')}
                onChange={(tags) => patchDoc({ tags })}
              />
            </SoulField>
          </>
        )}
      </div>
    </div>
  );

  const renderGreeting = () => {
    const alternates = draft.doc.alternateGreetings;
    const at = alternates.length === 0 ? -1 : Math.min(altSelected, alternates.length - 1);
    const selected = at >= 0 ? (alternates[at] ?? '') : null;
    const setAlternates = (next: string[]) => patchDoc({ alternateGreetings: next });
    return (
      <>
        {textField('firstMessage', t('pa.soul.editor.greeting.first'), L.firstMessage, 6, { hint: t('pa.soul.editor.greeting.firstHint') })}
        <div className="flex min-w-0 flex-col gap-3">
          <Label variant="form" className="mb-0">
            {t('pa.soul.editor.greeting.alternates')}
          </Label>
          {alternates.length > 0 ? (
            <div className={cn(modalStyles.group, styles.pickList)}>
              {alternates.map((text, index) => (
                <div key={index} className={styles.pickRow} data-selected={index === at ? '' : undefined}>
                  <Button variant="bare" className={styles.pickButton} aria-pressed={index === at} onClick={() => setAltSelected(index)}>
                    <span className={styles.pickIndex}>{t('pa.soul.editor.greeting.alternateN', { n: index + 1 })}</span>
                    <span className={styles.pickText} data-empty={firstLine(text) ? undefined : ''}>
                      {firstLine(text) || '—'}
                    </span>
                  </Button>
                  <IconButton
                    size="xs"
                    aria-label={t('pa.soul.editor.greeting.remove')}
                    onClick={() => {
                      setAlternates(alternates.filter((_, i) => i !== index));
                      setAltSelected((current) => (current >= index ? Math.max(0, current - 1) : current));
                    }}
                  >
                    <Icon icon={Trash2} size="sm" />
                  </IconButton>
                </div>
              ))}
            </div>
          ) : null}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              disabled={alternates.length >= L.alternateGreetings}
              onClick={() => {
                setAlternates([...alternates, '']);
                setAltSelected(alternates.length);
              }}
            >
              <PlusIcon size="sm" />
              {t('pa.soul.editor.greeting.add')}
            </Button>
          </div>
          {selected !== null ? (
            <SoulField
              id={id('alternate')}
              text={selected}
              max={L.firstMessage}
              error={alternatesTotal > L.alternateGreetingsTotal ? t('pa.soul.editor.greeting.tooLong') : undefined}
            >
              <Textarea
                id={id('alternate')}
                rows={6}
                value={selected}
                aria-label={t('pa.soul.editor.greeting.alternateN', { n: at + 1 })}
                aria-invalid={selected.length > L.firstMessage || undefined}
                onChange={(event) => setAlternates(alternates.map((text, i) => (i === at ? event.target.value : text)))}
              />
            </SoulField>
          ) : null}
        </div>
        <SoulField id={id('openers')} label={t('pa.soul.editor.greeting.openers')} hint={t('pa.soul.editor.greeting.openersHint')}>
          <SoulTagInput
            id={id('openers')}
            value={draft.doc.openers}
            max={L.openers}
            maxLength={L.opener}
            placeholder={t('pa.soul.editor.basic.tagsPlaceholder')}
            onChange={(openers) => patchDoc({ openers })}
          />
        </SoulField>
      </>
    );
  };

  const renderLore = () => {
    const bound = draft.doc.lorebookIds.map((bookId) => {
      const book = index.lorebooks.get(bookId);
      return { id: bookId, name: book?.name ?? bookId, entries: book?.entryCount ?? null };
    });
    const unbound = [...index.lorebooks.values()].filter((book) => !draft.doc.lorebookIds.includes(book.id));
    const selected = loreSelected && draft.doc.lorebookIds.includes(loreSelected) ? loreSelected : (draft.doc.lorebookIds[0] ?? null);
    const saveFirst = dirty || agentId === null;
    return (
      <>
        <div className="flex min-w-0 flex-col gap-3">
          <Label variant="form" className="mb-0">
            {t('pa.soul.editor.lore.bound')}
          </Label>
          <div className={modalStyles.group}>
            {bound.length === 0 ? (
              <p className={modalStyles.listEmpty}>{t('pa.soul.editor.lore.empty')}</p>
            ) : (
              bound.map((book) => (
                <div key={book.id} className={styles.pickRow} data-selected={book.id === selected ? '' : undefined}>
                  <Button
                    variant="bare"
                    className={styles.pickButton}
                    aria-pressed={book.id === selected}
                    onClick={() => setLoreSelected(book.id)}
                  >
                    <span className={styles.pickName}>{book.name}</span>
                    {book.entries !== null ? (
                      <span className={styles.pickMeta}>{t('pa.soul.editor.lore.entries', { n: book.entries })}</span>
                    ) : null}
                  </Button>
                  <Button
                    variant="bare"
                    size="sm"
                    onClick={() => patchDoc({ lorebookIds: draft.doc.lorebookIds.filter((bookId) => bookId !== book.id) })}
                  >
                    {t('pa.soul.editor.lore.unbind')}
                  </Button>
                </div>
              ))
            )}
          </div>
          <div className={styles.actions}>
            <Select
              value=""
              disabled={unbound.length === 0 || draft.doc.lorebookIds.length >= L.lorebookIds}
              onValueChange={(bookId) => {
                patchDoc({ lorebookIds: [...draft.doc.lorebookIds, bookId] });
                setLoreSelected(bookId);
              }}
            >
              <SelectTrigger className={styles.loreSelect} aria-label={t('pa.soul.editor.lore.bind')}>
                <SelectValue placeholder={t('pa.soul.editor.lore.bind')} />
              </SelectTrigger>
              <SelectContent>
                {unbound.map((book) => (
                  <SelectItem key={book.id} value={book.id}>
                    {book.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className={styles.actionsEnd} />
            <Button variant="secondary" size="sm" disabled={!selected || (saveFirst && blocked)} loading={submit.busy} onClick={() => selected && openLorebook(selected)}>
              {t(saveFirst ? 'pa.soul.editor.lore.saveOpen' : 'pa.soul.editor.lore.open')}
            </Button>
            <Button variant="secondary" size="sm" disabled={saveFirst && blocked} loading={submit.busy} onClick={() => openLorebook(null)}>
              {t(saveFirst ? 'pa.soul.editor.lore.saveNew' : 'pa.soul.editor.lore.new')}
            </Button>
          </div>
        </div>
      </>
    );
  };

  const renderStyle = () => (
    <>
      {fantay ? null : (
        <>
          <SoulField id={id('preset')} label={t('pa.soul.editor.style.preset')}>
            <Select value={draft.doc.presetId ?? SOUL_NONE} onValueChange={(value) => patchDoc({ presetId: value === SOUL_NONE ? null : value })}>
              <SelectTrigger id={id('preset')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SOUL_NONE}>{t('pa.soul.editor.style.presetDefault')}</SelectItem>
                {[...index.presets.values()].map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SoulField>
          <SoulField id={id('persona')} label={t('pa.soul.editor.style.persona')}>
            <Select value={draft.doc.personaId ?? SOUL_NONE} onValueChange={(value) => patchDoc({ personaId: value === SOUL_NONE ? null : value })}>
              <SelectTrigger id={id('persona')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SOUL_NONE}>{t('pa.soul.editor.style.personaDefault')}</SelectItem>
                {[...index.personas.values()].map((persona) => (
                  <SelectItem key={persona.id} value={persona.id}>
                    {persona.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SoulField>
        </>
      )}
      <SoulField id={id('model')} label={t('pa.soul.editor.style.model')} hint={data.models.length ? undefined : t('pa.noModels')}>
        <PaModelPicker
          id={id('model')}
          agent={previewAgent}
          variant="profile"
          onModelChange={(model) => {
            modelChosen.current = true;
            patchAgent({ model });
          }}
        />
      </SoulField>
      {fantay ? null : (
        <div className={modalStyles.group}>
          <div className={modalStyles.row}>
            <div className={modalStyles.rowText}>
              <span className={modalStyles.rowLabel}>{t('pa.soul.editor.style.talk')}</span>
              <div className={modalStyles.rowHint}>{t('pa.soul.editor.style.talkHint')}</div>
            </div>
            <div className={modalStyles.rowControl}>
              <SoulStepper
                value={draft.doc.talkativeness}
                min={0}
                max={1}
                step={0.1}
                format={(value) => value.toFixed(1)}
                aria-label={t('pa.soul.editor.style.talk')}
                onChange={(talkativeness) => patchDoc({ talkativeness })}
              />
            </div>
          </div>
          <PaSwitchRow
            label={t('pa.soul.editor.style.autoMemory', { name: displayName })}
            hint={t('pa.soul.editor.style.autoMemoryHint', { name: displayName })}
            checked={draft.doc.autoMemory}
            onChange={(autoMemory) => patchDoc({ autoMemory })}
          />
        </div>
      )}
      {fantay ? null : <SoulVoiceField value={draft.doc.voice ?? null} onChange={(voice) => patchDoc({ voice })} name={displayName} />}
    </>
  );

  const renderPlay = () => (
    <>
      <h4 className={styles.groupTitle}>{t('pa.soul.editor.play.state')}</h4>
      <SoulStateFieldsEditor value={draft.doc.stateSchema} onChange={(stateSchema) => patchDoc({ stateSchema })} name={displayName} />
      <h4 className={styles.groupTitle}>{t('pa.soul.editor.play.decks')}</h4>
      <SoulDeckEditor value={draft.doc.decks ?? []} onChange={(decks) => patchDoc({ decks })} name={displayName} />
    </>
  );

  const renderWork = () => (
    <>
      <SoulField id={id('role')} label={t('pa.soul.editor.work.role')} hint={t('pa.soul.editor.work.roleHint')} text={draft.agent.role} max={ROLE_MAX}>
        <Textarea
          id={id('role')}
          rows={6}
          value={draft.agent.role}
          placeholder={willHaveCharacter ? derivedRole : undefined}
          aria-invalid={roleMissing || draft.agent.role.length > ROLE_MAX || undefined}
          onChange={(event) => patchAgent({ role: event.target.value })}
        />
      </SoulField>
      <div className={modalStyles.group}>
        <PaSwitchRow
          label={t('pa.agentForm.project')}
          hint={t('pa.agentForm.projectHint')}
          checked={draft.agent.project}
          onChange={(project) => patchAgent({ project })}
        />
        {agentId !== null ? (
          <PaSwitchRow
            label={t('pa.agentForm.enabled')}
            hint={t('pa.agentForm.enabledHint')}
            checked={draft.agent.enabled}
            onChange={(checked) => {
              if (checked) patchAgent({ enabled: true });
              else setConfirmDisable(true);
            }}
          />
        ) : null}
      </div>
    </>
  );

  const renderAdvanced = () => {
    const origin = base.character?.origin ?? null;
    const version = origin && origin.format.startsWith('ccv') ? origin.format.slice(3) : null;
    const preserved = base.character?.preservedKeys ?? [];
    const review = base.character?.needsReview ?? [];
    return (
      <>
        {textField('systemPrompt', t('pa.soul.editor.advanced.system'), L.systemPrompt, 5, { hint: t('pa.soul.editor.advanced.systemHint') })}
        {textField('postHistoryInstructions', t('pa.soul.editor.advanced.post'), L.postHistoryInstructions, 4, {
          hint: t('pa.soul.editor.advanced.postHint'),
        })}
        <div className="flex min-w-0 flex-col gap-2.5">
          <SoulField id={id('note')} label={t('pa.soul.editor.advanced.note')} text={draft.note.text} max={L.characterNote}>
            <Textarea
              id={id('note')}
              rows={3}
              value={draft.note.text}
              aria-invalid={draft.note.text.length > L.characterNote || undefined}
              onChange={(event) => patchNote({ text: event.target.value })}
            />
          </SoulField>
          <div className={styles.inlineControls}>
            <span className={styles.inlineControl}>
              {t('pa.soul.editor.advanced.depth')}
              <SoulStepper
                value={draft.note.depth}
                min={0}
                max={L.noteDepth}
                aria-label={t('pa.soul.editor.advanced.depth')}
                onChange={(depth) => patchNote({ depth })}
              />
            </span>
            <span className={styles.inlineControl}>
              {t('pa.soul.editor.advanced.noteRole')}
              <Select value={draft.note.role} onValueChange={(role) => patchNote({ role: role as NoteDraft['role'] })}>
                <SelectTrigger className={styles.inlineSelect} aria-label={t('pa.soul.editor.advanced.noteRole')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`pa.soul.editor.advanced.role.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          </div>
        </div>
        {textField('creatorNotes', t('pa.soul.editor.advanced.creatorNotes'), L.creatorNotes, 3, {
          hint: t('pa.soul.editor.advanced.creatorNotesHint', { name: displayName }),
        })}
        <div className={styles.grid2}>
          <SoulField id={id('creator')} label={t('pa.soul.editor.advanced.creator')} text={draft.doc.creator} max={L.creator}>
            <Input
              id={id('creator')}
              value={draft.doc.creator}
              autoComplete="off"
              aria-invalid={draft.doc.creator.length > L.creator || undefined}
              onChange={(event) => patchDoc({ creator: event.target.value })}
            />
          </SoulField>
          <SoulField id={id('version')} label={t('pa.soul.editor.advanced.version')} text={draft.doc.characterVersion} max={L.characterVersion}>
            <Input
              id={id('version')}
              value={draft.doc.characterVersion}
              autoComplete="off"
              aria-invalid={draft.doc.characterVersion.length > L.characterVersion || undefined}
              onChange={(event) => patchDoc({ characterVersion: event.target.value })}
            />
          </SoulField>
        </div>

        {origin && version ? (
          <>
            <h4 className={styles.groupTitle}>{t('pa.soul.editor.advanced.import')}</h4>
            <p className={styles.fact}>
              {t('pa.soul.editor.advanced.importFrom', { n: version, name: origin.name, date: formatDay(origin.importedAt, now, locale) })}
            </p>
            {preserved.length > 0 ? (
              <div>
                <span className={modalStyles.caption}>{t('pa.soul.editor.advanced.preserved')}</span>
                <div className={modalStyles.group}>
                  <div className={styles.keys}>
                    {preserved.map((key) => (
                      <span key={key}>{key}</span>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            {review.length > 0 ? (
              <div>
                <span className={modalStyles.caption}>{t('pa.soul.editor.advanced.review')}</span>
                <div className={modalStyles.group} data-testid="pa-profile-review">
                  {review.map((item, index) => (
                    <div key={`${item.key}:${index}`} className={styles.reviewRow}>
                      <SoulTag tone="outline">{t(REVIEW_KIND[item.kind])}</SoulTag>
                      <span className={styles.reviewSummary}>{item.summary}</span>
                      <span className={styles.reviewAction}>{t(REVIEW_ACTION[item.action])}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {agentId !== null ? (
          <div className={styles.sectionEnd}>
            <Button variant="secondary" size="sm" onClick={() => close.guard(() => nav.openModal({ kind: 'cardImport', agentId }))}>
              {t('pa.soul.editor.advanced.overwrite')}
            </Button>
            {base.character ? (
              <Button variant="ghost" size="sm" className={modalStyles.dangerQuiet} onClick={() => setConfirmCard(true)}>
                {t('pa.soul.editor.advanced.removeCard')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </>
    );
  };

  const renderSection = () => {
    switch (active) {
      case 'basic':
        return renderBasic();
      case 'persona':
        return (
          <>
            {textField('description', t('pa.soul.editor.persona.description'), L.description, 8, { tokens: true })}
            {textField('personality', t('pa.soul.editor.persona.personality'), L.personality, 5, { tokens: true })}
            {textField('scenario', t('pa.soul.editor.persona.scenario'), L.scenario, 4, {
              tokens: true,
              hint: t('pa.soul.editor.persona.scenarioHint', { name: displayName }),
            })}
          </>
        );
      case 'greeting':
        return renderGreeting();
      case 'examples':
        return textField('exampleDialogue', t('pa.soul.editor.examples.label'), L.exampleDialogue, 14, {
          tokens: true,
          code: true,
          hint: t('pa.soul.editor.examples.hint'),
        });
      case 'lore':
        return renderLore();
      case 'style':
        return renderStyle();
      case 'look':
        return (
          <SoulAppearancePicker
            value={draft.doc.appearance}
            base={null}
            onChange={(next) => patchDoc({ appearance: next })}
            portrait={{ src: portraitSrc, name: displayName }}
          />
        );
      case 'sprites':
        return (
          <SoulSpritesEditor
            value={draft.doc.sprites ?? {}}
            onChange={(sprites) => patchDoc({ sprites })}
            name={displayName}
            theme={appearance.theme}
          />
        );
      case 'play':
        return renderPlay();
      case 'work':
        return renderWork();
      case 'advanced':
        return renderAdvanced();
    }
  };

  return (
    <PaModalFrame
      open={open}
      onClose={() => close.guard()}
      size="2xl"
      title={agentId === null ? t('pa.soul.editor.titleNew') : t('pa.soul.editor.title', { name: displayName })}
      leading={
        <SoulPortrait
          src={fantay ? null : portraitSrc}
          name={displayName}
          size={40}
          frame={fantay ? 'circle' : soulFrameOf(appearance)}
          theme={appearance.theme}
          fallback={
            <PaAvatar agent={hasFace ? previewAgent : null} size={40} fantay={fantay} className={hasFace ? undefined : modalStyles.blankFace} />
          }
        />
      }
      conflict={submit.conflict}
      error={submit.error}
      onSubmit={() => save()}
      bodyClassName={modalStyles.fixedFrame}
      testId="pa-profile-modal"
      footer={
        <>
          {savedCharacter ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" data-testid="pa-profile-export">
                  {t('pa.soul.editor.export.label')}
                  <ChevronDownIcon size="xs" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent width={quarantined ? 'auto' : 'sm'} align="start" side="top">
                <DropdownMenuItem onSelect={() => void exportAs('json')}>{t('pa.soul.editor.export.json')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportAs('png')}>{t('pa.soul.editor.export.png')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportAs('charx')}>{t('pa.soul.editor.export.charx')}</DropdownMenuItem>
                {quarantined ? (
                  <DropdownMenuItem onSelect={() => void exportAs('jsonAll')}>{t('pa.soul.editor.export.jsonAll')}</DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <ModalSpacer />
          <Button variant="ghost" onClick={() => close.guard()}>
            {t('pa.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={blocked}
            disabledReason={saveHeld}
            loading={submit.busy}
            data-testid="pa-profile-save"
          >
            {t('pa.save')}
          </Button>
        </>
      }
    >
      <div className={styles.editor}>
        <nav className={styles.nav} aria-label={t('pa.soul.editor.nav.label')}>
          {sections.map((item) => (
            <Button
              key={item}
              variant="bare"
              className={styles.navItem}
              aria-current={item === active ? 'true' : undefined}
              data-testid={`pa-profile-nav-${item}`}
              onClick={() => setActive(item)}
            >
              <span className={styles.navLabel}>{t(`pa.soul.editor.nav.${item}`)}</span>
              {invalid.has(item) ? (
                <>
                  <span aria-hidden className={styles.navDot} />
                  <VisuallyHidden>{t('pa.soul.editor.nav.error')}</VisuallyHidden>
                </>
              ) : null}
            </Button>
          ))}
        </nav>
        <div ref={paneRef} className={styles.pane}>
          <section key={active} className={styles.section} aria-labelledby={id('title')} data-section={active}>
            <h3 id={id('title')} className={styles.sectionTitle}>
              {t(`pa.soul.editor.nav.${active}`)}
            </h3>
            {renderSection()}
          </section>
        </div>
      </div>

      <SoulDiscardDialog unit="editor" {...close.dialog} />
      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={t('pa.agentForm.disableConfirmTitle', { name: displayName })}
        description={t('pa.agentForm.enabledHint')}
        confirmLabel={t('pa.disable')}
        cancelLabel={t('pa.cancel')}
        destructive
        onConfirm={() => {
          patchAgent({ enabled: false });
          setConfirmDisable(false);
        }}
      />
      <ConfirmDialog
        open={confirmCard}
        onOpenChange={(next) => {
          if (!removingRef.current) setConfirmCard(next);
        }}
        title={t('pa.soul.editor.confirm.cardTitle', { name: displayName })}
        description={
          <>
            {t('pa.soul.editor.confirm.cardBody', { name: displayName })}
            {memoryCount > 0 ? (
              <span className="mt-3 block">
                <CheckboxField
                  label={t('pa.soul.editor.confirm.cardMemories', { name: displayName, n: memoryCount })}
                  checked={forgetMemories}
                  onChange={(event) => setForgetMemories(event.target.checked)}
                />
              </span>
            ) : null}
          </>
        }
        confirmLabel={t('pa.soul.editor.confirm.cardConfirm')}
        cancelLabel={t('pa.cancel')}
        destructive
        busy={removing}
        onConfirm={() => void removeCard()}
      />
    </PaModalFrame>
  );
}
