import { describe, expect, it } from 'vitest';
import {
  PA_DEFAULT_CHAT_SETTINGS, anyPart, buildFooterContract, footerReminder, paCharacterInputSchema, paStateSchemaSchema,
  paStylePresetInputSchema, parseSoulReply, renderFooter, resolveMetaParts, seededRng,
} from '../../src/soul/index';
import type { PaMetaParts, PaStateOp, SoulReplyContext } from '../../src/soul/index';

const schema = paStateSchemaSchema.parse([
  { key: 'hp', label: '体力', hint: '归零就倒下', kind: 'number', initial: 80, min: 0, max: 100, maxStep: 20 },
  { key: 'gold', label: '金币', kind: 'number', initial: 0 },
  { key: 'location', label: '位置', kind: 'text', initial: '旧书店' },
  { key: 'weather', label: '天气', kind: 'enum', initial: '晴', options: ['晴', '雨', 'Fog'] },
  { key: 'bag', label: '背包', kind: 'list', initial: ['面包'] },
  { key: 'trust', label: '信任', kind: 'number', initial: 1, writable: 'user' },
]);

const ALL: PaMetaParts = { mood: true, state: true, choices: true, remember: true, play: true };
const NONE: PaMetaParts = { mood: false, state: false, choices: false, remember: false, play: false };

function ctx(over: Partial<SoulReplyContext> = {}): SoulReplyContext {
  return {
    schema, parts: ALL, speakerNames: ['周行简', '老周'], userName: '阿青', otherNames: [], format: 'im',
    decks: [{ id: 'tarot', name: '塔罗' }, { id: 'topic', name: '话题' }],
    ...over,
  };
}

const parse = (raw: string, over: Partial<SoulReplyContext> = {}) => parseSoulReply(raw, ctx(over));
const block = (...lines: string[]) => ['<turn_meta>', ...lines, '</turn_meta>'].join('\n');

describe('footer gating', () => {
  const preset = (over: Record<string, unknown> = {}) => paStylePresetInputSchema.parse({ name: 'p', ...over });
  const character = paCharacterInputSchema.parse({ stateSchema: schema, autoMemory: true });

  it('follows the preset, the card and the chat', () => {
    const base = { preset: preset({ suggestChoices: true, playRequests: true }), character, chat: PA_DEFAULT_CHAT_SETTINGS, group: false, care: 'none' as const };
    expect(resolveMetaParts(base)).toEqual(ALL);
    expect(resolveMetaParts({ ...base, group: true }).state).toBe(false);
    expect(resolveMetaParts({ ...base, character: null })).toEqual({ ...ALL, state: false, remember: false });
    expect(resolveMetaParts({ ...base, preset: preset({ mood: false }) })).toEqual({ ...NONE, state: true, remember: true });
    expect(resolveMetaParts({ ...base, care: 'concern' })).toEqual(ALL);
  });

  it('turns everything off for turnRecord off and for crisis', () => {
    const base = { preset: preset({ suggestChoices: true }), character, chat: PA_DEFAULT_CHAT_SETTINGS, group: false, care: 'none' as const };
    expect(resolveMetaParts({ ...base, chat: { ...PA_DEFAULT_CHAT_SETTINGS, turnRecord: 'off' } })).toEqual(NONE);
    expect(resolveMetaParts({ ...base, care: 'crisis' })).toEqual(NONE);
    expect(anyPart(NONE)).toBe(false);
    expect(buildFooterContract({ parts: NONE, schema, decks: [], locale: 'zh' })).toBe('');
    expect(footerReminder(NONE, 'zh', true)).toBe('');
  });
});

describe('buildFooterContract', () => {
  it('lists only the enabled lines and drops the state rules and table when state is off', () => {
    const text = buildFooterContract({ parts: { ...NONE, mood: true }, schema, decks: [], locale: 'zh' });
    expect(text).toContain('- mood：');
    expect(text).not.toMatch(/choices：|remember：|roll：|draw：|状态行/);
    expect(text).not.toContain('状态字段');
    expect(text).not.toContain('数字带正负号');
    expect(text).toContain('3. 只能用上面列出的名称');
    expect(text).toContain('<turn_meta>\nmood: 有点紧张\n</turn_meta>');
  });

  it('writes the field table without current values and an example built from the schema', () => {
    const text = buildFooterContract({ parts: ALL, schema, decks: [{ id: 'tarot', name: '塔罗' }], locale: 'zh' });
    expect(text).toContain('hp | 体力：归零就倒下 | 数字 0–100');
    expect(text).toContain('gold | 金币 | 数字\n');
    expect(text).toContain('location | 位置 | 文字');
    expect(text).toContain('weather | 天气 | 选项：晴 / 雨 / Fog');
    expect(text).toContain('bag | 背包 | 列表');
    expect(text).toContain('trust | 信任 | 数字，只读，由 {{user}} 修改');
    expect(text).toContain('可用的牌堆：tarot（塔罗）');
    expect(text).toContain('<turn_meta>\nmood: 有点紧张\nhp: -1\nbag+: 面包\nchoices: 推门进去 | 先敲门 | 转身离开\n</turn_meta>');
    expect(text).not.toContain('旧书店');
    expect(text).not.toMatch(/\nremember: |\nroll: |\ndraw: /);
    const noDecks = buildFooterContract({ parts: ALL, schema, decks: [], locale: 'en' });
    expect(noDecks).toContain('- roll: ask {{user}} to roll');
    expect(noDecks).not.toContain('- draw:');
    expect(noDecks).toContain('hp | 体力: 归零就倒下 | number 0–100');
  });

  it('adds the remember hint to the reminder only when asked and the part is on', () => {
    expect(footerReminder(ALL, 'zh', false)).toBe('正文之后别忘了附上 <turn_meta> 记录块。');
    expect(footerReminder(ALL, 'zh', true)).toContain('\n如果上次聊天留下了值得记住的事');
    expect(footerReminder({ ...NONE, mood: true }, 'en', true)).toBe('After the reply text, remember the <turn_meta> block.');
  });
});

describe('renderFooter', () => {
  it('writes the canonical grammar', () => {
    const ops: PaStateOp[] = [
      { key: 'hp', op: 'delta', value: -10 }, { key: 'gold', op: 'delta', value: 2.5 }, { key: 'gold', op: 'set', value: 3 },
      { key: 'hp', op: 'set', value: -5 }, { key: 'location', op: 'set', value: '旧书店\n二楼' },
      { key: 'bag', op: 'add', value: '铜钥匙' }, { key: 'bag', op: 'remove', value: '面包' },
      { key: 'gold', op: 'delta', value: 1 / 3 },
    ];
    expect(renderFooter({ mood: '有点困', stateOps: ops, parts: ALL })).toBe(block(
      'mood: 有点困', 'hp: -10', 'gold: +2.5', 'gold: 3', 'hp:= -5', 'location: 旧书店 二楼', 'bag+: 铜钥匙', 'bag-: 面包', 'gold: +0.3333',
    ));
  });

  it('is always emitted, even with no lines, and respects the parts', () => {
    expect(renderFooter({ parts: ALL })).toBe('<turn_meta>\n</turn_meta>');
    expect(renderFooter({ mood: '困', stateOps: [{ key: 'hp', op: 'delta', value: 1 }], parts: { ...NONE, mood: true } })).toBe(block('mood: 困'));
  });
});

describe('parseSoulReply: footer forms', () => {
  it('reads a strict block', () => {
    const reply = parse(`你来了。\n${block('mood: 开心', 'hp: -5', 'gold: +3')}`);
    expect(reply).toMatchObject({ text: '你来了。', footer: 'ok', mood: '开心', empty: false });
    expect(reply.stateOps).toEqual([{ key: 'hp', op: 'delta', value: -5 }, { key: 'gold', op: 'delta', value: 3 }]);
  });

  it('reads loose trailing lines', () => {
    const reply = parse('你来了。\n\n---\nmood: 开心\nhp: +3\n');
    expect(reply).toMatchObject({ text: '你来了。', footer: 'loose', mood: '开心' });
    expect(reply.stateOps).toEqual([{ key: 'hp', op: 'delta', value: 3 }]);
    expect(parse('你来了。\nfoo: 1')).toMatchObject({ text: '你来了。\nfoo: 1', footer: 'missing' });
    expect(parse('你来了。\nmood: 一个词')).toMatchObject({ text: '你来了。\nmood: 一个词', footer: 'missing' });
  });

  it('reads an unclosed block and drops a possibly cut last line', () => {
    const cut = parse('嗯。\n<turn_meta>\nmood: 开心\nhp: -');
    expect(cut).toMatchObject({ text: '嗯。', footer: 'unclosed', mood: '开心', stateOps: [] });
    const whole = parse('嗯。\n<turn_meta>\nmood: 开心\nhp: -5\n');
    expect(whole.stateOps).toEqual([{ key: 'hp', op: 'delta', value: -5 }]);
  });

  it('reports a missing footer and leaves the text alone', () => {
    expect(parse('只是一句话。')).toMatchObject({ text: '只是一句话。', footer: 'missing', stateOps: [], empty: false });
  });

  it('strips a block but ignores it when no part is on', () => {
    const reply = parse(`好。\n${block('mood: 开心', 'hp: -5', 'choices: a | b')}`, { parts: NONE });
    expect(reply).toMatchObject({ text: '好。', footer: 'off', stateOps: [], choices: [], remember: [], play: [], dropped: [] });
    expect(reply.mood).toBeUndefined();
    expect(parse('好。\nmood: 开心', { parts: NONE })).toMatchObject({ text: '好。', footer: 'off' });
  });

  it('removes reasoning blocks: complete, stray closer and unclosed', () => {
    expect(parse('<think>先想想</think>你好。').text).toBe('你好。');
    expect(parse('<THINKING>a</THINKING>你好<think>b</think>呀').text).toBe('你好呀');
    expect(parse('计划：先寒暄</think>你好。').text).toBe('你好。');
    expect(parse('你好。<thinking>还在想').text).toBe('你好。');
  });

  it('accepts full-width tags and punctuation, labels and the legacy <meta> spelling', () => {
    const reply = parse('你好\n＜turn_meta＞\n心情：紧张\n体力：－５\n位置＝“河岸”\n＜/turn_meta＞');
    expect(reply).toMatchObject({ text: '你好', footer: 'ok', mood: '紧张' });
    expect(reply.stateOps).toEqual([{ key: 'hp', op: 'delta', value: -5 }, { key: 'location', op: 'set', value: '河岸' }]);
    // Values keep their CJK punctuation as written; only names and operators are folded.
    const kept = parse(`x\n${block('mood: 有点困，但还挺清醒', 'remember: 约定 ｜ ２０２６－１１－２１ ｜ 周六去看老海报展，很期待！', 'choices: 好啊！｜等等（先想想）', 'location：“河岸，桥下”')}`);
    expect(kept.mood).toBe('有点困，但还挺清醒');
    expect(kept.remember).toEqual([{ kind: 'promise', text: '周六去看老海报展，很期待！', due: '2026-11-21' }]);
    expect(kept.choices).toEqual(['好啊！', '等等（先想想）']);
    expect(kept.stateOps).toEqual([{ key: 'location', op: 'set', value: '河岸，桥下' }]);
    const legacy = parse('嗨\n<meta>\nmood: 安静\n</meta>');
    expect(legacy).toMatchObject({ text: '嗨', footer: 'ok', mood: '安静' });
    expect(parse('嗨\n<turn-meta>\nmood: 安静\n</turn meta>')).toMatchObject({ text: '嗨', footer: 'ok', mood: '安静' });
  });

  it('consumes fences around the block, removes earlier blocks and keeps text after the closer', () => {
    expect(parse(`嗨\n\`\`\`\n${block('mood: x')}\n\`\`\``)).toMatchObject({ text: '嗨', footer: 'ok' });
    const twice = parse(`A\n${block('mood: 一')}\nB\n${block('mood: 二')}`);
    expect(twice).toMatchObject({ text: 'A\n\nB', mood: '二' });
    expect(parse(`嗨\n${block('mood: 好')}\nP.S. 晚安`).text).toBe('嗨\nP.S. 晚安');
  });
});

describe('parseSoulReply: line grammar', () => {
  const ops = (...lines: string[]) => parse(`x\n${block(...lines)}`).stateOps;

  it('reads number sets, deltas, := and arrows', () => {
    expect(ops('hp: 50', 'hp:= -5', 'gold := 7', 'hp += 4', 'hp -= 4', 'gold = -2', 'hp: 80 → 60', 'hp: 50/100', 'hp: 1->2'))
      .toEqual([
        { key: 'hp', op: 'set', value: 50 }, { key: 'hp', op: 'set', value: -5 }, { key: 'gold', op: 'set', value: 7 },
        { key: 'hp', op: 'delta', value: 4 }, { key: 'hp', op: 'delta', value: -4 }, { key: 'gold', op: 'delta', value: -2 },
        { key: 'hp', op: 'set', value: 60 }, { key: 'hp', op: 'set', value: 50 }, { key: 'hp', op: 'set', value: 2 },
      ]);
    const reply = parse(`x\n${block('hp: 很多', 'hp: 无变化', 'hp: none')}`);
    expect(reply.stateOps).toEqual([]);
    expect(reply.dropped).toEqual([{ line: 'hp: 很多', reason: 'invalid-value' }]);
  });

  it('reads list adds and removes, enum options and text', () => {
    expect(ops('bag+: 铜钥匙，旧地图', 'bag-: 面包', 'bag: 雨伞', 'bag += 火柴、蜡烛', 'weather: fog', 'location: "河岸"')).toEqual([
      { key: 'bag', op: 'add', value: '铜钥匙' }, { key: 'bag', op: 'add', value: '旧地图' },
      { key: 'bag', op: 'remove', value: '面包' }, { key: 'bag', op: 'add', value: '雨伞' },
      { key: 'bag', op: 'add', value: '火柴' }, { key: 'bag', op: 'add', value: '蜡烛' },
      { key: 'weather', op: 'set', value: 'Fog' }, { key: 'location', op: 'set', value: '河岸' },
    ]);
  });

  it('reads the legacy state: line', () => {
    expect(ops('state: hp -= 5; bag + 钥匙；location = 码头; bag - 面包')).toEqual([
      { key: 'hp', op: 'delta', value: -5 }, { key: 'bag', op: 'add', value: '钥匙' },
      { key: 'location', op: 'set', value: '码头' }, { key: 'bag', op: 'remove', value: '面包' },
    ]);
  });

  it('drops unknown fields, read-only fields, invalid values and disabled parts', () => {
    const reply = parse(`x\n${block('foo: 1', 'trust: +1', 'weather: 雪', 'mood: 好')}`);
    expect(reply.dropped).toEqual([
      { line: 'foo: 1', reason: 'unknown-field' },
      { line: 'trust: +1', reason: 'not-writable' },
      { line: 'weather: 雪', reason: 'invalid-value' },
    ]);
    const moodOnly = parse(`x\n${block('hp: -1', 'choices: a | b', 'roll: d20')}`, { parts: { ...NONE, mood: true } });
    expect(moodOnly.dropped.map(item => item.reason)).toEqual(['part-off', 'part-off', 'part-off']);
    expect(moodOnly.footer).toBe('ok');
  });

  it('reads remember lines with and without a date', () => {
    const reply = parse(`x\n${block('remember: promise | 2026-11-21 | 周六傍晚一起去旧书摊', 'remember: 喜好 | 喜欢下雨天')}`);
    expect(reply.remember).toEqual([
      { kind: 'promise', text: '周六傍晚一起去旧书摊', due: '2026-11-21' },
      { kind: 'preference', text: '喜欢下雨天' },
    ]);
    const more = parse(`x\n${block('remember: 随便一句', 'remember: 约定 | 2026-02-30 | 不存在的日子', 'remember: moment | 第三条')}`);
    expect(more.remember).toEqual([{ kind: 'fact', text: '随便一句' }, { kind: 'promise', text: '不存在的日子' }]);
    expect(more.dropped).toEqual([{ line: 'remember: moment | 第三条', reason: 'limit' }]);
  });

  it('reads roll and draw lines within the play limit', () => {
    const reply = parse(`x\n${block('roll: D20 + 2 | 翻墙检定 | 12', 'draw: 塔罗', 'draw: TOPIC')}`);
    expect(reply.play).toEqual([{ kind: 'roll', notation: 'd20+2', label: '翻墙检定', dc: 12 }, { kind: 'draw', deckId: 'tarot' }]);
    expect(reply.dropped).toEqual([{ line: 'draw: TOPIC', reason: 'limit' }]);
    const bad = parse(`x\n${block('roll: banana', 'draw: 不存在', 'roll: 2d6 | | 5000')}`);
    expect(bad.play).toEqual([{ kind: 'roll', notation: '2d6' }]);
    expect(bad.dropped.map(item => item.reason)).toEqual(['invalid-value', 'invalid-value']);
  });

  it('reads choices inline and as following list lines, at most four', () => {
    expect(parse(`x\n${block('choices: 推门进去 ｜ 先敲门 | 转身离开')}`).choices).toEqual(['推门进去', '先敲门', '转身离开']);
    expect(parse(`x\n${block('choices:', '- 推门', '1. 敲门', '③ 离开', 'mood: 好')}`)).toMatchObject({ choices: ['推门', '敲门', '离开'], mood: '好' });
    expect(parse(`x\n${block('choices: a | b | c | d | e')}`).choices).toEqual(['a', 'b', 'c', 'd']);
  });

  it('enforces the mood and op limits', () => {
    expect(parse(`x\n${block('mood: 这是一个非常非常非常长的心情描述')}`).mood).toBe('这是一个非常非常非常长的');
    expect(parse(`x\n${block('mood: ...')}`).mood).toBeUndefined();
    const many = parse(`x\n${block(...Array.from({ length: 20 }, () => 'gold: +1'))}`);
    expect(many.stateOps).toHaveLength(16);
    expect(many.dropped.filter(item => item.reason === 'limit')).toHaveLength(4);
  });
});

describe('parseSoulReply: visible text', () => {
  it('strips one leading speaker label', () => {
    expect(parse('周行简：你来了。').text).toBe('你来了。');
    expect(parse('**老周**: 嗯。').text).toBe('嗯。');
    expect(parse('【周行简】：好。').text).toBe('好。');
    expect(parse('[老周] : 好。').text).toBe('好。');
    const repeated = parse(`${'周行简：'.repeat(200)}你好`);
    expect(repeated.text).toBe('你好');
    expect(parse(repeated.text).text).toBe('你好');
  });

  it('cuts at a later line spoken by the user or another member', () => {
    expect(parse('好的。\n阿青：那我们走吧\n周行简：嗯').text).toBe('好的。');
    expect(parse('好的。\n阿青：那我们走吧', { format: 'script' }).text).toBe('好的。\n阿青：那我们走吧');
    expect(parse('好的。\n你：走吧', { userName: '你' }).text).toBe('好的。\n你：走吧');
    expect(parse('好的。\n小月: 我也去', { otherNames: ['小月'] }).text).toBe('好的。');
  });

  it('removes echoed asides and stray footer tags and lines', () => {
    expect(parse('你好<aside>现在是晚上</aside>呀').text).toBe('你好呀');
    expect(parse('A\n</turn_meta>\nB turn_meta C\nD').text).toBe('A\n\nD');
    expect(parse('A\n\n\n\nB').text).toBe('A\n\nB');
  });

  it('marks a reply with nothing visible as empty', () => {
    expect(parse(block('mood: 开心'))).toMatchObject({ text: '', empty: true, footer: 'ok', mood: '开心' });
    expect(parse('<think>只是在想</think>')).toMatchObject({ text: '', empty: true });
  });
});

describe('parseSoulReply: invariants over random splices', () => {
  const fixtures = [
    `周行简：雨还在下。\n\n*他把灯拨亮了一点*\n${block('mood: 平静', 'hp: -3', 'bag+: 铜钥匙', 'choices: 留下 | 离开')}`,
    '<think>她今天好像很累</think>今天辛苦了。\n要不要先喝点热的？\nmood: 担心\nhp: +2',
    '你来啦！\n```\n<turn_meta>\nmood: 开心\nremember: promise | 2026-11-21 | 去旧书摊\n</turn_meta>\n```',
    '嗯……\n＜turn_meta＞\n心情：犹豫\n位置：钟楼\n天气：雨',
    '阿青：等等我\n<aside>现在是晚上</aside>\n好，我等你。\n<meta>\nroll: d20 | 察觉 | 12\ndraw: tarot\n</meta>\nP.S. 别忘了伞',
    '计划</thinking>那我先说一句。\n---\nstate: hp -= 5; bag + 地图\n',
    '**老周**: 走吧。\n<turn_meta>\nchoices:\n- 跟上\n2. 停下\n</turn_meta>\n</turn_meta>\nturn_meta 泄露了',
    '纯文本，没有任何记录块。\r\n第二行​。',
  ];
  const rng = seededRng('reply-splices');
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;
  const splice = () => {
    let out = '';
    const pieces = 1 + Math.floor(rng() * 4);
    for (let index = 0; index < pieces; index += 1) {
      const source = pick(fixtures);
      const start = Math.floor(rng() * source.length);
      const end = start + Math.floor(rng() * (source.length - start + 1));
      out += source.slice(start, end) + (rng() < 0.3 ? '\n' : '');
    }
    return out;
  };
  const contexts = [ctx(), ctx({ parts: NONE }), ctx({ parts: { ...NONE, mood: true }, otherNames: ['小月'] }), ctx({ format: 'script' })];

  it('never throws, never leaks the footer tag and is idempotent on its own text', () => {
    for (let round = 0; round < 400; round += 1) {
      const raw = round < fixtures.length ? (fixtures[round] as string) : splice();
      const context = pick(contexts);
      const result = parseSoulReply(raw, context);
      expect(result.text).not.toContain('turn_meta');
      expect(parseSoulReply(result.text, context).text).toBe(result.text);
      expect(result.empty).toBe(result.text === '');
    }
  });

  it('round-trips any footer built from valid ops', () => {
    const moods = ['开心', '有点困', '紧张', 'calm', '想念你'];
    const words = ['旧书店二楼', '河岸', 'harbor gate', '钟楼 顶层'];
    const items = ['铜钥匙', '旧地图', 'lamp'];
    const number = () => {
      const value = Math.round((rng() * 2000 - 1000) * 10 ** Math.floor(rng() * 5)) / 10 ** Math.floor(rng() * 5);
      return Math.round(value * 10000) / 10000 || 0;
    };
    const randomOp = (): PaStateOp => {
      switch (Math.floor(rng() * 6)) {
        case 0: return { key: pick(['hp', 'gold']), op: 'delta', value: number() };
        case 1: return { key: pick(['hp', 'gold']), op: 'set', value: number() };
        case 2: return { key: 'location', op: 'set', value: pick(words) };
        case 3: return { key: 'weather', op: 'set', value: pick(['晴', '雨', 'Fog']) };
        case 4: return { key: 'bag', op: 'add', value: pick(items) };
        default: return { key: 'bag', op: 'remove', value: pick(items) };
      }
    };
    for (let round = 0; round < 300; round += 1) {
      const context = ctx();
      const text = parseSoulReply(splice(), context).text;
      const mood = rng() < 0.8 ? pick(moods) : undefined;
      const stateOps = Array.from({ length: Math.floor(rng() * 9) }, randomOp);
      const footer = renderFooter({ ...(mood !== undefined ? { mood } : {}), stateOps, parts: ALL });
      const reply = parseSoulReply(`${text}\n${footer}`, context);
      expect(reply.mood).toBe(mood);
      expect(reply.stateOps).toEqual(stateOps);
      expect(reply.footer).toBe('ok');
    }
  });

  it('stays fast on long runs of spaces in the last line and in a footer body', () => {
    const spaces = ' '.repeat(20000);
    const inputs = [
      `你好\n${spaces}好`,
      `你好\n${spaces}hp${spaces}`,
      `你好\n${block(`${spaces}mood${spaces}`, `state:${spaces}hp${spaces};`)}`,
      `你好\n${block('choices: 推门', `- ${spaces}${String.fromCharCode(0x2028)}x`)}`,
    ];
    for (const raw of inputs) {
      const started = performance.now();
      const result = parseSoulReply(raw, ctx());
      expect(performance.now() - started).toBeLessThan(250);
      expect(result.text).not.toContain('turn_meta');
    }
  });
});
