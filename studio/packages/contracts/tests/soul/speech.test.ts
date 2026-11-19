import { describe, expect, it } from 'vitest';
import { SOUL_LIMITS, seededRng, speechText } from '../../src/soul/index';

describe('speechText', () => {
  it('drops markdown markers, emphasis, headings, quotes, bullets and tables', () => {
    expect(speechText('# 今天\n> 引用的一句\n- 第一件事\n* 第二件事\n**重要**的是_休息_，~~别熬夜~~。'))
      .toBe('今天\n引用的一句\n第一件事\n第二件事\n重要的是休息，别熬夜。');
    expect(speechText('| 名字 | 心情 |\n|---|---|\n| 小月 | 开心 |')).toBe('名字 心情\n小月 开心');
    expect(speechText('上面\n\n---\n\n下面')).toBe('上面\n下面');
  });

  it('removes fenced code, keeps inline code text, and reads links and images by their words', () => {
    expect(speechText('看这段：\n```js\nconst a = 1;\n```\n就这样，用 `npm test` 跑。')).toBe('看这段：\n就这样，用 npm test 跑。');
    expect(speechText('还没写完\n~~~\nunclosed code')).toBe('还没写完');
    expect(speechText('去[这个网站](https://example.com/a)看看，![一只猫](https://x.test/cat.png)也在。'))
      .toBe('去这个网站看看，一只猫也在。');
    expect(speechText('地址是 https://example.com/path?q=1 ，记得收藏')).toBe('地址是 ，记得收藏');
  });

  it('reads speech and plain text, not stage directions', () => {
    expect(speechText('*他把灯拨亮了一点* “你来了。”（笑）坐吧。')).toBe('“你来了。”坐吧。');
    expect(speechText('*推门进来*\n今天好冷。')).toBe('今天好冷。');
  });

  it('reads a narration-only message as written', () => {
    expect(speechText('*他把灯拨亮了一点*')).toBe('他把灯拨亮了一点');
    expect(speechText('（窗外下起了雨）')).toBe('窗外下起了雨');
    expect(speechText('(雨停了)')).toBe('雨停了');
  });

  it('drops card markup blocks and inline tags', () => {
    const card = '<details class="box">\n<summary>状态面板</summary>\n</details>\n<b>你好</b>，<i>欢迎</i>回来<br>今天<span style="x">也</span>辛苦了';
    expect(speechText(card)).toBe('你好，欢迎回来\n今天也辛苦了');
    expect(speechText('<style>p{}</style>只剩这句')).toBe('只剩这句');
  });

  it('answers empty text for empty, blank or non-string input', () => {
    expect(speechText('')).toBe('');
    expect(speechText('   \n\n  ')).toBe('');
    expect(speechText('```\ncode only\n```')).toBe('');
    expect(speechText(undefined as unknown as string)).toBe('');
  });

  it('collapses spaces and blank lines', () => {
    expect(speechText('  一   二\t三  \n\n\n\n四  ')).toBe('一 二 三\n四');
  });

  it('is idempotent', () => {
    const samples = [
      '# 今天\n> 引用\n- *动作* “台词”\n[链接](http://a.b) `code` ~~删~~ |a|b|',
      '[a]_(b)_ and **[c](d)**',
      '*（他笑了）*\n（她也笑了）（又笑）',
      '<div>\nx\n</div>\n<b>粗</b> https://x.y/z 结尾',
      '((嵌套)) ** __ ~~ ``',
    ];
    const rng = seededRng('speech');
    const alphabet = ['*', '_', '~', '`', '|', '#', '>', '-', '(', ')', '（', '）', '[', ']', '!', '\n', ' ', '说', 'a', '“', '”', '<b>', '</b>', '```', 'http://x.y '];
    for (let round = 0; round < 400; round += 1) {
      samples.push(Array.from({ length: 1 + Math.floor(rng() * 30) }, () => alphabet[Math.floor(rng() * alphabet.length)] ?? '').join(''));
    }
    for (const sample of samples) {
      const once = speechText(sample);
      expect(speechText(once), JSON.stringify(sample)).toBe(once);
    }
  });

  it('stays fast on hostile input of a full message', () => {
    const inputs = ['['.repeat(SOUL_LIMITS.messageContent), '[a]('.repeat(8000), '*'.repeat(32000), `${'（'.repeat(16000)}x`];
    for (const input of inputs) {
      const started = performance.now();
      speechText(input);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});
