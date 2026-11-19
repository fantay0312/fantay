import { describe, expect, it } from 'vitest';
import {
  applyOp, chatStateSlots, foldChatState, initialState, opEffects, paStateSchemaSchema, reanchorUserOps, stateRecord,
} from '../../src/soul/index';
import type { PaMessageSoul, PaStateOp, PaUserStateOp, SoulMessage, StateSlot } from '../../src/soul/index';

const schema = paStateSchemaSchema.parse([
  { key: 'hp', label: '体力', kind: 'number', initial: 80, min: 0, max: 100, maxStep: 20 },
  { key: 'gold', label: '金币', kind: 'number', initial: 0 },
  { key: 'location', label: '位置', kind: 'text', initial: '旧书店' },
  { key: 'weather', label: '天气', kind: 'enum', initial: '晴', options: ['晴', '雨', 'Fog'] },
  { key: 'bag', label: '背包', kind: 'list', initial: ['面包'] },
  { key: 'trust', label: '信任', kind: 'number', initial: 1, min: 0, max: 5, writable: 'user' },
]);

const op = (key: string, kind: PaStateOp['op'], value: PaStateOp['value']): PaStateOp => ({ key, op: kind, value });
const userOp = (after: string | null, key: string, kind: PaStateOp['op'], value: PaStateOp['value']): PaUserStateOp =>
  ({ after, key, op: kind, value });

describe('initialState and applyOp', () => {
  it('starts from the initial values', () => {
    expect(stateRecord(initialState(schema))).toEqual({ hp: 80, gold: 0, location: '旧书店', weather: '晴', bag: ['面包'], trust: 1 });
  });

  it('clamps numbers, applies maxStep to model deltas only and rounds to 4 decimals', () => {
    const state = initialState(schema);
    expect(applyOp(schema, state, op('hp', 'delta', -50), 'model')).toBe(true);
    expect(state.get('hp')).toBe(60);
    expect(applyOp(schema, state, op('hp', 'delta', -100), 'user')).toBe(true);
    expect(state.get('hp')).toBe(0);
    expect(applyOp(schema, state, op('hp', 'set', 250), 'model')).toBe(true);
    expect(state.get('hp')).toBe(100);
    expect(applyOp(schema, state, op('gold', 'delta', 1 / 3), 'model')).toBe(true);
    expect(state.get('gold')).toBe(0.3333);
    expect(applyOp(schema, state, op('gold', 'set', '12'), 'user')).toBe(true);
    expect(state.get('gold')).toBe(12);
    expect(applyOp(schema, state, op('gold', 'add', 1), 'model')).toBe(false);
    expect(applyOp(schema, state, op('gold', 'delta', Number.NaN), 'model')).toBe(false);
    expect(applyOp(schema, state, op('gold', 'delta', '很多'), 'model')).toBe(false);
  });

  it('sets text and enum values only through set', () => {
    const state = initialState(schema);
    expect(applyOp(schema, state, op('location', 'set', 'x'.repeat(500)), 'model')).toBe(true);
    expect((state.get('location') as string).length).toBe(400);
    expect(applyOp(schema, state, op('location', 'add', '码头'), 'model')).toBe(false);
    expect(applyOp(schema, state, op('weather', 'set', ' fog '), 'model')).toBe(true);
    expect(state.get('weather')).toBe('Fog');
    expect(applyOp(schema, state, op('weather', 'set', '雪'), 'model')).toBe(false);
    expect(state.get('weather')).toBe('Fog');
  });

  it('keeps list items unique and stops at 40', () => {
    const state = initialState(schema);
    expect(applyOp(schema, state, op('bag', 'add', '钥匙'), 'model')).toBe(true);
    expect(applyOp(schema, state, op('bag', 'add', ' 钥匙 '), 'model')).toBe(true);
    expect(applyOp(schema, state, op('bag', 'add', 'ＫＥＹ'), 'model')).toBe(true);
    expect(applyOp(schema, state, op('bag', 'add', 'key'), 'model')).toBe(true);
    expect(state.get('bag')).toEqual(['面包', '钥匙', 'ＫＥＹ']);
    expect(applyOp(schema, state, op('bag', 'remove', '不存在'), 'model')).toBe(true);
    expect(applyOp(schema, state, op('bag', 'remove', '面包'), 'model')).toBe(true);
    expect(state.get('bag')).toEqual(['钥匙', 'ＫＥＹ']);
    expect(applyOp(schema, state, op('bag', 'add', ''), 'model')).toBe(false);
    for (let index = 0; index < 50; index += 1) applyOp(schema, state, op('bag', 'add', `item ${index}`), 'model');
    expect((state.get('bag') as string[]).length).toBe(40);
  });

  it('lets only the user replace a list with set', () => {
    const state = initialState(schema);
    expect(applyOp(schema, state, op('bag', 'set', ['a', 'A', 'b']), 'model')).toBe(false);
    expect(applyOp(schema, state, op('bag', 'set', 'a'), 'user')).toBe(false);
    expect(applyOp(schema, state, op('bag', 'set', ['a', 'A', ' b ', '']), 'user')).toBe(true);
    expect(state.get('bag')).toEqual(['a', 'b']);
  });

  it('refuses model ops on user-writable fields and ops on unknown keys', () => {
    const state = initialState(schema);
    expect(applyOp(schema, state, op('trust', 'delta', 1), 'model')).toBe(false);
    expect(applyOp(schema, state, op('trust', 'delta', 9), 'user')).toBe(true);
    expect(state.get('trust')).toBe(5);
    expect(applyOp(schema, state, op('mana', 'set', 1), 'user')).toBe(false);
    expect(applyOp(schema, state, op('__proto__', 'set', 1), 'user')).toBe(false);
    expect(applyOp(schema, state, op('HP', 'delta', -1), 'model')).toBe(true);
    expect(state.get('hp')).toBe(79);
  });
});

describe('foldChatState', () => {
  const slots: StateSlot[] = [
    { slotId: 's1', ops: [op('hp', 'delta', -10), op('bag', 'add', '钥匙')] },
    { slotId: 's2', ops: [op('gold', 'delta', 5)] },
    { slotId: 's3', ops: [op('hp', 'delta', -10), op('weather', 'set', '雨')] },
  ];

  it('applies leading, anchored and orphan user ops in order', () => {
    const userOps = [
      userOp('s2', 'gold', 'set', 100),
      userOp(null, 'location', 'set', '码头'),
      userOp('gone', 'bag', 'add', '地图'),
      userOp('s1', 'hp', 'set', 50),
      userOp('s2', 'gold', 'delta', 1),
    ];
    const state = stateRecord(foldChatState(schema, slots, userOps));
    expect(state).toEqual({ hp: 40, gold: 101, location: '码头', weather: '雨', bag: ['面包', '钥匙', '地图'], trust: 1 });
  });

  it('stops before the upTo slot and skips orphan anchors then', () => {
    const userOps = [userOp('s2', 'gold', 'set', 100), userOp('s3', 'gold', 'set', 7), userOp('gone', 'bag', 'add', '地图')];
    const state = stateRecord(foldChatState(schema, slots, userOps, { upTo: 's3' }));
    expect(state).toMatchObject({ hp: 70, gold: 100, weather: '晴', bag: ['面包', '钥匙'] });
  });

  it('skips ops that are invalid for the current schema without throwing', () => {
    const broken: StateSlot[] = [{ slotId: 's1', ops: [op('nope', 'set', 1), op('weather', 'set', '雪'), op('trust', 'set', 3), op('gold', 'delta', 2)] }];
    const state = stateRecord(foldChatState(schema, broken, [userOp(null, 'bag', 'set', 'not a list')]));
    expect(state).toMatchObject({ gold: 2, weather: '晴', trust: 1, bag: ['面包'] });
    expect(stateRecord(foldChatState([], broken, []))).toEqual({});
  });

  it('folds the selected variant of each slot, hidden slots included', () => {
    const message = (id: string, createdAt: number, soul?: PaMessageSoul): SoulMessage =>
      ({ id, createdAt, senderId: 'agent', taskId: null, content: id, ...(soul ? { soul } : {}) });
    const messages: SoulMessage[] = [
      message('m1', 1, { kind: 'chat', stateOps: [op('gold', 'delta', 1)], activeVariant: 'm1b' }),
      message('m2', 3, { kind: 'chat', stateOps: [op('gold', 'delta', 10)], hidden: true }),
      message('m1b', 2, { kind: 'chat', variantOf: 'm1', stateOps: [op('gold', 'delta', 100)] }),
    ];
    const slotsOf = chatStateSlots(messages);
    expect(slotsOf.map(slot => slot.slotId)).toEqual(['m1', 'm2']);
    expect(stateRecord(foldChatState(schema, slotsOf, [])).gold).toBe(110);
  });
});

describe('reanchorUserOps', () => {
  const userOps = [userOp('s1', 'gold', 'set', 1), userOp('s2', 'gold', 'set', 2), userOp(null, 'gold', 'set', 3)];

  it('moves the ops of a removed slot to the previous slot or to the start', () => {
    expect(reanchorUserOps(userOps, { removed: 's2', previous: 's1' }).map(item => item.after)).toEqual(['s1', 's1', null]);
    expect(reanchorUserOps(userOps, { removed: 's1', previous: null }).map(item => item.after)).toEqual([null, 's2', null]);
  });

  it('renames anchors and leaves the input untouched', () => {
    const renamed = reanchorUserOps(userOps, { renamed: 's2', to: 'v2' });
    expect(renamed.map(item => item.after)).toEqual(['s1', 'v2', null]);
    expect(userOps[1]?.after).toBe('s2');
  });
});

describe('opEffects', () => {
  it('reports what the ops really changed after clamps', () => {
    const before = initialState(schema);
    const effects = opEffects(schema, before, [
      op('hp', 'delta', -50), op('gold', 'delta', 0), op('bag', 'add', '钥匙'), op('bag', 'remove', '面包'),
      op('bag', 'add', '面包'), op('weather', 'set', '雨'), op('location', 'set', '旧书店'), op('trust', 'delta', 1),
    ], 'model');
    expect(effects).toEqual([
      { key: 'hp', label: '体力', kind: 'number', delta: -20, value: 60 },
      { key: 'bag', label: '背包', kind: 'list', added: ['钥匙'], removed: [], value: ['钥匙', '面包'] },
      { key: 'weather', label: '天气', kind: 'enum', value: '雨' },
    ]);
    expect(before.get('hp')).toBe(80);
    expect(before.get('bag')).toEqual(['面包']);
  });
});
