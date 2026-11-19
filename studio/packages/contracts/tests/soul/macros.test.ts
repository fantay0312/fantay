import { describe, expect, it } from 'vitest';
import { expandMacros, seededRng } from '../../src/soul/index';
import type { MacroContext } from '../../src/soul/index';

// 2026-11-14 13:06 UTC is Saturday 21:06 at UTC+8.
const NOW = Date.UTC(2026, 10, 14, 13, 6);

function ctx(over: Partial<MacroContext> = {}): MacroContext {
  return {
    char: '小月', user: '阿青', persona: '一个爱喝茶的人',
    now: NOW, timezoneOffsetMin: 480, locale: 'zh',
    pickSeed: 'conv-1', blockId: 'main', zone: 'tail', rng: seededRng('macro-test'),
    ...over,
  };
}

describe('expandMacros: registry', () => {
  it('expands names, persona and original', () => {
    expect(expandMacros('{{char}} 和 {{user}}', ctx())).toBe('小月 和 阿青');
    expect(expandMacros('{{CHAR}}/{{ User }}', ctx())).toBe('小月/阿青');
    expect(expandMacros('人设：{{persona}}', ctx())).toBe('人设：一个爱喝茶的人');
    expect(expandMacros('[{{original}}]', ctx())).toBe('[]');
    expect(expandMacros('前 {{original}} 后', ctx({ original: '原文' }))).toBe('前 原文 后');
  });

  it('random picks one argument with both separators', () => {
    expect(expandMacros('{{random::甲::乙::丙}}', ctx({ rng: () => 0 }))).toBe('甲');
    expect(expandMacros('{{random::甲::乙::丙}}', ctx({ rng: () => 0.99 }))).toBe('丙');
    expect(expandMacros('{{random:a, b\\,c}}', ctx({ rng: () => 0.99 }))).toBe('b,c');
    expect(expandMacros('{{random}}', ctx())).toBe('');
  });

  it('pick is stable per conversation and content, whatever the zone and rng', () => {
    const text = '{{pick::红茶::绿茶::乌龙::普洱::白茶}}';
    const first = expandMacros(text, ctx({ rng: () => 0 }));
    expect(expandMacros(text, ctx({ rng: () => 0.99, zone: 'system' }))).toBe(first);
    expect(expandMacros(text, ctx({ blockId: 'other' }))).toBe(first);
    const seen = new Set<string>();
    for (let index = 0; index < 40; index += 1) seen.add(expandMacros(text, ctx({ pickSeed: `conv-${index}` })));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('roll returns the total, accepts a bare die size and gives "" when invalid', () => {
    expect(expandMacros('{{roll::2d6+1}}', ctx({ rng: () => 0 }))).toBe('3');
    expect(expandMacros('{{roll:20}}', ctx({ rng: () => 0.999 }))).toBe('20');
    expect(expandMacros('{{roll 1d4}}', ctx({ rng: () => 0.5 }))).toBe('3');
    expect(expandMacros('[{{roll::banana}}]', ctx())).toBe('[]');
  });

  it('formats local time in both locales', () => {
    expect(expandMacros('{{time}}|{{isotime}}|{{isodate}}', ctx())).toBe('21:06|21:06|2026-11-14');
    expect(expandMacros('{{date}} {{weekday}} {{daypart}}', ctx())).toBe('2026年11月14日 星期六 晚上');
    expect(expandMacros('{{date}} {{weekday}} {{daypart}}', ctx({ locale: 'en' }))).toBe('November 14, 2026 Saturday evening');
    expect(expandMacros('{{time}}', ctx({ timezoneOffsetMin: 0 }))).toBe('13:06');
  });

  it('maps every hour to its daypart', () => {
    const zh: string[] = [];
    const en: string[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const now = Date.UTC(2026, 10, 14, hour, 30);
      zh.push(expandMacros('{{daypart}}', ctx({ now, timezoneOffsetMin: 0 })));
      en.push(expandMacros('{{daypart}}', ctx({ now, timezoneOffsetMin: 0, locale: 'en' })));
    }
    expect(zh).toEqual([
      '深夜', '深夜', '深夜', '深夜', '深夜', '清晨', '清晨', '清晨', '上午', '上午', '上午', '中午',
      '中午', '下午', '下午', '下午', '下午', '傍晚', '傍晚', '晚上', '晚上', '晚上', '晚上', '深夜',
    ]);
    expect(en[6]).toBe('early morning');
    expect(en[12]).toBe('noon');
    expect(en[17]).toBe('dusk');
    expect(en[23]).toBe('late night');
  });

  it('humanises idle_duration', () => {
    expect(expandMacros('[{{idle_duration}}]', ctx())).toBe('[]');
    expect(expandMacros('{{idle_duration}}', ctx({ idleMs: 30_000 }))).toBe('刚刚');
    expect(expandMacros('{{idle_duration}}', ctx({ idleMs: 30_000, locale: 'en' }))).toBe('just now');
    expect(expandMacros('{{idle_duration}}', ctx({ idleMs: 5 * 60_000 + 59_000 }))).toBe('5 分钟');
    expect(expandMacros('{{idle_duration}}', ctx({ idleMs: 60_000, locale: 'en' }))).toBe('1 minute');
    expect(expandMacros('{{idle_duration}}', ctx({ idleMs: 3 * 3_600_000, locale: 'en' }))).toBe('3 hours');
    expect(expandMacros('{{idle_duration}}', ctx({ idleMs: 3 * 3_600_000 }))).toBe('3 小时');
    expect(expandMacros('{{idle_duration}}', ctx({ idleMs: 86_400_000, locale: 'en' }))).toBe('1 day');
    expect(expandMacros('{{idle_duration}}', ctx({ idleMs: 9 * 86_400_000 }))).toBe('9 天');
  });

  it('reads the context strings and state', () => {
    const state = new Map<string, number | string | string[]>([['hp', 80.5], ['bag', ['钥匙', '地图']], ['where', '码头']]);
    const context = ctx({ lastMessage: 'L', lastUserMessage: 'U', lastCharMessage: 'C', state });
    expect(expandMacros('{{lastMessage}}{{lastusermessage}}{{LASTCHARMESSAGE}}', context)).toBe('LUC');
    expect(expandMacros('{{lastmessage}}', ctx())).toBe('');
    expect(expandMacros('{{getvar::hp}} {{getvar::bag}} {{getvar::where}} [{{getvar::none}}]', context)).toBe('80.5 钥匙、地图 码头 []');
    expect(expandMacros('{{getvar::bag}}', { ...context, locale: 'en' })).toBe('钥匙, 地图');
    expect(expandMacros('{{getvar::HP}}', context)).toBe('80.5');
  });

  it('expands newline, trim and comments; writers expand to nothing', () => {
    expect(expandMacros('a{{newline}}b', ctx())).toBe('a\nb');
    expect(expandMacros('左边   {{trim}}   右边', ctx())).toBe('左边右边');
    expect(expandMacros('a {{// 作者的注释}} b', ctx())).toBe('a  b');
    for (const writer of ['setvar::x::1', 'addvar::x::1', 'incvar::x', 'decvar::x', 'deletevar::x', 'setglobalvar::x::1',
      'addglobalvar::x::1', 'incglobalvar::x', 'decglobalvar::x']) {
      expect(expandMacros(`[{{${writer}}}]`, ctx())).toBe('[]');
    }
  });
});

describe('expandMacros: grammar', () => {
  it('keeps unknown macros as their original text', () => {
    expect(expandMacros('{{foo}} {{ Bar baz }} {{}}', ctx())).toBe('{{foo}} {{ Bar baz }} {{}}');
    expect(expandMacros('{{char', ctx())).toBe('{{char');
  });

  it('runs one pass: macro output is never rescanned', () => {
    expect(expandMacros('{{persona}}', ctx({ persona: '{{user}} <USER>' }))).toBe('{{user}} <USER>');
    expect(expandMacros('{{original}}', ctx({ original: '{{char}}' }))).toBe('{{char}}');
    expect(expandMacros('{{char}}', ctx({ char: '{{user}}' }))).toBe('{{user}}');
  });

  it('treats an outer {{ before a nested tag, and an over-long body, as literal text', () => {
    expect(expandMacros('{{a {{char}}', ctx())).toBe('{{a 小月');
    const long = `{{${'x'.repeat(2001)}}} {{char}}`;
    expect(expandMacros(long, ctx())).toBe(`{{${'x'.repeat(2001)}}} 小月`);
  });

  it('stays fast on many trim tags after a long inner run of spaces', () => {
    const text = `${' '.repeat(16000)}x${'{{trim}}'.repeat(2000)} y`;
    const started = performance.now();
    expect(expandMacros(text, ctx())).toBe(`${' '.repeat(16000)}xy`);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('replaces legacy tags in literal segments only', () => {
    expect(expandMacros('<USER> 对 <bot> 说，<Char> 笑了', ctx())).toBe('阿青 对 小月 说，小月 笑了');
    expect(expandMacros('{{persona}} <user>', ctx({ persona: '<BOT>' }))).toBe('<BOT> 阿青');
  });
});

describe('expandMacros: randomness and volatility', () => {
  it('random and roll are stable in the system zone and use ctx.rng elsewhere', () => {
    const text = '{{random::a::b::c::d::e::f::g::h}}{{roll::1d1000}}';
    const systemA = expandMacros(text, ctx({ zone: 'system', rng: () => 0 }));
    const systemB = expandMacros(text, ctx({ zone: 'system', rng: () => 0.99 }));
    expect(systemA).toBe(systemB);
    expect(expandMacros(text, ctx({ zone: 'tail', rng: () => 0 }))).toBe('a1');
    expect(expandMacros(text, ctx({ zone: 'tail', rng: () => 0.999 }))).toBe('h1000');
    const salted = new Set<string>();
    for (let index = 0; index < 20; index += 1) salted.add(expandMacros(text, ctx({ zone: 'system', blockId: `b${index}` })));
    expect(salted.size).toBeGreaterThan(1);
  });

  it('reports time macros expanded in the system zone and still expands them', () => {
    const seen: string[] = [];
    const out = expandMacros('{{char}} {{time}} {{weekday}} {{idle_duration}}', ctx({ zone: 'system', idleMs: 0, onVolatile: name => seen.push(name) }));
    expect(out).toBe('小月 21:06 星期六 刚刚');
    expect(seen).toEqual(['time', 'weekday', 'idle_duration']);
    const tail: string[] = [];
    expandMacros('{{time}}', ctx({ zone: 'tail', onVolatile: name => tail.push(name) }));
    expandMacros('{{date}}', ctx({ zone: 'greeting', onVolatile: name => tail.push(name) }));
    expect(tail).toEqual([]);
  });
});
