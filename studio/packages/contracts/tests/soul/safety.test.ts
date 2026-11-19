import { describe, expect, it } from 'vitest';
import { detectCrisis } from '../../src/soul/index';

const one = (text: string, fiction?: boolean) => detectCrisis([text], fiction === undefined ? undefined : { fiction });

describe('detectCrisis: crisis tier', () => {
  it('matches every crisis rule', () => {
    const cases: Array<[string, string]> = [
      ['我想自杀', 'zh-intent'],
      ['有时候想要结束自己的生命', 'zh-intent'],
      ['想结束生命', 'zh-intent'],
      ['我想了结自己', 'zh-intent'],
      ['真的不想活了', 'zh-live'],
      ['我不想活下去', 'zh-live'],
      ['我活不下去', 'zh-live'],
      ['我准备去跳楼', 'zh-plan'],
      ['打算烧炭', 'zh-plan'],
      ['今晚决定吞药', 'zh-plan'],
      ['我又自残了', 'zh-act'],
      ['昨天割腕了', 'zh-act'],
      ['想紫砂', 'zh-act'],
      ['我想死', 'zh-die'],
      ['好想死啊', 'zh-die'],
      ['我真的该去死', 'zh-go'],
      ['我要去死', 'zh-go'],
      ['I want to kill myself', 'en'],
      ['I will end my life', 'en'],
      ['I might take my own life', 'en'],
      ['thinking about suicide', 'en'],
      ['I feel suicidal', 'en'],
      ['I want to die', 'en'],
      ['self-harm again', 'en'],
      ['selfharm', 'en'],
      ['I cut myself', 'en'],
    ];
    for (const [text, rule] of cases) expect(one(text), text).toEqual({ level: 'crisis', rule });
  });

  it('does not read affectionate or exaggerated 想死 as crisis', () => {
    for (const text of ['想死你了', '可想死我了', '累得想死', '困到要想死', '笑得想死', '尴尬得想死', '无聊到想死']) {
      expect(one(text), text).toEqual({ level: 'none', rule: '' });
    }
  });

  it('downgrades negated and third-person statements to concern', () => {
    expect(one('我不是想自杀，只是很累')).toEqual({ level: 'concern', rule: 'zh-intent' });
    expect(one('我没有想自杀')).toEqual({ level: 'concern', rule: 'zh-intent' });
    expect(one('别自残')).toEqual({ level: 'concern', rule: 'zh-act' });
    expect(one('我不会想自杀的')).toEqual({ level: 'concern', rule: 'zh-intent' });
    expect(one('她想自杀')).toEqual({ level: 'concern', rule: 'zh-intent' });
    expect(one('他说他想死')).toEqual({ level: 'concern', rule: 'zh-die' });
    expect(one('他们都说ta想死')).toEqual({ level: 'concern', rule: 'zh-die' });
    expect(one("I'm not going to kill myself")).toEqual({ level: 'concern', rule: 'en' });
    expect(one('I don’t want to die')).toEqual({ level: 'concern', rule: 'en' });
    expect(one('she says she might want to die')).toEqual({ level: 'concern', rule: 'en' });
  });

  it('keeps first-person statements next to a third person as crisis', () => {
    expect(one('他说我想死')).toEqual({ level: 'crisis', rule: 'zh-die' });
    expect(one('她走了以后我想自杀')).toEqual({ level: 'crisis', rule: 'zh-intent' });
    expect(one('数据data想死')).toEqual({ level: 'crisis', rule: 'zh-die' });
    expect(one('the only way out is to kill myself')).toEqual({ level: 'crisis', rule: 'en' });
    expect(one('他不想死，但我想死')).toEqual({ level: 'crisis', rule: 'zh-die' });
  });

  it('normalises width, case, zero-width characters and spaces between CJK', () => {
    expect(one('我想​自‍杀').level).toBe('crisis');
    expect(one('我 想 自 杀').level).toBe('crisis');
    expect(one('ＫＩＬＬ ＭＹＳＥＬＦ').level).toBe('crisis');
    expect(one('I WANT TO DIE').level).toBe('crisis');
    expect(one(`我想自杀${'。'.repeat(2000)}`).level).toBe('none');
    expect(one(`${'。'.repeat(5000)}我想自杀`).level).toBe('crisis');
  });
});

describe('detectCrisis: concern tier', () => {
  it('matches despair wording', () => {
    for (const text of ['我快崩溃了', '真的好绝望', '撑不下去了', '我撑不住了', '活着没意思', '活着有什么意思', '消失算了', '好想消失', '不想醒来']) {
      expect(one(text), text).toEqual({ level: 'concern', rule: 'zh-concern' });
    }
    for (const text of ['I feel hopeless', "I can't go on", 'I can’t go on', 'I cannot go on', 'no reason to live', 'I want to disappear', 'I am worthless']) {
      expect(one(text), text).toEqual({ level: 'concern', rule: 'en-concern' });
    }
    expect(one('今天天气不错')).toEqual({ level: 'none', rule: '' });
  });

  it('ignores despair wording inside narration spans', () => {
    expect(one('*绝望地看着窗外*')).toEqual({ level: 'none', rule: '' });
    expect(one('（崩溃）你又迟到了')).toEqual({ level: 'none', rule: '' });
    expect(one('(hopeless sigh) fine')).toEqual({ level: 'none', rule: '' });
    expect(one('*叹气* 我快崩溃了')).toEqual({ level: 'concern', rule: 'zh-concern' });
    expect(one('*我想自杀*').level).toBe('crisis');
  });
});

describe('detectCrisis: three texts and fiction', () => {
  it('lets a crisis in an older text decay to concern', () => {
    expect(detectCrisis(['今天吃了面', '我想自杀'])).toEqual({ level: 'concern', rule: 'zh-intent' });
    expect(detectCrisis(['好的', '嗯', '我想死'])).toEqual({ level: 'concern', rule: 'zh-die' });
    expect(detectCrisis(['我想自杀', '今天吃了面'])).toEqual({ level: 'crisis', rule: 'zh-intent' });
    expect(detectCrisis(['我快崩溃了', 'I want to die'])).toEqual({ level: 'concern', rule: 'zh-concern' });
  });

  it('ignores older concern wording, older negated matches and anything past three texts', () => {
    expect(detectCrisis(['好的', '我快崩溃了'])).toEqual({ level: 'none', rule: '' });
    expect(detectCrisis(['好的', '我不是想自杀'])).toEqual({ level: 'none', rule: '' });
    expect(detectCrisis(['a', 'b', 'c', '我想自杀'])).toEqual({ level: 'none', rule: '' });
    expect(detectCrisis([])).toEqual({ level: 'none', rule: '' });
  });

  it('suppresses concern but never crisis in fiction', () => {
    expect(one('我快崩溃了', true)).toEqual({ level: 'none', rule: '' });
    expect(one('她想自杀', true)).toEqual({ level: 'none', rule: '' });
    expect(detectCrisis(['继续', '我想自杀'], { fiction: true })).toEqual({ level: 'none', rule: '' });
    expect(one('我想自杀', true)).toEqual({ level: 'crisis', rule: 'zh-intent' });
    expect(one('我快崩溃了', false)).toEqual({ level: 'concern', rule: 'zh-concern' });
  });

  it('is deterministic and does not mutate its input', () => {
    const texts = Object.freeze(['我想死', '还好']);
    expect(detectCrisis(texts)).toEqual(detectCrisis(texts));
    expect(texts).toEqual(['我想死', '还好']);
  });
});
