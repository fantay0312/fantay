import { describe, expect, it } from 'vitest';
import {
  isInContext,
  mentionedMembers,
  mentionsEveryone,
  messageAt,
  pickNaturalSpeaker,
  resolveChatMode,
  resolveNames,
  seededRng,
  selectedVariant,
  slotIdOf,
  visibleSlots,
} from '../../src/soul/index';
import type { PaMessageSoul, SoulMessage } from '../../src/soul/index';

function msg(id: string, createdAt: number, soul?: PaMessageSoul): SoulMessage {
  return { id, createdAt, senderId: 'agent-1', taskId: null, content: `text of ${id}`, ...(soul ? { soul } : {}) };
}

function lookupOf(messages: readonly SoulMessage[]) {
  const byId = new Map(messages.map(message => [message.id, message]));
  return (id: string) => byId.get(id);
}

describe('resolveChatMode', () => {
  const carded = new Set(['mira', 'ash']);
  const hasCard = (id: string) => carded.has(id);
  const base = { explicit: null, channel: false, memberIds: null, agentId: 'mira', hasCard };

  it('applies the four rules in order', () => {
    expect(resolveChatMode({ ...base, explicit: 'work' })).toBe('work');
    expect(resolveChatMode({ ...base, explicit: 'companion', channel: true, agentId: 'plain' })).toBe('companion');
    expect(resolveChatMode({ ...base, explicit: undefined, channel: true })).toBe('work');
    expect(resolveChatMode({ ...base, memberIds: ['mira', 'ash'], agentId: null })).toBe('companion');
    expect(resolveChatMode({ ...base, memberIds: ['mira', 'plain'], agentId: null })).toBe('work');
    expect(resolveChatMode({ ...base, memberIds: [], agentId: null })).toBe('work');
    expect(resolveChatMode(base)).toBe('companion');
    expect(resolveChatMode({ ...base, agentId: 'plain' })).toBe('work');
    expect(resolveChatMode({ ...base, agentId: null })).toBe('work');
  });
});

describe('resolveNames', () => {
  it('prefers the nickname and the persona name, with locale fallbacks', () => {
    expect(resolveNames({ agentName: 'Mira', nickname: '小米', personaName: '林', locale: 'zh' }))
      .toEqual({ char: '小米', user: '林' });
    expect(resolveNames({ agentName: 'Mira', nickname: '  ', personaName: null, locale: 'zh' }))
      .toEqual({ char: 'Mira', user: '你' });
    expect(resolveNames({ agentName: 'Mira', locale: 'en' })).toEqual({ char: 'Mira', user: 'you' });
    expect(resolveNames({ agentName: 'Mira', nickname: ' Mi ', personaName: ' Lin ', locale: 'en' }))
      .toEqual({ char: 'Mi', user: 'Lin' });
  });
});

describe('slots and variants', () => {
  it('reads time and slot id from the soul extension', () => {
    expect(messageAt(msg('a', 50))).toBe(50);
    expect(messageAt(msg('a', 50, { kind: 'chat', at: 10 }))).toBe(10);
    expect(slotIdOf(msg('a', 50))).toBe('a');
    expect(slotIdOf(msg('b', 60, { kind: 'chat', variantOf: 'a' }))).toBe('a');
  });

  it('selects the active variant, else the root', () => {
    const root = msg('r', 1, { kind: 'chat', activeVariant: 'v2' });
    const variants = [root, msg('v1', 2, { kind: 'chat', variantOf: 'r' }), msg('v2', 3, { kind: 'chat', variantOf: 'r' })];
    expect(selectedVariant(root, variants).id).toBe('v2');
    expect(selectedVariant(msg('r', 1), variants).id).toBe('r');
    expect(selectedVariant(msg('r', 1, { kind: 'chat', activeVariant: 'gone' }), variants).id).toBe('r');
  });

  it('groups variants under their root and keeps input order inside a slot', () => {
    const messages = [
      msg('u1', 100),
      msg('a1', 200, { kind: 'chat', activeVariant: 'a1-v2' }),
      msg('a1-v1', 300, { kind: 'chat', variantOf: 'a1' }),
      msg('a1-v2', 400, { kind: 'chat', variantOf: 'a1' }),
      msg('u2', 500),
    ];
    const slots = visibleSlots(messages);
    expect(slots.map(slot => slot.slotId)).toEqual(['u1', 'a1', 'u2']);
    const second = slots[1];
    expect(second?.variants.map(message => message.id)).toEqual(['a1', 'a1-v1', 'a1-v2']);
    expect(second?.selected.id).toBe('a1-v2');
    expect(second?.root.id).toBe('a1');
    expect(second?.at).toBe(200);
  });

  it('treats an orphaned variant as a root', () => {
    const slots = visibleSlots([msg('u1', 100), msg('lost', 200, { kind: 'chat', variantOf: 'deleted' })]);
    expect(slots.map(slot => [slot.slotId, slot.variants.length])).toEqual([['u1', 1], ['lost', 1]]);
  });

  it('sorts branch copies by their original time and keeps ties in input order', () => {
    const slots = visibleSlots([
      msg('copy-2', 9000, { kind: 'chat', at: 200, copiedFrom: 'orig-2' }),
      msg('copy-1', 9001, { kind: 'chat', at: 100, copiedFrom: 'orig-1' }),
      msg('tie-a', 300),
      msg('tie-b', 300),
      msg('new', 9500),
    ]);
    expect(slots.map(slot => slot.slotId)).toEqual(['copy-1', 'copy-2', 'tie-a', 'tie-b', 'new']);
  });

  it('returns hidden slots, flagged by the selected variant', () => {
    const slots = visibleSlots([
      msg('h', 1, { kind: 'chat', hidden: true }),
      msg('r', 2, { kind: 'chat', activeVariant: 'rv' }),
      msg('rv', 3, { kind: 'chat', variantOf: 'r', hidden: true }),
      msg('s', 4),
    ]);
    expect(slots.map(slot => [slot.slotId, slot.hidden])).toEqual([['h', true], ['r', true], ['s', false]]);
  });
});

describe('isInContext', () => {
  it('follows the selected variant of each slot', () => {
    const messages = [
      msg('plain', 1),
      msg('r', 2, { kind: 'chat', activeVariant: 'v2' }),
      msg('v1', 3, { kind: 'chat', variantOf: 'r' }),
      msg('v2', 4, { kind: 'chat', variantOf: 'r' }),
      msg('self', 5, { kind: 'chat', activeVariant: 'self' }),
      msg('stale', 6, { kind: 'chat', activeVariant: 'deleted-variant' }),
      msg('orphan', 7, { kind: 'chat', variantOf: 'deleted-root' }),
      msg('hidden', 8, { kind: 'chat', hidden: true }),
      msg('hr', 9, { kind: 'chat', activeVariant: 'hv' }),
      msg('hv', 10, { kind: 'chat', variantOf: 'hr', hidden: true }),
    ];
    const lookup = lookupOf(messages);
    const inContext = Object.fromEntries(messages.map(message => [message.id, isInContext(message, lookup)]));
    expect(inContext).toEqual({
      plain: true, r: false, v1: false, v2: true, self: true, stale: true,
      orphan: true, hidden: false, hr: false, hv: false,
    });
  });
});

describe('mentions', () => {
  const members = [
    { id: 'rain', names: ['小雨', 'Rain'] },
    { id: 'moon', names: ['月'] },
    { id: 'ash', names: ['Ash', '阿灰'] },
  ];

  it('detects everyone tags case-insensitively', () => {
    for (const text of ['@全体 开饭了', '大家@所有人', 'hi @ALL', '@Everyone look']) expect(mentionsEveryone(text)).toBe(true);
    for (const text of ['all of you', '全体成员', 'every one']) expect(mentionsEveryone(text)).toBe(false);
  });

  it('matches CJK names as substrings, with or without @', () => {
    expect(mentionedMembers('小雨你在吗', members)).toEqual(['rain']);
    expect(mentionedMembers('@阿灰 和 @小雨', members)).toEqual(['ash', 'rain']);
    expect(mentionedMembers('rain? ASH!', members)).toEqual(['rain', 'ash']);
    expect(mentionedMembers('ＲＡＩＮ来了', members)).toEqual(['rain']);
  });

  it('needs @ for one-character names', () => {
    expect(mentionedMembers('11月的月亮', members)).toEqual([]);
    expect(mentionedMembers('@月 你看', members)).toEqual(['moon']);
    expect(mentionedMembers('ash 和 @月 还有 小雨 和 Rain', members)).toEqual(['ash', 'moon', 'rain']);
  });

  it('returns unique ids ordered by first mention', () => {
    expect(mentionedMembers('Rain, rain, 小雨 and Ash', members)).toEqual(['rain', 'ash']);
    expect(mentionedMembers('nobody here', members)).toEqual([]);
  });
});

describe('pickNaturalSpeaker', () => {
  const fixed = (value: number) => () => value;

  it('returns null without members and the only member otherwise', () => {
    expect(pickNaturalSpeaker([], null, fixed(0.5))).toBeNull();
    expect(pickNaturalSpeaker([{ id: 'a', talkativeness: 0.5 }], 'a', fixed(0.5))).toBe('a');
  });

  it('excludes the previous speaker when another member exists', () => {
    const members = [{ id: 'a', talkativeness: 1 }, { id: 'b', talkativeness: 0 }];
    for (const value of [0, 0.3, 0.7, 0.999]) expect(pickNaturalSpeaker(members, 'a', fixed(value))).toBe('b');
  });

  it('uses one weighted draw with a 0.05 floor', () => {
    const members = [{ id: 'quiet', talkativeness: 0 }, { id: 'loud', talkativeness: 1 }];
    // weights 0.05 and 1: the first 0.05 / 1.05 of the range belongs to the quiet member.
    expect(pickNaturalSpeaker(members, null, fixed(0.04))).toBe('quiet');
    expect(pickNaturalSpeaker(members, null, fixed(0.05))).toBe('loud');
    expect(pickNaturalSpeaker(members, null, fixed(0.999))).toBe('loud');

    let draws = 0;
    const counting = () => { draws += 1; return 0.5; };
    pickNaturalSpeaker(members, null, counting);
    expect(draws).toBe(1);

    const rng = seededRng('room');
    const trio = [{ id: 'a', talkativeness: 0.5 }, { id: 'b', talkativeness: 0.25 }, { id: 'c', talkativeness: 0.25 }];
    const counts = new Map<string, number>();
    for (let index = 0; index < 20000; index += 1) {
      const id = pickNaturalSpeaker(trio, null, rng) ?? 'none';
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect((counts.get('a') ?? 0) / 20000).toBeCloseTo(0.5, 1);
    expect((counts.get('b') ?? 0) / 20000).toBeCloseTo(0.25, 1);
    expect(counts.has('none')).toBe(false);
  });
});
