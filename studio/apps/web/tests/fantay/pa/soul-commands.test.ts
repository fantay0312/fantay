// SPDX-License-Identifier: Apache-2.0
// Fantay Soul composer commands (ARCH 5.4): slash parsing, aliases, roll arguments and the completion list.
import { describe, expect, it } from 'vitest';

import { SOUL_COMMANDS, matchSlash, parseRollArg, parseSlash } from '../../../src/fantay/pa/soul/soul-commands';

describe('SOUL_COMMANDS', () => {
  it('lists the play group, then the turn and the bridge commands, with their label keys', () => {
    expect(SOUL_COMMANDS.map((command) => [command.id, command.group])).toEqual([
      ['roll', 'play'],
      ['draw', 'play'],
      ['event', 'play'],
      ['continue', 'turn'],
      ['task', 'bridge'],
    ]);
    for (const command of SOUL_COMMANDS) expect(command.labelKey).toBe(`pa.soul.chat.cmd.${command.id}`);
  });
});

describe('parseSlash', () => {
  it('splits the command word from its argument', () => {
    expect(parseSlash('/roll d20+2 翻墙')).toEqual({ id: 'roll', arg: 'd20+2 翻墙' });
    expect(parseSlash('  /draw  tarot ')).toEqual({ id: 'draw', arg: 'tarot' });
    expect(parseSlash('/event')).toEqual({ id: 'event', arg: '' });
  });

  it('accepts every alias, Latin case-insensitively', () => {
    expect(parseSlash('/r d6')).toEqual({ id: 'roll', arg: 'd6' });
    expect(parseSlash('/掷骰 d6')).toEqual({ id: 'roll', arg: 'd6' });
    expect(parseSlash('/抽')?.id).toBe('draw');
    expect(parseSlash('/抽一张 情绪卡')).toEqual({ id: 'draw', arg: '情绪卡' });
    expect(parseSlash('/小插曲')?.id).toBe('event');
    expect(parseSlash('/插曲')?.id).toBe('event');
    expect(parseSlash('/C')?.id).toBe('continue');
    expect(parseSlash('/接着说')?.id).toBe('continue');
    expect(parseSlash('/ROLL d20')?.id).toBe('roll');
  });

  it('keeps a multi-line task goal', () => {
    expect(parseSlash('/任务 写周报\n附上数据')).toEqual({ id: 'task', arg: '写周报\n附上数据' });
  });

  it('is null for plain text, unknown commands and a glued argument', () => {
    expect(parseSlash('hello /roll')).toBeNull();
    expect(parseSlash('/unknown x')).toBeNull();
    expect(parseSlash('/rolld20')).toBeNull();
    expect(parseSlash('')).toBeNull();
  });
});

describe('matchSlash', () => {
  it('lists every command for a bare slash, in registry order', () => {
    expect(matchSlash('/').map((command) => command.id)).toEqual(['roll', 'draw', 'event', 'continue', 'task']);
  });

  it('matches the slash or any alias by prefix', () => {
    expect(matchSlash('/r').map((command) => command.id)).toEqual(['roll']);
    expect(matchSlash('/c').map((command) => command.id)).toEqual(['continue']);
    expect(matchSlash('/抽').map((command) => command.id)).toEqual(['draw']);
    expect(matchSlash('/小').map((command) => command.id)).toEqual(['event']);
    expect(matchSlash('/T').map((command) => command.id)).toEqual(['task']);
  });

  it('needs an exact name once the word is followed by a space, and is empty without a slash', () => {
    expect(matchSlash('/ro d20').map((command) => command.id)).toEqual([]);
    expect(matchSlash('/roll d20').map((command) => command.id)).toEqual(['roll']);
    expect(matchSlash('roll')).toEqual([]);
    expect(matchSlash('/zz')).toEqual([]);
  });
});

describe('parseRollArg', () => {
  it('reads notation, label and target', () => {
    expect(parseRollArg('d20+2 翻墙 12')).toEqual({ notation: 'd20+2', label: '翻墙', dc: 12 });
    expect(parseRollArg('2d6')).toEqual({ notation: '2d6' });
    expect(parseRollArg('d20 潜行 检定')).toEqual({ notation: 'd20', label: '潜行 检定' });
    expect(parseRollArg('d20 DC15')).toEqual({ notation: 'd20', dc: 15 });
  });

  it('normalises the notation through the engine', () => {
    expect(parseRollArg('1D20')).toEqual({ notation: 'd20' });
    expect(parseRollArg('d%')).toEqual({ notation: 'd100' });
  });

  it('keeps an out-of-range number in the label and cuts the label to the route limit', () => {
    expect(parseRollArg('d20 1000')).toEqual({ notation: 'd20', label: '1000' });
    expect(parseRollArg(`d20 ${'很'.repeat(60)}`)?.label).toBe('很'.repeat(40));
  });

  it('is null when the first word is not dice notation', () => {
    expect(parseRollArg('翻墙 d20')).toBeNull();
    expect(parseRollArg('')).toBeNull();
    expect(parseRollArg('d1')).toBeNull();
    expect(parseRollArg('99d6')).toBeNull();
  });
});
