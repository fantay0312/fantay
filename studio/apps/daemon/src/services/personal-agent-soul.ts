import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  MemoryVia,
  PaAgentInput,
  PaAttempt,
  PaChannel,
  PaCharacter,
  PaCharacterView,
  PaChatSettings,
  PaChatSettingsDoc,
  PaChatState,
  PaChatView,
  PaChatWire,
  PaConversation,
  PaDataClass,
  PaDeck,
  PaEntity,
  PaGroup,
  PaGroupInput,
  PaLorebook,
  PaLorebookSummary,
  PaLoreTimer,
  PaMemory,
  PaMemoryCandidate,
  PaMemoryInput,
  PaMessage,
  PaMessageSoul,
  PaModel,
  PaNeedsReviewItem,
  PaPersona,
  PaPrincipal,
  PaRoutine,
  PaSoulSnapshot,
  PaSoulTrace,
  PaSoulTraceLore,
  PaSoulWarning,
  PaSpeechItem,
  PaSpeechMime,
  PaSpeechPreview,
  PaSpeechStatus,
  PaSpeechVoices,
  PaEmotion,
  PaStateOp,
  PaStylePreset,
  PaTask,
  PaTaskInput,
  PaTaskSoul,
  PaUserStateOp,
  PaVoice,
  PersonalAgent,
} from "@open-design/contracts";
import { paAgentInputSchema } from "@open-design/contracts";
import {
  PA_BUILTIN_DECKS,
  PA_BUILTIN_PRESETS,
  PA_DEFAULT_CHAT_SETTINGS,
  PA_EVENT_TURNS,
  PA_HISTORY_BUDGET_TOKENS,
  PA_STARTERS,
  SOUL_LIMITS,
  SOUL_TEXT,
  activateLore,
  anyPart,
  applyOp,
  availableDecks,
  base64ToBytes,
  chatStateSlots,
  composeSoulPrompt,
  detectCrisis,
  drawCard,
  drawInterlude,
  expandMacros,
  exportCharacterCard,
  exportWorldInfo,
  foldCardMarkup,
  foldChatState,
  importWorldInfo,
  isInContext,
  mentionedMembers,
  mentionsEveryone,
  messageAt,
  paAssetIdSchema,
  paCharacterInputSchema,
  paCharacterPatchSchema,
  paChatSettingsInputSchema,
  paChatSettingsPatchSchema,
  paLorebookInputSchema,
  paLorebookPatchSchema,
  paPersonaInputSchema,
  paPersonaPatchSchema,
  paSpeechIdSchema,
  paSpeechPreviewInputSchema,
  paSpritesSchema,
  paStylePresetInputSchema,
  paStylePresetPatchSchema,
  parseCharacterCard,
  parseSoulReply,
  pickNaturalSpeaker,
  pickPromptLocale,
  reanchorUserOps,
  resolveChatMode,
  resolveMetaParts,
  resolveNames,
  resolvePreset,
  rollDice,
  secretSuffix,
  seededRng,
  speechSampleText,
  speechText,
  stateRecord,
  storyText,
  stripPngMetadata,
  toCharacterInput,
  toChatSettingsInput,
  toLorebookInput,
  toPersonaInput,
  toPresetInput,
  visibleSlots,
} from "@open-design/contracts/soul";
import type {
  ActivateLoreInput,
  CareLevel,
  ComposeSoulResult,
  PaStarterCharacter,
  PaStarterRoom,
  SoulHistoryItem,
  SoulLocale,
  SoulReplyContext,
} from "@open-design/contracts/soul";
import { PaError, type PaStore } from "../storage/personal-agent-store.js";
import { paCanReadClass, paMemoryActive, paMemoryMatches, selectPaMemories } from "./personal-agent-context.js";
import { redactPaCredentials } from "./personal-agent-gateway.js";
import { paLoreRegexBudget } from "./personal-agent-soul-regex.js";
import { sniffPaAudio, type PaSpeechPort } from "./personal-agent-soul-speech.js";

export interface PaSoulDeps {
  store: PaStore;
  dataDir: string;
  /** Enterprise mode: the library is shared, and conversations, personas and memories belong to one member each. */
  enterprise?: () => boolean;
  /** False when the organization switched character memory off: no memory is proposed or saved from a chat. */
  memoryEnabled?: () => boolean;
  now?: () => number;                                   // default Date.now
  rng?: () => number;                                   // default Math.random
  core: {
    createAgent(input: PaAgentInput): PersonalAgent;
    createConversation(agentId: string, principalId?: string): PaConversation;   // runs onConversationCreated
    createGroup(input: PaGroupInput): PaGroup;
    groupConversation?(groupId: string, principalId: string): PaConversation;    // a member's own chat of a group
    submit(input: PaTaskInput, soul?: PaTaskSoul): PaTask;
    /** Puts a memory away (it can be restored); nothing is deleted. `principalId`: the member it belongs to. */
    deleteMemory(id: string, principalId?: string): void;
    deleteMemories?(entries: ReadonlyArray<{ id: string; principalId?: string | undefined }>): void;
    /** Without `principalId`, every member's. */
    memories(filter?: { scope?: PaMemoryInput["scope"]; scopeId?: string | null; principalId?: string }): PaMemory[];
    /** Whether text built on these memories may be written into a bot's memory (bot and group memory only). */
    botMayCarry?(refs: ReadonlyArray<{ id: string; revision: number; standing?: boolean }> | undefined, text: string): boolean;
    saveMemory?(input: PaMemoryInput, principalId?: string, context?: { via?: MemoryVia | null; actor?: string }): PaMemory;
    /** What a chat turn of this speaker in this conversation may read; persona facts come shaped as private ones. */
    chatMemories?(conversation: PaConversation, agentId: string): PaMemory[];
    onConversationMessagesChanged?(conversationId: string): void;
    activeChatTasks(conversationId: string): PaTask[];       // chat tasks in the queue map or the active map
    queuedChatTask(conversationId: string): PaTask | null;   // in the queue map, status 'queued', not started
    defaultModel(): PaModel;                                 // the Fantay agent's model
    defaultBudget(): PaTask["budget"];
    promptByteLimit(model: PaModel): number | null;          // argv budget of a local CLI adapter, else null
  };
}
export interface PaImportCardInput {
  card: unknown; fileName?: string; portrait?: { mime: string; data: string }; model?: PaModel; agentId?: string; revision?: number;
  sprites?: Partial<Record<PaEmotion, string>>;
  principalId?: string;                                    // enterprise mode: the member importing, who gets the chat
}
export interface PaImportCardResult<C> {
  agent: PersonalAgent; character: PaCharacterView; lorebook: PaLorebookSummary | null; conversation: C;
  report: { needsReview: PaNeedsReviewItem[]; preservedKeys: string[]; lorebookNeedsReview: PaNeedsReviewItem[] };
}
export interface PaPreparedTurn {
  taskId: string; flat: string; chat: PaChatWire; trace: PaSoulTrace;
  loreTimers: Record<string, PaLoreTimer>; memoryRefs: Array<{ id: string; revision: number; standing?: boolean }>;
  parse: SoulReplyContext; care: CareLevel; locale: SoulLocale;
}
export interface PaCommittedTurn { content: string; soul: PaMessageSoul; after(latest: PaTask): void }

type ChatOrigin = Extract<PaPrincipal, { kind: "channel" | "device" | "enterprise" }>;
type NewMessage = Omit<PaMessage, keyof PaEntity>;
type StoredTrace = PaSoulTrace & PaEntity;
type PersonaRef = { id: string | null; name: string; description: string };
type InstalledStarter = { agent: PersonalAgent; character: PaCharacter; lorebooks: PaLorebook[]; conversation: PaConversation | null };
/** Generated read-aloud audio of one message (collection `soul_speech`, id = message id). */
interface PaSpeechRow extends PaEntity { conversationId: string; agentId: string; assetId: string; key: string; mime: PaSpeechMime; bytes: number }
/** What `speak` needs once every check has passed. */
type SpeechPlan = { message: PaMessage; voice: PaVoice; text: string; language: string; key: string };
interface BuildInput {
  taskId: string | null;
  taskSoul: PaTaskSoul | undefined;
  dataClass: PaDataClass | undefined;
  agent: PersonalAgent;
  conversation: PaConversation;
  memories: readonly PaMemory[];
  draft?: string;
}

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const IN_FLIGHT: ReadonlySet<string> = new Set(["queued", "running", "verifying"]);
const STORY_KINDS: ReadonlySet<string> = new Set(["roll", "draw", "event"]);
const ASSET_EXT: ReadonlyMap<string, "png" | "jpg" | "webp"> = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"],
]);
const ASSET_MIME: ReadonlyMap<string, "image/png" | "image/jpeg" | "image/webp"> = new Map([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["webp", "image/webp"],
]);
const SPEECH_MIME: ReadonlyMap<string, PaSpeechMime> = new Map([
  ["mp3", "audio/mpeg"], ["wav", "audio/wav"], ["ogg", "audio/ogg"], ["m4a", "audio/mp4"],
]);
const SPEECH_KINDS: ReadonlySet<string> = new Set(["chat", "greeting"]);
const SPEECH_WAIT_MS = 90000;                             // a caller waits this long; the generation itself goes on
const SPEECH_PARALLEL = 2;                                // distinct generations at once
const SWEEP_EVERY_MS = 6 * 60 * MINUTE;                   // the file sweep runs at most this often
const SWEEP_GRACE_MS = DAY;                               // an image is uploaded before its form is saved
const SAMPLE_KEEP_MS = 7 * DAY;                           // a voice sample nobody replayed for this long
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const IMPORT_REASON: ReadonlyMap<string, string> = new Map([
  ["bad-json", "文件不是有效的 JSON"],
  ["too-large", "文件太大"],
  ["not-object", "文件内容不是可识别的对象"],
  ["no-name", "角色卡缺少名字"],
  ["unsupported-format", "不支持这种文件格式"],
]);

/** Memory dedupe key: NFKC, case, whitespace and punctuation do not make a sentence new. */
const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
/** Still recalled: forgetting puts it away; one already put away or replaced is left as it is. */
const recalled = (memory: PaMemory) => memory.status === "active" || memory.status === "challenged";
const notFound = (message = "记录不存在") => new PaError(message, 404, "PA_NOT_FOUND");
const conflict = () => new PaError("内容已更新，请刷新后重试", 409, "PA_REVISION_CONFLICT");
const invalid = (message: string) => new PaError(message, 400, "PA_INVALID_REQUEST");
const assetError = (message: string) => new PaError(message, 400, "PA_SOUL_ASSET");
const isStory = (message: Pick<PaMessage, "senderId" | "soul">) =>
  message.senderId === "owner" && STORY_KINDS.has(message.soul?.kind ?? "");
const stripEntity = <T extends PaEntity>(row: T): Omit<T, keyof PaEntity> => {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, revision: _revision, ...rest } = row;
  return rest;
};
const emptyState = (): Omit<PaChatState, keyof PaEntity> => ({
  loreTimers: {}, activeEvent: null, candidateEvent: null, branchOf: null,
  userStateOps: [], traceIds: [], secrets: {}, careAt: null,
});
const matchesMagic = (bytes: Uint8Array, ext: "png" | "jpg" | "webp"): boolean => {
  const at = (index: number) => bytes[index] ?? -1;
  const ascii = (from: number, text: string) => [...text].every((char, index) => at(from + index) === char.charCodeAt(0));
  if (ext === "png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => at(index) === byte);
  if (ext === "jpg") return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
  return bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP");
};
/** End of the server's local day of `YYYY-MM-DD`; null for anything else. */
const endOfLocalDay = (due: string | undefined): number | null => {
  const match = due ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(due) : null;
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
};
/** Local hour and day of `at` in an IANA time zone (the system zone when the name is not usable). */
const zonedParts = (at: number, timeZone: string): { hour: number; day: string } => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(at);
  }
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return { hour: Number(part("hour")) % 24, day: `${part("year")}-${part("month")}-${part("day")}` };
};

export class PaSoulService {
  private readonly store: PaStore;
  private readonly core: PaSoulDeps["core"];
  private readonly rng: () => number;
  private readonly staged = new Map<string, PaPreparedTurn>();
  private speech: PaSpeechPort | null = null;
  private readonly speaking = new Map<string, Promise<unknown>>();        // speech key → running generation
  /** The voice of a character that has none (`PaSpeechStatus.default`), as of the last status read. */
  private fallbackVoice: PaVoice | null = null;
  private sweptAt = 0;
  private counter = 0;
  private readonly boot = randomUUID().slice(0, 8);

  constructor(private readonly deps: PaSoulDeps) {
    this.store = deps.store;
    this.core = deps.core;
    this.rng = deps.rng ?? Math.random;
  }

  // ---- version ---------------------------------------------------------------------------------------------------
  version(): string { return `${this.boot}.${this.counter}`; }
  get revision(): number { return this.counter; }
  private bump(): void { this.counter += 1; }
  /** Puts these memories away in one go (each one as its own member's), and says how many. */
  private archiveAll(memories: readonly PaMemory[]): number {
    const entries = memories.map((memory) => ({ id: memory.id, principalId: memory.principalId }));
    if (this.core.deleteMemories) this.core.deleteMemories(entries);
    else for (const entry of entries) this.core.deleteMemory(entry.id, entry.principalId);
    return entries.length;
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  // ---- internal helpers ------------------------------------------------------------------------------------------
  private card(agentId: string | null | undefined): PaCharacter | null {
    return agentId ? this.store.get<PaCharacter>("characters", agentId) : null;
  }
  private chatRow(conversationId: string): PaChatSettings | null {
    return this.store.get<PaChatSettings>("chat_settings", conversationId);
  }
  private chatDoc(conversationId: string): PaChatSettingsDoc {
    const row = this.chatRow(conversationId);
    return row ? { ...PA_DEFAULT_CHAT_SETTINGS, ...toChatSettingsInput(row) } : PA_DEFAULT_CHAT_SETTINGS;
  }
  private stateRow(conversationId: string): PaChatState {
    return this.store.get<PaChatState>("chat_state", conversationId)
      ?? { id: conversationId, createdAt: 0, updatedAt: 0, revision: 0, ...emptyState() };
  }
  /** Creates the settings row with defaults when it is missing. A new row is a new chat view, so it bumps. */
  private ensureChat(conversationId: string): void {
    if (this.store.has("chat_settings", conversationId)) return;
    this.store.create<PaChatSettings>("chat_settings", { ...PA_DEFAULT_CHAT_SETTINGS }, conversationId);
    this.bump();
  }
  private writeState(conversationId: string, patch: Partial<Omit<PaChatState, keyof PaEntity>>): PaChatState {
    this.ensureChat(conversationId);
    if (this.store.has("chat_state", conversationId))
      return this.store.update<PaChatState>("chat_state", conversationId, patch);
    return this.store.create<PaChatState>("chat_state", { ...emptyState(), ...patch }, conversationId);
  }
  private assertIdle(conversationId: string): void {
    if (this.core.activeChatTasks(conversationId).length)
      throw new PaError("TA 正在回复，请等这一轮结束", 409, "PA_SOUL_BUSY");
  }
  private assertCompanion(conversation: PaConversation): void {
    if (this.modeOf(conversation) !== "companion")
      throw new PaError("这个对话不在聊天模式", 400, "PA_SOUL_MODE");
  }
  private checkRevision(current: PaEntity | null, revision: number | undefined): void {
    if (current && (revision === undefined || current.revision !== revision)) throw conflict();
  }
  private group(conversation: PaConversation): PaGroup | null {
    return conversation.groupId ? this.store.get<PaGroup>("groups", conversation.groupId) : null;
  }
  private agentName(id: string): string {
    const agent = this.store.get<PersonalAgent>("agents", id);
    return this.card(id)?.nickname.trim() || agent?.name || "";
  }
  private enterprise(): boolean { return this.deps.enterprise?.() === true; }
  /** A persona belongs to the member who wrote it; outside enterprise mode nobody is named and every persona matches. */
  private ownPersona(persona: PaPersona, principalId: string | undefined): boolean {
    return (persona.principalId ?? null) === (principalId ?? null);
  }
  private personaFor(conversation: PaConversation, character: PaCharacter | null): PersonaRef {
    const chat = this.chatDoc(conversation.id);
    const owner = conversation.principalId;
    const pick = (id: string | null | undefined) => {
      const found = id ? this.store.get<PaPersona>("personas", id) : null;
      return found && this.ownPersona(found, owner) ? found : null;
    };
    const persona = pick(chat.personaId)
      ?? (conversation.groupId ? null : pick(character?.personaId))
      ?? this.store.list<PaPersona>("personas").find(item => item.isDefault && this.ownPersona(item, owner))
      ?? null;
    return persona ? { id: persona.id, name: persona.name, description: persona.description } : { id: null, name: "", description: "" };
  }
  /** The persona a chat speaks as (without a conversation, the member's default one); memory reads that persona's scope. */
  personaIdFor(conversation: PaConversation | null, agentId: string | null, principalId?: string): string | null {
    if (conversation) return this.personaFor(conversation, this.card(agentId)).id;
    return this.store.list<PaPersona>("personas").find(item => item.isDefault && this.ownPersona(item, principalId))?.id ?? null;
  }
  private presetFor(chat: PaChatSettingsDoc, character: PaCharacter | null, locale: SoulLocale): PaStylePreset {
    return resolvePreset(chat.presetId ?? character?.presetId, this.store.list<PaStylePreset>("presets"), locale);
  }
  private localeFor(character: PaCharacter | null, newestOwnerText: string): SoulLocale {
    return pickPromptLocale([character?.description ?? "", character?.firstMessage ?? "", newestOwnerText]);
  }
  /** The locale of story text and interludes: the direct agent's card (rooms: the moderator's) and the newest owner text. */
  private conversationLocale(conversation: PaConversation, messages: readonly PaMessage[]): SoulLocale {
    const lead = conversation.groupId ? this.group(conversation)?.moderatorId : conversation.agentId;
    let newest = "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && message.senderId === "owner" && !isStory(message)) { newest = message.content; break; }
    }
    return this.localeFor(this.card(lead), newest);
  }
  private toView(character: PaCharacter): PaCharacterView {
    const { preserved, ...rest } = character;
    const preservedKeys = (["root", "data", "extensions", "quarantine"] as const)
      .flatMap(bucket => Object.keys(preserved?.[bucket] ?? {}).map(key => `${bucket}.${key}`));
    return { ...rest, sprites: rest.sprites ?? {}, voice: rest.voice ?? null, preservedKeys };
  }
  private toSummary(lorebook: PaLorebook): PaLorebookSummary {
    const { entries, preserved: _preserved, needsReview, ...rest } = lorebook;
    return {
      ...rest,
      entryCount: entries.length,
      constantCount: entries.filter(entry => entry.constant).length,
      needsReviewCount: needsReview.length,
    };
  }
  private toChatView(conversationId: string): PaChatView {
    const row = this.chatRow(conversationId);
    const state = this.stateRow(conversationId);
    const base: PaChatSettings = row ? { ...PA_DEFAULT_CHAT_SETTINGS, ...row } : { id: conversationId, createdAt: 0, updatedAt: 0, revision: 0, ...PA_DEFAULT_CHAT_SETTINGS };
    return {
      ...base,
      activeEvent: state.activeEvent, candidateEvent: state.candidateEvent,
      branchOf: state.branchOf, userStateOps: state.userStateOps,
    };
  }
  private contextTokens(model: PaModel): number {
    if (model.runtime === "claude") return 200000;
    if (model.runtime === "ollama") return 12000;
    return 32000;
  }
  private isFantayConversation(conversation: PaConversation): boolean {
    const ids = conversation.groupId ? this.group(conversation)?.memberIds ?? [] : [conversation.agentId ?? ""];
    return ids.some(id => this.store.get<PersonalAgent>("agents", id)?.avatar === "fantay");
  }
  private checkRefs(refs: {
    lorebookIds?: readonly string[]; personaId?: string | null; presetId?: string | null; assetIds?: ReadonlyArray<string | null | undefined>;
  }): void {
    for (const id of refs.lorebookIds ?? []) if (!this.store.has("lorebooks", id)) throw invalid("引用的世界书不存在");
    if (refs.personaId && !this.store.has("personas", refs.personaId)) throw invalid("引用的人设不存在");
    if (refs.presetId && !PA_BUILTIN_PRESETS.some(preset => preset.id === refs.presetId) && !this.store.has("presets", refs.presetId))
      throw invalid("引用的文风不存在");
    for (const id of refs.assetIds ?? []) if (id && !existsSync(this.assetPath(id))) throw invalid("引用的图片不存在");
  }
  private postMessage(value: NewMessage): PaMessage {
    const created = this.store.create<PaMessage>("messages", value);
    this.core.onConversationMessagesChanged?.(value.conversationId);
    return created;
  }
  private findByRequest(conversationId: string, requestId: string): PaMessage | null {
    return this.store.listConversationMessages<PaMessage>(conversationId).find(message => message.soul?.requestId === requestId) ?? null;
  }
  private macroText(conversation: PaConversation, character: PaCharacter, source: string): string {
    const agent = this.store.get<PersonalAgent>("agents", character.id);
    const persona = this.personaFor(conversation, character);
    const locale = this.localeFor(character, "");
    const names = resolveNames({ agentName: agent?.name ?? "", nickname: character.nickname, personaName: persona.name, locale });
    const now = this.now();
    return expandMacros(source, {
      char: names.char, user: names.user, persona: persona.description,
      now, timezoneOffsetMin: -new Date(now).getTimezoneOffset(), locale,
      pickSeed: conversation.id, blockId: "greeting", zone: "greeting", rng: this.rng,
    }).slice(0, SOUL_LIMITS.messageContent);
  }
  private postGreeting(conversation: PaConversation, character: PaCharacter): void {
    if (!character.firstMessage.trim()) return;
    const content = this.macroText(conversation, character, character.firstMessage);
    if (!content.trim()) return;
    this.postMessage({
      conversationId: conversation.id, taskId: null, senderId: character.id, content, targetAgentIds: [], replyTo: null,
      soul: { kind: "greeting", greetingIndex: 0, ...(character.openers.length ? { choices: [...character.openers] } : {}) },
    });
  }
  /** First card of an agent: conversations that already hold a task and have no explicit mode stay work chats. */
  private markWorkConversations(agentId: string): void {
    for (const conversation of this.store.list<PaConversation>("conversations")) {
      if (conversation.channelId) continue;
      const group = this.group(conversation);
      const applies = conversation.groupId
        ? Boolean(group && group.memberIds.includes(agentId) && group.memberIds.every(id => this.store.has("characters", id)))
        : conversation.agentId === agentId;
      if (!applies) continue;
      const row = this.chatRow(conversation.id);
      if (row?.mode) continue;
      // Only work already done here makes it a work chat; chat turns (a card removed and re-added) do not.
      const kinds = new Map<string, boolean>();
      const isWork = (taskId: string) => {
        if (!kinds.has(taskId)) kinds.set(taskId, this.store.get<PaTask>("tasks", taskId)?.kind !== "chat");
        return kinds.get(taskId)!;
      };
      if (!this.store.listConversationMessages<PaMessage>(conversation.id).some(message => message.taskId && isWork(message.taskId))) continue;
      if (row) this.store.update<PaChatSettings>("chat_settings", conversation.id, { mode: "work" });
      else this.store.create<PaChatSettings>("chat_settings", { ...PA_DEFAULT_CHAT_SETTINGS, mode: "work" }, conversation.id);
    }
  }
  private newestDirectConversation(agentId: string, principalId?: string): PaConversation | null {
    return this.store.list<PaConversation>("conversations")
      .filter(item => item.agentId === agentId && !item.groupId && !item.channelId
        && (!this.enterprise() || (item.principalId ?? null) === (principalId ?? null)))
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }
  private assetDir(): string {
    return path.join(this.deps.dataDir, "pa", "soul", "assets");
  }
  private assetPath(id: string): string {
    if (!paAssetIdSchema.safeParse(id).success) throw assetError("图片编号无效");
    return path.join(this.assetDir(), id);
  }

  // ---- reads -----------------------------------------------------------------------------------------------------
  /** `principalId` (enterprise mode) is the member the snapshot is for: the library is the same for everyone, while
   *  personas and chat settings are only the member's own (plus the settings of shared work rooms). */
  snapshot(principalId?: string): PaSoulSnapshot {
    const personas = this.store.list<PaPersona>("personas");
    const chats = this.store.list<PaChatSettings>("chat_settings");
    if (!this.enterprise()) {
      return {
        version: this.version(),
        characters: this.store.list<PaCharacter>("characters").map(character => this.toView(character)),
        lorebooks: this.store.list<PaLorebook>("lorebooks").map(book => this.toSummary(book)),
        personas,
        presets: this.store.list<PaStylePreset>("presets"),
        chats: chats.map(row => this.toChatView(row.id)),
      };
    }
    const mine = new Set(personas.filter(persona => this.ownPersona(persona, principalId)).map(persona => persona.id));
    const visible = (conversationId: string) => {
      const owner = this.store.get<PaConversation>("conversations", conversationId)?.principalId;
      return owner === undefined || owner === principalId;
    };
    return {
      version: this.version(),
      characters: this.store.list<PaCharacter>("characters").map(character => {
        const view = this.toView(character);
        return view.personaId && !mine.has(view.personaId) ? { ...view, personaId: null } : view;
      }),
      lorebooks: this.store.list<PaLorebook>("lorebooks").map(book => this.toSummary(book)),
      personas: personas.filter(persona => mine.has(persona.id)),
      presets: this.store.list<PaStylePreset>("presets"),
      chats: chats.filter(row => visible(row.id)).map(row => this.toChatView(row.id)),
    };
  }
  character(agentId: string): PaCharacterView | null {
    const character = this.card(agentId);
    return character ? this.toView(character) : null;
  }
  lorebook(id: string): PaLorebook {
    return this.store.require<PaLorebook>("lorebooks", id);
  }
  chatView(conversationId: string): PaChatView {
    return this.toChatView(conversationId);
  }
  trace(messageId: string): PaSoulTrace | null {
    const row = this.store.get<StoredTrace>("soul_traces", messageId);
    return row ? stripEntity(row) : null;
  }
  modeOf(conversation: PaConversation): "work" | "companion" {
    return resolveChatMode({
      sharedRoom: this.enterprise() && !conversation.principalId,
      explicit: this.chatRow(conversation.id)?.mode ?? null,
      channel: Boolean(conversation.channelId),
      channelCompanion: this.channelCompanion(conversation),
      memberIds: conversation.groupId ? this.group(conversation)?.memberIds ?? [] : null,
      agentId: conversation.agentId,
      hasCard: id => this.store.has("characters", id),
    });
  }
  /** The conversation belongs to a Feishu or WeChat channel whose 聊天模式 is on. */
  private channelCompanion(conversation: PaConversation): boolean {
    return Boolean(conversation.channelId)
      && this.store.get<PaChannel>("channels", conversation.channelId!)?.chatMode === "companion";
  }
  inContext(message: PaMessage): boolean {
    if (!message.soul) return true;
    return isInContext(message, id => this.store.get<PaMessage>("messages", id) ?? undefined);
  }

  // ---- characters ------------------------------------------------------------------------------------------------
  saveCharacter(agentId: string, body: unknown, revision?: number): PaCharacterView {
    const agent = this.store.require<PersonalAgent>("agents", agentId);
    if (agent.avatar === "fantay") throw new PaError("Fantay 不使用角色卡", 409, "PA_SOUL_FANTAY");
    const saved = this.store.transaction(() => {
      const existing = this.card(agentId);
      this.checkRevision(existing, revision);
      const doc = existing
        ? paCharacterInputSchema.parse({ ...toCharacterInput(existing), ...paCharacterPatchSchema.parse(body) })
        : paCharacterInputSchema.parse(body);
      this.checkRefs({ lorebookIds: doc.lorebookIds, personaId: doc.personaId, presetId: doc.presetId, assetIds: [doc.portraitAssetId, ...Object.values(doc.sprites)] });
      if (existing) return this.store.update<PaCharacter>("characters", agentId, doc, existing.revision);
      const created = this.store.create<PaCharacter>("characters", {
        ...doc, origin: { format: "native", name: agent.name, importedAt: this.now() }, preserved: {}, needsReview: [],
      }, agentId);
      this.markWorkConversations(agentId);
      return created;
    });
    this.bump();
    return this.toView(saved);
  }
  removeCharacter(agentId: string, revision: number, forgetMemories: boolean): { ok: true; removedMemories: number } {
    this.store.transaction(() => {
      const existing = this.store.require<PaCharacter>("characters", agentId);
      this.checkRevision(existing, revision);
      this.store.remove("characters", agentId);
    });
    this.bump();
    let removedMemories = 0;
    if (forgetMemories) {
      removedMemories = this.archiveAll(this.core.memories({ scope: "agent", scopeId: agentId }).filter(recalled));
    }
    return { ok: true, removedMemories };
  }
  /** With `agentId` of an agent that already has a card, the import overwrites that card (用角色卡覆盖, addendum 9):
   *  every field a card carries is replaced, together with origin, preserved data and review items. The agent's own
   *  bindings stay: persona, world books bound outside a card (the previous card's embedded book is swapped for the new
   *  one and stays in the library), autoMemory, the portrait when the import brings none, and the style preset when the
   *  card names no built-in one. `revision`, when given, must match the current card. `sprites` are asset ids the
   *  client saved from a CHARX archive; without them an overwrite keeps the existing sprites, and it always keeps the
   *  voice. */
  importCard(input: PaImportCardInput & { open: false }): PaImportCardResult<null>;
  importCard(input: PaImportCardInput): PaImportCardResult<PaConversation>;
  importCard(input: PaImportCardInput & { open?: boolean }): PaImportCardResult<PaConversation | null> {
    const now = this.now();
    const preview = parseCharacterCard(input.card, { ...(input.fileName !== undefined ? { fileName: input.fileName } : {}), now });
    if (!preview.ok) {
      const reason = IMPORT_REASON.get(preview.error) ?? "无法读取";
      throw new PaError(`无法导入角色卡：${reason}${preview.detail ? `（${preview.detail}）` : ""}`, 422, "PA_SOUL_IMPORT");
    }
    const existingAgent = input.agentId ? this.store.require<PersonalAgent>("agents", input.agentId) : null;
    if (existingAgent?.avatar === "fantay") throw new PaError("Fantay 不使用角色卡", 409, "PA_SOUL_FANTAY");
    if (existingAgent && input.revision !== undefined) this.checkRevision(this.card(existingAgent.id), input.revision);
    const agentInput = existingAgent ? null : paAgentInputSchema.parse({
      name: preview.name.slice(0, 60),
      role: `角色扮演：${preview.name}。${preview.character.tagline}`.slice(0, 4000),
      avatar: "",
      model: input.model ?? this.core.defaultModel(),
      enabled: true,
      tools: ["respond"],
    });
    const parsedSprites = paSpritesSchema.safeParse(input.sprites ?? {});
    if (!parsedSprites.success) throw invalid("立绘只能按八种心情保存图片编号");
    const sprites = parsedSprites.data;
    this.checkRefs({ assetIds: Object.values(sprites) });
    let portraitId: string | null = null;
    if (input.portrait) portraitId = this.saveAsset(input.portrait).id;
    else if (preview.portrait) {
      try { portraitId = this.saveAsset(preview.portrait).id; } catch { portraitId = null; }
    }
    try {
      const result = this.store.transaction(() => {
        const agent = existingAgent ?? this.core.createAgent(agentInput!);
        const book = preview.lorebook ? this.store.create<PaLorebook>("lorebooks", {
          ...preview.lorebook,
          ...(preview.lorebookMeta ?? { origin: { format: "card", name: preview.name }, preserved: {}, needsReview: [] }),
        }) : null;
        const previousCard = existingAgent ? this.card(agent.id) : null;
        const presetId = preview.character.presetId && PA_BUILTIN_PRESETS.some(preset => preset.id === preview.character.presetId)
          ? preview.character.presetId : null;
        const doc = paCharacterInputSchema.parse(previousCard ? {
          ...preview.character,
          lorebookIds: [...new Set([
            ...previousCard.lorebookIds.filter(id => this.store.get<PaLorebook>("lorebooks", id)?.origin?.format !== "card"),
            ...(book ? [book.id] : []),
          ])],
          personaId: previousCard.personaId,
          presetId: presetId ?? previousCard.presetId,
          portraitAssetId: portraitId ?? previousCard.portraitAssetId,
          autoMemory: previousCard.autoMemory,
          sprites: Object.keys(sprites).length ? sprites : (previousCard.sprites ?? {}),
          voice: previousCard.voice ?? null,
        } : {
          ...preview.character,
          lorebookIds: book ? [book.id] : [],
          personaId: null,
          presetId,
          portraitAssetId: portraitId,
          sprites,
        });
        const character = previousCard
          ? this.store.update<PaCharacter>("characters", agent.id, { ...doc, ...preview.meta }, previousCard.revision)
          : this.store.create<PaCharacter>("characters", { ...doc, ...preview.meta }, agent.id);
        let conversation: PaConversation | null = null;
        if (existingAgent && !previousCard) this.markWorkConversations(agent.id);
        // `open: false` (an item synced from the organization server): nobody is importing for themselves, so no chat
        // is opened; each member opens their own.
        if (input.open === false) conversation = null;
        else if (existingAgent) {
          const current = this.newestDirectConversation(agent.id, input.principalId);
          if (current) {
            conversation = current;
            if (!this.store.listConversationMessages<PaMessage>(current.id).length) {
              this.ensureChat(current.id);
              this.postGreeting(current, character);
            }
          } else conversation = this.core.createConversation(agent.id, input.principalId);
        } else conversation = this.core.createConversation(agent.id, input.principalId);
        return { agent, character, book, conversation };
      });
      this.bump();
      return {
        agent: result.agent,
        character: this.toView(result.character),
        lorebook: result.book ? this.toSummary(result.book) : null,
        conversation: result.conversation,
        report: {
          needsReview: preview.meta.needsReview,
          preservedKeys: preview.preservedKeys,
          lorebookNeedsReview: preview.lorebookMeta?.needsReview ?? [],
        },
      };
    } catch (error) {
      if (portraitId) {
        try { unlinkSync(this.assetPath(portraitId)); } catch { /* an unreferenced portrait is never served by a card */ }
      }
      throw error;
    }
  }
  exportCard(agentId: string, includeQuarantined: boolean): Record<string, unknown> {
    const character = this.card(agentId);
    if (!character) throw notFound("这个角色还没有角色卡");
    const agent = this.store.require<PersonalAgent>("agents", agentId);
    const lorebooks = character.lorebookIds
      .map(id => this.store.get<PaLorebook>("lorebooks", id))
      .filter((book): book is PaLorebook => book !== null);
    return exportCharacterCard({ name: agent.name, character, lorebooks, now: this.now(), includeQuarantined });
  }
  installStarter(id: string, principalId?: string): {
    agents: PersonalAgent[]; characters: PaCharacterView[]; lorebooks: PaLorebookSummary[];
    group: PaGroup | null; conversation: PaConversation;
  } {
    const starter = PA_STARTERS.find(item => item.id === id);
    if (!starter) throw notFound("入门角色不存在");
    const result = this.store.transaction((): { members: InstalledStarter[]; group: PaGroup | null; conversation: PaConversation } => {
      if (starter.kind === "character") {
        const installed = this.installCharacterStarter(starter, principalId);
        const conversation = installed.conversation
          ?? this.newestDirectConversation(installed.agent.id, principalId)
          ?? this.core.createConversation(installed.agent.id, principalId);
        return { members: [installed], group: null, conversation };
      }
      return this.installRoomStarter(starter, principalId);
    });
    this.bump();
    return {
      agents: result.members.map(member => member.agent),
      characters: result.members.map(member => this.toView(member.character)),
      lorebooks: result.members.flatMap(member => member.lorebooks.map(book => this.toSummary(book))),
      group: result.group,
      conversation: result.conversation,
    };
  }
  private installCharacterStarter(starter: PaStarterCharacter, principalId?: string): InstalledStarter {
    const existing = this.store.list<PaCharacter>("characters")
      .find(item => item.origin?.format === "starter" && item.origin.name === starter.id);
    const existingAgent = existing ? this.store.get<PersonalAgent>("agents", existing.id) : null;
    if (existing && existingAgent) {
      const lorebooks = existing.lorebookIds
        .map(bookId => this.store.get<PaLorebook>("lorebooks", bookId))
        .filter((book): book is PaLorebook => book !== null);
      return { agent: existingAgent, character: existing, lorebooks, conversation: null };
    }
    const agent = this.core.createAgent(paAgentInputSchema.parse({
      name: starter.agent.name, role: starter.agent.role, avatar: "", model: this.core.defaultModel(),
      enabled: true, tools: ["respond"],
    }));
    const book = starter.lorebook ? this.store.create<PaLorebook>("lorebooks", {
      ...paLorebookInputSchema.parse(starter.lorebook),
      origin: { format: "starter", name: starter.id }, preserved: {}, needsReview: [],
    }) : null;
    const doc = paCharacterInputSchema.parse({
      ...starter.character,
      lorebookIds: [...(starter.character.lorebookIds ?? []), ...(book ? [book.id] : [])],
    });
    const character = this.store.create<PaCharacter>("characters", {
      ...doc, origin: { format: "starter", name: starter.id, importedAt: this.now() }, preserved: {}, needsReview: [],
    }, agent.id);
    const conversation = this.core.createConversation(agent.id, principalId);
    return { agent, character, lorebooks: book ? [book] : [], conversation };
  }
  private installRoomStarter(starter: PaStarterRoom, principalId?: string): { members: InstalledStarter[]; group: PaGroup; conversation: PaConversation } {
    const members = starter.group.members.map(memberId => {
      const member = PA_STARTERS.find(item => item.id === memberId);
      if (!member || member.kind !== "character") throw notFound("入门群聊的成员不存在");
      return { starterId: memberId, ...this.installCharacterStarter(member, principalId) };
    });
    const agentOf = (starterId: string) => members.find(member => member.starterId === starterId)?.agent.id;
    const memberIds = members.map(member => member.agent.id);
    const moderatorId = agentOf(starter.group.moderator) ?? memberIds[0]!;
    const same = (ids: readonly string[]) => ids.length === memberIds.length && memberIds.every(item => ids.includes(item));
    let group = this.store.list<PaGroup>("groups").find(item => item.name === starter.group.name && same(item.memberIds)) ?? null;
    if (!group) {
      group = this.core.createGroup({ name: starter.group.name, memberIds, moderatorId, mode: "discussion" });
      const conversation = this.store.require<PaConversation>("conversations", group.conversationId);
      const chat = paChatSettingsInputSchema.parse(starter.chat);
      if (this.chatRow(conversation.id)) this.store.update<PaChatSettings>("chat_settings", conversation.id, chat);
      else this.store.create<PaChatSettings>("chat_settings", chat, conversation.id);
      const speaker = members.find(member => member.starterId === starter.opening.from) ?? members[0]!;
      const content = this.macroText(conversation, speaker.character, starter.opening.text);
      this.postMessage({
        conversationId: conversation.id, taskId: null, senderId: speaker.agent.id, content, targetAgentIds: [], replyTo: null,
        soul: { kind: "greeting", ...(starter.opening.openers.length ? { choices: [...starter.opening.openers] } : {}) },
      });
    }
    // Enterprise mode: the group's own conversation is the shared template; the member chats in a copy of their own.
    const conversation = principalId && this.core.groupConversation
      ? this.core.groupConversation(group.id, principalId)
      : this.store.require<PaConversation>("conversations", group.conversationId);
    return { members, group, conversation };
  }
  /** A group chat is a companion chat when it has members and every one of them has a character card. */
  companionGroup(group: PaGroup): boolean {
    return group.memberIds.length > 0 && group.memberIds.every(id => this.store.has("characters", id));
  }
  /** A member's own conversation of a group chat starts as a copy of the group's shared room: its chat settings and
   *  its opening lines (the room itself holds no member's messages). */
  onGroupConversationCreated(conversation: PaConversation, group: PaGroup): void {
    if (!this.companionGroup(group)) return;
    const template = this.chatRow(group.conversationId);
    const { personaId: _persona, ...settings } = template ? toChatSettingsInput(template) : PA_DEFAULT_CHAT_SETTINGS;
    this.store.create<PaChatSettings>("chat_settings", { ...PA_DEFAULT_CHAT_SETTINGS, ...settings, personaId: null }, conversation.id);
    for (const message of this.store.listConversationMessages<PaMessage>(group.conversationId)) {
      if (message.taskId || message.soul?.kind !== "greeting") continue;
      this.postMessage({
        conversationId: conversation.id, taskId: null, senderId: message.senderId, content: message.content,
        targetAgentIds: [], replyTo: null, soul: { ...message.soul },
      });
    }
    this.bump();
  }
  onAgentCloned(sourceId: string, copyId: string): void {
    const source = this.card(sourceId);
    if (!source) return;
    this.store.create<PaCharacter>("characters", stripEntity(source), copyId);
    this.bump();
  }

  // ---- lorebooks, personas, presets ------------------------------------------------------------------------------
  saveLorebook(body: unknown, id?: string, revision?: number): PaLorebookSummary {
    const saved = this.store.transaction(() => {
      if (id) {
        const existing = this.store.require<PaLorebook>("lorebooks", id);
        this.checkRevision(existing, revision);
        const doc = paLorebookInputSchema.parse({ ...toLorebookInput(existing), ...paLorebookPatchSchema.parse(body) });
        return this.store.update<PaLorebook>("lorebooks", id, doc, existing.revision);
      }
      const doc = paLorebookInputSchema.parse(body);
      return this.store.create<PaLorebook>("lorebooks", {
        ...doc, origin: { format: "native", name: doc.name }, preserved: {}, needsReview: [],
      });
    });
    this.bump();
    return this.toSummary(saved);
  }
  removeLorebook(id: string, revision: number): { ok: true } {
    this.store.transaction(() => {
      this.checkRevision(this.store.require<PaLorebook>("lorebooks", id), revision);
      this.store.remove("lorebooks", id);
      for (const character of this.store.list<PaCharacter>("characters"))
        if (character.lorebookIds.includes(id))
          this.store.update<PaCharacter>("characters", character.id, { lorebookIds: character.lorebookIds.filter(item => item !== id) });
      const prefix = `${id}:`;
      for (const row of this.store.list<PaChatSettings>("chat_settings")) {
        if (!row.lorebookIds.includes(id) && !row.disabledLoreEntryIds.some(key => key.startsWith(prefix))) continue;
        this.store.update<PaChatSettings>("chat_settings", row.id, {
          lorebookIds: row.lorebookIds.filter(item => item !== id),
          disabledLoreEntryIds: row.disabledLoreEntryIds.filter(key => !key.startsWith(prefix)),
        });
      }
    });
    this.bump();
    return { ok: true };
  }
  importWorld(input: { world: unknown; name?: string; fileName?: string; agentId?: string; lorebookId?: string }): {
    lorebook: PaLorebookSummary; report: PaNeedsReviewItem[];
  } {
    const preview = importWorldInfo(input.world, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
    });
    if (!preview.ok) {
      const reason = IMPORT_REASON.get(preview.error) ?? "无法读取";
      throw new PaError(`无法导入世界书：${reason}${preview.detail ? `（${preview.detail}）` : ""}`, 422, "PA_SOUL_IMPORT");
    }
    const book = this.store.transaction(() => {
      // `lorebookId` replaces that world book in place (a synced item that changed), keeping every binding to it.
      if (input.lorebookId) return this.store.update<PaLorebook>("lorebooks", input.lorebookId, { ...preview.lorebook, ...preview.meta });
      const created = this.store.create<PaLorebook>("lorebooks", { ...preview.lorebook, ...preview.meta });
      if (input.agentId) {
        const character = this.card(input.agentId);
        if (!character) throw notFound("这个角色还没有角色卡");
        const doc = paCharacterInputSchema.parse({ ...toCharacterInput(character), lorebookIds: [...character.lorebookIds, created.id] });
        this.store.update<PaCharacter>("characters", character.id, { lorebookIds: doc.lorebookIds });
      }
      return created;
    });
    this.bump();
    return { lorebook: this.toSummary(book), report: preview.meta.needsReview };
  }
  exportWorld(id: string): Record<string, unknown> {
    return exportWorldInfo(this.store.require<PaLorebook>("lorebooks", id));
  }
  testLorebook(input: {
    lorebook?: unknown; lorebookId?: string; messages: readonly string[]; index?: number; names?: { char: string; user: string };
  }): { trace: PaSoulTraceLore[]; used: number; limit: number } {
    let book: ActivateLoreInput["books"][number]["book"];
    if (input.lorebook !== undefined) book = { id: "draft", ...paLorebookInputSchema.parse(input.lorebook) };
    else if (input.lorebookId) book = this.store.require<PaLorebook>("lorebooks", input.lorebookId);
    else throw invalid("请提供世界书内容或编号");
    const result = activateLore({
      books: [{ book, rank: 1 }],
      disabled: new Set(),
      messages: input.messages,
      extraScan: [],
      index: input.index ?? input.messages.length,
      timers: {},
      names: input.names ?? { char: "", user: "" },
      regexTest: paLoreRegexBudget(),
      rng: seededRng("test"),
    });
    return { trace: result.trace, used: result.used, limit: result.limit };
  }
  /** The persona `id` when it is the caller's own; another member's persona does not exist for this caller. */
  private persona(id: string, principalId: string | undefined): PaPersona {
    const found = this.store.require<PaPersona>("personas", id);
    if (!this.ownPersona(found, principalId)) throw notFound();
    return found;
  }
  savePersona(body: unknown, id?: string, revision?: number, principalId?: string): PaPersona {
    const saved = this.store.transaction(() => {
      const existing = id ? this.persona(id, principalId) : null;
      this.checkRevision(existing, revision);
      const others = this.store.list<PaPersona>("personas").filter(item => item.id !== id && this.ownPersona(item, principalId));
      const parsed = existing
        ? paPersonaInputSchema.parse({ ...toPersonaInput(existing), ...paPersonaPatchSchema.parse(body) })
        : paPersonaInputSchema.parse(body);
      const doc = !existing && !others.length ? { ...parsed, isDefault: true } : parsed;
      this.checkRefs({ assetIds: [doc.avatarAssetId] });
      if (doc.isDefault)
        for (const other of others)
          if (other.isDefault) this.store.update<PaPersona>("personas", other.id, { isDefault: false });
      return existing
        ? this.store.update<PaPersona>("personas", existing.id, doc, existing.revision)
        : this.store.create<PaPersona>("personas", { ...doc, ...(principalId ? { principalId } : {}) });
    });
    this.bump();
    return saved;
  }
  removePersona(id: string, revision: number, principalId?: string): { ok: true } {
    this.store.transaction(() => {
      const existing = this.persona(id, principalId);
      this.checkRevision(existing, revision);
      this.store.remove("personas", id);
      for (const character of this.store.list<PaCharacter>("characters"))
        if (character.personaId === id) this.store.update<PaCharacter>("characters", character.id, { personaId: null });
      for (const row of this.store.list<PaChatSettings>("chat_settings"))
        if (row.personaId === id) this.store.update<PaChatSettings>("chat_settings", row.id, { personaId: null });
      const remaining = this.store.list<PaPersona>("personas").filter(item => this.ownPersona(item, principalId));
      if (existing.isDefault && remaining.length && !remaining.some(item => item.isDefault)) {
        const oldest = [...remaining].sort((a, b) => a.createdAt - b.createdAt)[0]!;
        this.store.update<PaPersona>("personas", oldest.id, { isDefault: true });
      }
    });
    this.bump();
    return { ok: true };
  }
  savePreset(body: unknown, id?: string, revision?: number): PaStylePreset {
    if (id?.startsWith("builtin:")) throw invalid("内置文风不能修改，请另存一份");
    const saved = this.store.transaction(() => {
      const existing = id ? this.store.require<PaStylePreset>("presets", id) : null;
      this.checkRevision(existing, revision);
      const doc = existing
        ? paStylePresetInputSchema.parse({ ...toPresetInput(existing), ...paStylePresetPatchSchema.parse(body) })
        : paStylePresetInputSchema.parse(body);
      return existing
        ? this.store.update<PaStylePreset>("presets", existing.id, doc, existing.revision)
        : this.store.create<PaStylePreset>("presets", doc);
    });
    this.bump();
    return saved;
  }
  removePreset(id: string, revision: number): { ok: true } {
    if (id.startsWith("builtin:")) throw invalid("内置文风不能删除");
    this.store.transaction(() => {
      this.checkRevision(this.store.require<PaStylePreset>("presets", id), revision);
      this.store.remove("presets", id);
      for (const character of this.store.list<PaCharacter>("characters"))
        if (character.presetId === id) this.store.update<PaCharacter>("characters", character.id, { presetId: null });
      for (const row of this.store.list<PaChatSettings>("chat_settings"))
        if (row.presetId === id) this.store.update<PaChatSettings>("chat_settings", row.id, { presetId: null });
    });
    this.bump();
    return { ok: true };
  }

  // ---- chats -----------------------------------------------------------------------------------------------------
  saveChat(conversationId: string, body: unknown, revision?: number): PaChatView {
    const conversation = this.store.require<PaConversation>("conversations", conversationId);
    this.store.transaction(() => {
      const row = this.chatRow(conversationId);
      this.checkRevision(row, revision);
      const doc = row
        ? paChatSettingsInputSchema.parse({ ...PA_DEFAULT_CHAT_SETTINGS, ...toChatSettingsInput(row), ...paChatSettingsPatchSchema.parse(body) })
        : paChatSettingsInputSchema.parse(body);
      if (doc.mode === "companion" && this.isFantayConversation(conversation))
        throw new PaError("和 Fantay 的对话不能切换为聊天模式", 409, "PA_SOUL_FANTAY");
      // A channel chat takes its mode from the channel's own 聊天模式 switch, never from a chat setting alone.
      if (doc.mode === "companion" && conversation.channelId && !this.channelCompanion(conversation))
        throw new PaError("渠道对话的聊天模式在连接设置里开启", 400, "PA_SOUL_MODE");
      this.checkRefs({ lorebookIds: doc.lorebookIds, personaId: doc.personaId, presetId: doc.presetId });
      if (doc.personaId && !this.ownPersona(this.store.require<PaPersona>("personas", doc.personaId), conversation.principalId))
        throw invalid("引用的人设不存在");
      if (row) this.store.update<PaChatSettings>("chat_settings", conversationId, doc, row.revision);
      else this.store.create<PaChatSettings>("chat_settings", doc, conversationId);
    });
    this.bump();
    return this.toChatView(conversationId);
  }
  applyStateOps(conversationId: string, ops: readonly PaStateOp[]): PaChatView {
    const conversation = this.store.require<PaConversation>("conversations", conversationId);
    const character = conversation.groupId ? null : this.card(conversation.agentId);
    const schema = character?.stateSchema ?? [];
    if (!schema.length || this.modeOf(conversation) !== "companion")
      throw new PaError("这个对话没有状态栏", 409, "PA_SOUL_STATE");
    this.store.transaction(() => {
      const slots = chatStateSlots(this.store.listConversationMessages<PaMessage>(conversationId));
      const after = slots[slots.length - 1]?.slotId ?? null;
      let userOps: PaUserStateOp[] = [...this.stateRow(conversationId).userStateOps];
      const state = foldChatState(schema, slots, userOps);
      for (const op of ops) {
        if (!applyOp(schema, state, op, "user")) throw invalid(`状态修改无效：${op.key}`);
        if (op.op === "set") userOps = userOps.filter(item => !(item.after === after && item.key === op.key));
        userOps.push({ key: op.key, op: op.op, value: Array.isArray(op.value) ? [...op.value] : op.value, after });
      }
      if (userOps.length > SOUL_LIMITS.userStateOps)
        throw new PaError("状态修改记录太多了", 409, "PA_SOUL_LIMIT");
      this.writeState(conversationId, { userStateOps: userOps });
    });
    this.bump();
    return this.toChatView(conversationId);
  }

  // ---- assets ----------------------------------------------------------------------------------------------------
  saveAsset(input: { mime: string; data: string }): { id: string } {
    const ext = ASSET_EXT.get(input.mime);
    if (!ext) throw assetError("只支持 PNG、JPEG 或 WebP 图片");
    const text = typeof input.data === "string" ? input.data.replace(/^data:[^,]*;base64,/, "") : "";
    if (!text || text.length > Math.ceil(SOUL_LIMITS.assetBytes / 3) * 4 + 8) throw assetError("图片太大或为空");
    let bytes = base64ToBytes(text);
    if (!bytes || !bytes.length) throw assetError("图片数据无效");
    if (bytes.length > SOUL_LIMITS.assetBytes) throw assetError("图片太大");
    if (!matchesMagic(bytes, ext)) throw assetError("图片内容与类型不符");
    if (ext === "png") bytes = stripPngMetadata(bytes);
    const id = `${randomUUID()}.${ext}`;
    mkdirSync(this.assetDir(), { recursive: true, mode: 0o700 });
    writeFileSync(this.assetPath(id), bytes, { mode: 0o600, flag: "wx" });
    return { id };
  }
  readAsset(id: string): { bytes: Buffer; mime: "image/png" | "image/jpeg" | "image/webp" } {
    const file = this.assetPath(id);
    const mime = ASSET_MIME.get(id.slice(id.lastIndexOf(".") + 1));
    if (!mime) throw assetError("图片编号无效");
    try {
      return { bytes: readFileSync(file), mime };
    } catch {
      throw notFound("图片不存在");
    }
  }

  // ---- speech (read aloud) ---------------------------------------------------------------------------------------
  /** The server attaches the media-backed port; without one nothing can be read aloud and every check says so. */
  attachSpeech(port: PaSpeechPort | null): void {
    this.speech = port;
  }
  async speechStatus(): Promise<PaSpeechStatus> {
    if (!this.speech) {
      this.fallbackVoice = null;
      return { available: false, models: [] };
    }
    try {
      const status = await this.speech.status();
      this.fallbackVoice = status.default ?? null;
      return status;
    } catch (error) {
      throw this.speechFailed("读取语音服务失败", error);
    }
  }
  async speechVoices(model: string): Promise<PaSpeechVoices> {
    if (!this.speech) return { model, voices: [] };
    try {
      return { model, voices: await this.speech.voices(model) };
    } catch (error) {
      throw this.speechFailed("读取音色失败", error);
    }
  }
  /** Audio that is still current: the message exists, its text and its character's voice still give the stored key. */
  listSpeech(conversationId: string): PaSpeechItem[] {
    if (!this.speech || this.chatDoc(conversationId).voiceReplies === "off") return [];
    const items: PaSpeechItem[] = [];
    for (const row of this.store.list<PaSpeechRow>("soul_speech")) {
      if (row.conversationId !== conversationId) continue;
      const message = this.store.get<PaMessage>("messages", row.id);
      const voice = message ? this.voiceOf(message) : null;
      if (!message || !voice || !this.speakable(message) || message.dataClass === "local_only") continue;
      if (this.speechKey(message.id, speechText(message.content), voice).key !== row.key) continue;
      if (!this.speechExists(row.assetId)) continue;
      items.push({ messageId: row.id, id: row.assetId, mime: row.mime, bytes: row.bytes, cached: true });
    }
    return items;
  }
  /** Reads a reply aloud: the stored file when text and voice are unchanged, else one generation through the port.
   *  The caller waits at most SPEECH_WAIT_MS; a later success still fills the cache. */
  async speak(messageId: string): Promise<PaSpeechItem> {
    const plan = await this.speechPlan(messageId);
    const row = this.store.get<PaSpeechRow>("soul_speech", messageId);
    if (row && row.key === plan.key && this.speechExists(row.assetId))
      return { messageId, id: row.assetId, mime: row.mime, bytes: row.bytes, cached: true };
    return this.awaitSpeech(plan.key, () => this.generateSpeech(plan));
  }
  /** 试听: the voice as picked in the editor (saved or not) reads a short line. The audio is cached by text and voice
   *  like a reply's but belongs to no message, so it has no `soul_speech` row; the file sweep removes it once nobody
   *  has replayed it for SAMPLE_KEEP_MS. */
  async previewSpeech(body: unknown): Promise<PaSpeechPreview> {
    const input = paSpeechPreviewInputSchema.parse(body);
    const status = await this.speechStatus();
    if (!status.models.some(model => model.id === input.model && model.configured))
      throw new PaError("没有可用的语音服务，请先在设置里添加语音提供商", 409, "PA_SOUL_SPEECH_UNAVAILABLE");
    const text = speechText(input.text) || speechSampleText(input.language);
    const voice: PaVoice = { model: input.model, voice: input.voice, language: input.language };
    const language = voice.language || pickPromptLocale([text]);
    const key = sha256(["preview", sha256(text), voice.model, voice.voice, language].join("\0"));
    const stored = this.storedSpeech(key);
    if (stored) {
      const at = new Date(this.now());
      try { utimesSync(this.speechFile(stored.assetId), at, at); } catch { /* the age only delays the sweep */ }
      return { id: stored.assetId, mime: stored.mime, bytes: stored.bytes, cached: true };
    }
    return this.awaitSpeech(key, async () => {
      const made = await this.renderSpeech(key, voice, language, text);
      return { id: made.assetId, mime: made.mime, bytes: made.bytes, cached: false };
    });
  }
  /** Joins the running generation of `key` or starts one (SPEECH_PARALLEL at once). The caller waits at most
   *  SPEECH_WAIT_MS; the generation itself goes on. */
  private async awaitSpeech<T>(key: string, start: () => Promise<T>): Promise<T> {
    let job = this.speaking.get(key) as Promise<T> | undefined;
    if (!job) {
      if (this.speaking.size >= SPEECH_PARALLEL) throw new PaError("正在生成别的语音，请稍等", 429, "PA_SOUL_SPEECH_BUSY");
      const started = start().finally(() => this.speaking.delete(key));
      started.catch(() => undefined);                    // a caller that timed out no longer listens
      this.speaking.set(key, started);
      job = started;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PaError("语音生成超时，稍后再点一次朗读", 504, "PA_SOUL_SPEECH_TIMEOUT")), SPEECH_WAIT_MS);
    });
    try {
      return await Promise.race([job, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  readSpeech(id: string): { file: string; mime: PaSpeechMime; bytes: number } {
    const file = this.speechFile(id);
    const mime = SPEECH_MIME.get(id.slice(id.lastIndexOf(".") + 1));
    if (!mime) throw assetError("语音编号无效");
    try {
      const stat = statSync(file);
      if (stat.isFile()) return { file, mime, bytes: stat.size };
    } catch { /* answered below */ }
    throw notFound("语音不存在");
  }
  private speechDir(): string {
    return path.join(this.deps.dataDir, "pa", "soul", "speech");
  }
  /** Validates a speech id before any path join. */
  private speechFile(id: string): string {
    if (!paSpeechIdSchema.safeParse(id).success) throw assetError("语音编号无效");
    return path.join(this.speechDir(), id);
  }
  private speechExists(id: string): boolean {
    return paSpeechIdSchema.safeParse(id).success && existsSync(path.join(this.speechDir(), id));
  }
  /** The file generated for `key`, whichever container the service answered with. */
  private storedSpeech(key: string): { assetId: string; mime: PaSpeechMime; bytes: number } | null {
    for (const [ext, mime] of SPEECH_MIME) {
      const assetId = `${key}.${ext}`;
      try {
        const stat = statSync(this.speechFile(assetId));
        if (stat.isFile()) return { assetId, mime, bytes: stat.size };
      } catch { /* the next container */ }
    }
    return null;
  }
  private unlinkSpeech(id: string): void {
    try { unlinkSync(this.speechFile(id)); } catch { /* already gone */ }
  }
  private dropSpeech(messageId: string): void {
    const row = this.store.get<PaSpeechRow>("soul_speech", messageId);
    if (!row) return;
    this.store.remove("soul_speech", messageId);
    this.unlinkSpeech(row.assetId);
  }
  /** Owner messages and story records are never read aloud. */
  private speakable(message: PaMessage): boolean {
    return message.senderId !== "owner" && SPEECH_KINDS.has(message.soul?.kind ?? "");
  }
  /** A message is read with its sender's character voice; rooms therefore use one voice per speaker. A character
   *  without a voice of its own uses the default one of the last status read (TokenToSea's, when signed in). */
  private voiceOf(message: PaMessage): PaVoice | null {
    return this.card(message.senderId)?.voice ?? this.fallbackVoice;
  }
  /** A new text, voice or language is a new file. */
  private speechKey(messageId: string, text: string, voice: PaVoice): { key: string; language: string } {
    const language = voice.language || pickPromptLocale([text]);
    return { language, key: sha256([messageId, sha256(text), voice.model, voice.voice, language].join("\0")) };
  }
  private speechFailed(prefix: string, error: unknown): PaError {
    const detail = redactPaCredentials(error instanceof Error ? error.message : String(error)).slice(0, 200);
    return new PaError(`${prefix}：${detail}`, 502, "PA_SOUL_SPEECH_FAILED");
  }
  /** The checks of `speak`, in order; each answers with its own code. */
  private async speechPlan(messageId: string): Promise<SpeechPlan> {
    const message = this.store.get<PaMessage>("messages", messageId);
    if (!message) throw notFound("消息不存在");
    if (!this.speakable(message)) throw new PaError("这条消息不能朗读", 400, "PA_SOUL_SPEECH");
    // Every speech provider is remote; a local-only reply never leaves the device.
    if (message.dataClass === "local_only") throw new PaError("仅限本机的消息不能朗读", 409, "PA_SOUL_SPEECH_LOCAL");
    if (this.chatDoc(message.conversationId).voiceReplies === "off")
      throw new PaError("这个对话关闭了语音回复", 409, "PA_SOUL_SPEECH_OFF");
    // The status first: it carries the default voice of a character that has none.
    const status = await this.speechStatus();
    const voice = this.voiceOf(message);
    if (!voice) throw new PaError("这个角色还没有设置声音", 409, "PA_SOUL_VOICE_UNSET");
    if (!status.models.some(model => model.id === voice.model && model.configured))
      throw new PaError("没有可用的语音服务，请先在设置里添加语音提供商", 409, "PA_SOUL_SPEECH_UNAVAILABLE");
    const text = speechText(message.content);
    if (!text) throw new PaError("这条消息不能朗读", 400, "PA_SOUL_SPEECH");
    if (Array.from(text).length > SOUL_LIMITS.speechChars) throw new PaError("这条太长，不能朗读", 413, "PA_SOUL_SPEECH_LONG");
    const { key, language } = this.speechKey(message.id, text, voice);
    return { message, voice, text, language, key };
  }
  /** One generation through the port, written as `<key>.<container>`. */
  private async renderSpeech(key: string, voice: PaVoice, language: string, text: string):
    Promise<{ assetId: string; mime: PaSpeechMime; bytes: number }> {
    const port = this.speech;
    if (!port) throw new PaError("没有可用的语音服务，请先在设置里添加语音提供商", 409, "PA_SOUL_SPEECH_UNAVAILABLE");
    let audio: Awaited<ReturnType<PaSpeechPort["synthesize"]>>;
    try {
      audio = await port.synthesize({ model: voice.model, voice: voice.voice, language, text });
    } catch (error) {
      throw this.speechFailed("语音生成失败", error);
    }
    // The port already refuses non-audio; the file name and type are derived here again, never taken on trust.
    const kind = audio && Buffer.isBuffer(audio.bytes) ? sniffPaAudio(audio.bytes) : null;
    if (!kind) throw new PaError("语音生成失败：返回的不是音频", 502, "PA_SOUL_SPEECH_FAILED");
    const assetId = `${key}.${kind.ext}`;
    const file = this.speechFile(assetId);
    mkdirSync(this.speechDir(), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, audio.bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;   // the same name is the same audio
    }
    return { assetId, mime: kind.mime, bytes: audio.bytes.length };
  }
  private async generateSpeech(plan: SpeechPlan): Promise<PaSpeechItem> {
    const { assetId, mime, bytes } = await this.renderSpeech(plan.key, plan.voice, plan.language, plan.text);
    const messageId = plan.message.id;
    const message = this.store.get<PaMessage>("messages", messageId);
    if (!message) {
      this.unlinkSpeech(assetId);
      throw notFound("消息不存在");
    }
    const previous = this.store.get<PaSpeechRow>("soul_speech", messageId);
    const fields = { conversationId: message.conversationId, agentId: message.senderId, assetId, key: plan.key, mime, bytes };
    if (previous) this.store.update<PaSpeechRow>("soul_speech", messageId, fields);
    else this.store.create<PaSpeechRow>("soul_speech", fields, messageId);
    if (previous && previous.assetId !== assetId) this.unlinkSpeech(previous.assetId);
    return { messageId, id: assetId, mime, bytes, cached: false };
  }

  // ---- file sweep ------------------------------------------------------------------------------------------------
  /** Removes stored files nothing refers to any more. Images: an upload whose form was never saved, a replaced
   *  portrait or sprite, the pictures of a deleted character. Audio: the file of a message that is gone, and voice
   *  samples nobody replayed for SAMPLE_KEEP_MS. A file younger than SWEEP_GRACE_MS always stays, because an editor
   *  uploads an image before its form is saved and a generation writes its file before its row. Files this service
   *  did not name are left alone. Called from the service's maintenance tick; it runs at most every SWEEP_EVERY_MS
   *  unless `force` is set. */
  sweepFiles(force = false): { images: number; audio: number } | null {
    const now = this.now();
    if (!force && this.sweptAt && now - this.sweptAt < SWEEP_EVERY_MS) return null;
    this.sweptAt = now;
    const usedImages = new Set<string>();
    for (const character of this.store.list<PaCharacter>("characters")) {
      if (character.portraitAssetId) usedImages.add(character.portraitAssetId);
      for (const id of Object.values(character.sprites ?? {})) if (id) usedImages.add(id);
    }
    for (const persona of this.store.list<PaPersona>("personas")) if (persona.avatarAssetId) usedImages.add(persona.avatarAssetId);
    const usedAudio = new Set<string>();
    let orphaned = 0;
    for (const row of this.store.list<PaSpeechRow>("soul_speech")) {
      if (this.store.has("messages", row.id)) usedAudio.add(row.assetId);
      else {
        this.store.remove("soul_speech", row.id);
        if (this.speechExists(row.assetId)) orphaned += 1;
        this.unlinkSpeech(row.assetId);
      }
    }
    const sweep = (dir: string, mine: (name: string) => boolean, used: ReadonlySet<string>, keepMs: number): number => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return 0; }
      let removed = 0;
      for (const name of names) {
        if (!mine(name) || used.has(name)) continue;
        const file = path.join(dir, name);
        try {
          const stat = statSync(file);
          if (!stat.isFile() || now - stat.mtimeMs < keepMs) continue;
          unlinkSync(file);
          removed += 1;
        } catch { /* gone or unreadable: the next sweep looks again */ }
      }
      return removed;
    };
    return {
      images: sweep(this.assetDir(), name => paAssetIdSchema.safeParse(name).success, usedImages, SWEEP_GRACE_MS),
      audio: orphaned + sweep(this.speechDir(), name => paSpeechIdSchema.safeParse(name).success, usedAudio, SAMPLE_KEEP_MS),
    };
  }

  // ---- submit hooks ----------------------------------------------------------------------------------------------
  /** Task options a chat turn never takes. `SVC.submit` calls this first, ahead of its own capability checks for those
   *  options, so a chat request carrying them always answers 400 `PA_SOUL_MODE`. */
  assertChatInput(input: PaTaskInput): void {
    if (input.execution || input.projectId || input.completionCriteria)
      throw new PaError("聊天回合不支持这些任务选项", 400, "PA_SOUL_MODE");
  }
  /** A chat turn comes from the desktop, from the channel a conversation belongs to once that channel is in chat mode
   *  (`modeOf` answers work for any other channel chat), or in enterprise mode from the member who owns the
   *  conversation. Never from a paired device, and never from a member into a conversation that is not theirs. */
  assertChatAllowed(input: PaTaskInput, conversation: PaConversation, origin?: ChatOrigin): void {
    const fromOwnChannel = origin?.kind === "channel" && Boolean(conversation.channelId) && origin.id === conversation.channelId;
    const fromOwner = origin?.kind === "enterprise" && conversation.principalId === origin.id;
    if (origin !== undefined && !fromOwnChannel && !fromOwner)
      throw new PaError("聊天消息只能从本机桌面、已开启聊天模式的渠道或对话所属成员发送", 403, "PA_SOUL_ORIGIN");
    this.assertChatInput(input);
    if (this.modeOf(conversation) !== "companion")
      throw new PaError("这个对话不在聊天模式", 400, "PA_SOUL_MODE");
  }
  /** What a finished chat turn sends back to its channel: each reply of the turn as written, without card markup and
   *  with the speaker's name in front in a group chat, then the care line when the turn was a care case (the reply was
   *  told the app shows it beside the message, and a channel has no app beside it). Null when nothing can be sent. */
  channelReply(task: PaTask): { text: string; care: string | null } | null {
    if (task.kind !== "chat") return null;
    const conversation = this.store.get<PaConversation>("conversations", task.conversationId);
    if (!conversation) return null;
    const turn = this.store.listConversationMessages<PaMessage>(conversation.id).filter(message => message.taskId === task.id);
    const lines = turn
      .filter(message => message.senderId !== "owner" && message.soul?.kind === "chat" && this.inContext(message))
      .map(message => {
        const body = foldCardMarkup(message.content).filter(part => part.kind === "text").map(part => part.text).join("").trim();
        return body && conversation.groupId ? `${this.agentName(message.senderId)}：${body}` : body;
      })
      .filter(Boolean);
    if (!lines.length) return null;
    const care = turn.some(message => message.senderId === "owner" && message.soul?.care === "crisis");
    return { text: lines.join("\n\n"), care: care ? SOUL_TEXT[this.conversationLocale(conversation, turn)]["care.card"] : null };
  }
  coalesce(input: PaTaskInput, conversation: PaConversation): PaTask | null {
    const same = this.findByRequest(conversation.id, input.requestId);
    if (same) {
      if (!same.taskId) throw new PaError("请求标识已被使用", 409, "PA_IDEMPOTENCY_CONFLICT");
      return this.store.require<PaTask>("tasks", same.taskId);
    }
    const target = this.core.queuedChatTask(conversation.id);
    if (!target || target.soul) return null;
    if ((input.dataClass ?? "standard") !== (target.dataClass ?? "standard")) return null;
    if (conversation.groupId) {
      const group = this.group(conversation);
      const members = (group?.memberIds ?? []).map(id => ({ id, names: this.memberNames(id) }));
      if (input.targetAgentIds.length || input.replyTo || mentionsEveryone(input.goal) || mentionedMembers(input.goal, members).length)
        return null;
    }
    this.postMessage({
      conversationId: conversation.id, taskId: target.id, senderId: "owner", content: input.goal,
      targetAgentIds: [], replyTo: null,
      ...(input.dataClass ? { dataClass: input.dataClass } : {}),
      soul: this.ownerSoul(input, conversation),
    });
    return target;
  }
  private memberNames(agentId: string): string[] {
    const agent = this.store.get<PersonalAgent>("agents", agentId);
    const nickname = this.card(agentId)?.nickname.trim();
    return [agent?.name ?? "", ...(nickname ? [nickname] : [])].filter(name => name.trim());
  }
  participants(input: PaTaskInput, conversation: PaConversation, group: PaGroup | null): string[] {
    if (!group) return conversation.agentId ? [conversation.agentId] : [];
    const eligible = group.memberIds.filter(id => {
      const agent = this.store.get<PersonalAgent>("agents", id);
      return Boolean(agent?.enabled && agent.tools.includes("respond"));
    });
    let selected = mentionedMembers(input.goal, eligible.map(id => ({ id, names: this.memberNames(id) })));
    if (!selected.length && mentionsEveryone(input.goal)) selected = [...eligible];
    if (!selected.length) {
      const strategy = this.chatDoc(conversation.id).groupStrategy;
      if (strategy === "list") selected = [...eligible];
      else if (strategy === "manual") {
        const moderator = eligible.includes(group.moderatorId) ? group.moderatorId : eligible[0];
        selected = moderator ? [moderator] : [];
      } else {
        const messages = this.store.listConversationMessages<PaMessage>(conversation.id);
        const newest = messages[messages.length - 1];
        const previous = newest && newest.senderId !== "owner" ? newest.senderId : null;
        const speaker = pickNaturalSpeaker(
          eligible.map(id => ({ id, talkativeness: this.card(id)?.talkativeness ?? 0.5 })), previous, this.rng);
        selected = speaker ? [speaker] : [];
      }
    }
    if (detectCrisis([input.goal]).level === "crisis") selected = selected.slice(0, 1);
    selected = selected.slice(0, SOUL_LIMITS.speakersPerTurn);
    if (!selected.length) throw new PaError("群聊里暂时没有能回复的角色", 400, "PA_SOUL_NO_SPEAKER");
    return selected;
  }
  ownerSoul(input: PaTaskInput, conversation: PaConversation): PaMessageSoul {
    const character = this.card(conversation.groupId ? this.group(conversation)?.moderatorId : conversation.agentId);
    const previous = this.store.listConversationMessages<PaMessage>(conversation.id)
      .filter(message => message.senderId === "owner" && !isStory(message) && message.soul?.hidden !== true)
      .slice(-2).reverse().map(message => message.content);
    const locale = this.localeFor(character, input.goal);
    const preset = this.presetFor(this.chatDoc(conversation.id), character, locale);
    const crisis = detectCrisis([input.goal, ...previous], { fiction: preset.id === "builtin:game-master" }).level === "crisis";
    const persona = this.personaFor(conversation, character);
    return { kind: "chat", personaId: persona.id, requestId: input.requestId, ...(crisis ? { care: "crisis" as const } : {}) };
  }
  chatBudget(speakers: number): PaTask["budget"] {
    const count = Math.max(1, speakers);
    return { maxAttempts: Math.min(12, count + 2), timeoutMs: Math.min(1800000, 120000 * count) };
  }
  assertResumable(task: PaTask): void {
    const slots = visibleSlots(this.store.listConversationMessages<PaMessage>(task.conversationId)).filter(slot => !slot.hidden);
    const stale = task.soul?.hiddenOwner
      ? slots.some(slot => slot.selected.taskId !== task.id && messageAt(slot.selected) > task.createdAt)
      : slots[slots.length - 1]?.selected.taskId !== task.id;
    if (stale) throw new PaError("后面已经有新消息了，请重新发送", 409, "PA_SOUL_STALE");
  }

  // ---- run hooks -------------------------------------------------------------------------------------------------
  prepareTurn(task: PaTask, agent: PersonalAgent, conversation: PaConversation, memories: PaMemory[]): PaPreparedTurn {
    const built = this.build({
      taskId: task.id, taskSoul: task.soul, dataClass: task.dataClass, agent, conversation, memories,
    });
    return { ...built, taskId: task.id };
  }
  stage(attemptId: string, prepared: PaPreparedTurn): void {
    this.staged.set(attemptId, prepared);
  }
  noteWire(attemptId: string, wire: "structured" | "flat"): void {
    const staged = this.staged.get(attemptId);
    if (staged) this.staged.set(attemptId, { ...staged, trace: { ...staged.trace, wire } });
  }
  unstageTask(taskId: string): void {
    for (const [attemptId, prepared] of this.staged) if (prepared.taskId === taskId) this.staged.delete(attemptId);
  }
  commitTurn(task: PaTask, attempt: PaAttempt): PaCommittedTurn {
    const staged = this.staged.get(attempt.id);
    const conversation = this.store.require<PaConversation>("conversations", task.conversationId);
    const parse = staged?.parse ?? this.rebuildParse(attempt.agentSnapshot, conversation);
    const reply = parseSoulReply(attempt.output, parse);
    if (reply.empty) throw new PaError("回复内容为空，请重试", 422, "PA_INVALID_OUTPUT");
    const content = reply.text.slice(0, SOUL_LIMITS.messageContent);
    const regenerateOf = task.soul?.regenerateOf;
    const soul: PaMessageSoul = {
      kind: "chat",
      footer: reply.footer,
      ...(reply.mood !== undefined ? { mood: reply.mood } : {}),
      ...(!conversation.groupId && parse.parts.state && reply.stateOps.length ? { stateOps: reply.stateOps } : {}),
      ...(reply.choices.length ? { choices: reply.choices } : {}),
      ...(reply.play.length ? { play: reply.play } : {}),
      ...(regenerateOf ? { variantOf: regenerateOf } : {}),
      ...(task.soul?.directive === "reachout" ? { proactive: true } : {}),
    };
    const after = (latest: PaTask): void => {
      const now = this.now();
      // 1. Regenerate: select the new variant, or make it a root when its slot is gone. The replaced replies' memory
      // suggestions stay pending: only the owner dismisses one, and the earlier variant can be selected again.
      if (regenerateOf) {
        const root = this.store.get<PaMessage>("messages", regenerateOf);
        if (root) this.store.update<PaMessage>("messages", root.id, { soul: { ...(root.soul ?? { kind: "chat" }), activeVariant: attempt.id } });
        else {
          const { variantOf: _variantOf, ...rest } = soul;
          this.store.update<PaMessage>("messages", attempt.id, { soul: rest });
        }
      }
      // 2. Memory candidates.
      if (parse.parts.remember && reply.remember.length) this.proposeMemories(latest, attempt, conversation, reply.remember);
      // 3. Chat state.
      const state = this.stateRow(conversation.id);
      const patch: Partial<Omit<PaChatState, keyof PaEntity>> = {};
      if (staged) patch.loreTimers = staged.loreTimers;
      let eventChanged = false;
      const index = attempt.authority?.participantIndex ?? latest.nextParticipant;
      // A regenerate replaces a turn, it does not add one: only new turns count down the interlude.
      if (state.activeEvent && !regenerateOf && index >= latest.participantIds.length - 1) {
        eventChanged = true;
        const remainingTurns = state.activeEvent.remainingTurns - 1;
        if (remainingTurns > 0) patch.activeEvent = { ...state.activeEvent, remainingTurns };
        else {
          patch.activeEvent = null;
          const { id, title, summary } = state.activeEvent;
          this.postMessage({
            conversationId: conversation.id, taskId: null, senderId: "owner",
            content: storyText({ kind: "event", title, phase: "ended" }, staged?.locale ?? this.conversationLocale(conversation, [])),
            targetAgentIds: [], replyTo: null,
            soul: { kind: "event", event: { id, title, summary, phase: "ended" } },
          });
        }
      }
      if (staged?.care === "crisis") patch.careAt = now;
      // 4. Trace.
      if (staged) {
        const warnings: PaSoulWarning[] = [
          ...staged.trace.warnings,
          ...(anyPart(staged.trace.parts) && reply.footer === "missing" ? [{ code: "footer-missing" as const }] : []),
        ];
        const stored: PaSoulTrace = {
          ...staged.trace, messageId: attempt.id, footer: reply.footer, warnings,
          lore: staged.trace.lore.filter(entry => entry.status !== "inactive"),
          loreInactive: staged.trace.lore.filter(entry => entry.status === "inactive").length,
        };
        if (this.store.has("soul_traces", attempt.id)) this.store.update<StoredTrace>("soul_traces", attempt.id, stored);
        else this.store.create<StoredTrace>("soul_traces", stored, attempt.id);
        const traceIds = [...state.traceIds.filter(item => item !== attempt.id), attempt.id];
        while (traceIds.length > SOUL_LIMITS.tracesPerConversation) {
          const old = traceIds.shift();
          if (old) this.store.remove("soul_traces", old);
        }
        patch.traceIds = traceIds;
      }
      if (Object.keys(patch).length) this.writeState(conversation.id, patch);
      if (eventChanged) this.bump();
    };
    return { content, soul, after };
  }
  private proposeMemories(task: PaTask, attempt: PaAttempt, conversation: PaConversation,
    items: ReadonlyArray<{ kind: "fact" | "promise" | "moment" | "preference"; text: string; due?: string }>): void {
    // Private memory stays on the desktop: a channel chat neither reads it (applicableMemories) nor proposes any.
    if (conversation.channelId || this.deps.memoryEnabled?.() === false) return;
    const agentId = attempt.agentSnapshot.id;
    const liveAgent = this.store.get<PersonalAgent>("agents", agentId);
    const autoMode = liveAgent?.memoryPolicy?.autoMemoryMode;
    if (autoMode === "off") return;
    // Enterprise mode: what the character remembers is kept per member, so only this member's memories count as known.
    const principalId = task.principal?.kind === "enterprise" ? task.principal.id : undefined;
    const known = new Set(this.core.memories({ scope: "agent", scopeId: agentId, principalId: principalId ?? "owner" })
      .map(memory => fold(memory.content)));
    for (const candidate of this.store.list<PaMemoryCandidate>("memory_candidates"))
      if (candidate.status === "pending" && candidate.conversationId === conversation.id) known.add(fold(candidate.content));
    const charName = this.card(agentId)?.nickname.trim()
      || liveAgent?.name
      || attempt.agentSnapshot.name;
    // In a group, what the character keeps is marked as learned there.
    const group = this.group(conversation);
    const via: MemoryVia | null = group
      ? { groupId: group.id, groupName: group.name, conversationId: conversation.id, conversationTitle: conversation.title }
      : null;
    // A turn that drew on memory the character may not carry into its groups (the owner's profile, a persona, a
    // project) never saves by itself: its suggestions wait for the owner.
    const autoSave = (text: string): boolean =>
      autoMode === "explicit_auto" && this.core.botMayCarry?.(attempt.memoryRefs, text) === true;
    items.forEach((item, n) => {
      const text = fold(item.text);
      const id = `${attempt.id}:${n}`;
      if (!text || known.has(text) || this.store.has("memory_candidates", id)) return;
      known.add(text);
      const dueAt = item.kind === "promise" ? endOfLocalDay(item.due) : null;
      if (autoSave(item.text) && this.core.saveMemory) {
        try {
          this.core.saveMemory({
            content: item.text.trim(),
            kind: item.kind,
            originKind: "llm_inferred",
            scope: "agent",
            scopeId: agentId,
            source: `对话 · ${charName}`,
            sourceMessageId: attempt.id,
            sourceRefs: [{ kind: "message", id: attempt.id, conversationId: conversation.id }],
            dataClass: attempt.dataClass ?? "standard",
            ...(dueAt != null ? { dueAt } : {}),
          }, principalId, { via, actor: `agent:${agentId}` });
          return;
        } catch {
          // Fall back to candidate queue if security gate or validation rejects auto-save.
        }
      }
      this.store.create<PaMemoryCandidate>("memory_candidates", {
        taskId: task.id, attemptId: attempt.id, content: item.text.trim(), kind: item.kind,
        originKind: "llm_inferred", targetScope: "agent", targetScopeId: agentId,
        dueAt,
        sourceMessageId: attempt.id, agentId, conversationId: conversation.id,
        dataClass: attempt.dataClass ?? "standard", status: "pending",
      }, id);
    });
  }
  /** Parse context from current records, for a received attempt whose staged turn was lost in a restart. */
  private rebuildParse(agent: PersonalAgent, conversation: PaConversation): SoulReplyContext {
    const character = this.card(agent.id);
    const chat = this.chatDoc(conversation.id);
    const group = this.group(conversation);
    const messages = this.store.listConversationMessages<PaMessage>(conversation.id);
    const locale = this.conversationLocale(conversation, messages);
    const preset = this.presetFor(chat, character, locale);
    const persona = this.personaFor(conversation, character);
    const schema = !group && character ? character.stateSchema : [];
    return {
      schema,
      parts: resolveMetaParts({ preset, character, chat, group: Boolean(group), care: "none" }),
      speakerNames: [agent.name, ...(character?.nickname.trim() ? [character.nickname] : [])],
      userName: resolveNames({ agentName: agent.name, nickname: character?.nickname ?? null, personaName: persona.name, locale }).user,
      otherNames: (group?.memberIds ?? []).filter(id => id !== agent.id).map(id => this.agentName(id)).filter(Boolean),
      format: preset.format,
      decks: availableDecks(character).map(deck => ({ id: deck.id, name: deck.name })),
    };
  }
  /** The shared input of prepareTurn and preview (section 4.2, steps 1–13). */
  private build(input: BuildInput): Omit<PaPreparedTurn, "taskId"> {
    const { agent, conversation } = input;
    const now = this.now();
    // 1.
    const character = this.card(agent.id);
    const chat = this.chatDoc(conversation.id);
    const state = this.stateRow(conversation.id);
    const group = this.group(conversation);
    // 2.
    const messages = this.store.listConversationMessages<PaMessage>(conversation.id);
    const slots = visibleSlots(messages);
    const regenerateOf = input.taskSoul?.regenerateOf;
    const cut = regenerateOf ? slots.findIndex(slot => slot.slotId === regenerateOf) : -1;
    const counted = cut >= 0 ? slots.slice(0, cut) : slots;
    const loreIndex = counted.length;
    // 3. Selected messages that may reach the model, then roles.
    const statusOf = new Map<string, string | null>();
    const taskStatus = (id: string) => {
      if (!statusOf.has(id)) statusOf.set(id, this.store.get<PaTask>("tasks", id)?.status ?? null);
      return statusOf.get(id) ?? null;
    };
    let hidden = 0;
    const readable: PaMessage[] = [];
    for (const slot of counted) {
      if (slot.hidden) { hidden += 1; continue; }
      const message = slot.selected;
      if (!paCanReadClass(input.dataClass, message.dataClass)) continue;
      if (message.senderId === "owner" && message.taskId && message.taskId !== input.taskId && input.taskId !== null
        && IN_FLIGHT.has(taskStatus(message.taskId) ?? "")) continue;
      readable.push(message);
    }
    const ownerTexts = [
      ...(input.draft !== undefined ? [input.draft] : []),
      ...readable.filter(message => message.senderId === "owner" && !isStory(message)).reverse().map(message => message.content),
    ];
    // 4. Persona, preset, locale, names, cast and decks.
    const locale = this.localeFor(character, ownerTexts[0] ?? "");
    const persona = this.personaFor(conversation, character);
    const preset = this.presetFor(chat, character, locale);
    const names = resolveNames({ agentName: agent.name, nickname: character?.nickname ?? null, personaName: persona.name, locale });
    const cast = (group?.memberIds ?? []).filter(id => id !== agent.id)
      .map(id => ({ name: this.agentName(id), tagline: this.card(id)?.tagline ?? "" }))
      .filter(member => member.name);
    const decks = availableDecks(character).map(deck => ({ id: deck.id, name: deck.name }));
    const history: Array<SoulHistoryItem & { taskId: string | null }> = readable.map(message => {
      const base = { id: message.id, at: messageAt(message), taskId: message.taskId };
      if (isStory(message)) {
        const secret = message.soul?.kind === "draw" && Object.hasOwn(state.secrets, message.id) ? state.secrets[message.id] : undefined;
        const text = secret ? `${message.content}${locale === "en" ? " " : ""}${secretSuffix(secret, locale)}` : message.content;
        return { ...base, role: "story" as const, name: "", text };
      }
      if (message.senderId === "owner") return { ...base, role: "owner" as const, name: names.user, text: message.content };
      if (message.senderId === agent.id) return {
        ...base, role: "self" as const, name: names.char, text: message.content,
        ...(message.soul?.mood ? { mood: message.soul.mood } : {}),
        ...(message.soul?.stateOps?.length ? { stateOps: message.soul.stateOps } : {}),
      };
      return { ...base, role: "other" as const, name: this.agentName(message.senderId), text: message.content };
    });
    if (input.draft !== undefined && input.draft.trim())
      history.push({ id: "draft", at: now, taskId: input.taskId, role: "owner", name: names.user, text: input.draft });
    const windowed = history.slice(-200);
    // 5. Books: chat (rank 0), the speaker's card (rank 1), global (rank 2); the lowest rank wins.
    const ranks = new Map<string, 0 | 1 | 2>();
    const addBook = (id: string, rank: 0 | 1 | 2) => { if (!ranks.has(id)) ranks.set(id, rank); };
    for (const id of chat.lorebookIds) addBook(id, 0);
    for (const id of character?.lorebookIds ?? []) addBook(id, 1);
    const allBooks = this.store.list<PaLorebook>("lorebooks");
    for (const book of [...allBooks].filter(item => item.global).sort((a, b) => a.createdAt - b.createdAt)) addBook(book.id, 2);
    const byId = new Map(allBooks.map(book => [book.id, book]));
    const books: Array<ActivateLoreInput["books"][number]> = [];
    for (const [id, rank] of ranks) {
      const book = byId.get(id);
      if (book) books.push({ book, rank });
    }
    // 6. Memories: due promises, then agent-scoped by relevance, then any other memory with a keyword hit.
    const query = windowed.slice(-4).map(item => item.text).join("\n");
    const agentScoped = input.memories.filter(memory => memory.scope === "agent" && memory.scopeId === agent.id);
    const promises = agentScoped
      .filter(memory => memory.kind === "promise" && paMemoryActive(memory, now) && (memory.dueAt == null || memory.dueAt >= now - 7 * DAY))
      .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 3);
    const chosen: PaMemory[] = [...promises];
    const taken = () => new Set(chosen.map(memory => memory.id));
    if (chosen.length < 8) {
      const skip = taken();
      chosen.push(...selectPaMemories(agentScoped.filter(memory => !skip.has(memory.id)), query, { limit: 8 - chosen.length }));
    }
    if (chosen.length < 8) {
      const skip = taken();
      const others = input.memories.filter(memory => !(memory.scope === "agent" && memory.scopeId === agent.id) && !skip.has(memory.id));
      chosen.push(...selectPaMemories(others, query, { minScore: 1, limit: 8 - chosen.length }));
    }
    // A pinned memory that has nothing to do with this turn is in the prompt only because it is always included.
    const due = new Set(promises.map(memory => memory.id));
    const memoryRefs = chosen.map(memory => ({
      id: memory.id,
      revision: memory.revision,
      ...(memory.pinned && !due.has(memory.id) && !paMemoryMatches(memory, query) ? { standing: true } : {}),
    }));
    // 7. State: direct chats with a schema only.
    const schema = !group && character ? character.stateSchema : [];
    // Only ops of replies this task may read: a local_only reply's state must not reach a cloud prompt.
    const stateSlots = slots.map(slot => ({
      slotId: slot.slotId,
      ops: paCanReadClass(input.dataClass, slot.selected.dataClass) ? slot.selected.soul?.stateOps ?? [] : [],
    }));
    const folded = schema.length
      ? stateRecord(foldChatState(schema, stateSlots, state.userStateOps, regenerateOf ? { upTo: regenerateOf } : undefined))
      : {};
    // 8. Care.
    const care = detectCrisis(ownerTexts.slice(0, 3), { fiction: preset.id === "builtin:game-master" }).level;
    // 9. Directive, idle time, mood, first meeting.
    const directive: { kind: "continue" | "reachout" | "regenerate" | "react"; text?: string } | null = regenerateOf
      ? { kind: "regenerate" }
      : input.taskSoul?.directive
        ? { kind: input.taskSoul.directive, ...(input.taskSoul.directiveText ? { text: input.taskSoul.directiveText } : {}) }
        : null;
    let lastOwnerAt: number | null = null;
    let lastMood: { text: string; at: number } | null = null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index]!;
      if (lastOwnerAt === null && item.role === "owner" && item.id !== "draft" && (input.taskId === null || item.taskId !== input.taskId))
        lastOwnerAt = item.at;
      if (lastMood === null && item.role === "self" && item.mood) lastMood = { text: item.mood, at: item.at };
      if (lastOwnerAt !== null && lastMood !== null) break;
    }
    const firstMetAt = group
      ? conversation.createdAt
      : this.store.list<PaConversation>("conversations")
        .filter(item => item.agentId === agent.id && !item.groupId)
        .reduce<number | null>((min, item) => (min === null || item.createdAt < min ? item.createdAt : min), null);
    // 10. Compose (11: shrink the history until the flat prompt fits a CLI argv budget).
    const regexTest = paLoreRegexBudget();
    const compose = (historyBudgetTokens: number): ComposeSoulResult => composeSoulPrompt({
      conversationId: conversation.id,
      group: Boolean(group),
      agentName: agent.name,
      agentRole: agent.role,
      character: character && toCharacterInput(character),
      persona,
      preset,
      chat,
      books,
      loreTimers: state.loreTimers,
      loreIndex,
      history: windowed.map(({ taskId: _taskId, ...item }) => item),
      // The preview's draft is one more message of the window, so it counts toward the total too.
      historyTotals: { total: counted.length + (history.at(-1)?.id === "draft" ? 1 : 0), hidden },
      memories: chosen.map(memory => ({
        id: memory.id, content: memory.content, source: memory.source,
        ...(memory.kind ? { kind: memory.kind } : {}),
        ...(memory.dueAt !== undefined ? { dueAt: memory.dueAt } : {}),
      })),
      state: folded,
      cast,
      decks,
      activeEvent: state.activeEvent,
      directive,
      care,
      locale,
      now,
      timezoneOffsetMin: -new Date(now).getTimezoneOffset(),
      lastOwnerAt,
      lastMood,
      firstMetAt,
      contextTokens: this.contextTokens(agent.model),
      historyBudgetTokens,
      regexTest,
      rng: this.rng,
    });
    let budget = PA_HISTORY_BUDGET_TOKENS[chat.historyBudget];
    let result = compose(budget);
    const byteLimit = this.core.promptByteLimit(agent.model);
    let shrunk = false;
    for (let round = 0; typeof byteLimit === "number" && round < 4 && Buffer.byteLength(result.flat) > byteLimit; round += 1) {
      budget = Math.floor(budget / 2);
      result = compose(budget);
      shrunk = true;
    }
    // 12. Wire extras.
    const sampling = {
      ...(preset.sampling.temperature !== undefined ? { temperature: preset.sampling.temperature } : {}),
      ...(preset.sampling.topP !== undefined ? { topP: preset.sampling.topP } : {}),
      ...(preset.sampling.maxTokens !== undefined ? { maxTokens: preset.sampling.maxTokens } : {}),
    };
    const chatWire: PaChatWire = {
      ...result.wire,
      ...(Object.keys(sampling).length ? { sampling } : {}),
      ...(agent.model.runtime === "ollama" ? {
        contextTokens: Math.min(32768, Math.max(4096, Math.ceil((result.trace.totalTokens + result.replyTokens) * 1.5 / 1024) * 1024)),
      } : {}),
    };
    const trace: PaSoulTrace = {
      ...result.trace,
      speaker: { agentId: agent.id, name: result.trace.speaker.name },
      warnings: [...result.trace.warnings, ...(shrunk ? [{ code: "prompt-shrunk" as const }] : [])],
    };
    // 13. Reply parse context.
    const parse: SoulReplyContext = {
      schema,
      parts: result.parts,
      speakerNames: [agent.name, ...(character?.nickname.trim() ? [character.nickname] : [])],
      userName: result.names.user,
      otherNames: cast.map(member => member.name),
      format: preset.format,
      decks,
    };
    return { flat: result.flat, chat: chatWire, trace, loreTimers: result.loreTimers, memoryRefs, parse, care, locale };
  }
  acceptCandidate(item: PaMemoryCandidate, attempt: PaAttempt, save: (input: PaMemoryInput) => PaMemory): PaMemory {
    if (!this.store.has("messages", item.attemptId)) throw new PaError("这条回复已删除", 409, "PA_REVISION_CONFLICT");
    const agentId = attempt.agentSnapshot.id;
    const name = this.card(agentId)?.nickname.trim()
      || this.store.get<PersonalAgent>("agents", agentId)?.name
      || attempt.agentSnapshot.name;
    return save({
      content: item.content,
      kind: item.kind ?? "fact",
      originKind: item.originKind ?? "llm_inferred",
      scope: "agent",
      scopeId: agentId,
      source: `对话 · ${name}`,
      sourceMessageId: item.attemptId,
      sourceRefs: [{
        kind: "message",
        id: item.attemptId,
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      }],
      dataClass: item.dataClass,
      ...(item.dueAt != null ? { dueAt: item.dueAt } : {}),
    });
  }
  onConversationCreated(conversation: PaConversation): void {
    if (conversation.groupId || conversation.channelId || !conversation.agentId) return;
    // Enterprise mode: only a member's own conversation is a companion chat; a shared room gets no greeting.
    if (this.enterprise() && !conversation.principalId) return;
    const character = this.card(conversation.agentId);
    if (!character) return;
    this.ensureChat(conversation.id);
    this.postGreeting(conversation, character);
  }

  // ---- message mutations -----------------------------------------------------------------------------------------
  private mutable(id: string): { message: PaMessage; conversation: PaConversation } {
    const message = this.store.require<PaMessage>("messages", id);
    const conversation = this.store.require<PaConversation>("conversations", message.conversationId);
    this.assertIdle(conversation.id);
    this.assertCompanion(conversation);
    return { message, conversation };
  }
  /** Messages of a work task, and messages whose own task has not finished, cannot change. */
  private assertSettled(message: PaMessage, allowWork: boolean): void {
    if (!message.taskId) return;
    const task = this.store.get<PaTask>("tasks", message.taskId);
    if (!task) return;
    if (!TERMINAL.has(task.status)) throw new PaError("这一轮还没有结束，暂时不能修改", 409, "PA_SOUL_MESSAGE");
    if (!allowWork && task.kind !== "chat") throw new PaError("任务里的消息不能在这里修改", 409, "PA_SOUL_MESSAGE");
  }
  editMessage(id: string, patch: { content?: string; hidden?: boolean }, revision: number): PaMessage {
    const { message } = this.mutable(id);
    if (patch.content !== undefined) {
      if (STORY_KINDS.has(message.soul?.kind ?? "")) throw new PaError("故事记录不能编辑", 409, "PA_SOUL_MESSAGE");
      if (!patch.content.trim() || patch.content.length > SOUL_LIMITS.messageContent) throw invalid("请输入有效内容");
    }
    this.assertSettled(message, patch.content === undefined);
    const current: PaMessageSoul = message.soul ?? { kind: "chat" };
    const { hidden: _hidden, ...withoutHidden } = current;
    const edited = patch.content !== undefined && patch.content !== message.content;
    const soul: PaMessageSoul = {
      ...(patch.hidden === undefined ? current : patch.hidden ? { ...current, hidden: true } : withoutHidden),
      ...(edited ? { edited: true } : {}),
    };
    const updated = this.store.update<PaMessage>("messages", id, { ...(patch.content !== undefined ? { content: patch.content } : {}), soul }, revision);
    this.core.onConversationMessagesChanged?.(message.conversationId);
    return updated;
  }
  deleteMessage(id: string, revision: number, forget: boolean): { ok: true; removedMemories: number } {
    const { message, conversation } = this.mutable(id);
    this.assertSettled(message, false);
    if (message.revision !== revision) throw conflict();
    this.store.transaction(() => {
      const messages = this.store.listConversationMessages<PaMessage>(conversation.id);
      const slotsBefore = visibleSlots(messages);
      const state = this.stateRow(conversation.id);
      let userOps = state.userStateOps;
      const parentId = message.soul?.variantOf;
      const parent = parentId && parentId !== id ? messages.find(item => item.id === parentId) ?? null : null;
      this.store.remove("messages", id);
      if (parent) {
        if (parent.soul?.activeVariant === id) {
          const { activeVariant: _active, ...rest } = parent.soul;
          this.store.update<PaMessage>("messages", parent.id, { soul: rest });
        }
      } else {
        const variants = messages.filter(item => item.id !== id && item.soul?.variantOf === id);
        const active = message.soul?.activeVariant;
        const promoted = variants.find(item => item.id === active) ?? variants[0];
        if (promoted) {
          const promotedSoul: PaMessageSoul = promoted.soul ?? { kind: "chat" };
          const { variantOf: _of, ...rest } = promotedSoul;
          this.store.update<PaMessage>("messages", promoted.id, { soul: rest });
          for (const sibling of variants)
            if (sibling.id !== promoted.id)
              this.store.update<PaMessage>("messages", sibling.id, { soul: { ...(sibling.soul ?? { kind: "chat" }), variantOf: promoted.id } });
          userOps = reanchorUserOps(userOps, { renamed: id, to: promoted.id });
        } else {
          const at = slotsBefore.findIndex(slot => slot.slotId === id);
          userOps = reanchorUserOps(userOps, { removed: id, previous: at > 0 ? slotsBefore[at - 1]!.slotId : null });
        }
      }
      if (this.store.has("soul_traces", id)) this.store.remove("soul_traces", id);
      this.dropSpeech(id);
      if (this.store.has("chat_state", conversation.id)) {
        this.writeState(conversation.id, {
          userStateOps: userOps,
          secrets: Object.fromEntries(Object.entries(state.secrets).filter(([key]) => key !== id)),
          traceIds: state.traceIds.filter(item => item !== id),
        });
      }
    });
    this.bump();
    this.core.onConversationMessagesChanged?.(conversation.id);
    let removedMemories = 0;
    if (forget) {
      removedMemories = this.archiveAll(this.core.memories().filter((memory) => memory.sourceMessageId === id && recalled(memory)));
    }
    return { ok: true, removedMemories };
  }
  selectVariant(rootId: string, choice: { messageId: string } | { greetingIndex: number }): PaMessage {
    const { message: root, conversation } = this.mutable(rootId);
    const refuse = (text: string) => new PaError(text, 409, "PA_SOUL_VARIANT");
    const parentId = root.soul?.variantOf;
    if (parentId && parentId !== rootId && this.store.has("messages", parentId)) throw refuse("请在这一条的第一版上切换");
    if ("messageId" in choice) {
      const soul: PaMessageSoul = root.soul ?? { kind: "chat" };
      if (choice.messageId === rootId) {
        const { activeVariant: _active, ...rest } = soul;
        return this.store.update<PaMessage>("messages", rootId, { soul: rest });
      }
      const target = this.store.get<PaMessage>("messages", choice.messageId);
      if (!target || target.soul?.variantOf !== rootId) throw refuse("这个版本不属于这条消息");
      return this.store.update<PaMessage>("messages", rootId, { soul: { ...soul, activeVariant: target.id } });
    }
    const index = choice.greetingIndex;
    if (root.soul?.kind !== "greeting" || root.soul.greetingIndex === undefined) throw refuse("只有开场白可以换一个");
    const character = this.card(root.senderId);
    const source = !character ? undefined : index === 0 ? character.firstMessage : character.alternateGreetings[index - 1];
    if (!character || source === undefined || !source.trim() || !Number.isInteger(index) || index < 0)
      throw refuse("没有这个开场白");
    const slots = visibleSlots(this.store.listConversationMessages<PaMessage>(conversation.id));
    const at = slots.findIndex(slot => slot.slotId === rootId);
    if (slots.slice(at + 1).some(slot => !slot.hidden)) throw refuse("对话已经开始，开场白不能再换了");
    const { choices: _choices, ...rest } = root.soul;
    const soul: PaMessageSoul = {
      ...rest, greetingIndex: index,
      ...(index === 0 && character.openers.length ? { choices: [...character.openers] } : {}),
    };
    return this.store.update<PaMessage>("messages", rootId, { content: this.macroText(conversation, character, source), soul });
  }
  revealDraw(id: string): PaMessage {
    const { message, conversation } = this.mutable(id);
    const draw = message.soul?.kind === "draw" ? message.soul.draw : undefined;
    const state = this.stateRow(conversation.id);
    const secret = Object.hasOwn(state.secrets, id) ? state.secrets[id] : undefined;
    if (!draw || !message.soul || !secret) throw invalid("这张牌没有可以翻开的内容");
    return this.store.transaction(() => {
      const updated = this.store.update<PaMessage>("messages", id, { soul: { ...message.soul!, draw: { ...draw, secret } } });
      this.writeState(conversation.id, { secrets: Object.fromEntries(Object.entries(state.secrets).filter(([key]) => key !== id)) });
      return updated;
    });
  }
  branch(conversationId: string, messageId: string): PaConversation {
    const source = this.store.require<PaConversation>("conversations", conversationId);
    if (source.groupId || !source.agentId) throw invalid("只有单聊可以开支线");
    this.assertIdle(conversationId);
    this.assertCompanion(source);
    const agent = this.store.require<PersonalAgent>("agents", source.agentId);
    const slots = visibleSlots(this.store.listConversationMessages<PaMessage>(conversationId));
    const at = slots.findIndex(slot => slot.variants.some(variant => variant.id === messageId));
    if (at < 0) throw notFound("消息不存在");
    const state = this.stateRow(conversationId);
    const created = this.store.transaction(() => {
      const conversation = this.store.create<PaConversation>("conversations", {
        title: `${agent.name} · 支线`, agentId: agent.id, groupId: null,
        ...(source.principalId ? { principalId: source.principalId } : {}),
      });
      const slotMap = new Map<string, string>();
      const secrets: Record<string, string> = {};
      for (const slot of slots.slice(0, at + 1)) {
        const original = slot.selected;
        const originalSoul: PaMessageSoul = original.soul ?? { kind: "chat" };
        const { variantOf: _of, activeVariant: _active, requestId: _request, ...soul } = originalSoul;
        const copy = this.postMessage({
          conversationId: conversation.id, taskId: null, senderId: original.senderId, content: original.content,
          targetAgentIds: [], replyTo: null,
          ...(original.model ? { model: original.model } : {}),
          ...(original.dataClass ? { dataClass: original.dataClass } : {}),
          soul: { ...soul, at: messageAt(original), copiedFrom: original.id },
        });
        slotMap.set(slot.slotId, copy.id);
        const secret = Object.hasOwn(state.secrets, original.id) ? state.secrets[original.id] : undefined;
        if (secret) secrets[copy.id] = secret;
      }
      this.store.create<PaChatSettings>("chat_settings", { ...this.chatDoc(conversationId) }, conversation.id);
      const userStateOps = state.userStateOps.flatMap(op => {
        if (op.after === null) return [{ ...op }];
        const mapped = slotMap.get(op.after);
        return mapped ? [{ ...op, after: mapped }] : [];
      });
      this.store.create<PaChatState>("chat_state", {
        ...emptyState(),
        loreTimers: { ...state.loreTimers },
        branchOf: { conversationId, messageId },
        userStateOps,
        secrets,
      }, conversation.id);
      return conversation;
    });
    this.bump();
    return created;
  }

  // ---- generation and play ---------------------------------------------------------------------------------------
  regenerate(conversationId: string, messageId: string, requestId: string): PaTask {
    const conversation = this.store.require<PaConversation>("conversations", conversationId);
    this.assertIdle(conversationId);
    this.assertCompanion(conversation);
    const refuse = (text: string) => new PaError(text, 409, "PA_SOUL_VARIANT");
    const slots = visibleSlots(this.store.listConversationMessages<PaMessage>(conversationId)).filter(slot => !slot.hidden);
    const slot = slots.find(item => item.variants.some(variant => variant.id === messageId));
    if (!slot || slot !== slots[slots.length - 1]) throw refuse("只能给最新的一条回复换个说法");
    const selected = slot.selected;
    if (selected.senderId === "owner" || selected.soul?.kind !== "chat") throw refuse("这条消息不能换个说法");
    if (slot.variants.length >= SOUL_LIMITS.variantsPerSlot) throw new PaError("这条回复的版本已经够多了", 409, "PA_SOUL_LIMIT");
    return this.core.submit({
      requestId, conversationId, goal: "换个说法", kind: "chat", targetAgentIds: [selected.senderId], budget: this.core.defaultBudget(),
    }, { regenerateOf: slot.slotId, hiddenOwner: true });
  }
  continueChat(conversationId: string, requestId: string, agentId?: string,
    directive: "continue" | "reachout" | "react" = "continue", directiveText?: string): PaTask {
    const conversation = this.store.require<PaConversation>("conversations", conversationId);
    this.assertIdle(conversationId);
    this.assertCompanion(conversation);
    return this.core.submit({
      requestId, conversationId, goal: directive === "reachout" ? "先开口" : "接着说", kind: "chat",
      targetAgentIds: agentId ? [agentId] : [], budget: this.core.defaultBudget(),
    }, { directive, ...(directiveText ? { directiveText: directiveText.slice(0, 400) } : {}), hiddenOwner: true });
  }
  /** The reply to a roll, draw or interlude: the speaker is told to react to that story line, not just carry on. */
  private reactTo(story: PaMessage, requestId: string): PaTask {
    return this.continueChat(story.conversationId, `${requestId}:respond`, undefined, "react", story.content);
  }
  private playTarget(conversationId: string): { conversation: PaConversation; messages: PaMessage[]; locale: SoulLocale } {
    const conversation = this.store.require<PaConversation>("conversations", conversationId);
    this.assertCompanion(conversation);
    const messages = this.store.listConversationMessages<PaMessage>(conversationId);
    return { conversation, messages, locale: this.conversationLocale(conversation, messages) };
  }
  private respondTask(requestId: string): PaTask | null {
    return this.store.taskByRequest<PaTask>(`${requestId}:respond`);
  }
  roll(conversationId: string, input: { notation: string; label?: string; dc?: number; respond?: boolean; requestId: string }):
    { message: PaMessage; task: PaTask | null } {
    const { conversation, messages, locale } = this.playTarget(conversationId);
    const respond = input.respond ?? true;
    const repeated = messages.find(message => message.soul?.requestId === input.requestId);
    if (repeated) return { message: repeated, task: respond ? this.respondTask(input.requestId) : null };
    this.assertIdle(conversationId);
    const roll = rollDice(input.notation, this.rng, input.dc);
    if (!roll) throw invalid("看不懂这个骰子写法，例如 d20 或 2d6+1");
    const label = input.label?.trim();
    const message = this.postMessage({
      conversationId: conversation.id, taskId: null, senderId: "owner",
      content: storyText({ kind: "roll", roll, ...(label ? { label } : {}) }, locale),
      targetAgentIds: [], replyTo: null,
      soul: {
        kind: "roll", requestId: input.requestId,
        roll: {
          notation: roll.notation, rolls: roll.rolls, modifier: roll.modifier, total: roll.total,
          ...(label ? { label } : {}),
          ...(roll.dc !== undefined ? { dc: roll.dc } : {}),
          ...(roll.outcome !== undefined ? { outcome: roll.outcome } : {}),
        },
      },
    });
    return { message, task: respond ? this.reactTo(message, input.requestId) : null };
  }
  private decksOf(conversation: PaConversation): PaDeck[] {
    const group = this.group(conversation);
    if (!group) return availableDecks(this.card(conversation.agentId));
    const own = group.memberIds.flatMap(id => this.card(id)?.decks ?? []);
    const seen = new Set<string>();
    return [...own, ...PA_BUILTIN_DECKS].filter(deck => (seen.has(deck.id) ? false : (seen.add(deck.id), true)));
  }
  draw(conversationId: string, input: { deckId: string; respond?: boolean; requestId: string }): { message: PaMessage; task: PaTask | null } {
    const { conversation, messages, locale } = this.playTarget(conversationId);
    const respond = input.respond ?? true;
    const repeated = messages.find(message => message.soul?.requestId === input.requestId);
    if (repeated) return { message: repeated, task: respond ? this.respondTask(input.requestId) : null };
    this.assertIdle(conversationId);
    const deck = this.decksOf(conversation).find(item => item.id === input.deckId);
    if (!deck) throw notFound("牌堆不存在");
    const { card } = drawCard(deck, this.rng);
    const message = this.store.transaction(() => {
      const created = this.postMessage({
        conversationId: conversation.id, taskId: null, senderId: "owner",
        content: storyText({ kind: "draw", deckName: deck.name, title: card.title, text: card.text }, locale),
        targetAgentIds: [], replyTo: null,
        soul: {
          kind: "draw", requestId: input.requestId,
          draw: { deckId: deck.id, deckName: deck.name, title: card.title, text: card.text, ...(card.secret ? { hasSecret: true } : {}) },
        },
      });
      if (card.secret) {
        const secrets = { ...this.stateRow(conversation.id).secrets };
        secrets[created.id] = card.secret;
        this.writeState(conversation.id, { secrets });
      }
      return created;
    });
    return { message, task: respond ? this.reactTo(message, input.requestId) : null };
  }
  eventAction(conversationId: string, input: { action: "draw" | "accept" | "skip" | "stop"; respond?: boolean; requestId: string }):
    { chat: PaChatView; message: PaMessage | null; task: PaTask | null } {
    const { conversation, messages, locale } = this.playTarget(conversationId);
    const respond = input.respond ?? true;
    const state = this.stateRow(conversationId);
    if (input.action === "draw") {
      const exclude = [state.candidateEvent?.id, state.activeEvent?.id].filter((id): id is string => Boolean(id));
      const beat = drawInterlude(exclude, this.rng);
      this.writeState(conversationId, { candidateEvent: { id: beat.id, title: beat.title[locale], summary: beat.summary[locale] } });
      this.bump();
      return { chat: this.toChatView(conversationId), message: null, task: null };
    }
    if (input.action === "skip") {
      this.writeState(conversationId, { candidateEvent: null });
      this.bump();
      return { chat: this.toChatView(conversationId), message: null, task: null };
    }
    const repeated = messages.find(message => message.soul?.requestId === input.requestId);
    if (repeated) return { chat: this.toChatView(conversationId), message: repeated, task: respond ? this.respondTask(input.requestId) : null };
    this.assertIdle(conversationId);
    if (input.action === "accept") {
      const candidate = state.candidateEvent;
      if (!candidate) throw invalid("现在没有可以接受的小插曲");
      const message = this.store.transaction(() => {
        this.writeState(conversationId, { activeEvent: { ...candidate, remainingTurns: PA_EVENT_TURNS }, candidateEvent: null });
        return this.postMessage({
          conversationId: conversation.id, taskId: null, senderId: "owner",
          content: storyText({ kind: "event", title: candidate.title, phase: "accepted" }, locale),
          targetAgentIds: [], replyTo: null,
          soul: { kind: "event", requestId: input.requestId, event: { ...candidate, phase: "accepted" } },
        });
      });
      this.bump();
      const task = respond ? this.reactTo(message, input.requestId) : null;
      return { chat: this.toChatView(conversationId), message, task };
    }
    const active = state.activeEvent;
    if (!active) throw invalid("现在没有进行中的小插曲");
    const message = this.store.transaction(() => {
      this.writeState(conversationId, { activeEvent: null });
      return this.postMessage({
        conversationId: conversation.id, taskId: null, senderId: "owner",
        content: storyText({ kind: "event", title: active.title, phase: "ended" }, locale),
        targetAgentIds: [], replyTo: null,
        soul: { kind: "event", requestId: input.requestId, event: { id: active.id, title: active.title, summary: active.summary, phase: "ended" } },
      });
    });
    this.bump();
    return { chat: this.toChatView(conversationId), message, task: null };
  }
  preview(conversationId: string, input: { draft?: string; agentId?: string }): PaSoulTrace {
    const conversation = this.store.require<PaConversation>("conversations", conversationId);
    const group = this.group(conversation);
    const speakerId = input.agentId ?? (group ? group.moderatorId : conversation.agentId);
    if (!speakerId) throw invalid("这个对话没有可以预览的角色");
    if (group ? !group.memberIds.includes(speakerId) : speakerId !== conversation.agentId)
      throw invalid("这个角色不在当前对话里");
    const agent = this.store.require<PersonalAgent>("agents", speakerId);
    const built = this.build({
      taskId: null, taskSoul: undefined, dataClass: undefined, agent, conversation,
      memories: this.previewMemories(conversation, agent.id),
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
    });
    return built.trace;
  }
  /** The memories a standard chat turn of this speaker could read: the same read as the turn itself. */
  private previewMemories(conversation: PaConversation, agentId: string): PaMemory[] {
    return this.core.chatMemories?.(conversation, agentId) ?? [];
  }

  // ---- scheduled reachout (W6) -----------------------------------------------------------------------------------
  reachoutBlocked(routine: PaRoutine, now: number): string | null {
    const conversation = this.store.get<PaConversation>("conversations", routine.conversationId);
    if (!conversation || this.modeOf(conversation) !== "companion") return "这个对话不在聊天模式，先开口已跳过";
    const local = zonedParts(now, routine.timezone);
    if (local.hour >= 23 || local.hour < 8) return "现在是安静时段，先开口已跳过";
    const messages = this.store.listConversationMessages<PaMessage>(conversation.id);
    const proactive = messages.filter(message => message.soul?.proactive === true).sort((a, b) => messageAt(a) - messageAt(b));
    if (proactive.filter(message => zonedParts(messageAt(message), routine.timezone).day === local.day).length >= 2)
      return "今天已经主动开口两次了";
    const third = proactive.length >= 3 ? proactive[proactive.length - 3] : undefined;
    if (third && !messages.some(message => message.senderId === "owner" && !isStory(message) && messageAt(message) > messageAt(third)))
      return "最近三次先开口都还没有回应，先开口已暂停";
    const careAt = this.stateRow(conversation.id).careAt;
    if (careAt !== null && now - careAt < DAY) return "最近的对话需要先照顾好情绪，先开口已暂停";
    return null;
  }
}
