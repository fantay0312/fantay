// SPDX-License-Identifier: Apache-2.0
// Fantay Soul contracts: zod input schemas, entity types and wire types of the PA companion layer.
// Runtime values in this file ship only through "@open-design/contracts/soul"; the root index re-exports types.
import { z } from "zod";
import type { PaEntity } from "./personal-agent.js";
import { SOUL_LIMITS as L } from "../soul/limits.js";

const issue = (ctx: z.RefinementCtx, message: string, path: Array<string | number> = []) =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
const bounded = (max: number) => z.number().int().min(0).max(max);

// ---- ids -------------------------------------------------------------------------------------------------------
/** `<uuid>.<png|jpg|webp>`; validated before any path join. */
export const paAssetIdSchema = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/);
/** Persona, lorebook and user preset ids (store uuids). */
export const paSoulIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
/** A user preset id or a built-in `builtin:<slug>`. */
export const paPresetRefSchema = z.string().regex(/^(?:builtin:[a-z0-9-]{1,40}|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/);
/** A generated speech file: `<sha256 hex>.<mp3|wav|ogg|m4a>`; validated before any path join. */
export const paSpeechIdSchema = z.string().regex(/^[0-9a-f]{64}\.(?:mp3|wav|ogg|m4a)$/);

// ---- appearance ------------------------------------------------------------------------------------------------
export const PA_CHAT_THEMES = ["fantay", "clean", "sakura", "archive", "rain", "ink", "deepsea"] as const;
export type PaChatTheme = (typeof PA_CHAT_THEMES)[number];
export const paChatAppearanceSchema = z.object({
  theme: z.enum(PA_CHAT_THEMES),
  shape: z.enum(["round", "soft", "square"]),
  font: z.enum(["ui", "serif", "kai", "mono"]),
  scale: z.enum(["sm", "md", "lg"]),
  pacing: z.enum(["instant", "paced"]),
  // layout, pattern, avatarFrame, accent and stage are user controls since stage 2.
  layout: z.enum(["bubble", "journal"]),
  pattern: z.enum(["none", "grid", "ruled", "dots"]),
  avatarFrame: z.enum(["circle", "squircle", "polaroid"]),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  stage: z.enum(["off", "side"]),
}).partial().strict();
/** Always partial; resolved by resolveAppearance(). */
export type PaChatAppearance = z.output<typeof paChatAppearanceSchema>;
export type PaResolvedAppearance = { [K in keyof PaChatAppearance]-?: Exclude<PaChatAppearance[K], undefined> };

// ---- story state -----------------------------------------------------------------------------------------------
/** Lower-cased names a state key may not take: JS object members and the footer's own line names. */
export const PA_RESERVED_STATE_KEYS: ReadonlySet<string> = new Set([
  "constructor", "prototype", "tostring", "valueof", "hasownproperty",
  "mood", "choices", "remember", "roll", "draw", "state", "play", "meta",
]);
const paStateKeySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/)
  .refine(key => !PA_RESERVED_STATE_KEYS.has(key.toLowerCase()), "reserved key");
const stateFieldBase = {
  key: paStateKeySchema,
  label: z.string().trim().min(1).max(L.stateLabel),
  hint: z.string().max(L.stateHint).default(""),          // told to the model
  writable: z.enum(["model", "user"]).default("model"),   // 'user': shown to the model, ignored in its footer
};
export const paStateFieldSchema = z.discriminatedUnion("kind", [
  z.object({
    ...stateFieldBase, kind: z.literal("number"), initial: z.number().finite(),
    min: z.number().finite().optional(), max: z.number().finite().optional(),
    maxStep: z.number().finite().positive().optional(), render: z.enum(["bar", "value"]).optional(),
  }).strict(),
  z.object({ ...stateFieldBase, kind: z.literal("text"), initial: z.string().max(L.stateText) }).strict(),
  z.object({
    ...stateFieldBase, kind: z.literal("enum"), initial: z.string().max(L.stateOption),
    options: z.array(z.string().trim().min(1).max(L.stateOption)).min(1).max(L.stateOptions),
    render: z.enum(["value", "chips"]).optional(),
  }).strict(),
  z.object({
    ...stateFieldBase, kind: z.literal("list"),
    initial: z.array(z.string().trim().min(1).max(L.stateListItem)).max(L.stateListItems),
    render: z.enum(["list", "chips"]).optional(),
  }).strict(),
]);
export type PaStateField = z.output<typeof paStateFieldSchema>;
export const paStateSchemaSchema = z.array(paStateFieldSchema).max(L.stateFields).superRefine((fields, ctx) => {
  const keys = new Set<string>();
  const labels = new Set<string>();
  fields.forEach((field, index) => {
    const key = field.key.toLowerCase();
    const label = field.label.normalize("NFKC").toLowerCase();
    if (keys.has(key)) issue(ctx, "duplicate key", [index, "key"]);
    if (labels.has(label)) issue(ctx, "duplicate label", [index, "label"]);
    keys.add(key);
    labels.add(label);
    if (field.kind === "number") {
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) issue(ctx, "min is above max", [index]);
      if ((field.min !== undefined && field.initial < field.min) || (field.max !== undefined && field.initial > field.max))
        issue(ctx, "initial is out of range", [index, "initial"]);
    } else if (field.kind === "enum") {
      if (new Set(field.options).size !== field.options.length) issue(ctx, "duplicate option", [index, "options"]);
      if (!field.options.includes(field.initial)) issue(ctx, "initial is not an option", [index, "initial"]);
    } else if (field.kind === "list") {
      if (new Set(field.initial).size !== field.initial.length) issue(ctx, "duplicate item", [index, "initial"]);
    }
  });
});
export type PaStateValue = number | string | string[];
/** `value` is a string[] only for a user `set` on a list field. */
export interface PaStateOp { key: string; op: "set" | "delta" | "add" | "remove"; value: string | number | string[] }
/** A user edit, anchored after a slot (`after` is a slot id, or null for "before the first message"). */
export interface PaUserStateOp extends PaStateOp { after: string | null }
export const paStateOpInputSchema = z.object({
  key: z.string().min(1).max(32),
  op: z.enum(["set", "delta", "add", "remove"]),
  value: z.union([
    z.string().max(L.stateText), z.number().finite(),
    z.array(z.string().max(L.stateListItem)).max(L.stateListItems),
  ]),
}).strict();

// ---- decks -----------------------------------------------------------------------------------------------------
export const paDeckSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  name: z.string().trim().min(1).max(L.deckName),
  cards: z.array(z.object({
    title: z.string().trim().min(1).max(L.cardTitle),
    text: z.string().max(L.cardText).default(""),
    secret: z.string().max(L.cardSecret).default(""),     // sent to the model, never shown until revealed
  }).strict()).min(2).max(L.deckCards),
}).strict();
export type PaDeck = z.output<typeof paDeckSchema>;
const paDecksSchema = z.array(paDeckSchema).max(L.decks).superRefine((decks, ctx) => {
  const ids = new Set<string>();
  decks.forEach((deck, index) => {
    if (ids.has(deck.id)) issue(ctx, "duplicate deck id", [index, "id"]);
    ids.add(deck.id);
  });
});

// ---- emotions, sprites, voice (stage 2) ---------------------------------------------------------------------
export const PA_EMOTIONS = ["neutral", "happy", "sad", "angry", "surprised", "shy", "worried", "sleepy"] as const;
export type PaEmotion = (typeof PA_EMOTIONS)[number];
/** One image per emotion; every key optional. */
export const paSpritesSchema = z.object({
  neutral: paAssetIdSchema, happy: paAssetIdSchema, sad: paAssetIdSchema, angry: paAssetIdSchema,
  surprised: paAssetIdSchema, shy: paAssetIdSchema, worried: paAssetIdSchema, sleepy: paAssetIdSchema,
}).partial().strict();
export type PaSprites = z.output<typeof paSpritesSchema>;
/** `model` is a speech model id of the media catalogue; `voice` '' means the service default. */
export const paVoiceSchema = z.object({
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/),
  voice: z.string().trim().max(L.voiceId).default(""),
  language: z.string().trim().max(L.voiceLanguage).default(""),      // '' = decide from the text
}).strict();
export type PaVoice = z.output<typeof paVoiceSchema>;
/** 试听: a voice as picked in the editor (saved or not) reading a short text; '' reads the daemon's sample line. */
export const paSpeechPreviewInputSchema = paVoiceSchema.extend({
  text: z.string().trim().max(L.speechPreviewChars).default(""),
}).strict();
export type PaSpeechPreviewInput = z.input<typeof paSpeechPreviewInputSchema>;

// ---- character -------------------------------------------------------------------------------------------------
const paCharacterObject = z.object({
  nickname: z.string().max(L.nickname).default(""),                    // replaces {{char}} when set
  tagline: z.string().max(L.tagline).default(""),                      // list subtitle; never sent as an instruction
  description: z.string().max(L.description).default(""),
  personality: z.string().max(L.personality).default(""),
  scenario: z.string().max(L.scenario).default(""),
  firstMessage: z.string().max(L.firstMessage).default(""),
  alternateGreetings: z.array(z.string().max(L.firstMessage)).max(L.alternateGreetings)
    .superRefine((list, ctx) => {
      if (list.reduce((sum, text) => sum + text.length, 0) > L.alternateGreetingsTotal) issue(ctx, "greetings are too large");
    }).default([]),
  openers: z.array(z.string().trim().min(1).max(L.opener)).max(L.openers).default([]),   // chips on greeting 0
  exampleDialogue: z.string().max(L.exampleDialogue).default(""),      // blocks separated by <START>
  systemPrompt: z.string().max(L.systemPrompt).default(""),            // overrides the preset main; {{original}}
  postHistoryInstructions: z.string().max(L.postHistoryInstructions).default(""),
  characterNote: z.object({
    text: z.string().max(L.characterNote),
    depth: bounded(L.noteDepth).default(4),
    role: z.enum(["system", "user", "assistant"]).default("system"),
  }).strict().nullable().default(null),
  creatorNotes: z.string().max(L.creatorNotes).default(""),            // shown to the user only
  tags: z.array(z.string().trim().min(1).max(L.tag)).max(L.tags).default([]),
  creator: z.string().max(L.creator).default(""),
  characterVersion: z.string().max(L.characterVersion).default(""),
  presetId: paPresetRefSchema.nullable().default(null),
  personaId: paSoulIdSchema.nullable().default(null),
  lorebookIds: z.array(paSoulIdSchema).max(L.lorebookIds).default([]),
  talkativeness: z.number().min(0).max(1).default(0.5),                // natural order in rooms
  portraitAssetId: paAssetIdSchema.nullable().default(null),
  appearance: paChatAppearanceSchema.default({}),
  stateSchema: paStateSchemaSchema.default([]),
  decks: paDecksSchema.default([]),
  sprites: paSpritesSchema.default({}),                                // stage 2: asset ids by emotion
  voice: paVoiceSchema.nullable().default(null),                       // stage 2: null = no read-aloud
  autoMemory: z.boolean().default(true),                               // false for imported cards
}).strict();
export const paCharacterInputSchema = paCharacterObject;
export const paCharacterPatchSchema = paCharacterObject.partial();
export type PaCharacterInput = z.input<typeof paCharacterInputSchema>;
export type PaCharacterDoc = z.output<typeof paCharacterInputSchema>;
export type PaCharacterPatch = z.input<typeof paCharacterPatchSchema>;

// ---- world book ------------------------------------------------------------------------------------------------
export const PA_LORE_LOGIC = ["and_any", "not_all", "not_any", "and_all"] as const;   // ST selectiveLogic 0..3
export const paLoreEntrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
  title: z.string().max(L.loreTitle).default(""),
  keys: z.array(z.string().max(L.loreKey)).max(L.loreKeys).default([]),
  secondaryKeys: z.array(z.string().max(L.loreKey)).max(L.loreKeys).default([]),
  selective: z.boolean().default(true),                                // false: secondary keys are ignored
  logic: z.enum(PA_LORE_LOGIC).default("and_any"),
  content: z.string().max(L.loreContent).default(""),
  enabled: z.boolean().default(true),
  constant: z.boolean().default(false),
  order: z.number().int().min(-L.loreOrder).max(L.loreOrder).default(100),
  position: z.enum(["before_char", "after_char", "at_depth"]).default("before_char"),
  depth: bounded(L.loreDepth).default(4),
  role: z.enum(["system", "user", "assistant"]).default("system"),
  scanDepth: bounded(L.loreScanDepth).nullable().default(null),        // null: the book's
  caseSensitive: z.boolean().nullable().default(null),
  matchWholeWords: z.boolean().nullable().default(null),
  probability: bounded(100).default(100),
  groups: z.array(z.string().trim().min(1).max(L.loreGroup)).max(L.loreGroups).default([]),
  groupWeight: z.number().int().min(1).max(L.loreGroupWeight).default(100),
  groupOverride: z.boolean().default(false),
  sticky: bounded(L.loreTimer).default(0),                             // counted in messages
  cooldown: bounded(L.loreTimer).default(0),
  delay: bounded(L.loreTimer).default(0),
  excludeRecursion: z.boolean().default(false),
  preventRecursion: z.boolean().default(false),
  recursionOnly: z.boolean().default(false),
  ignoreBudget: z.boolean().default(false),
  preserved: z.record(z.unknown()).default({}),                        // original uid, position number, decorators, unmapped fields
}).strict();
export type PaLoreEntry = z.output<typeof paLoreEntrySchema>;
const paLoreEntriesSchema = z.array(paLoreEntrySchema).max(L.loreEntries).superRefine((entries, ctx) => {
  const ids = new Set<string>();
  let total = 0;
  entries.forEach((entry, index) => {
    if (ids.has(entry.id)) issue(ctx, "duplicate entry id", [index, "id"]);
    ids.add(entry.id);
    total += entry.content.length;
  });
  if (total > L.loreContentTotal) issue(ctx, "lorebook content is too large");
});
const paLorebookObject = z.object({
  name: z.string().trim().min(1).max(L.lorebookName),
  description: z.string().max(L.lorebookDescription).default(""),
  scanDepth: bounded(L.loreScanDepth).default(4),
  tokenBudget: z.number().int().min(L.loreBudgetMin).max(L.loreBudgetMax).default(L.loreBudgetDefault),
  recursive: z.boolean().default(true),
  caseSensitive: z.boolean().default(false),
  matchWholeWords: z.boolean().default(true),                          // applies to pure-ASCII keys only
  global: z.boolean().default(false),                                  // active in every companion chat
  entries: paLoreEntriesSchema.default([]),
}).strict();
export const paLorebookInputSchema = paLorebookObject;
export const paLorebookPatchSchema = paLorebookObject.partial();
export type PaLorebookInput = z.input<typeof paLorebookInputSchema>;
export type PaLorebookDoc = z.output<typeof paLorebookInputSchema>;
export type PaLorebookPatch = z.input<typeof paLorebookPatchSchema>;

// ---- persona ---------------------------------------------------------------------------------------------------
const paPersonaObject = z.object({
  name: z.string().trim().min(1).max(L.personaName),
  description: z.string().max(L.personaDescription).default(""),
  avatarAssetId: paAssetIdSchema.nullable().default(null),
  isDefault: z.boolean().default(false),
}).strict();
export const paPersonaInputSchema = paPersonaObject;
export const paPersonaPatchSchema = paPersonaObject.partial();
export type PaPersonaInput = z.input<typeof paPersonaInputSchema>;
export type PaPersonaDoc = z.output<typeof paPersonaInputSchema>;
export type PaPersonaPatch = z.input<typeof paPersonaPatchSchema>;

// ---- style preset ----------------------------------------------------------------------------------------------
const paStylePresetObject = z.object({
  name: z.string().trim().min(1).max(L.presetName),
  description: z.string().max(L.presetDescription).default(""),
  main: z.string().max(L.presetMain).default(""),                      // style instruction; macros allowed
  postHistory: z.string().max(L.presetPostHistory).default(""),
  format: z.enum(["im", "prose", "script"]).default("im"),            // IM short lines / prose / stage script
  replyLength: z.enum(["short", "medium", "long"]).default("short"),
  narration: z.enum(["none", "first", "second", "third"]).default("none"),
  userAgency: z.enum(["strict", "allow"]).default("strict"),          // strict: never speak or act for {{user}}
  tempo: z.enum(["slow", "normal", "fast"]).default("normal"),        // narrative speed
  multiBubble: z.boolean().default(true),                              // blank line between thoughts = separate bubbles
  timeAware: z.boolean().default(true),                                // real date, time and gaps go into the tail
  suggestChoices: z.boolean().default(false),                          // footer `choices` line
  mood: z.boolean().default(true),                                     // footer `mood` line
  playRequests: z.boolean().default(false),                            // footer `roll` / `draw` lines
  extra: z.string().max(L.presetExtra).default(""),                    // free style notes appended to the style block
  sampling: z.object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
  }).strict().default({}),
}).strict();
export const paStylePresetInputSchema = paStylePresetObject;
export const paStylePresetPatchSchema = paStylePresetObject.partial();
export type PaStylePresetInput = z.input<typeof paStylePresetInputSchema>;
export type PaStylePresetDoc = z.output<typeof paStylePresetInputSchema>;
export type PaStylePresetPatch = z.input<typeof paStylePresetPatchSchema>;

// ---- chat settings (user-owned) --------------------------------------------------------------------------------
const paChatSettingsObject = z.object({
  mode: z.enum(["work", "companion"]).nullable().default(null),        // null: derive (resolveChatMode)
  personaId: paSoulIdSchema.nullable().default(null),                  // null: character pin, else default persona
  presetId: paPresetRefSchema.nullable().default(null),                // null: character default, else builtin:real-chat
  lorebookIds: z.array(paSoulIdSchema).max(L.chatLorebookIds).default([]),
  disabledLoreEntryIds: z.array(z.string().max(200)).max(L.disabledLoreEntries).default([]),   // `${lorebookId}:${entryId}`
  authorNote: z.object({
    text: z.string().max(L.authorNote),
    depth: bounded(L.noteDepth).default(4),
  }).strict().nullable().default(null),                                // UI term: 便签
  scenario: z.string().max(L.chatScenario).default(""),                // overrides the card scenario (本次场景)
  appearance: paChatAppearanceSchema.default({}),
  groupStrategy: z.enum(["natural", "list", "manual"]).default("natural"),
  historyBudget: z.enum(["short", "medium", "long", "max"]).default("medium"),   // 4k / 8k / 16k / 32k tokens
  turnRecord: z.enum(["auto", "off"]).default("auto"),                 // off: no footer contract at all
  voiceReplies: z.enum(["off", "manual", "auto"]).default("manual"),   // 关 / 点了才读 / 自动朗读
}).strict();
export const paChatSettingsInputSchema = paChatSettingsObject;
export const paChatSettingsPatchSchema = paChatSettingsObject.partial();
export type PaChatSettingsInput = z.input<typeof paChatSettingsInputSchema>;
export type PaChatSettingsDoc = z.output<typeof paChatSettingsInputSchema>;
export type PaChatSettingsPatch = z.input<typeof paChatSettingsPatchSchema>;
export const PA_DEFAULT_CHAT_SETTINGS: PaChatSettingsDoc = paChatSettingsObject.parse({});
export const PA_HISTORY_BUDGET_TOKENS: Record<PaChatSettingsDoc["historyBudget"], number> =
  { short: 4000, medium: 8000, long: 16000, max: 32000 };

// ---- import bookkeeping (service-owned; never part of a user schema) -------------------------------------------
export interface PaNeedsReviewItem {
  key: string;                                                         // field or entry the item is about
  kind: "script" | "regex" | "html" | "remote" | "other";
  summary: string;
  action: "quarantined" | "kept" | "disabled" | "truncated";
}
/** Fixed layout of preserved card data. Every value went through sanitizeForeign. */
export interface PaPreserved {
  root?: Record<string, unknown>;
  data?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  quarantine?: Record<string, unknown>;                                // executable or remote data; never interpreted
}
export interface PaCharacterImportMeta {
  origin: { format: "native" | "ccv1" | "ccv2" | "ccv3" | "starter"; name: string; importedAt: number } | null;
  preserved: PaPreserved;
  needsReview: PaNeedsReviewItem[];
}
export interface PaLorebookImportMeta {
  origin: { format: "native" | "card" | "st-world" | "starter"; name: string } | null;
  preserved: Record<string, unknown>;
  needsReview: PaNeedsReviewItem[];
}

// ---- entities --------------------------------------------------------------------------------------------------
/** Stored row; id === agentId. */
export interface PaCharacter extends PaEntity, PaCharacterDoc, PaCharacterImportMeta {}
/** What the snapshot and the routes return: preserved data stays on the daemon. */
export type PaCharacterView = Omit<PaCharacter, "preserved"> & { preservedKeys: string[] };
export interface PaLorebook extends PaEntity, PaLorebookDoc, PaLorebookImportMeta {}
export interface PaLorebookSummary extends PaEntity, Omit<PaLorebookDoc, "entries"> {
  origin: PaLorebookImportMeta["origin"];
  entryCount: number;
  constantCount: number;
  needsReviewCount: number;
}
/** `principalId` is set in enterprise mode: a persona belongs to the member who wrote it. */
export interface PaPersona extends PaEntity, PaPersonaDoc { principalId?: string }
export interface PaStylePreset extends PaEntity, PaStylePresetDoc { builtin?: boolean }
/** Stored row; id === conversationId. */
export interface PaChatSettings extends PaEntity, PaChatSettingsDoc {}
export interface PaLoreTimer { at: number; stickyEnd: number; cooldownEnd: number }   // message indexes
export interface PaActiveEvent { id: string; title: string; summary: string; remainingTurns: number }
/** Stored row; id === conversationId. Written only by the service. */
export interface PaChatState extends PaEntity {
  loreTimers: Record<string, PaLoreTimer>;                             // key `${lorebookId}:${entryId}`
  activeEvent: PaActiveEvent | null;
  candidateEvent: { id: string; title: string; summary: string } | null;
  branchOf: { conversationId: string; messageId: string } | null;
  userStateOps: PaUserStateOp[];
  traceIds: string[];                                                  // newest last, at most 5
  secrets: Record<string, string>;                                     // draw message id -> card secret
  careAt: number | null;                                               // last crisis-level owner message
}
export type PaChatPublicState = Pick<PaChatState, "activeEvent" | "candidateEvent" | "branchOf" | "userStateOps">;
/** The chat DTO of the snapshot and routes. `revision` is the chat_settings row revision; 0 means "no row yet". */
export type PaChatView = PaChatSettings & PaChatPublicState;

// ---- task and message extensions -------------------------------------------------------------------------------
export interface PaTaskSoul {
  regenerateOf?: string;                                               // slot id being regenerated
  directive?: "continue" | "reachout" | "react";                       // react: answer the newest roll, draw or interlude
  directiveText?: string;                                              // routine prompt (reachout) or the story line (react)
  hiddenOwner?: boolean;                                               // no owner message is created
}
export type PaPlayRequest =
  | { kind: "roll"; notation: string; label?: string; dc?: number }
  | { kind: "draw"; deckId: string };
export type PaFooterStatus = "ok" | "loose" | "unclosed" | "missing" | "off";
export interface PaMessageSoul {
  kind: "greeting" | "chat" | "roll" | "draw" | "event";
  at?: number;                                                         // original createdAt (branch copies)
  copiedFrom?: string;                                                 // branch copies
  variantOf?: string;                                                  // slot id (the root message id); absent on the root
  activeVariant?: string;                                              // root only: selected variant id (absent: the root)
  greetingIndex?: number;                                              // greeting only: 0 = firstMessage, n = alternate n-1
  edited?: boolean;
  hidden?: boolean;                                                    // excluded from model context; state ops still fold
  personaId?: string | null;                                           // owner messages
  requestId?: string;                                                  // owner and story messages: idempotency
  care?: "crisis";                                                     // owner messages: the app shows its care card
  mood?: string;                                                       // agent messages
  stateOps?: PaStateOp[];
  choices?: string[];
  play?: PaPlayRequest[];
  footer?: PaFooterStatus;
  proactive?: boolean;                                                 // reply to a `reachout` directive
  roll?: { notation: string; rolls: number[]; modifier: number; total: number; label?: string; dc?: number; outcome?: "success" | "fail" };
  draw?: { deckId: string; deckName: string; title: string; text: string; hasSecret?: boolean; secret?: string };
  event?: { id: string; title: string; summary: string; phase: "accepted" | "ended" };
}

// ---- snapshot --------------------------------------------------------------------------------------------------
export interface PaSoulSnapshot {
  version: string;
  characters: PaCharacterView[];
  lorebooks: PaLorebookSummary[];
  personas: PaPersona[];
  presets: PaStylePreset[];                                            // user presets; built-ins come from the engine
  chats: PaChatView[];
}

// ---- wire and trace --------------------------------------------------------------------------------------------
export interface PaChatWire {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string;                                                  // flat prompt minus its header line and the system text
  stop: string[];
  contextTokens?: number;                                              // Ollama num_ctx
  sampling?: { temperature?: number; topP?: number; maxTokens?: number };
}
export interface PaMetaParts { mood: boolean; state: boolean; choices: boolean; remember: boolean; play: boolean }
export type PaLoreStatus = "included" | "budget" | "inactive" | "disabled" | "cooldown" | "probability" | "group";
export interface PaLoreReason {
  code: "constant" | "sticky" | "key" | "no-key" | "over-budget" | "cooldown" | "delay" | "probability" | "group"
    | "disabled" | "empty" | "recursion-only" | "regex-rejected" | "regex-timeout" | "regex-needs-daemon";
  key?: string;
  need?: number;
  left?: number;
}
export interface PaSoulTraceLore {
  lorebookId: string; lorebookName: string; entryId: string; title: string; tokens: number;
  status: PaLoreStatus; reason: PaLoreReason; position: PaLoreEntry["position"]; constant: boolean;
}
export interface PaSoulTraceBlock { id: string; zone: "system" | "history" | "tail"; tokens: number }
export interface PaSoulWarning {
  code: "lore-constant-cut" | "examples-dropped" | "history-floor" | "over-window" | "volatile-macro-in-system"
    | "footer-missing" | "regex-timeout" | "prompt-shrunk";
  detail?: string;
}
export interface PaSoulTrace {
  conversationId: string;
  messageId?: string;                                                  // absent on a preview
  at: number;
  speaker: { agentId: string; name: string };
  persona: { id: string | null; name: string };
  preset: { id: string; name: string };
  locale: "zh" | "en";
  wire: "structured" | "flat";                                         // what the runtime really sent
  parts: PaMetaParts;
  footer?: PaFooterStatus;                                             // set at commit
  blocks: PaSoulTraceBlock[];                                          // the web localises block ids
  lore: PaSoulTraceLore[];                                             // stored traces keep non-inactive entries only
  loreInactive: number;
  loreBudget: { used: number; limit: number };
  memories: Array<{ id: string; title: string }>;
  history: { included: number; total: number; hidden: number };
  totalTokens: number;
  contextTokens: number;
  replyTokens: number;
  warnings: PaSoulWarning[];
}
/** The visible text so far of the running chat attempt of a conversation. `text` is absent when `unchanged`. */
export interface PaSoulLiveText { attemptId: string; taskId: string; agentId: string; seq: number; text?: string; unchanged?: true }
export interface PaSoulLiveResponse { live: PaSoulLiveText | null }

export interface PaSpeechModel { id: string; label: string; provider: string; configured: boolean; voices: "list" | "free" }
/** `default` is the voice a character without one of its own is read with (the signed-in TokenToSea account's default
 *  speech model); absent or null when there is none, and then such a character cannot be read aloud. */
export interface PaSpeechStatus { available: boolean; models: PaSpeechModel[]; default?: PaVoice | null }
export interface PaSpeechVoices { model: string; voices: Array<{ id: string; name: string }> }
export type PaSpeechMime = "audio/mpeg" | "audio/wav" | "audio/ogg" | "audio/mp4";
export interface PaSpeechItem { messageId: string; id: string; mime: PaSpeechMime; bytes: number; cached: boolean }
/** A generated voice sample; `id` is served by GET /soul/speech/:id like a reply's audio and belongs to no message. */
export interface PaSpeechPreview { id: string; mime: PaSpeechMime; bytes: number; cached: boolean }

// ---- import previews (pure; the daemon re-runs the parser and never trusts a client preview) ---------------------
/** An image a card names inside its own archive (`embeded://path`). Only CHARX carries the files. */
export interface PaCardEmbeddedAsset { index: number; role: "portrait" | "sprite"; emotion?: PaEmotion; path: string; name: string }
export type PaCardImportPreview =
  | { ok: false; error: "bad-json" | "too-large" | "not-object" | "no-name" | "unsupported-format"; detail?: string }
  | {
      ok: true; format: "ccv1" | "ccv2" | "ccv3"; name: string;
      character: PaCharacterDoc;                                       // "可用"
      lorebook: PaLorebookDoc | null;
      meta: PaCharacterImportMeta;                                     // "已保留" (preserved) and "需另行处理" (needsReview)
      lorebookMeta: PaLorebookImportMeta | null;
      preservedKeys: string[];
      portrait: { mime: "image/png" | "image/jpeg" | "image/webp"; data: string } | null;   // base64, from card assets
      embedded: PaCardEmbeddedAsset[];                                 // stage 2: archive images the card plans to import
    };
export type PaWorldImportPreview =
  | { ok: false; error: "bad-json" | "too-large" | "not-object" | "unsupported-format"; detail?: string }
  | { ok: true; name: string; lorebook: PaLorebookDoc; meta: PaLorebookImportMeta };

// ---- pickers: the only way to turn an entity into a request body -------------------------------------------------
function pickShape(shape: z.ZodRawShape, value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) if (Object.hasOwn(value, key)) out[key] = (value as Record<string, unknown>)[key];
  return out;
}
export const toCharacterInput = (value: PaCharacter | PaCharacterView): PaCharacterDoc =>
  pickShape(paCharacterObject.shape, value) as PaCharacterDoc;
export const toLorebookInput = (value: PaLorebook): PaLorebookDoc =>
  pickShape(paLorebookObject.shape, value) as PaLorebookDoc;
export const toPersonaInput = (value: PaPersona): PaPersonaDoc =>
  pickShape(paPersonaObject.shape, value) as PaPersonaDoc;
export const toPresetInput = (value: PaStylePreset): PaStylePresetDoc =>
  pickShape(paStylePresetObject.shape, value) as PaStylePresetDoc;
export const toChatSettingsInput = (value: PaChatSettings | PaChatView): PaChatSettingsDoc =>
  pickShape(paChatSettingsObject.shape, value) as PaChatSettingsDoc;
