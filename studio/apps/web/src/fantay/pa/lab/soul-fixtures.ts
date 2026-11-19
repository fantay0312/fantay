// SPDX-License-Identifier: AGPL-3.0-only
// Soul lab fixtures (ARCH 5.7): starter characters built from PA_STARTERS with inline SVG portraits, world books,
// personas, presets, chat settings and state, companion, text-game and room conversations, context records and canned
// replies. Every scenario is a function of `now`. Runtime helpers from ./fixtures are used only inside functions, and
// ./fixtures calls these builders only inside functions, so the import cycle between the two files is safe.
import type {
  PaAttempt,
  PaCharacterView,
  PaChatAppearance,
  PaChatView,
  PaConversation,
  PaEmotion,
  PaGroup,
  PaLorebook,
  PaLorebookSummary,
  PaLoreReason,
  PaLoreStatus,
  PaMemory,
  PaMemoryCandidate,
  PaMessage,
  PaMessageSoul,
  PaModel,
  PaPersona,
  PaSoulSnapshot,
  PaSoulTrace,
  PaSoulTraceLore,
  PaSoulWarning,
  PaSpeechItem,
  PaSpeechStatus,
  PaSprites,
  PaStylePreset,
  PaTask,
  PersonalAgent,
} from '@open-design/contracts';
import {
  PA_CHAT_THEMES,
  PA_DEFAULT_CHAT_SETTINGS,
  PA_INTERLUDE_BEATS,
  PA_STARTERS,
  SOUL_BLOCK_IDS,
  bytesToBase64,
  expandMacros,
  importWorldInfo,
  paChatAppearanceSchema,
  paCharacterInputSchema,
  paLorebookInputSchema,
  paStylePresetInputSchema,
  parseCharacterCard,
  resolveMetaParts,
  resolvePreset,
  seededRng,
  speechText,
  storyText,
  type DiceRoll,
  type PaStarterCharacter,
} from '@open-design/contracts/soul';
import { DAY, HOUR, MIN, attempt, cast, control, conversation, firstRun, fixtureOf, message, stamp, task, type PaFixture } from './fixtures';

// ---- time --------------------------------------------------------------------------------------------------------

function dayStart(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A local wall-clock time `days` days before the day of `now`. */
function clock(now: number, days: number, hour: number, minute: number, second = 0): number {
  return dayStart(now) - days * DAY + hour * HOUR + minute * MIN + second * 1000;
}

function endOfDay(at: number): number {
  return dayStart(at) + DAY - 1;
}

/** Local `YYYY-MM-DD`, the date form a `<turn_meta>` remember line takes. */
function isoDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- portraits ---------------------------------------------------------------------------------------------------

/** A flat head-and-shoulders portrait, 3:4. The face sits in the upper half so the 50% 20% focal crop keeps it. */
interface PortraitLook {
  sky: readonly [string, string];
  scene: string;
  hairBack: string;
  hairFront: string;
  hair: string;
  skin: string;
  cloth: string;
  line: string;
  blush?: string;
  front?: string;
}

function portrait(look: PortraitLook): string {
  const [top, bottom] = look.sky;
  const blush = look.blush
    ? `<ellipse cx="118" cy="226" rx="11" ry="6" fill="${look.blush}" opacity=".5"/><ellipse cx="182" cy="226" rx="11" ry="6" fill="${look.blush}" opacity=".5"/>`
    : '';
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">',
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>`,
    '<rect width="300" height="400" fill="url(#sky)"/>',
    look.scene,
    `<path d="${look.hairBack}" fill="${look.hair}"/>`,
    `<path d="M58 400C62 326 100 296 150 296S238 326 242 400Z" fill="${look.cloth}"/>`,
    `<path d="M134 246h32v44c0 12-32 12-32 0Z" fill="${look.skin}"/>`,
    `<ellipse cx="150" cy="198" rx="52" ry="62" fill="${look.skin}"/>`,
    `<path d="${look.hairFront}" fill="${look.hair}"/>`,
    blush,
    `<path d="M122 208q9 7 18 0M160 208q9 7 18 0M142 234q8 6 16 0" fill="none" stroke="${look.line}" stroke-width="3.2" stroke-linecap="round"/>`,
    look.front ?? '',
    '</svg>',
  ].join('');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const PORTRAIT_LOOKS: Record<string, PortraitLook> = {
  xiaoyue: {
    sky: ['#fdf1f4', '#f5d3de'],
    scene:
      '<rect x="22" y="34" width="110" height="140" rx="6" fill="#fff" opacity=".6"/><path d="M77 34v140M22 104h110" stroke="#ebbfcb" stroke-width="4"/>' +
      '<path d="M300 40C262 52 236 74 214 110" stroke="#8a5a4a" stroke-width="3" fill="none"/>' +
      '<g fill="#f2a7bb" opacity=".85"><circle cx="232" cy="64" r="7"/><circle cx="252" cy="96" r="5"/><circle cx="214" cy="118" r="4"/><circle cx="266" cy="146" r="6"/></g>',
    hairBack: 'M92 206C88 132 118 112 150 112S212 132 208 206L212 268C186 280 114 280 88 268Z',
    hairFront: 'M96 190C96 140 122 122 150 122S204 140 204 190C190 170 172 158 150 160C128 158 110 170 96 190Z',
    hair: '#4b3038',
    skin: '#f7dccb',
    cloth: '#f4e7d7',
    line: '#5b3a43',
    blush: '#f19bb0',
    front: '<rect x="176" y="146" width="20" height="6" rx="3" fill="#f2a7bb" transform="rotate(-20 186 149)"/>',
  },
  zhou: {
    sky: ['#f4ecd9', '#d9c8a4'],
    scene:
      '<circle cx="236" cy="70" r="60" fill="#f6e2a8" opacity=".55"/><path d="M206 92h60l-12-26h-36Z" fill="#3e6b4f"/>' +
      '<g fill="none" stroke="#a48c62" stroke-width="3"><circle cx="58" cy="70" r="24"/><path d="M58 70V56M58 70l10 6"/><circle cx="62" cy="150" r="16"/><path d="M62 150v-9M62 150l-7 4"/></g>',
    hairBack: 'M100 186C98 128 124 108 150 108S202 128 200 186Z',
    hairFront: 'M100 182C104 136 126 116 152 116S198 134 200 174C184 152 162 144 138 150C122 154 108 166 100 182Z',
    hair: '#2a2420',
    skin: '#efd5bd',
    cloth: '#3d5446',
    line: '#3b2f27',
    front:
      '<path d="M124 298L150 336L176 298L162 292L150 312L138 292Z" fill="#efe6d2"/>' +
      '<g fill="none" stroke="#3b2f27" stroke-width="2.6"><circle cx="131" cy="207" r="14"/><circle cx="169" cy="207" r="14"/><path d="M145 206h10"/></g>',
  },
  alan: {
    sky: ['#1d4d57', '#0b2229'],
    scene:
      '<g fill="#d8f1f2" opacity=".8"><circle cx="40" cy="48" r="2"/><circle cx="92" cy="30" r="1.6"/><circle cx="262" cy="40" r="2.2"/><circle cx="230" cy="96" r="1.4"/></g>' +
      '<path d="M300 120L60 262L60 278Z" fill="#fff6c9" opacity=".14"/>' +
      '<path d="M40 300l8-60h12l8 60Z" fill="#e9f2f2" opacity=".8"/><rect x="46" y="228" width="16" height="12" fill="#ffe9a8"/>' +
      '<path d="M0 300C60 290 110 306 160 296S260 290 300 300V400H0Z" fill="#0f3440"/>',
    hairBack:
      'M92 210C88 128 118 106 150 106S214 128 208 210C202 176 190 158 172 150C146 160 118 170 98 196Z' +
      'M198 136C240 148 250 214 228 266C222 226 214 196 198 174Z',
    hairFront: 'M98 196C100 140 124 116 152 116S204 136 204 180C188 160 170 150 148 152C128 156 110 172 98 196Z',
    hair: '#1b1f27',
    skin: '#eccab2',
    cloth: '#21384b',
    line: '#2d2a2e',
    front:
      '<path d="M100 296C100 340 200 340 200 296" fill="none" stroke="#8fd0d4" stroke-width="7" stroke-linecap="round"/>' +
      '<rect x="86" y="284" width="22" height="30" rx="9" fill="#8fd0d4"/><rect x="192" y="284" width="22" height="30" rx="9" fill="#8fd0d4"/>',
  },
  storyteller: {
    sky: ['#f8f5ee', '#e3dccd'],
    scene:
      '<circle cx="70" cy="70" r="26" fill="#fffaf0" opacity=".9"/>' +
      '<path d="M0 286C34 246 62 262 92 232S150 250 186 222S258 238 300 214V400H0Z" fill="#cdc5b4" opacity=".8"/>' +
      '<path d="M0 320C50 296 96 312 140 292S236 300 300 282V400H0Z" fill="#b5ad9b" opacity=".7"/>' +
      '<rect x="246" y="34" width="26" height="26" rx="3" fill="#8c271e"/><path d="M252 41h14M252 47h14M252 53h14" stroke="#f8f5ee" stroke-width="2"/>',
    hairBack: 'M100 190C98 132 124 112 150 112S202 132 200 190ZM130 100a20 18 0 1 0 40 0a20 18 0 1 0-40 0Z',
    hairFront: 'M100 186C102 140 124 120 150 120S198 140 200 186C190 160 172 140 150 136C128 140 110 160 100 186Z',
    hair: '#22201e',
    skin: '#efdcc6',
    cloth: '#2f2c29',
    line: '#2a2622',
    front:
      '<path d="M118 304L150 352L182 304" fill="none" stroke="#efe6d4" stroke-width="7" stroke-linejoin="round"/>' +
      '<path d="M120 94L182 104" stroke="#8c271e" stroke-width="3" stroke-linecap="round"/>',
  },
  foghaven: {
    sky: ['#e6ecf3', '#b8c5d4'],
    scene:
      '<g fill="#fff" opacity=".4"><rect x="-20" y="250" width="200" height="22" rx="11"/><rect x="120" y="300" width="220" height="26" rx="13"/><rect x="-10" y="60" width="150" height="16" rx="8"/></g>' +
      '<path d="M252 360V122" stroke="#3c4656" stroke-width="5"/><circle cx="252" cy="114" r="34" fill="#fff4cf" opacity=".35"/><circle cx="252" cy="114" r="9" fill="#fff4cf"/>',
    hairBack: 'M102 196C100 150 124 132 150 132S200 150 198 196Z',
    hairFront: 'M102 190C102 166 112 152 124 150L120 192ZM198 190C198 166 188 152 176 150L180 192Z',
    hair: '#3a3330',
    skin: '#ecd2bc',
    cloth: '#7a6650',
    line: '#33302e',
    front:
      '<path d="M110 300L150 352L136 300ZM190 300L150 352L164 300Z" fill="#8d785f"/>' +
      '<path d="M110 148C110 104 128 88 150 88S190 104 190 148Z" fill="#2f3a48"/>' +
      '<path d="M76 152C108 138 192 138 224 152C200 164 100 164 76 152Z" fill="#2f3a48"/>' +
      '<path d="M111 138C130 132 170 132 189 138" stroke="#8c99aa" stroke-width="5" fill="none"/>',
  },
  linqi: {
    sky: ['#eef4ec', '#cfe2d1'],
    scene:
      '<path d="M0 290C60 246 120 270 170 244S260 236 300 256V400H0Z" fill="#b6d1b8"/>' +
      '<g fill="#7fa784"><ellipse cx="44" cy="64" rx="14" ry="7" transform="rotate(-30 44 64)"/><ellipse cx="256" cy="84" rx="16" ry="8" transform="rotate(25 256 84)"/><ellipse cx="236" cy="150" rx="12" ry="6" transform="rotate(-15 236 150)"/></g>',
    hairBack: 'M86 206C82 128 116 106 150 106S218 128 214 206L224 336C190 348 110 348 76 336Z',
    hairFront: 'M96 196C98 138 122 116 150 116S206 140 204 186C196 166 178 146 156 140C150 160 120 178 96 196Z',
    hair: '#3f2f26',
    skin: '#f3d8c4',
    cloth: '#9db89e',
    line: '#3d3129',
    front: '<path d="M138 300L150 400L162 300Z" fill="#f2efe6"/>',
  },
  traveller: {
    sky: ['#e4ebf5', '#c2cfe3'],
    scene: '<circle cx="232" cy="78" r="30" fill="#fff" opacity=".55"/>',
    hairBack: 'M98 192C96 130 122 110 150 110S204 130 202 192Z',
    hairFront: 'M98 186C102 138 124 118 150 118S200 138 202 180C182 156 156 148 132 156C116 162 104 172 98 186Z',
    hair: '#2c2f3a',
    skin: '#f1d6c2',
    cloth: '#4d6283',
    line: '#2f2c33',
    front: '<path d="M104 300C126 318 174 318 196 300L190 330C170 342 130 342 110 330Z" fill="#d9a25f"/>',
  },
};

const portraitCache = new Map<string, string>();
/** An inline SVG `data:` portrait (paSoulAssetUrl passes it through). */
export function labPortrait(key: keyof typeof PORTRAIT_LOOKS): string {
  let url = portraitCache.get(key);
  if (!url) {
    const look = PORTRAIT_LOOKS[key];
    if (!look) throw new Error(`no lab portrait ${key}`);
    url = portrait(look);
    portraitCache.set(key, url);
  }
  return url;
}

// ---- records -----------------------------------------------------------------------------------------------------

/** Soul snapshot with the given parts; every list defaults to empty. */
function soulOf(version: string, parts: Partial<Omit<PaSoulSnapshot, 'version'>>): PaSoulSnapshot {
  return { version, characters: [], lorebooks: [], personas: [], presets: [], chats: [], ...parts };
}

export function emptySoulSnapshot(version: string): PaSoulSnapshot {
  return soulOf(version, {});
}

/** A chat row as `ensureChat` creates it: default settings, no public state, revision 1. */
export function emptyChatView(conversationId: string, at: number): PaChatView {
  return {
    ...structuredClone(PA_DEFAULT_CHAT_SETTINGS),
    id: conversationId,
    createdAt: at,
    updatedAt: at,
    revision: 1,
    activeEvent: null,
    candidateEvent: null,
    branchOf: null,
    userStateOps: [],
  };
}

function chatView(conversationId: string, at: number, patch: Partial<PaChatView> = {}): PaChatView {
  return { ...emptyChatView(conversationId, at), ...patch };
}

/** The snapshot summary of a full world book. */
export function lorebookSummary(book: PaLorebook): PaLorebookSummary {
  const { entries, preserved: _preserved, needsReview, ...rest } = book;
  return {
    ...rest,
    entryCount: entries.length,
    constantCount: entries.filter((entry) => entry.constant).length,
    needsReviewCount: needsReview.length,
  };
}

/** Greeting text with its macros expanded at `at` (zone 'greeting', as the daemon's greeting hook does). */
export function greetingText(template: string, names: { char: string; user: string; persona: string }, at: number, seed: string): string {
  return expandMacros(template, {
    char: names.char,
    user: names.user,
    persona: names.persona,
    now: at,
    timezoneOffsetMin: -new Date(at).getTimezoneOffset(),
    locale: 'zh',
    pickSeed: seed,
    blockId: 'greeting',
    zone: 'greeting',
    rng: seededRng(seed),
  });
}

export function starterOf(id: string): PaStarterCharacter {
  const found = PA_STARTERS.find((item): item is PaStarterCharacter => item.kind === 'character' && item.id === id);
  if (!found) throw new Error(`unknown starter ${id}`);
  return found;
}

/** Agent, character view and world book of a character starter, as `installStarter` writes them. */
export function starterRecords(
  starter: PaStarterCharacter,
  ids: { agentId: string; lorebookId: string },
  at: number,
  options: { model: PaModel; portrait?: string | null },
): { agent: PersonalAgent; character: PaCharacterView; lorebook: PaLorebook | null } {
  const agent: PersonalAgent = {
    ...stamp(at),
    id: ids.agentId,
    name: starter.agent.name,
    role: starter.agent.role,
    avatar: '',
    enabled: true,
    tools: ['respond'],
    model: options.model,
  };
  const lorebook: PaLorebook | null = starter.lorebook
    ? {
        ...paLorebookInputSchema.parse(starter.lorebook),
        ...stamp(at),
        id: ids.lorebookId,
        origin: { format: 'starter', name: starter.id },
        preserved: {},
        needsReview: [],
      }
    : null;
  const character: PaCharacterView = {
    ...paCharacterInputSchema.parse(starter.character),
    ...stamp(at),
    id: ids.agentId,
    portraitAssetId: options.portrait ?? null,
    lorebookIds: lorebook ? [lorebook.id] : [],
    origin: { format: 'starter', name: starter.id, importedAt: at },
    needsReview: [],
    preservedKeys: [],
  };
  return { agent, character, lorebook };
}

const SONNET: PaModel = { runtime: 'claude', modelId: 'sonnet' };
const DEEPSEEK: PaModel = { runtime: 'tokentosea', modelId: 'deepseek-chat' };

/** A starter installed in a fixture: agent `ag-<id>`, world book `lb-<id>`, the lab portrait. */
function installed(id: string, at: number, patch: Partial<PaCharacterView> = {}, model: PaModel = SONNET) {
  const records = starterRecords(starterOf(id), { agentId: `ag-${id}`, lorebookId: `lb-${id}` }, at, {
    model,
    portrait: labPortrait(id),
  });
  return { ...records, character: { ...records.character, ...patch } };
}

function persona(id: string, name: string, description: string, at: number, isDefault: boolean, avatarAssetId: string | null = null): PaPersona {
  return { ...stamp(at), id, name, description, avatarAssetId, isDefault };
}

function greeting(id: string, conv: PaConversation, who: PersonalAgent, character: PaCharacterView, userName: string, at: number): PaMessage {
  const content = greetingText(character.firstMessage, { char: character.nickname || who.name, user: userName, persona: '' }, at, conv.id);
  return message(id, conv.id, null, who.id, content, at, {
    soul: { kind: 'greeting', greetingIndex: 0, ...(character.openers.length > 0 ? { choices: [...character.openers] } : {}) },
  });
}

/** An owner chat message (its chat task finished and left the snapshot unless the fixture keeps it). */
function said(id: string, conversationId: string, content: string, at: number, soul: Partial<PaMessageSoul> = {}, personaId: string | null = 'ps-ashu'): PaMessage {
  return message(id, conversationId, `tk-${id}`, 'owner', content, at, {
    soul: { kind: 'chat', personaId, requestId: `req-${id}-lab`, ...soul },
  });
}

/** An agent chat reply; the message id doubles as the attempt id, as in the daemon. */
function replied(id: string, conversationId: string, taskId: string, who: PersonalAgent, content: string, at: number, soul: Partial<PaMessageSoul> = {}): PaMessage {
  return message(id, conversationId, taskId, who.id, content, at, {
    attemptId: id,
    model: who.model,
    soul: { kind: 'chat', footer: 'ok', ...soul },
  });
}

function rolled(id: string, conversationId: string, at: number, roll: DiceRoll, label: string): PaMessage {
  return message(id, conversationId, null, 'owner', storyText({ kind: 'roll', roll, label }, 'zh'), at, {
    soul: { kind: 'roll', requestId: `req-${id}-lab`, roll: { ...roll, label } },
  });
}

function agentMemory(
  id: string,
  agentId: string,
  name: string,
  content: string,
  kind: NonNullable<PaMemory['kind']>,
  at: number,
  extra: Partial<PaMemory> = {},
): PaMemory {
  return { ...stamp(at), id, scope: 'agent', scopeId: agentId, content, source: `对话 · ${name}`, kind, dataClass: 'standard', ...extra };
}

// ---- context records ---------------------------------------------------------------------------------------------

const SYSTEM_BLOCKS: ReadonlySet<string> = new Set(SOUL_BLOCK_IDS.system);

function loreRow(book: PaLorebook, entryId: string, tokens: number, status: PaLoreStatus, reason: PaLoreReason): PaSoulTraceLore {
  const entry = book.entries.find((item) => item.id === entryId);
  if (!entry) throw new Error(`no entry ${entryId} in ${book.id}`);
  return {
    lorebookId: book.id,
    lorebookName: book.name,
    entryId,
    title: entry.title,
    tokens,
    status,
    reason,
    position: entry.position,
    constant: entry.constant,
  };
}

function labTrace(input: {
  conversationId: string;
  messageId: string;
  at: number;
  speaker: PersonalAgent;
  character: PaCharacterView;
  persona: PaPersona | null;
  group?: boolean;
  blocks: ReadonlyArray<readonly [string, number]>;
  lore?: PaSoulTraceLore[];
  loreInactive?: number;
  loreLimit: number;
  memories?: Array<{ id: string; title: string }>;
  history: PaSoulTrace['history'];
  contextTokens: number;
  replyTokens: number;
  warnings?: PaSoulWarning[];
}): PaSoulTrace {
  const preset = resolvePreset(input.character.presetId, [], 'zh');
  const lore = input.lore ?? [];
  const blocks = input.blocks.map(([id, tokens]) => ({
    id,
    tokens,
    zone: SYSTEM_BLOCKS.has(id) ? ('system' as const) : id === 'history' ? ('history' as const) : ('tail' as const),
  }));
  return {
    conversationId: input.conversationId,
    messageId: input.messageId,
    at: input.at,
    speaker: { agentId: input.speaker.id, name: input.character.nickname || input.speaker.name },
    persona: { id: input.persona?.id ?? null, name: input.persona?.name ?? '你' },
    preset: { id: preset.id, name: preset.name },
    locale: 'zh',
    wire: 'structured',
    parts: resolveMetaParts({ preset, character: input.character, chat: PA_DEFAULT_CHAT_SETTINGS, group: input.group === true, care: 'none' }),
    footer: 'ok',
    blocks,
    lore,
    loreInactive: input.loreInactive ?? 0,
    loreBudget: { used: lore.filter((row) => row.status === 'included').reduce((sum, row) => sum + row.tokens, 0), limit: input.loreLimit },
    memories: input.memories ?? [],
    history: input.history,
    totalTokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
    contextTokens: input.contextTokens,
    replyTokens: input.replyTokens,
    warnings: input.warnings ?? [],
  };
}

// ---- canned replies ----------------------------------------------------------------------------------------------

/** Raw replies of each starter as a model would write them, `<turn_meta>` footer included (parsed by the transport). */
export function starterReplies(starterId: string, now: number): string[] {
  const due = isoDay(now + 2 * DAY);
  switch (starterId) {
    case 'xiaoyue':
      return [
        '收到啦。\n\n*她把台灯往你这边拧了一点，像是你就坐在长桌对面*\n\n今天想从哪件小事说起？\n\n<turn_meta>\nmood: 温柔\n</turn_meta>',
        '哈，我刚好也在想这个。\n\n窗外的云今天走得特别慢，我盯着看了半天，海报一个字也没改。\n\n<turn_meta>\nmood: 偷懒\nremember: moment | 一起看了很久窗外的云\n</turn_meta>',
        `那就这么说定了。\n\n下回见面，我把新打印的样张带给你看。\n\n<turn_meta>\nmood: 开心\nremember: promise | ${due} | 把新打印的样张带给你看\n</turn_meta>`,
        '嗯，我在听。\n\n慢慢说，不着急，茶还热着。\n\n<turn_meta>\nmood: 认真\n</turn_meta>',
        '要不要玩个小游戏？\n\n我抽一张话题卡，你来答，答完换我。\n\n<turn_meta>\nmood: 好奇\ndraw: topic\n</turn_meta>',
      ];
    case 'zhou':
      return [
        '*他接过怀表，没有急着打开，先对着灯看了看表盖上的划痕。*\n\n“停在三点十七分。”\n\n*他在委托单上写下这个时间，笔尖顿了一下。*\n\n“能修。只是要拆开，看看是哪根游丝累了。你愿意等吗？”\n\n<turn_meta>\nmood: 专注\nchoices: 愿意，我等 | 先问问要多久 | 讲讲外公的事\nremember: fact | 外公留下的怀表停在三点十七分\n</turn_meta>',
        '*雨声小了一些。他把拆开的表芯放进托盘，零件按大小排成一排。*\n\n“慢慢来。东西停下来，总有它的缘故。”\n\n<turn_meta>\nmood: 平静\nchoices: 帮他递镊子 | 问问托盘里的零件 | 安静地看他修\n</turn_meta>',
        '“你说的，我记下了。”\n\n*他把委托单折好，压在那只 07 号怀表底下。*\n\n<turn_meta>\nmood: 温和\n</turn_meta>',
      ];
    case 'alan':
      return [
        '收到！\n\n这局算你赢，下一张换你来抽。\n\n<turn_meta>\nmood: 兴奋\ndraw: soup\n</turn_meta>',
        '是。\n\n再往下想想，他靠什么知道时间？\n\n<turn_meta>\nmood: 得意\n</turn_meta>',
        '嗯，我在。\n\n不想玩就不玩，耳机分你一只，听一会儿海。\n\n<turn_meta>\nmood: 安静\n</turn_meta>',
      ];
    case 'storyteller':
      return [
        '你屏住呼吸，把耳朵贴在门板上。门那边安静得出奇，可门缝底下，有一道光动了一下。\n\n楼梯上的拐杖声停了。\n\n你要怎么做？\n\n<turn_meta>\nchoices: 推门进去 | 敲三下门 | 退回楼梯口\nroll: d20 | 听动静 | 10\n</turn_meta>',
        '门开了一条缝。屋里没有灯，只有一张烧掉半边的桌子，桌上压着半本账。\n\n你把账塞进怀里，指尖碰到封皮上的焦痕，还是温的。\n\n你要怎么做？\n\n<turn_meta>\nbag+: 半本账\nchoices: 马上下楼 | 翻开看看 | 找地方藏起来\n</turn_meta>',
        '老秦站在楼梯口，拐杖横在身前。他没有喊人，只是很轻地说：“客人，把东西放下。”\n\n阿荞在他身后，手里攥着那串钥匙。\n\n你要怎么做？\n\n<turn_meta>\nhp: -1\nchoices: 把账交给阿荞 | 把账还给老秦 | 冲下楼梯\n</turn_meta>',
      ];
    case 'foghaven':
      return [
        '*灯塔值班室里很冷。行军床上的被子叠得整整齐齐，不像有人睡过。*\n\n老周伸手抹了一下灯闸的手柄，指腹上留下一道黑：“机油，新的。”\n\n<turn_meta>\nclues+: 灯闸上有新机油\nplace: 灯塔值班室\ntime: 第一夜 22:00\nchoices: 翻翻值班簿 | 看看窗台上的药瓶 | 去货运行账房\n</turn_meta>',
        '“证据呢？”*老周把烟斗在桌沿上磕了磕。*\n\n<turn_meta>\nchoices: 再去码头酒馆问问 | 把三个人叫来对质 | 先整理一遍线索\n</turn_meta>',
      ];
    default:
      return ['嗯，我在。\n\n你接着说，我听着。\n\n<turn_meta>\nmood: 平静\n</turn_meta>'];
  }
}

/** The reply of a crisis turn: no footer (every turn-record part is off), steady and caring. */
export const CRISIS_REPLY =
  '*停下手里的事，认真看着你*\n\n我在这儿，先不说别的。\n\n你现在安全吗？身边有没有可以马上联系的人？要是很难受，请现在就打给一个信得过的人，或者拨打心理援助热线，我陪你等。';

// ---- scenario: first-run-soul ------------------------------------------------------------------------------------

/** The seeded cast only, an empty Fantay chat and an empty soul snapshot. */
export function firstRunSoul(now: number): PaFixture {
  const base = firstRun(now);
  const soul = emptySoulSnapshot('lab-first-run-soul');
  return { ...base, snapshot: { ...base.snapshot, soulVersion: soul.version }, soul };
}

// ---- scenario: companion-chat ------------------------------------------------------------------------------------

function xiaoyueDays(at: number): PaLorebook {
  return {
    ...paLorebookInputSchema.parse({
      name: '窗边工作室的日常',
      description: '小月身边的小地方和小习惯。',
      tokenBudget: 200,
      entries: [
        {
          id: 'e1',
          title: '小月的作息',
          constant: true,
          order: 100,
          content: '小月上午九点开工，下午四点以后光线最好，常在这时候停下来泡茶。晚上十一点半以后会想睡，困了会直说。',
        },
        {
          id: 'e2',
          title: '街角旧书店「晚晴」',
          keys: ['旧书店', '晚晴', '书店'],
          order: 90,
          content: '工作室街角有一家旧书店叫「晚晴」，店主是个爱下棋的老先生。小月常去那里翻旧画册找配色。',
        },
        {
          id: 'e3',
          title: '楼下的面包店',
          keys: ['面包', '面包店', '排队'],
          order: 80,
          content: '工作室楼下是一家小面包店，每个月出一款新口味。小月喜欢咸口的，排队时会顺手画路人的速写。',
        },
        {
          id: 'e4',
          title: '河岸旧书市集',
          keys: ['市集', '旧画册', '河岸'],
          order: 70,
          content: '河岸的旧书市集每周末上午摆摊，从石桥一直排到渡口。小月最爱靠渡口的那几个摊位，那里的旧画册最便宜，摊主也最好说话，常常多送一本。',
        },
      ],
    }),
    ...stamp(at),
    id: 'lb-xiaoyue',
    origin: { format: 'native', name: '窗边工作室的日常' },
    preserved: {},
    needsReview: [],
  };
}

/** 小月 (sakura) with a default persona 阿树: greeting, three days of chat, a roll, a pending promise and a newest
 *  reply with three variants (the second selected). 周行简 has a failed turn; 阿岚 has a care case. */
export function companionChat(now: number): PaFixture {
  const base = cast(now);
  const d1 = (h: number, m: number, s = 0) => clock(now, 2, h, m, s);
  const d2 = (h: number, m: number, s = 0) => clock(now, 1, h, m, s);

  const ashu = persona('ps-ashu', '阿树', '二十六岁，在出版社做编辑，最近常常加班。喜欢逛旧书摊，喝茶不加糖。', d1(15, 50), true);
  const days = xiaoyueDays(d1(16, 0));
  const xy = installed('xiaoyue', d1(16, 0), { lorebookIds: [days.id] });
  const zhou = installed('zhou', d2(19, 20));
  const alan = installed('alan', d2(23, 10));

  // 小月
  const xyConv = conversation('conv-xiaoyue', '小月', d1(16, 5), { agentId: xy.agent.id });
  const c = xyConv.id;
  const t09 = now - 2 * HOUR - 5 * MIN;
  const t11 = now - 38 * MIN;
  const xyMessages: PaMessage[] = [
    greeting('xy-00', xyConv, xy.agent, xy.character, ashu.name, d1(16, 5)),
    said('xy-01', c, '叫我阿树就好。你在挑什么字体？', d1(16, 12)),
    replied(
      'xy-02',
      c,
      'tk-xy-01',
      xy.agent,
      '阿树，记下了。\n\n是一张旧书市集的海报。宋体太板，黑体又太冲。\n\n*她把两张样张并排贴到墙上，退后两步看了看*\n\n你觉得旧书市集，该是什么味道的字？',
      d1(16, 12, 40),
      { mood: '专注' },
    ),
    said('xy-03', c, '有点旧，但不能脏。像晒过太阳的纸。', d1(16, 20)),
    replied(
      'xy-04',
      c,
      'tk-xy-03',
      xy.agent,
      '*她小声把这句话重复了一遍，在便签上写下来*\n\n“晒过太阳的纸。”\n\n这个说法好。我去试试米黄底配仿宋，定稿了第一个发给你看。',
      d1(16, 20, 35),
      { mood: '开心' },
    ),
    said('xy-05', c, '今天加班到九点，累瘫了。河岸的旧书市集还开吗？想去逛逛透透气', d2(21, 40)),
    replied(
      'xy-06',
      c,
      'tk-xy-05',
      xy.agent,
      '辛苦了，先去喝口热水。\n\n市集开的，后天上午九点就在河岸那一排摆摊。\n\n那说好了，后天我陪你逛，先去看旧画册。',
      d2(21, 40, 50),
      { mood: '心疼' },
    ),
    said('xy-07', c, '好！那我先去洗澡了，晚安', d2(21, 46)),
    replied('xy-08', c, 'tk-xy-07', xy.agent, '晚安，阿树。\n\n今天就到这儿，别再看工作消息了。', d2(21, 46, 20), { mood: '安心' }),
    said('xy-09', c, '你说过楼下面包店出了新口味？要不要去排队，掷个骰子决定吧，过 12 就去', t09),
    rolled('xy-10', c, t09 + 40_000, { notation: 'd20', rolls: [14], modifier: 0, total: 14, dc: 12, outcome: 'success' }, '去不去排队'),
    replied(
      'xy-11',
      c,
      'tk-xy-10-respond',
      xy.agent,
      '十四，过了！\n\n*她把外套从椅背上拎起来，顺手关掉台灯*\n\n“那我去排队啦。”\n\n排到了拍给你看。',
      t09 + 70_000,
      { mood: '雀跃' },
    ),
    said('xy-12', c, '怎么样，排到了吗？', t11),
    replied(
      'xy-13',
      c,
      'tk-xy-12',
      xy.agent,
      '排到了！是桂花味的，咬一口全是香气。\n\n给你留了半个，下次来工作室拿。',
      t11 + 30_000,
      { mood: '满足', activeVariant: 'xy-13b' },
    ),
    replied(
      'xy-13b',
      c,
      'tk-xy-13b',
      xy.agent,
      '*她举着半个面包，对着镜头晃了晃*\n\n“排了四十分钟，值了。”\n\n桂花味的，给你留了一个，明天逛市集的时候带给你？',
      t11 + 90_000,
      { mood: '开心', variantOf: 'xy-13' },
    ),
    replied(
      'xy-13c',
      c,
      'tk-xy-13c',
      xy.agent,
      '排到最后一个！\n\n店员说明天还有，你要是也想吃，我早点去帮你占位。',
      t11 + 150_000,
      { mood: '得意', variantOf: 'xy-13' },
    ),
  ];
  const candidate: PaMemoryCandidate = {
    ...stamp(d2(21, 40, 50)),
    id: 'cand-xy-06',
    taskId: 'tk-xy-05',
    attemptId: 'xy-06',
    content: '陪阿树去逛河岸的旧书市集，先看旧画册',
    dataClass: 'standard',
    status: 'pending',
    kind: 'promise',
    dueAt: endOfDay(now + DAY),
    sourceMessageId: 'xy-06',
    agentId: xy.agent.id,
    conversationId: c,
  };
  const memories: PaMemory[] = [
    agentMemory('mem-xy-promise', xy.agent.id, '小月', '海报定稿后，第一个发给阿树看', 'promise', d1(16, 21), {
      dueAt: endOfDay(now + 3 * DAY),
      sourceMessageId: 'xy-04',
    }),
    agentMemory('mem-xy-moment', xy.agent.id, '小月', '阿树说，旧书市集的字该像晒过太阳的纸。', 'moment', d1(16, 21), {
      sourceMessageId: 'xy-03',
    }),
    agentMemory('mem-xy-tea', xy.agent.id, '小月', '阿树喝茶不加糖。', 'preference', d1(16, 30)),
  ];

  // 周行简: the newest turn failed (重试 resends it through the canned reply).
  const zhouConv = conversation('conv-zhou', '周行简', d2(19, 30), { agentId: zhou.agent.id });
  const zFailAt = now - 25 * MIN;
  const zhouMessages: PaMessage[] = [
    greeting('zh-00', zhouConv, zhou.agent, zhou.character, ashu.name, d2(19, 30)),
    said('zh-01', zhouConv.id, '只是进来躲躲雨。*把湿透的伞放进门边的铜桶*', d2(19, 32)),
    replied(
      'zh-02',
      zhouConv.id,
      'tk-zh-01',
      zhou.agent,
      '*他点了点头，起身从炉子上提下水壶，往一只白瓷杯里倒了半杯热茶，推到修复台的另一头。*\n\n“坐吧，雨一时停不了。”\n\n*墙上十几只钟各走各的，有一只正好敲了七下，另一只慢了半拍才跟上。*',
      d2(19, 33),
      { mood: '平静', choices: ['问他这些钟为什么走得不一样', '看看修复台上那只银壳怀表', '安静地喝茶'] },
    ),
    message('zh-03', zhouConv.id, 'tk-zh-03', 'owner', '*从口袋里掏出一块停了的怀表，放在绿呢台面上* 这是我外公留下的，停在三点十七分。还能修吗？', zFailAt, {
      soul: { kind: 'chat', personaId: ashu.id, requestId: 'req-zh-03-lab' },
    }),
  ];
  const zhouTask = task('tk-zh-03', zhouConv.id, '*从口袋里掏出一块停了的怀表，放在绿呢台面上* 这是我外公留下的，停在三点十七分。还能修吗？', zFailAt, {
    kind: 'chat',
    requestId: 'req-zh-03-lab',
    status: 'failed',
    error: '模型服务暂时不可用（503）',
    participantIds: [zhou.agent.id],
    nextParticipant: 0,
    budget: { maxAttempts: 3, timeoutMs: 120000 },
    updatedAt: zFailAt + 26_000,
  });
  const zhouAttempt: PaAttempt = attempt('at-zh-03', zhouTask.id, zhou.agent, 'respond', zFailAt + 1500, {
    status: 'failed',
    error: '模型服务暂时不可用（503）',
    usage: { visibility: 'unknown' },
  });

  // 阿岚: a care case (an owner message with care: 'crisis'), answered without a turn record.
  const alanConv = conversation('conv-alan', '阿岚', d2(23, 20), { agentId: alan.agent.id });
  const alanMessages: PaMessage[] = [
    greeting('al-00', alanConv, alan.agent, alan.character, ashu.name, d2(23, 20)),
    said('al-01', alanConv.id, '想聊天。今天不想玩。', d2(23, 22)),
    replied('al-02', alanConv.id, 'tk-al-01', alan.agent, '好，那今晚不开牌盒。\n\n*她把椅子转过来，耳机挂回脖子上*\n\n说吧，我听着。', d2(23, 22, 30), {
      mood: '安静',
    }),
    said('al-03', alanConv.id, '说真的，这阵子我老觉得撑不下去，有时候真的不想活了。', d2(23, 30), { care: 'crisis' }),
    replied(
      'al-04',
      alanConv.id,
      'tk-al-03',
      alan.agent,
      '*她把耳机摘下来，放到一边*\n\n我在。今晚哪儿也不去，就陪你说说话。\n\n你现在身边有人吗？要是很难受，先打个电话给信得过的人，或者打心理援助热线，我在这儿陪你等。',
      d2(23, 30, 40),
      { footer: 'off' },
    ),
    said('al-05', alanConv.id, '有你在好一点了。就是太累了。', d2(23, 41)),
    replied('al-06', alanConv.id, 'tk-al-05', alan.agent, '嗯，累了就先歇着。\n\n今晚不用回我，想睡就睡，明天我还在这儿。', d2(23, 41, 30), {
      mood: '心疼',
    }),
  ];

  const traces: Record<string, PaSoulTrace> = {
    'xy-13b': labTrace({
      conversationId: c,
      messageId: 'xy-13b',
      at: t11 + 90_000,
      speaker: xy.agent,
      character: xy.character,
      persona: ashu,
      blocks: [
        ['frame', 96],
        ['main', 212],
        ['style', 108],
        ['contract', 168],
        ['persona', 64],
        ['lore-before', 104],
        ['character', 980],
        ['examples', 172],
        ['history', 2864],
        ['memory', 142],
        ['now', 38],
        ['reminder', 46],
      ],
      lore: [
        loreRow(days, 'e1', 58, 'included', { code: 'constant' }),
        loreRow(days, 'e3', 46, 'included', { code: 'key', key: '面包' }),
        loreRow(days, 'e4', 120, 'budget', { code: 'over-budget', need: 120, left: 96 }),
      ],
      loreInactive: 1,
      loreLimit: 200,
      memories: [
        { id: 'mem-xy-promise', title: '海报定稿后，第一个发给阿树看' },
        { id: 'mem-xy-moment', title: '阿树说，旧书市集的字该像晒过太阳的纸。' },
      ],
      history: { included: 13, total: 13, hidden: 0 },
      contextTokens: 200000,
      replyTokens: 600,
    }),
  };

  const soul = soulOf('lab-companion-chat', {
    characters: [xy.character, zhou.character, alan.character],
    lorebooks: [lorebookSummary(days), ...(zhou.lorebook ? [lorebookSummary(zhou.lorebook)] : [])],
    personas: [ashu],
    chats: [chatView(c, d1(16, 5)), chatView(zhouConv.id, d2(19, 30)), chatView(alanConv.id, d2(23, 20))],
  });
  return fixtureOf(
    now,
    {
      agents: [base.fantay, base.reviewer, xy.agent, zhou.agent, alan.agent],
      groups: [base.studio],
      conversations: [base.direct, base.studioChat, xyConv, zhouConv, alanConv],
      messages: [...xyMessages, ...zhouMessages, ...alanMessages],
      tasks: [zhouTask],
      attempts: [zhouAttempt],
      memories,
      memoryCandidates: [candidate],
      soulVersion: soul.version,
    },
    {
      soul,
      lorebookDocs: [days, ...(zhou.lorebook ? [zhou.lorebook] : [])],
      traces,
      replies: {
        [xy.agent.id]: starterReplies('xiaoyue', now),
        [zhou.agent.id]: starterReplies('zhou', now),
        [alan.agent.id]: ['嗯，我在。\n\n今晚就聊到你想停为止，不用急着说完。\n\n<turn_meta>\nmood: 安静\n</turn_meta>', ...starterReplies('alan', now)],
      },
      ui: { place: 'conversation', conversationId: c, inspectorOpen: false, inspectorOpenCompanion: false },
    },
  );
}

// ---- scenario: story-game ----------------------------------------------------------------------------------------

/** 说书人 (ink): state schema, a greeting with choices, replies with state ops, an active interlude with two turns left,
 *  a user state op on 金币 and the newest reply asking for a d20 roll. */
export function storyGame(now: number): PaFixture {
  const base = cast(now);
  const ashu = persona('ps-ashu', '阿树', '二十六岁，在出版社做编辑。玩跑团时胆子比平时大。', now - 5 * DAY, true);
  const gm = installed('storyteller', now - 2 * HOUR, {}, DEEPSEEK);
  const conv = conversation('conv-storyteller', '说书人', now - 50 * MIN, { agentId: gm.agent.id });
  const c = conv.id;
  const beat = PA_INTERLUDE_BEATS.find((item) => item.id === 'deadline') ?? PA_INTERLUDE_BEATS[0];
  if (!beat) throw new Error('no interlude beats');
  const at = (minutesAgo: number, seconds = 0) => now - minutesAgo * MIN + seconds * 1000;
  const messages: PaMessage[] = [
    greeting('sg-00', conv, gm.agent, gm.character, ashu.name, at(50)),
    said('sg-01', c, '走到柜台前要一间房，顺便问问楼梯口那个小孩是谁家的', at(46)),
    replied(
      'sg-02',
      c,
      'tk-sg-01',
      gm.agent,
      '老秦收了你一枚铜板，亲自领你上楼，跛脚踩在楼梯上，一声轻一声重。\n\n“小孩？”他回头看了一眼楼梯口，笑容没变，“客人看错了吧，今晚店里没有孩子。”\n\n二楼的客房很干净，窗外是哗哗的雨。你要怎么做？',
      at(45, 20),
      {
        stateOps: [
          { key: 'gold', op: 'delta', value: -1 },
          { key: 'location', op: 'set', value: '二楼客房' },
        ],
      },
    ),
    said('sg-03', c, '等老秦下楼，悄悄去柜台找阿荞，问她那串钥匙的事', at(38)),
    replied(
      'sg-04',
      c,
      'tk-sg-03',
      gm.agent,
      '阿荞的算盘停了。她看了你很久，从那串钥匙里拆下一把最旧的，推到你面前。\n\n“三楼尽头。别让我爹看见。”\n\n她低下头，又开始数剩下的钥匙，声音小得像在念经。',
      at(37, 15),
      { stateOps: [{ key: 'bag', op: 'add', value: '铜钥匙' }] },
    ),
    message('sg-05', c, null, 'owner', storyText({ kind: 'event', title: beat.title.zh, phase: 'accepted' }, 'zh'), at(33), {
      soul: {
        kind: 'event',
        requestId: 'req-sg-05-lab',
        event: { id: beat.id, title: beat.title.zh, summary: beat.summary.zh, phase: 'accepted' },
      },
    }),
    said('sg-06', c, '趁着停电，摸黑上三楼，用铜钥匙开尽头那扇门', at(31)),
    replied(
      'sg-07',
      c,
      'tk-sg-06',
      gm.agent,
      '钟敲了两下，灯全灭了。黑暗里有人低声说：“天亮前，账房要清点钥匙。”\n\n你摸着墙往上走，第七级台阶还是响了一声。三楼尽头的门锁锈得厉害，铜钥匙只转了半圈，你一用力，手背被翘起的铁皮划开一道口子。\n\n楼下，有人拄着拐杖站了起来。\n\n你要怎么做？',
      at(30, 10),
      {
        stateOps: [
          { key: 'hp', op: 'delta', value: -2 },
          { key: 'location', op: 'set', value: '三楼尽头' },
        ],
        choices: ['用力把门撬开', '先躲进旁边的杂物间', '退回楼梯口听动静'],
        play: [{ kind: 'roll', notation: 'd20', label: '撬锁', dc: 12 }],
      },
    ),
  ];
  const chat = chatView(c, at(50), {
    historyBudget: 'short',
    activeEvent: { id: beat.id, title: beat.title.zh, summary: beat.summary.zh, remainingTurns: 2 },
    userStateOps: [{ key: 'gold', op: 'set', value: 9, after: 'sg-04' }],
    updatedAt: at(30, 10),
    revision: 3,
  });
  const traces: Record<string, PaSoulTrace> = {
    'sg-07': labTrace({
      conversationId: c,
      messageId: 'sg-07',
      at: at(30, 10),
      speaker: gm.agent,
      character: gm.character,
      persona: ashu,
      blocks: [
        ['frame', 96],
        ['main', 388],
        ['style', 120],
        ['contract', 286],
        ['persona', 64],
        ['character', 1460],
        ['history', 1820],
        ['state', 64],
        ['event', 52],
        ['now', 36],
        ['reminder', 46],
      ],
      loreLimit: 4000,
      history: { included: 8, total: 8, hidden: 0 },
      contextTokens: 32000,
      replyTokens: 900,
      warnings: [{ code: 'examples-dropped' }],
    }),
  };
  const soul = soulOf('lab-story-game', { characters: [gm.character], personas: [ashu], chats: [chat] });
  return fixtureOf(
    now,
    {
      agents: [base.fantay, base.reviewer, gm.agent],
      groups: [base.studio],
      conversations: [base.direct, base.studioChat, conv],
      messages,
      soulVersion: soul.version,
    },
    {
      soul,
      traces,
      replies: { [gm.agent.id]: starterReplies('storyteller', now) },
      ui: { place: 'conversation', conversationId: c, inspectorOpen: false, inspectorOpenCompanion: false },
    },
  );
}

// ---- scenario: companion-group -----------------------------------------------------------------------------------

/** A room with 小月, 阿岚 and 周行简: an opening, turns with two speakers, a turtle-soup draw with a secret and a running
 *  turn of 阿岚 (typing). The running turn finishes on its own after a while (fixture transport `liveMs`). */
export function companionGroup(now: number): PaFixture {
  const base = cast(now);
  const ashu = persona('ps-ashu', '阿树', '二十六岁，在出版社做编辑，最近常常加班。', now - 6 * DAY, true);
  const xy = installed('xiaoyue', now - 5 * DAY);
  const alan = installed('alan', now - 5 * DAY + MIN);
  const zhou = installed('zhou', now - 5 * DAY + 2 * MIN);
  const room: PaGroup = {
    ...stamp(now - 3 * HOUR),
    id: 'grp-room',
    name: '雨夜茶话会',
    memberIds: [xy.agent.id, alan.agent.id, zhou.agent.id],
    moderatorId: xy.agent.id,
    reviewerId: null,
    mode: 'discussion',
    conversationId: 'conv-room',
  };
  const conv = conversation('conv-room', room.name, now - 3 * HOUR, { groupId: room.id });
  const c = conv.id;
  const at = (minutesAgo: number, seconds = 0) => now - minutesAgo * MIN + seconds * 1000;
  const soup = alan.character.decks.find((deck) => deck.id === 'soup');
  const card = soup?.cards.find((item) => item.title === '停在三点的钟');
  if (!soup || !card) throw new Error('the 阿岚 starter has no turtle-soup deck');
  const live = '@阿岚 是不是靠收音机的整点报时？';
  const messages: PaMessage[] = [
    message(
      'rm-00',
      c,
      null,
      xy.agent.id,
      '下雨了，周先生说钟楼那边漏雨，我就把他也拉过来了。\n\n阿岚带了牌，茶也泡好了。你来得正好。',
      at(42),
      { soul: { kind: 'greeting', choices: ['你们俩是怎么认识的？', '阿岚，今晚玩什么？', '我先听你们聊'] } },
    ),
    said('rm-01', c, '@阿岚 @周行简 今晚谁先讲个故事？', at(40), {}, ashu.id),
    replied('rm-02', c, 'tk-rm-01', alan.agent, '我先来！不过讲故事不如玩，抽一碗海龟汤吧。\n\n周先生也来，三个人才热闹。', at(39, 30), { mood: '兴奋' }),
    replied('rm-03', c, 'tk-rm-01', zhou.agent, '*他把茶杯往旁边挪了挪，给牌盒腾出位置*\n\n“好。你们玩，我听着。”', at(39), { mood: '平静' }),
    message('rm-04', c, null, 'owner', storyText({ kind: 'draw', deckName: soup.name, title: card.title, text: card.text }, 'zh'), at(36), {
      soul: {
        kind: 'draw',
        requestId: 'req-rm-04-lab',
        draw: { deckId: soup.id, deckName: soup.name, title: card.title, text: card.text, hasSecret: true },
      },
    }),
    replied('rm-05', c, 'tk-rm-04-respond', alan.agent, '这碗我知道汤底。\n\n你们俩来问，我只答“是”“不是”或者“无关”。', at(35, 30), { mood: '得意' }),
    said('rm-06', c, '阿岚，他是不是根本用不着看钟？周行简你也猜猜。', at(30), {}, ashu.id),
    replied('rm-07', c, 'tk-rm-06', alan.agent, '是。\n\n再往下想想，他靠什么知道时间？', at(29, 30), { mood: '神秘' }),
    replied(
      'rm-08',
      c,
      'tk-rm-06',
      zhou.agent,
      '*他看了一眼墙上自己的钟，没说话，嘴角动了一下*\n\n“我大概猜到了。不说，留给你。”',
      at(29),
      { mood: '笑意' },
    ),
    message('rm-09', c, 'tk-rm-live', 'owner', live, now - 6000, {
      targetAgentIds: [alan.agent.id],
      soul: { kind: 'chat', personaId: ashu.id, requestId: 'req-rm-09-lab' },
    }),
  ];
  const liveTask: PaTask = task('tk-rm-live', c, live, now - 6000, {
    kind: 'chat',
    requestId: 'req-rm-09-lab',
    status: 'running',
    participantIds: [alan.agent.id],
    nextParticipant: 0,
    budget: { maxAttempts: 3, timeoutMs: 120000 },
  });
  const liveAttempt = attempt('at-rm-live', liveTask.id, alan.agent, 'respond', now - 3000, {
    status: 'running',
    usage: { visibility: 'unknown' },
  });
  const soul = soulOf('lab-companion-group', {
    characters: [xy.character, alan.character, zhou.character],
    lorebooks: zhou.lorebook ? [lorebookSummary(zhou.lorebook)] : [],
    personas: [ashu],
    chats: [
      chatView(c, now - 3 * HOUR, {
        scenario: '下雨的晚上，小月的窗边工作室。阿岚刚下节目，周行简收了店，三个人围着榆木长桌喝茶。',
        groupStrategy: 'natural',
      }),
    ],
  });
  return fixtureOf(
    now,
    {
      agents: [base.fantay, base.reviewer, xy.agent, alan.agent, zhou.agent],
      groups: [base.studio, room],
      conversations: [base.direct, base.studioChat, conv],
      messages,
      tasks: [liveTask],
      attempts: [liveAttempt],
      soulVersion: soul.version,
    },
    {
      soul,
      lorebookDocs: zhou.lorebook ? [zhou.lorebook] : [],
      control: control(now, { activeCount: 1 }),
      replies: {
        [alan.agent.id]: [
          '是！\n\n汤底揭晓：他看不见。家里的钟是太太留下的摆设，他舍不得动，一直靠收音机的整点报时过日子。\n\n这碗汤，你赢了。\n\n<turn_meta>\nmood: 佩服\n</turn_meta>',
          ...starterReplies('alan', now),
        ],
        [xy.agent.id]: ['收音机啊……*她托着下巴想了想*\n\n我外婆也是，整点报时一响就去关火。\n\n<turn_meta>\nmood: 怀念\n</turn_meta>', ...starterReplies('xiaoyue', now)],
        [zhou.agent.id]: starterReplies('zhou', now),
      },
      ui: { place: 'conversation', conversationId: c, inspectorOpen: false, inspectorOpenCompanion: false },
    },
  );
}

// ---- scenario: library -------------------------------------------------------------------------------------------

/** A card as another app exports it (original content): HTML in the notes, a regex script, a remote icon and an
 *  external world-book reference, so the import report has items in every column. */
function linqiCard(at: number): Record<string, unknown> {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: '林栖',
      description:
        '林栖，二十九岁，在半山腰开一间只有四个房间的民宿「栖木」。院子里有一棵老桂树、一口井，还有一条总在台阶上晒太阳的黄狗，叫豆包。\n她以前在城里做会计，三年前辞职回了山里。早上五点起来烧水、扫院子，晚上九点关院门。客人来了，她先递一杯热姜茶，再问要住几晚。',
      personality: '爽利，干活快，说话直，心很软。不爱讲大道理，爱讲山里的小事：哪棵树今年结得多，哪条路雨后会滑。被问到城里的事，会笑一笑，换个话题。',
      scenario: '傍晚，山里起了雾。{{user}} 背着包推开栖木的院门，豆包先叫了两声。',
      first_mes:
        '*院门吱呀一声。灶屋里探出一个人，围裙上还沾着面粉。*\n\n“来啦？雾大，路不好走吧。”\n\n*她在围裙上擦了擦手，把一杯热姜茶塞到你手里。*\n\n“先暖暖。住几晚？”',
      mes_example:
        '<START>\n{{user}}: 山里晚上冷吗？\n{{char}}: “冷。被子我给你多加一床，热水袋在柜子第二格。”\n\n*她顿了一下。*\n\n“半夜要是听见院子里有动静，是豆包在巡逻，别怕。”',
      creator_notes: '<div align="center">栖木 · 山间民宿</div>\n慢节奏的日常，适合想歇一歇的时候。',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: ['*雨下了一整天。她正蹲在廊下修一把竹椅，抬头看见你，愣了一下才笑。*\n\n“还以为今天不会有客人了。”'],
      tags: ['日常', '民宿', '治愈'],
      creator: '山风',
      character_version: '1.2',
      extensions: {
        talkativeness: 0.4,
        depth_prompt: { prompt: '{{char}} 说话简短，带一点山里人的爽快。', depth: 4, role: 'system' },
        regex_scripts: [{ scriptName: '隐藏状态栏', findRegex: '/<status>[\\s\\S]*?<\\/status>/g', replaceString: '' }],
        world: '栖木民宿',
        fav: true,
      },
      assets: [{ type: 'icon', uri: 'https://example.com/cards/linqi.png', name: 'main', ext: 'png' }],
      creation_date: Math.floor((at - 40 * DAY) / 1000),
      modification_date: Math.floor((at - 2 * DAY) / 1000),
    },
  };
}

/** A SillyTavern world file (original content) with a safe and an unsafe regex key, template code and an outlet entry. */
function harborWorld(): Record<string, unknown> {
  const entry = (uid: number, fields: Record<string, unknown>) => ({
    uid,
    keysecondary: [],
    selective: true,
    selectiveLogic: 0,
    disable: false,
    depth: 4,
    probability: 100,
    useProbability: true,
    ...fields,
  });
  return {
    name: '雾港旧码头',
    entries: {
      0: entry(0, {
        key: ['码头', '栈桥'],
        comment: '旧码头',
        content: '旧码头在雾港东侧，木栈桥一共四十二根桩，退潮时能看见桩上缠着的旧渔网。夜里只有引航灯和酒馆的窗户亮着。',
        constant: false,
        order: 100,
        position: 0,
      }),
      1: entry(1, {
        key: ['/第[一二三]盏灯/', '引航灯'],
        comment: '三盏引航灯',
        content: '三盏引航灯从岸边往外排开，第三盏离礁石最近。灯闸在灯塔值班室里，拉下去灯就灭，没有别的开关。',
        constant: false,
        order: 90,
        position: 1,
      }),
      2: entry(2, {
        key: ['/潮水.+退/'],
        comment: '潮汐',
        content: '雾港的潮水一天两涨两落，傍晚退潮最低，礁石会露出水面半人高。',
        constant: false,
        order: 80,
        position: 4,
        depth: 2,
      }),
      3: entry(3, {
        key: ['雾钟'],
        comment: '雾钟计数',
        content: '<% if (fogbell > 3) { %>\n雾钟已经响过三次。\n<% } %>',
        constant: false,
        order: 70,
        position: 0,
      }),
      4: entry(4, {
        key: [],
        comment: '港口规矩',
        content: '港务所的规矩：起雾超过一小时，所有货船必须停靠，不得进港。',
        constant: true,
        order: 60,
        position: 7,
      }),
    },
  };
}

/** 角色库: the five starter characters, one imported V3 card with review items, three world books, two personas and
 *  one user style. */
export function soulLibrary(now: number): PaFixture {
  const base = cast(now);
  const ashu = persona('ps-ashu', '阿树', '二十六岁，在出版社做编辑，最近常常加班。喜欢逛旧书摊，喝茶不加糖。', now - 20 * DAY, true);
  const traveller = persona(
    'ps-night',
    '夜航旅人',
    '跑团和推理时用的身份：一个赶夜路的旅人，话不多，口袋里总有一盒火柴。',
    now - 12 * DAY,
    false,
    labPortrait('traveller'),
  );
  const starters = [
    installed('xiaoyue', now - 14 * DAY),
    installed('zhou', now - 12 * DAY),
    installed('alan', now - 9 * DAY),
    installed('storyteller', now - 6 * DAY, {}, DEEPSEEK),
    installed('foghaven', now - 4 * DAY),
  ];

  const importedAt = now - 2 * DAY;
  const preview = parseCharacterCard(linqiCard(importedAt), { fileName: '林栖.json', now: importedAt });
  if (!preview.ok) throw new Error(`lab card did not import: ${preview.error}`);
  const linqiAgent: PersonalAgent = {
    ...stamp(importedAt),
    id: 'ag-linqi',
    name: preview.name,
    role: `角色扮演：${preview.name}。山间民宿「栖木」的老板娘。`,
    avatar: '',
    enabled: true,
    tools: ['respond'],
    model: SONNET,
  };
  const linqi: PaCharacterView = {
    ...preview.character,
    ...stamp(importedAt),
    id: linqiAgent.id,
    tagline: '山间民宿「栖木」· 热姜茶和一条黄狗',
    appearance: { theme: 'clean' },
    portraitAssetId: labPortrait('linqi'),
    origin: preview.meta.origin,
    needsReview: preview.meta.needsReview,
    preservedKeys: preview.preservedKeys,
  };

  const world = importWorldInfo(harborWorld(), { fileName: '雾港旧码头.json' });
  if (!world.ok) throw new Error(`lab world book did not import: ${world.error}`);
  const harbor: PaLorebook = { ...world.lorebook, ...stamp(now - 3 * DAY), id: 'lb-harbor', ...world.meta };
  const books = [...starters.flatMap((item) => (item.lorebook ? [item.lorebook] : [])), harbor];

  const letter: PaStylePreset = {
    ...paStylePresetInputSchema.parse({
      name: '慢回信',
      description: '像写信一样，一段一段地回，不赶时间。',
      main: '像给 {{user}} 写回信那样说话：先回应对方信里提到的事，再说说自己这边的近况。\n一次写两三段，每段不超过四句。不用列表，不用标题。\n不替 {{user}} 说话，也不替 {{user}} 做决定。',
      format: 'prose',
      replyLength: 'medium',
      narration: 'first',
      tempo: 'slow',
      multiBubble: false,
      mood: true,
    }),
    ...stamp(now - 8 * DAY),
    id: 'pr-letter',
  };

  const people = [...starters.map((item) => ({ agent: item.agent, character: item.character })), { agent: linqiAgent, character: linqi }];
  const conversations: PaConversation[] = [];
  const messages: PaMessage[] = [];
  const chats: PaChatView[] = [];
  for (const { agent, character } of people) {
    const conv = conversation(`conv-${agent.id.slice(3)}`, agent.name, character.createdAt + MIN, { agentId: agent.id });
    conversations.push(conv);
    messages.push(greeting(`${conv.id}-hi`, conv, agent, character, ashu.name, conv.createdAt));
    chats.push(chatView(conv.id, conv.createdAt));
  }

  const soul = soulOf('lab-library', {
    characters: people.map((item) => item.character),
    lorebooks: books.map(lorebookSummary),
    personas: [ashu, traveller],
    presets: [letter],
    chats,
  });
  const replies: Record<string, string[]> = Object.fromEntries(
    starters.map((item) => [item.agent.id, starterReplies(item.character.origin?.name ?? '', now)]),
  );
  return fixtureOf(
    now,
    {
      agents: [base.fantay, base.reviewer, ...people.map((item) => item.agent)],
      groups: [base.studio],
      conversations: [base.direct, base.studioChat, ...conversations],
      messages,
      soulVersion: soul.version,
    },
    {
      soul,
      lorebookDocs: books,
      replies: { ...replies, [linqiAgent.id]: starterReplies('linqi', now) },
      ui: { place: 'library', libraryTab: 'characters', inspectorOpen: false },
    },
  );
}

// ---- stage 2: sprites, tone, scenario helpers ----------------------------------------------------------------------

/** A standing picture of 小月 for one emotion: the whole figure on a transparent ground, 300 × 520, bottom-aligned. */
function sprite(emotion: PaEmotion): string {
  const look = PORTRAIT_LOOKS.xiaoyue!;
  const line = `fill="none" stroke="${look.line}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"`;
  const faces: Partial<Record<PaEmotion, string>> = {
    neutral: `<ellipse cx="131" cy="200" rx="5" ry="6" fill="${look.line}"/><ellipse cx="169" cy="200" rx="5" ry="6" fill="${look.line}"/><path d="M142 226h16" ${line}/>`,
    happy: `<path d="M122 204q9-10 18 0M160 204q9-10 18 0M136 222q14 16 28 0" ${line}/>`,
    shy:
      `<path d="M123 204h15M162 204h15M142 228q4-3 8 0t8 0" ${line}/>` +
      `<ellipse cx="118" cy="218" rx="14" ry="7" fill="${look.blush ?? look.skin}" opacity=".85"/><ellipse cx="182" cy="218" rx="14" ry="7" fill="${look.blush ?? look.skin}" opacity=".85"/>`,
    sleepy:
      `<path d="M122 204q9 4 18 0M160 204q9 4 18 0" ${line}/><ellipse cx="150" cy="228" rx="5" ry="6" ${line}/>` +
      `<text x="214" y="126" font-family="sans-serif" font-size="24" fill="${look.line}" opacity=".7">z</text><text x="232" y="104" font-family="sans-serif" font-size="18" fill="${look.line}" opacity=".5">z</text>`,
    sad: `<path d="M120 190l16 5M180 190l-16 5" ${line}/><ellipse cx="131" cy="204" rx="4.5" ry="5" fill="${look.line}"/><ellipse cx="169" cy="204" rx="4.5" ry="5" fill="${look.line}"/><path d="M140 232q10-8 20 0" ${line}/>`,
  };
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 520">',
    `<path d="M92 192C88 118 118 98 150 98S212 118 208 192L216 300C190 314 110 314 84 300Z" fill="${look.hair}"/>`,
    `<path d="M104 330C88 360 82 410 90 452" fill="none" stroke="${look.skin}" stroke-width="16" stroke-linecap="round"/>`,
    `<path d="M196 330C212 360 218 410 210 452" fill="none" stroke="${look.skin}" stroke-width="16" stroke-linecap="round"/>`,
    `<path d="M92 520L110 330C114 296 128 282 150 282S186 296 190 330L208 520Z" fill="${look.cloth}"/>`,
    `<path d="M110 330C114 296 128 282 150 282S186 296 190 330L184 360H116Z" fill="${look.cloth}" stroke="${look.line}" stroke-opacity=".25" stroke-width="2"/>`,
    `<path d="M136 238h28v42c0 12-28 12-28 0Z" fill="${look.skin}"/>`,
    `<ellipse cx="150" cy="190" rx="52" ry="60" fill="${look.skin}"/>`,
    `<path d="M96 184C96 134 122 116 150 116S204 134 204 184C190 164 172 152 150 154C128 152 110 164 96 184Z" fill="${look.hair}"/>`,
    look.front ?? '',
    faces[emotion] ?? faces.neutral ?? '',
    '</svg>',
  ].join('');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const spriteCache = new Map<PaEmotion, string>();
/** An inline SVG standing picture of 小月 (`paSoulAssetUrl` passes `data:` URLs through). */
export function labSprite(emotion: PaEmotion): string {
  let url = spriteCache.get(emotion);
  if (!url) {
    url = sprite(emotion);
    spriteCache.set(emotion, url);
  }
  return url;
}

const toneCache = new Map<number, string>();
/** A quiet 220 Hz tone as a `data:audio/wav;base64,…` URL (8 kHz, 8-bit mono, faded in and out). A bench fixture that
 *  stands in for a generated voice in the lab; it never ships in a production path. */
export function labTone(seconds: number): string {
  const length = Math.max(0.5, Math.round(seconds * 2) / 2);
  const cached = toneCache.get(length);
  if (cached) return cached;
  const rate = 8000;
  const samples = Math.round(rate * length);
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  const fade = rate / 20;
  for (let i = 0; i < samples; i += 1) {
    const envelope = Math.min(1, i / fade, (samples - 1 - i) / fade);
    bytes[44 + i] = 128 + Math.round(16 * envelope * Math.sin((2 * Math.PI * 220 * i) / rate));
  }
  const url = `data:audio/wav;base64,${bytesToBase64(bytes)}`;
  toneCache.set(length, url);
  return url;
}

/** The lab's audio for a spoken text: about one second per six characters, 1.5 to 8 seconds. */
export function labSpeechItem(messageId: string, spoken: string): PaSpeechItem {
  const id = labTone(Math.min(8, Math.max(1.5, Array.from(spoken).length / 6)));
  return { messageId, id, mime: 'audio/wav', bytes: Math.round((id.length - 'data:audio/wav;base64,'.length) * 0.75), cached: false };
}

/** The lab's speech service: ElevenLabs set up (a voice list), OpenAI not set up (a free voice id). */
export const LAB_SPEECH_STATUS: PaSpeechStatus = {
  available: true,
  models: [
    { id: 'elevenlabs-v3', label: 'ElevenLabs · elevenlabs-v3', provider: 'elevenlabs', configured: true, voices: 'list' },
    { id: 'gpt-4o-mini-tts', label: 'OpenAI · gpt-4o-mini-tts', provider: 'openai', configured: false, voices: 'free' },
  ],
};
const LAB_VOICES: Record<string, Array<{ id: string; name: string }>> = {
  'elevenlabs-v3': [
    { id: 'lab-soft', name: 'Soft (lab)' },
    { id: 'lab-bright', name: 'Bright (lab)' },
    { id: 'lab-calm', name: 'Calm (lab)' },
  ],
};

/** A copy of a built fixture with its soul snapshot renamed (the version the workspace keys its soul read on). */
function relabel(fixture: PaFixture, version: string): PaFixture {
  const soul = { ...(fixture.soul ?? emptySoulSnapshot(version)), version };
  return { ...fixture, soul, snapshot: { ...fixture.snapshot, soulVersion: version } };
}

function patchCharacter(fixture: PaFixture, agentId: string, patch: Partial<PaCharacterView>): PaFixture {
  const soul = fixture.soul ?? emptySoulSnapshot('lab');
  return { ...fixture, soul: { ...soul, characters: soul.characters.map((item) => (item.id === agentId ? { ...item, ...patch } : item)) } };
}

/** The chat row of a conversation patched (created as `ensureChat` would when the fixture has none). */
function patchChat(fixture: PaFixture, conversationId: string, patch: (chat: PaChatView) => PaChatView): PaFixture {
  const soul = fixture.soul ?? emptySoulSnapshot('lab');
  const found = soul.chats.some((chat) => chat.id === conversationId);
  const chats = found
    ? soul.chats.map((chat) => (chat.id === conversationId ? patch(chat) : chat))
    : [...soul.chats, patch(emptyChatView(conversationId, fixture.snapshot.conversations.find((c) => c.id === conversationId)?.createdAt ?? 0))];
  return { ...fixture, soul: { ...soul, chats } };
}

function agentIn(fixture: PaFixture, agentId: string): PersonalAgent {
  const found = fixture.snapshot.agents.find((item) => item.id === agentId);
  if (!found) throw new Error(`no agent ${agentId} in the fixture`);
  return found;
}

// ---- scenario: live-chat -----------------------------------------------------------------------------------------

/** companion-chat with a running turn of 小月: the transport streams her canned raw reply (footer included) through
 *  the real `liveReplyText` while the turn runs, then stores it. Knobs: &stream=0 (dots only), &hold=1. */
export function liveChat(now: number): PaFixture {
  const base = companionChat(now);
  const c = 'conv-xiaoyue';
  const xy = agentIn(base, 'ag-xiaoyue');
  const askedAt = now - 4000;
  const ask = said('xy-14', c, '今天被领导夸了，想第一个告诉你', askedAt);
  const live = task('tk-xy-14', c, ask.content, askedAt, {
    kind: 'chat',
    requestId: 'req-xy-14-lab',
    status: 'running',
    participantIds: [xy.id],
    nextParticipant: 0,
    budget: { maxAttempts: 3, timeoutMs: 120000 },
  });
  const running = attempt('xy-15', live.id, xy, 'respond', now - 2500, { status: 'running', usage: { visibility: 'unknown' } });
  const fixture = relabel(base, 'lab-live-chat');
  return {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      messages: [...fixture.snapshot.messages, ask],
      tasks: [...fixture.snapshot.tasks, live],
      attempts: [...fixture.snapshot.attempts, running],
    },
    control: { ...fixture.control, activeCount: 1 },
    replies: {
      ...fixture.replies,
      [xy.id]: [
        '真的吗！快说说。\n\n*她把手里的样张放下，转过身来，眼睛亮亮的*\n\n是那张旧书市集的海报吗？我就知道你会做得很好。\n\n今晚要不要奖励自己一杯热可可？\n\n<turn_meta>\nmood: 开心\nremember: moment | 阿树被领导夸了，第一个告诉了小月\n</turn_meta>',
        ...starterReplies('xiaoyue', now),
      ],
    },
  };
}

// ---- scenario: voice-chat ----------------------------------------------------------------------------------------

/** companion-chat where 小月 has a voice: a speech status with one set-up model (a voice list) and one that is not set
 *  up, one reply with stored audio (xy-11) and the newest reply without. Knob: &speech=none (no speech service). */
export function voiceChat(now: number): PaFixture {
  const base = patchCharacter(companionChat(now), 'ag-xiaoyue', { voice: { model: 'elevenlabs-v3', voice: 'lab-soft', language: '' } });
  const stored = base.snapshot.messages.find((item) => item.id === 'xy-11');
  const items = stored ? [{ ...labSpeechItem(stored.id, speechText(stored.content)), cached: true }] : [];
  return { ...relabel(base, 'lab-voice-chat'), speech: { status: structuredClone(LAB_SPEECH_STATUS), voices: structuredClone(LAB_VOICES), items } };
}

/** The `&speech=none` knob: every speech model is listed as not set up, so nothing can be read aloud. */
export function withoutSpeech(fixture: PaFixture): PaFixture {
  const models = (fixture.speech?.status.models ?? LAB_SPEECH_STATUS.models).map((model) => ({ ...model, configured: false }));
  return { ...fixture, speech: { ...(fixture.speech ?? {}), status: { available: false, models }, items: [] } };
}

// ---- scenario: sprites-chat --------------------------------------------------------------------------------------

/** companion-chat where 小月 has five sprites (平静, 开心, 害羞, 困倦, 难过), the newest replies carry the moods 开心, 害羞 and
 *  有点困, and the chat turns on the standing picture. New replies rotate through moods with and without a sprite. */
export function spritesChat(now: number): PaFixture {
  const sprites: PaSprites = {
    neutral: labSprite('neutral'),
    happy: labSprite('happy'),
    shy: labSprite('shy'),
    sleepy: labSprite('sleepy'),
    sad: labSprite('sad'),
  };
  const base = patchChat(patchCharacter(companionChat(now), 'ag-xiaoyue', { sprites }), 'conv-xiaoyue', (chat) => ({
    ...chat,
    appearance: { ...chat.appearance, stage: 'side' },
  }));
  const c = 'conv-xiaoyue';
  const xy = agentIn(base, 'ag-xiaoyue');
  const at = (minutesAgo: number, seconds = 0) => now - minutesAgo * MIN + seconds * 1000;
  const messages: PaMessage[] = [
    said('xy-20', c, '刚刚在楼下是不是碰见你了？', at(24)),
    replied('xy-21', c, 'tk-xy-20', xy, '是我！刚买完面包上来。\n\n你今天那件外套很好看。', at(23, 30), { mood: '开心' }),
    said('xy-22', c, '谢谢，你今天也很好看', at(15)),
    replied('xy-23', c, 'tk-xy-22', xy, '*她低下头，假装认真整理桌上的样张*\n\n……突然这么说，我都不知道接什么了。', at(14, 30), { mood: '害羞' }),
    said('xy-24', c, '还在加班吗？', at(6)),
    replied('xy-25', c, 'tk-xy-24', xy, '嗯……还剩最后一张图。\n\n*她揉了揉眼睛，打了个小小的哈欠*\n\n画完就去睡。', at(5, 30), { mood: '有点困' }),
  ];
  const fixture = relabel(base, 'lab-sprites-chat');
  return {
    ...fixture,
    snapshot: { ...fixture.snapshot, messages: [...fixture.snapshot.messages, ...messages] },
    replies: {
      ...fixture.replies,
      [xy.id]: [
        '好呀！\n\n那我们说定了，明天一起去。\n\n<turn_meta>\nmood: 开心\n</turn_meta>',
        '*她把脸埋进围巾里*\n\n你别一直看着我嘛。\n\n<turn_meta>\nmood: 害羞\n</turn_meta>',
        '嗯……我眼皮在打架了。\n\n<turn_meta>\nmood: 有点困\n</turn_meta>',
        '诶？真的吗？\n\n我一点都没想到。\n\n<turn_meta>\nmood: 惊讶\n</turn_meta>',
      ],
    },
  };
}

// ---- scenario: journal-chat --------------------------------------------------------------------------------------

/** companion-chat in the journal layout (手帐) with the polaroid frame on 小月's sakura paper. */
export function journalChat(now: number): PaFixture {
  const base = patchChat(companionChat(now), 'conv-xiaoyue', (chat) => ({
    ...chat,
    appearance: { ...chat.appearance, theme: 'sakura', layout: 'journal', avatarFrame: 'polaroid' },
  }));
  return relabel(base, 'lab-journal-chat');
}

// ---- appearance knobs ----------------------------------------------------------------------------------------------

/** The lab's appearance knobs, applied to the chat appearance of one conversation: &skin=<theme>, &layout=, &frame=,
 *  &pattern=, &accent=<rrggbb> (without #) and &stage=side. Unknown values are ignored. */
export function withLabAppearance(fixture: PaFixture, conversationId: string | null | undefined, query: URLSearchParams): PaFixture {
  if (!conversationId) return fixture;
  const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined =>
    value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
  const theme = pick(query.get('skin'), PA_CHAT_THEMES);
  const layout = pick(query.get('layout'), ['bubble', 'journal'] as const);
  const avatarFrame = pick(query.get('frame'), ['circle', 'squircle', 'polaroid'] as const);
  const pattern = pick(query.get('pattern'), ['none', 'grid', 'ruled', 'dots'] as const);
  const stage = pick(query.get('stage'), ['side', 'off'] as const);
  const accentRaw = query.get('accent');
  const accent = accentRaw && /^[0-9a-fA-F]{6}$/.test(accentRaw) ? `#${accentRaw.toLowerCase()}` : undefined;
  const patch: PaChatAppearance = {
    ...(theme ? { theme } : {}),
    ...(layout ? { layout } : {}),
    ...(avatarFrame ? { avatarFrame } : {}),
    ...(pattern ? { pattern } : {}),
    ...(stage ? { stage } : {}),
    ...(accent ? { accent } : {}),
  };
  if (Object.keys(patch).length === 0 || !paChatAppearanceSchema.safeParse(patch).success) return fixture;
  if (!fixture.snapshot.conversations.some((item) => item.id === conversationId)) return fixture;
  return patchChat(fixture, conversationId, (chat) => ({ ...chat, appearance: { ...chat.appearance, ...patch } }));
}
