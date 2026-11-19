import { describe, expect, it } from 'vitest';
import { liveReplyText, paStateSchemaSchema, parseSoulReply, seededRng } from '../../src/soul/index';
import type { PaMetaParts, SoulReplyContext } from '../../src/soul/index';
import { mutate } from './fixtures/fuzz';

const schema = paStateSchemaSchema.parse([
  { key: 'hp', label: '体力', kind: 'number', initial: 80, min: 0, max: 100 },
  { key: 'gold', label: '金币', kind: 'number', initial: 0 },
  { key: 'location', label: '位置', kind: 'text', initial: '旧书店' },
  { key: 'weather', label: '天气', kind: 'enum', initial: '晴', options: ['晴', '雨'] },
  { key: 'bag', label: '背包', kind: 'list', initial: [] },
]);
const ALL: PaMetaParts = { mood: true, state: true, choices: true, remember: true, play: true };
const NONE: PaMetaParts = { mood: false, state: false, choices: false, remember: false, play: false };

function ctx(over: Partial<SoulReplyContext> = {}): SoulReplyContext {
  return {
    schema, parts: ALL, speakerNames: ['周行简', '老周'], userName: '阿青', otherNames: ['小月'], format: 'im',
    decks: [{ id: 'tarot', name: '塔罗' }], ...over,
  };
}

const block = (...lines: string[]) => ['<turn_meta>', ...lines, '</turn_meta>'].join('\n');

/** Raw replies of every shape the parser knows; each one is streamed one UTF-16 unit at a time. */
const corpus: string[] = [
  `你来了。\n\n*他把灯拨亮了一点*\n${block('mood: 平静', 'hp: -3', 'bag+: 铜钥匙', 'choices: 留下 | 离开')}`,       // strict
  '你来啦！\n```\n<turn_meta>\nmood: 开心\nremember: promise | 2026-11-21 | 去旧书摊\n</turn_meta>\n```',                 // fenced
  '嗯……\n<turn_meta>\n心情：犹豫\n位置：钟楼\n天气：雨',                                                                    // unclosed
  '今天辛苦了。\n要不要先喝点热的？\n\n---\nmood: 担心\nhp: +2',                                                          // loose
  '好呀，我们出发。\n＜turn_meta＞\n心情：期待\n体力：－５\n位置＝“河岸”\n＜/turn_meta＞',                                    // Chinese keys
  `你拿到了钥匙。\n${block('state: hp -= 5; bag + 钥匙；location = 码头', 'gold: +3')}`,                                    // state ops
  '<think>她今天好像很累，先关心一下</think>今天辛苦了。\n早点休息吧。',                                                     // reasoning first
  '你好。<thinking>还在想要不要说',                                                                                       // unclosed reasoning
  '周行简：雨还在下。\n他把伞往你那边偏了偏。',                                                                             // leading label
  '好的。\n阿青：那我们走吧\n周行简：嗯',                                                                                  // later user label
  '我也想去。\n小月: 那我也去\n好吧',                                                                                     // another member
  '你好<aside>现在是晚上</aside>呀，吃饭了吗？',                                                                           // aside
  '只是一句很普通的话，没有任何记录块。',                                                                                 // no footer
  '第一行。\r\n第二行。\r\n<turn_meta>\r\nmood: 安静\r\n</turn_meta>\r\n',                                                  // CRLF
  '**老周**: 走吧。\n<turn_meta>\nchoices:\n- 跟上\n2. 停下\n</turn_meta>',                                                // bold label, choice list
  `嗨\n${block('mood: 好')}\nP.S. 晚安`,                                                                                   // text after the block
  '嗯。\nhp: 很多\nmood: 开心',                                                                                           // loose, one invalid line
  `看这段：\n\`\`\`js\nconst a = 1;\n\`\`\`\n就这样。\n${block('mood: 得意')}`,                                               // code block
  'Okay, see you at the station.\nmood: calm\nchoices: wave | run',                                                       // English loose
  '【周行简】：好。🙂 明天见。',                                                                                            // bracket label, emoji
];

const contexts = [ctx(), ctx({ parts: NONE }), ctx({ format: 'script' }), ctx({ parts: { ...NONE, mood: true } })];
const lastLine = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').pop() ?? '';
const fenceOrRule = (line: string) => /^\s*`{3,}[\w-]*\s*$/.test(line) || /^\s*-{3,}\s*$/.test(line);

describe('liveReplyText: properties over every prefix of the corpus', () => {
  it('P1 never shows footer, reasoning or aside markup', () => {
    for (const context of contexts) {
      for (const reply of corpus) {
        for (let end = 0; end <= reply.length; end += 1) {
          const live = liveReplyText(reply.slice(0, end), context);
          expect(live, JSON.stringify(reply.slice(0, end))).not.toMatch(/turn_meta|<think|<\/think|<aside/i);
        }
      }
    }
  });

  it('P2 is always a prefix of what the final message shows', () => {
    const failures: string[] = [];
    for (const [ci, context] of contexts.entries()) {
      for (const reply of corpus) {
        const final = parseSoulReply(reply, context).text;
        for (let end = 0; end <= reply.length; end += 1) {
          const prefix = reply.slice(0, end);
          const live = liveReplyText(prefix, context);
          if (!final.startsWith(live)) failures.push(`ctx ${ci}: ${JSON.stringify(prefix)} -> ${JSON.stringify(live)} / ${JSON.stringify(final)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('P3 equals the final text once the reply is complete', () => {
    for (const context of contexts) {
      for (const reply of corpus) {
        if (fenceOrRule(lastLine(reply))) continue;
        expect(liveReplyText(`${reply}\n`, context), reply).toBe(parseSoulReply(`${reply}\n`, context).text);
      }
    }
  });

  it('P4 never throws on hostile and non-string input', () => {
    const rng = seededRng('live-reply-fuzz');
    const values: unknown[] = [undefined, null, 42, {}, [], Symbol('x'), () => 'x', new String('周行简：你好')];
    for (let round = 0; round < 300; round += 1) {
      const value = mutate({ replies: corpus }, rng);
      values.push(value, JSON.stringify(value) ?? '');
      const piece = corpus[round % corpus.length] ?? '';
      const start = Math.floor(rng() * piece.length);
      values.push(piece.slice(start) + piece.slice(0, start), '<'.repeat(round * 7) + piece, `${'<aside'.repeat(round)}x`);
    }
    for (const value of values) {
      for (const context of contexts) {
        let live = '';
        expect(() => { live = liveReplyText(value as string, context); }).not.toThrow();
        expect(typeof live).toBe('string');
        expect(live).not.toMatch(/turn_meta|<think|<\/think|<aside/i);
      }
    }
  });
});

describe('liveReplyText: explicit cases', () => {
  const moon = ctx({ speakerNames: ['小月'], otherNames: [] });
  it.each([
    ['小', ''], ['小月', ''], ['小月：', ''], ['小月：好', '好'],
    ['好呀\nmo', '好呀'], ['好呀\nmood: 开', '好呀'], ['好呀\n<turn_me', '好呀'], ['<think>想一想', ''],
    ['好呀\n```', '好呀'], ['好呀\n---\n', '好呀'], ['好呀<asi', '好呀'], ['好呀<aside>现在是', '好呀'],
    ['小月：小', ''], ['**小月**', ''], ['【小', ''], ['好呀\nmore', '好呀\nmore'], ['好呀\n心', '好呀'],
  ])('%j → %j', (raw, expected) => {
    expect(liveReplyText(raw, moon)).toBe(expected);
  });

  it('holds a later label of the owner until it is decided, and an unfinished schema line', () => {
    expect(liveReplyText('好的。\n阿', ctx())).toBe('好的。');
    expect(liveReplyText('好的。\n阿青', ctx())).toBe('好的。');
    expect(liveReplyText('好的。\n阿青说', ctx())).toBe('好的。\n阿青说');
    expect(liveReplyText('嗯\n体力', ctx())).toBe('嗯');
    expect(liveReplyText('嗯\n体力很好', ctx())).toBe('嗯\n体力很好');
    expect(liveReplyText('嗯\nhp ', ctx())).toBe('嗯');
  });

  it('drops a cut surrogate pair at the end', () => {
    const smile = '好🙂';
    expect(liveReplyText(smile.slice(0, 2), ctx())).toBe('好');
    expect(liveReplyText(smile, ctx())).toBe(smile);
  });

  it('stays fast on hostile text of the live buffer size', () => {
    const inputs = [
      '```\n'.repeat(30000), '---\n\n'.repeat(20000), '<'.repeat(120000), `${' '.repeat(100000)}mood`,
      `好\n${'hp: 很多\n'.repeat(10000)}`, '<aside>'.repeat(15000), `周行简：${'周行简：'.repeat(20000)}`,
    ];
    for (const raw of inputs) {
      const started = performance.now();
      const live = liveReplyText(raw, ctx());
      expect(performance.now() - started, raw.slice(0, 12)).toBeLessThan(1500);
      expect(live).not.toMatch(/turn_meta|<think|<\/think|<aside/i);
    }
  });

  it('answers empty text for empty or non-string input', () => {
    expect(liveReplyText('', ctx())).toBe('');
    expect(liveReplyText(undefined as unknown as string, ctx())).toBe('');
  });
});
