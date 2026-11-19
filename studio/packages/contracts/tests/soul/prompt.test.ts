import { describe, expect, it } from 'vitest';
import {
  PA_DEFAULT_CHAT_SETTINGS, SOUL_BLOCK_IDS, SOUL_TEXT, composeSoulPrompt, paCharacterInputSchema, paLorebookInputSchema,
  paStylePresetInputSchema, renderFlat, renderWire, seededRng, stopSequences,
} from '../../src/soul/index';
import type {
  ComposeSoulInput, ComposeSoulResult, LoreBookLike, PaCharacterDoc, PaLoreEntry, PaStylePreset, SoulHistoryItem,
} from '../../src/soul/index';

// 2026-11-14 13:06 UTC is Saturday 21:06 at UTC+8.
const NOW = Date.UTC(2026, 10, 14, 13, 6);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZH = SOUL_TEXT.zh;

function preset(over: Record<string, unknown> = {}): PaStylePreset {
  const doc = paStylePresetInputSchema.parse({ name: '测试文风', main: '主指令：好好扮演 {{char}}。', ...over });
  return { ...doc, id: 'builtin:test', createdAt: 0, updatedAt: 0, revision: 0, builtin: true };
}

function character(over: Record<string, unknown> = {}): PaCharacterDoc {
  return paCharacterInputSchema.parse({
    description: '周行简是钟楼旧档室的管理员。', personality: '沉稳、话少', scenario: '雨夜的档案室',
    exampleDialogue: '<START>\n{{user}}: 示例问候\n{{char}}: 示例回答，请坐。\n<start>\n{{user}}: 示例提问\n{{char}}: 示例答复，一份旧档案。',
    ...over,
  });
}

function lorebook(id: string, entries: Array<Partial<PaLoreEntry> & { id: string }>): LoreBookLike {
  const doc = paLorebookInputSchema.parse({ name: `书 ${id}`, entries });
  return {
    id, name: doc.name, scanDepth: doc.scanDepth, tokenBudget: doc.tokenBudget, recursive: doc.recursive,
    caseSensitive: doc.caseSensitive, matchWholeWords: doc.matchWholeWords, entries: doc.entries,
  };
}

const NAMES: Record<SoulHistoryItem['role'], string> = { owner: '阿青', self: '周行简', other: '小月', story: '' };

function item(role: SoulHistoryItem['role'], index: number, extra: Partial<SoulHistoryItem> = {}): SoulHistoryItem {
  return { id: `m${index}`, role, name: NAMES[role], text: `第${index}条${role}消息内容`, at: NOW - (100 - index) * MINUTE, ...extra };
}

/** Alternating owner and self items. */
function chat(count: number, first: 'owner' | 'self' = 'owner'): SoulHistoryItem[] {
  return Array.from({ length: count }, (_, index) => item((index % 2 === 0) === (first === 'owner') ? 'owner' : 'self', index));
}

function input(over: Partial<ComposeSoulInput> = {}): ComposeSoulInput {
  return {
    conversationId: 'conv-1', group: false, agentName: '周行简', agentRole: '', character: character(),
    persona: { id: 'p1', name: '阿青', description: '' }, preset: preset(), chat: PA_DEFAULT_CHAT_SETTINGS,
    books: [], loreTimers: {}, loreIndex: 10, history: chat(5), historyTotals: { total: 5, hidden: 0 },
    memories: [], state: {}, cast: [], decks: [], activeEvent: null, directive: null, care: 'none', locale: 'zh',
    now: NOW, timezoneOffsetMin: 480, lastOwnerAt: null, lastMood: null, firstMetAt: null,
    contextTokens: 32000, historyBudgetTokens: 8000, rng: seededRng('prompt'),
    ...over,
  };
}

const systemIds = (result: ComposeSoulResult) => result.ir.system.map(block => block.id);
const tailIds = (result: ComposeSoulResult) => result.ir.tail.map(block => block.id);
const blockText = (blocks: ReadonlyArray<{ id: string; text: string }>, id: string) => blocks.find(block => block.id === id)?.text ?? '';
const contents = (result: ComposeSoulResult) => result.wire.messages.map(message => message.content);
const roles = (result: ComposeSoulResult) => result.wire.messages.map(message => message.role);

const stateSchema = [
  { key: 'hp', label: '体力', kind: 'number', initial: 80, min: 0, max: 100 },
  { key: 'bag', label: '背包', kind: 'list', initial: [] },
  { key: 'location', label: '位置', kind: 'text', initial: '旧书店' },
];

function richInput(over: Partial<ComposeSoulInput> = {}): ComposeSoulInput {
  const book = lorebook('b1', [
    { id: 'cb', constant: true, content: '常驻前置设定：钟楼建于百年前。', position: 'before_char' },
    { id: 'ca', constant: true, content: '常驻后置设定：档案室只在雨夜开放。', position: 'after_char', order: 50 },
    { id: 'kb', keys: ['怀表'], content: '触发设定：怀表停在三点十分。' },
    { id: 'ka', keys: ['怀表'], content: '触发后置：怀表背面刻着名字。', position: 'after_char' },
    { id: 'd0', constant: true, content: '深度零设定：窗外有钟声。', position: 'at_depth', depth: 0 },
  ]);
  const history = chat(5);
  history[2] = { ...(history[2] as SoulHistoryItem), text: '第2条owner消息内容，提到了怀表' };
  return input({
    persona: { id: 'p1', name: '阿青', description: '阿青是个爱喝茶的学生。' },
    preset: preset({ postHistory: '后置指令：别太长。', extra: '额外文风：{{char}} 说话带一点古意。', narration: 'third', tempo: 'slow' }),
    character: character({ stateSchema, autoMemory: true }),
    books: [{ book, rank: 1 }],
    history,
    memories: [
      { id: 'mem1', content: '阿青喜欢下雨天', source: '对话 · 周行简', kind: 'preference' },
      { id: 'mem2', content: '周六傍晚一起去旧书摊', source: '对话 · 周行简', kind: 'promise', dueAt: Date.UTC(2026, 10, 15, 15, 59, 59, 999) },
      { id: 'mem3', content: '没有分类的记忆', source: '' },
    ],
    state: { hp: 60, bag: [], location: '码头' },
    activeEvent: { id: 'arrival', title: '有人来了', summary: '一个没想到的人出现在门口。', remainingTurns: 2 },
    directive: { kind: 'continue', text: '例行提示：问问今天过得怎样' },
    care: 'concern',
    lastOwnerAt: NOW - 3 * HOUR,
    lastMood: { text: '平静', at: NOW - 10 * MINUTE },
    firstMetAt: NOW - 6 * DAY,
    ...over,
  });
}

describe('composeSoulPrompt: block order', () => {
  it('orders the system and tail blocks', () => {
    const result = composeSoulPrompt(richInput());
    expect(systemIds(result)).toEqual(['frame', 'main', 'style', 'contract', 'persona', 'lore-before', 'character', 'lore-after', 'examples']);
    expect(tailIds(result)).toEqual([...SOUL_BLOCK_IDS.tail]);
    const order = (ids: readonly string[], all: readonly string[]) => ids.map(id => all.indexOf(id));
    const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
    expect(order(systemIds(result), SOUL_BLOCK_IDS.system)).toEqual(sorted(order(systemIds(result), SOUL_BLOCK_IDS.system)));
  });

  it('writes the system blocks', () => {
    const result = composeSoulPrompt(richInput({ character: character({ stateSchema, autoMemory: true, systemPrompt: '卡片指令 {{original}}' }) }));
    const system = result.ir.system;
    expect(blockText(system, 'frame')).toContain('你扮演「周行简」，对面是「阿青」');
    expect(blockText(system, 'main')).toBe('卡片指令 主指令：好好扮演 周行简。');
    expect(blockText(system, 'style')).toBe([
      ZH['style.heading'], ZH['style.format.im'], ZH['style.length.short'], ZH['style.narration.third'],
      '不替 阿青 说话、做决定，也不描写 阿青 的动作和想法。', ZH['style.tempo.slow'], ZH['style.multiBubble'],
      '额外文风：周行简 说话带一点古意。',
    ].join('\n'));
    expect(blockText(system, 'contract')).toContain('hp | 体力 | 数字 0–100');
    expect(blockText(system, 'persona')).toBe('关于 阿青：\n阿青是个爱喝茶的学生。');
    expect(blockText(system, 'character')).toBe('关于 周行简：\n周行简是钟楼旧档室的管理员。\n性格：沉稳、话少\n当前情境：雨夜的档案室');
    expect(blockText(system, 'examples')).toBe([
      '下面是 周行简 说话方式的示例，不是真实发生过的对话：',
      '阿青: 示例问候\n周行简: 示例回答，请坐。\n\n阿青: 示例提问\n周行简: 示例答复，一份旧档案。',
      '',
      '示例里没有 <turn_meta> 记录块，但你的每条回复都必须带上。',
    ].join('\n'));
    const scenario = composeSoulPrompt(richInput({ chat: { ...PA_DEFAULT_CHAT_SETTINGS, scenario: '本次场景：晴天的码头' } }));
    expect(blockText(scenario.ir.system, 'character')).toContain('当前情境：本次场景：晴天的码头');
    const noCard = composeSoulPrompt(input({ character: null, agentRole: '一个认真的工作助手' }));
    expect(blockText(noCard.ir.system, 'character')).toBe('关于 周行简：\n一个认真的工作助手');
    expect(systemIds(noCard)).not.toContain('examples');
  });

  it('puts constant lore in the system and triggered lore in the tail', () => {
    const result = composeSoulPrompt(richInput());
    expect(blockText(result.ir.system, 'lore-before')).toBe('世界设定：\n常驻前置设定：钟楼建于百年前。');
    expect(blockText(result.ir.system, 'lore-after')).toBe('补充设定：\n常驻后置设定：档案室只在雨夜开放。');
    expect(blockText(result.ir.tail, 'lore-triggered'))
      .toBe('和眼下话题有关的设定：\n触发设定：怀表停在三点十分。\n\n触发后置：怀表背面刻着名字。\n\n深度零设定：窗外有钟声。');
    expect(result.wire.system).not.toContain('触发设定');
  });

  it('writes the tail blocks', () => {
    const result = composeSoulPrompt(richInput());
    const tail = result.ir.tail;
    expect(blockText(tail, 'memory')).toBe([
      '周行简 记得的事（括号里是来源；自然地用，不要逐条复述）：',
      '- [约定 · 11月15日] 周六傍晚一起去旧书摊（对话 · 周行简）',
      '- [喜好] 阿青喜欢下雨天（对话 · 周行简）',
      '- 没有分类的记忆',
    ].join('\n'));
    expect(blockText(tail, 'state')).toBe('当前状态：\n体力 hp = 60 / 100\n背包 bag = （空）\n位置 location = 码头');
    expect(blockText(tail, 'event')).toBe('小插曲进行中：「有人来了」——一个没想到的人出现在门口。 还剩 2 回合。把它自然地织进这一幕；阿青 的选择永远优先。');
    expect(blockText(tail, 'now')).toBe([
      '现在是 2026年11月14日 星期六 21:06（晚上）。',
      '阿青 上一条消息是 3 小时前。',
      '周行简 刚才的心情：平静（10 分钟前）。',
      '临近的约定：周六傍晚一起去旧书摊（明天）。',
      '今天是你们认识的第 7 天。',
    ].join('\n'));
    expect(blockText(tail, 'care')).toBe(ZH['care.concern'].replaceAll('{{user}}', '阿青').replaceAll('{{char}}', '周行简'));
    expect(blockText(tail, 'post')).toBe('后置指令：别太长。');
    expect(blockText(tail, 'directive')).toBe(`${ZH['directive.continue'].replace('{{user}}', '阿青')}\n例行提示：问问今天过得怎样`);
    expect(blockText(tail, 'reminder')).toBe(ZH.reminder);
    expect(blockText(tail, 'nudge')).toBe('接下来只写 周行简 的下一条回复。');
    const later = composeSoulPrompt(richInput({ lastOwnerAt: NOW - 7 * HOUR }));
    expect(blockText(later.ir.tail, 'reminder')).toBe(`${ZH.reminder}\n${ZH['reminder.remember']}`);
    const react = composeSoulPrompt(richInput({ directive: { kind: 'react', text: '掷骰 d20 = 7' } }));
    expect(blockText(react.ir.tail, 'directive')).toBe(`${ZH['directive.react'].replace('{{user}}', '阿青')}\n掷骰 d20 = 7`);
  });

  it('localises the tail to English', () => {
    const result = composeSoulPrompt(richInput({ locale: 'en', persona: { id: null, name: '', description: '' } }));
    expect(result.names).toEqual({ char: '周行简', user: 'you' });
    expect(blockText(result.ir.tail, 'now')).toContain('It is Saturday, November 14, 2026, 21:06 (evening).');
    expect(blockText(result.ir.tail, 'now')).toContain('A promise coming up: 周六傍晚一起去旧书摊 (tomorrow).');
    expect(blockText(result.ir.tail, 'memory')).toContain('- [promise · Nov 15] 周六傍晚一起去旧书摊 (对话 · 周行简)');
  });

  it('warns about time macros in the system zone', () => {
    const result = composeSoulPrompt(input({ preset: preset({ main: '现在是 {{time}}' }) }));
    expect(result.trace.warnings).toContainEqual({ code: 'volatile-macro-in-system', detail: 'main' });
  });
});

describe('composeSoulPrompt: turns', () => {
  it('renders a direct chat without labels', () => {
    const result = composeSoulPrompt(input());
    expect(roles(result)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(contents(result)[0]).toBe('第0条owner消息内容');
    expect(contents(result)[1]).toContain('第1条self消息内容');
  });

  it('labels every non-self text part in a room and writes the cast', () => {
    const history = [item('owner', 0), item('other', 1), item('self', 2), item('story', 3, { text: '掷骰 d20 = 15' }), item('owner', 4)];
    const result = composeSoulPrompt(input({
      group: true, history, cast: [{ name: '小月', tagline: '窗边的画师' }, { name: '老板', tagline: '' }],
      character: character({ stateSchema }),
    }));
    expect(roles(result)).toEqual(['user', 'assistant', 'user']);
    expect(contents(result)[0]).toBe('阿青: 第0条owner消息内容\n\n小月: 第1条other消息内容');
    expect(contents(result)[1]).toMatch(/^第2条self消息内容/);
    expect(contents(result)[2]).toMatch(/^<aside>掷骰 d20 = 15<\/aside>\n\n阿青: 第4条owner消息内容\n\n<aside>/);
    expect(blockText(result.ir.system, 'cast')).toBe(`在场的还有：\n- 小月：窗边的画师\n- 老板\n${ZH['cast.rule'].replace('{{char}}', '周行简')}`);
    expect(blockText(result.ir.tail, 'nudge')).toBe('接下来只写 周行简 的下一条回复，不要替其他人说话。');
    expect(result.parts.state).toBe(false);
    expect(tailIds(result)).not.toContain('state');
    expect(result.wire.stop).toEqual(['\n阿青:', '\n阿青：', '\n小月:', '\n小月：', '\n老板:', '\n老板：']);
  });

  it('prepends a start aside when the first turn is not a user turn', () => {
    const result = composeSoulPrompt(input({ history: chat(4, 'self') }));
    expect(result.wire.messages[0]).toEqual({ role: 'user', content: '<aside>对话从这里开始。</aside>' });
    expect(roles(result)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('appends a final user turn holding only the tail', () => {
    const result = composeSoulPrompt(input({ history: chat(4), directive: { kind: 'continue' } }));
    const last = result.wire.messages[result.wire.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content.startsWith('<aside>')).toBe(true);
    expect(last?.content).toContain(ZH['directive.continue'].replace('{{user}}', '阿青'));
    expect(result.ir.turns[result.ir.turns.length - 1]?.parts).toEqual([]);
    const empty = composeSoulPrompt(input({ history: [] }));
    expect(roles(empty)).toEqual(['user']);
    expect(empty.wire.messages[0]?.content).toBe(result.ir.tail.length > 0 ? empty.ir.tail.map(block => `<aside>${block.text}</aside>`).join('\n\n') : '');
  });

  it('skips empty history items', () => {
    const history = [item('owner', 0), item('self', 1, { text: '  ' }), item('owner', 2)];
    const result = composeSoulPrompt(input({ history }));
    expect(roles(result)).toEqual(['user']);
    expect(result.trace.history.included).toBe(2);
  });

  it('places injections before or after user-role items only, and depth 0 in the tail', () => {
    const book = lorebook('b1', [
      { id: 'd1', constant: true, content: '深度一', position: 'at_depth', depth: 1 },
      { id: 'd2', constant: true, content: '深度二', position: 'at_depth', depth: 2, role: 'assistant' },
      { id: 'd0', constant: true, content: '深度零', position: 'at_depth', depth: 0 },
    ]);
    const result = composeSoulPrompt(input({
      books: [{ book, rank: 1 }],
      character: character({ characterNote: { text: '角色便签', depth: 4, role: 'system' } }),
      chat: { ...PA_DEFAULT_CHAT_SETTINGS, authorNote: { text: '对话便签', depth: 9 } },
    }));
    const messages = contents(result);
    expect(messages[0]).toBe('<aside>对话便签</aside>\n\n第0条owner消息内容\n\n<aside>角色便签</aside>');
    expect(messages[2]).toBe('第2条owner消息内容\n\n<aside>深度二</aside>');
    expect(messages[4]?.startsWith('<aside>深度一</aside>\n\n第4条owner消息内容\n\n')).toBe(true);
    expect(blockText(result.ir.tail, 'lore-triggered')).toBe('和眼下话题有关的设定：\n深度零');
    expect(result.wire.system).not.toContain('深度');
  });

  it('puts an injection with no user-role item before its boundary at the start of the first user turn', () => {
    const book = lorebook('b1', [{ id: 'deep', constant: true, content: '很深的设定', position: 'at_depth', depth: 5 }]);
    const result = composeSoulPrompt(input({ books: [{ book, rank: 1 }], history: chat(2, 'self') }));
    expect(result.wire.messages[0]).toEqual({ role: 'user', content: '<aside>很深的设定</aside>\n\n<aside>对话从这里开始。</aside>' });
  });

  it('replays the footer on the last two assistant items only', () => {
    const history = chat(7).map(entry => (entry.role === 'self' ? { ...entry, mood: `心情${entry.id}` } : entry));
    const result = composeSoulPrompt(input({ history }));
    const messages = contents(result);
    expect(messages[1]).toBe('第1条self消息内容');
    expect(messages[3]).toBe('第3条self消息内容\n\n<turn_meta>\nmood: 心情m3\n</turn_meta>');
    expect(messages[5]).toBe('第5条self消息内容\n\n<turn_meta>\nmood: 心情m5\n</turn_meta>');
    const off = composeSoulPrompt(input({ history, chat: { ...PA_DEFAULT_CHAT_SETTINGS, turnRecord: 'off' } }));
    expect(contents(off)[5]).toBe('第5条self消息内容');
    expect(systemIds(off)).not.toContain('contract');
    expect(tailIds(off)).not.toContain('reminder');
  });
});

describe('composeSoulPrompt: budgets', () => {
  const cjk = (count: number) => '字'.repeat(count);

  it('caps the world book at 35% of the context', () => {
    const book = lorebook('b1', [
      { id: 'a', constant: true, content: cjk(400), order: 3 },
      { id: 'b', constant: true, content: cjk(400), order: 2 },
      { id: 'c', constant: true, content: cjk(400), order: 1 },
    ]);
    const result = composeSoulPrompt(input({ books: [{ book, rank: 1 }], contextTokens: 2000 }));
    expect(result.trace.loreBudget).toEqual({ used: 400, limit: 700 });
    expect(result.trace.lore.map(entry => entry.status)).toEqual(['included', 'budget', 'budget']);
    expect(result.trace.warnings).toContainEqual({ code: 'lore-constant-cut' });
  });

  it('keeps whole example blocks within the cap and drops the block when the fixed zones are too large', () => {
    const examples = `<START>\n${cjk(150)}甲\n<START>\n${cjk(150)}乙`;
    const small = composeSoulPrompt(input({ character: character({ exampleDialogue: examples }), contextTokens: 2000 }));
    expect(blockText(small.ir.system, 'examples')).toContain('甲');
    expect(blockText(small.ir.system, 'examples')).not.toContain('乙');
    const large = composeSoulPrompt(input({ character: character({ exampleDialogue: examples }) }));
    expect(blockText(large.ir.system, 'examples')).toContain('乙');
    const crowded = composeSoulPrompt(input({ character: character({ description: cjk(2500) }), contextTokens: 4000 }));
    expect(systemIds(crowded)).not.toContain('examples');
    expect(crowded.trace.warnings).toContainEqual({ code: 'examples-dropped' });
    expect(crowded.trace.warnings).toContainEqual({ code: 'over-window' });
  });

  it('anchors the history window in steps of eight', () => {
    const long = (count: number) => Array.from({ length: count }, (_, index) =>
      item(index % 2 === 0 ? 'owner' : 'self', index, { text: `${index}号${cjk(98)}` }));
    const included = (count: number) =>
      composeSoulPrompt(input({ history: long(count), historyBudgetTokens: 1600 })).trace.history.included;
    expect([included(20), included(22), included(24)]).toEqual([12, 14, 8]);
    const floor = composeSoulPrompt(input({ history: long(10), historyBudgetTokens: 50 }));
    expect(floor.trace.history.included).toBe(2);
    expect(floor.trace.warnings).toContainEqual({ code: 'history-floor' });
    const four = composeSoulPrompt(input({ history: long(10), historyBudgetTokens: 450 }));
    expect(four.trace.history.included).toBe(4);
    expect(four.trace.warnings).not.toContainEqual({ code: 'history-floor' });
  });

  it('fills the trace', () => {
    const result = composeSoulPrompt(richInput({ historyTotals: { total: 9, hidden: 2 } }));
    const { trace } = result;
    expect(trace.blocks.map(block => block.zone)).toEqual([
      ...result.ir.system.map(() => 'system'), 'history', ...result.ir.tail.map(() => 'tail'),
    ]);
    const fixed = [...result.ir.system, ...result.ir.tail].reduce((sum, block) => sum + block.tokens, 0);
    const history = trace.blocks.find(block => block.id === 'history')?.tokens ?? 0;
    expect(trace.totalTokens).toBe(fixed + history);
    expect(trace.history).toEqual({ included: 5, total: 9, hidden: 2 });
    expect(trace.memories[0]).toEqual({ id: 'mem1', title: '阿青喜欢下雨天' });
    expect(trace).toMatchObject({ conversationId: 'conv-1', at: NOW, wire: 'flat', locale: 'zh', contextTokens: 32000, replyTokens: 1184 });
    expect(trace.lore).toHaveLength(5);
    expect(result.replyTokens).toBe(1184);
    const off = { ...PA_DEFAULT_CHAT_SETTINGS, turnRecord: 'off' as const };
    expect(composeSoulPrompt(input({ preset: preset({ sampling: { maxTokens: 300 } }), chat: off })).replyTokens).toBe(300);
  });
});

describe('composeSoulPrompt: care', () => {
  it('drops the post, event and directive blocks and the contract in a crisis', () => {
    const result = composeSoulPrompt(richInput({ care: 'crisis' }));
    expect(tailIds(result)).toEqual(['lore-triggered', 'memory', 'now', 'care', 'nudge']);
    expect(blockText(result.ir.tail, 'care')).toContain('先判断。');
    expect(systemIds(result)).not.toContain('contract');
    expect(blockText(result.ir.system, 'examples')).not.toContain('<turn_meta>');
    expect(result.parts).toEqual({ mood: false, state: false, choices: false, remember: false, play: false });
    expect(contents(result).join('\n')).not.toContain('<turn_meta>');
  });
});

describe('stopSequences', () => {
  it('stops on the user and, in rooms, the other names of two or more code points', () => {
    const names = { char: '周行简', user: '阿青' };
    expect(stopSequences(names, ['小月'], false)).toEqual(['\n阿青:', '\n阿青：']);
    expect(stopSequences(names, ['小月', '阿青', '岚'], true)).toEqual(['\n阿青:', '\n阿青：', '\n小月:', '\n小月：']);
    expect(stopSequences({ char: 'a', user: '你' }, [], false)).toEqual([]);
    expect(stopSequences(names, ['甲甲', '乙乙', '丙丙', '丁丁', '戊戊'], true)).toHaveLength(8);
  });
});

describe('renderers', () => {
  /** Every IR element appears exactly once, in IR order. */
  function expectParity(result: ComposeSoulResult) {
    const elements = [
      ...result.ir.system.map(block => block.text),
      ...result.ir.turns.flatMap(turn => turn.parts.map(part => part.text)),
      ...result.ir.tail.map(block => block.text),
    ];
    const wire = renderWire(result.ir);
    const renderings = [
      `${wire.system}\n\n${wire.messages.map(message => message.content).join('\n\n')}`,
      renderFlat(result.ir).flat,
    ];
    for (const rendering of renderings) {
      let cursor = 0;
      for (const element of elements) {
        expect(rendering.split(element).length - 1).toBe(1);
        const at = rendering.indexOf(element, cursor);
        expect(at).toBeGreaterThanOrEqual(cursor);
        cursor = at + element.length;
      }
    }
  }

  it('keeps flat and wire in parity for a direct chat', () => {
    const book = lorebook('b1', [{ id: 'd2', constant: true, content: '深度二的注入', position: 'at_depth', depth: 2 }]);
    const history = [...chat(6, 'self'), item('story', 6, { text: '抽到「愚者」· 塔罗' }), item('owner', 7)]
      .map(entry => (entry.role === 'self' ? { ...entry, mood: '平静' } : entry));
    const base = richInput();
    const result = composeSoulPrompt({ ...base, history, books: [...base.books, { book, rank: 2 }] });
    expectParity(result);
    expect(result.wire.transcript).toBe(renderFlat(result.ir).transcript);
    expect(result.flat).toBe(`${ZH.flatHeader}\n\n${result.wire.system}\n\n${result.wire.transcript}`);
    expect(result.wire.transcript.startsWith('<conversation>\n')).toBe(true);
    expect(result.wire.transcript.endsWith('\n\n现在写出 周行简 的下一条回复。不要加名字前缀，不要加任何说明。')).toBe(true);
    expect(result.wire.transcript).toContain('\n\n阿青: 第7条owner消息内容');
    expect(result.wire.transcript).toContain('周行简: 第0条self消息内容');
  });

  it('keeps flat and wire in parity for a room', () => {
    const history = [item('owner', 0), item('other', 1), item('self', 2, { mood: '好奇' }), item('owner', 3)];
    expectParity(composeSoulPrompt(input({ group: true, history, cast: [{ name: '小月', tagline: '画师' }] })));
  });

  it('never puts the tail into the system string', () => {
    const result = composeSoulPrompt(richInput());
    for (const block of result.ir.tail) expect(result.wire.system).not.toContain(block.text);
    const last = result.wire.messages[result.wire.messages.length - 1]?.content ?? '';
    for (const block of result.ir.tail) expect(last).toContain(`<aside>${block.text}</aside>`);
  });
});

describe('prompt stability (golden)', () => {
  it('keeps the system byte-identical and the message prefix stable across two turns', () => {
    const book = lorebook('b1', [
      { id: 'const', constant: true, content: '常驻：钟楼的钟每小时响一次。' },
      { id: 'deep', constant: true, content: '深度三：楼下有人在等。', position: 'at_depth', depth: 3 },
      { id: 'keyed', keys: ['怀表'], content: '触发：怀表停在三点十分。', sticky: 2 },
    ]);
    const moods = (items: SoulHistoryItem[]) => items.map(entry => (entry.role === 'self' ? { ...entry, mood: `心情${entry.id}` } : entry));
    const first = moods(chat(13));
    first[12] = { ...(first[12] as SoulHistoryItem), text: '第12条owner消息内容，带着怀表' };
    const base = richInput({
      books: [{ book, rank: 1 }],
      chat: { ...PA_DEFAULT_CHAT_SETTINGS, authorNote: { text: '便签：保持低声', depth: 2 } },
      care: 'none', directive: null,
    });
    const turnN = composeSoulPrompt({ ...base, history: first, loreIndex: 13, rng: seededRng('turn-n') });
    const second = [...first, item('self', 13, { mood: '安静' }), item('owner', 14)];
    const turnN1 = composeSoulPrompt({
      ...base, history: second, loreIndex: 15, loreTimers: turnN.loreTimers, rng: seededRng('turn-n-plus-1'),
      now: NOW + 5 * MINUTE, lastOwnerAt: NOW, lastMood: { text: '安静', at: NOW + MINUTE },
    });
    expect(turnN1.wire.system).toBe(turnN.wire.system);
    const keep = turnN1.wire.messages.length - (Math.max(3, 2, 4) + 2);
    expect(keep).toBeGreaterThan(0);
    expect(turnN1.wire.messages.slice(0, keep)).toEqual(turnN.wire.messages.slice(0, keep));
    // The bound is tight: the next message lost its replayed footer.
    expect(turnN1.wire.messages[keep]).not.toEqual(turnN.wire.messages[keep]);
    expect(blockText(turnN.ir.tail, 'lore-triggered')).toContain('触发：怀表停在三点十分。');
    expect(turnN.wire.system).not.toContain('触发：');
  });
});
