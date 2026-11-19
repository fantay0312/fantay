import { describe, expect, it } from 'vitest';
import { foldCardMarkup, revealPlan, seededRng, splitBubbles, tokenizeRoleplay } from '../../src/soul/index';
import type { RoleplayToken } from '../../src/soul/index';

const join = (tokens: readonly RoleplayToken[]) => tokens.map(token => token.text).join('');
const spans = (text: string) => tokenizeRoleplay(text).filter(token => token.kind !== 'text');

describe('tokenizeRoleplay', () => {
  it('stays linear on long runs of unclosed brackets and quotes', () => {
    for (const open of ['（', '“', '「', '"', '(']) {
      const text = open.repeat(32000);
      const started = performance.now();
      const tokens = tokenizeRoleplay(text);
      expect(performance.now() - started).toBeLessThan(300);
      expect(tokens.map(token => token.text).join('')).toBe(text);
    }
    const parens = `${'('.repeat(32000)}字)`;
    const started = performance.now();
    expect(tokenizeRoleplay(parens).map(token => token.text).join('')).toBe(parens);
    expect(performance.now() - started).toBeLessThan(300);
    expect(spans('（他笑了）和（她也笑了）')).toEqual([{ kind: 'action', text: '（他笑了）' }, { kind: 'action', text: '（她也笑了）' }]);
    expect(spans('(sigh) (叹气)')).toEqual([{ kind: 'action', text: '(叹气)' }]);
  });

  it('marks single-asterisk actions', () => {
    expect(tokenizeRoleplay('*waves* hi')).toEqual([{ kind: 'action', text: '*waves*' }, { kind: 'text', text: ' hi' }]);
    expect(tokenizeRoleplay('她笑了。*把茶推过来*“喝吧。”')).toEqual([
      { kind: 'text', text: '她笑了。' },
      { kind: 'action', text: '*把茶推过来*' },
      { kind: 'speech', text: '“喝吧。”' },
    ]);
    expect(spans('**bold** and ***both***')).toEqual([]);
    expect(spans('* not an action*')).toEqual([]);
    expect(spans('*not an action *')).toEqual([]);
    expect(spans('- list\n* item')).toEqual([]);
    expect(spans(`*${'a'.repeat(400)}*`)).toHaveLength(1);
    expect(spans(`*${'a'.repeat(401)}*`)).toEqual([]);
  });

  it('marks bracketed actions: full-width always, half-width only around CJK', () => {
    expect(spans('他（低头）说')).toEqual([{ kind: 'action', text: '（低头）' }]);
    expect(spans('(笑) ok')).toEqual([{ kind: 'action', text: '(笑)' }]);
    expect(spans('call me (maybe) later')).toEqual([]);
    expect(spans('f(x) = (a + b)')).toEqual([]);
  });

  it('marks quoted speech', () => {
    expect(spans('“你好”「好」『嗯』"hi"').map(token => [token.kind, token.text])).toEqual([
      ['speech', '“你好”'], ['speech', '「好」'], ['speech', '『嗯』'], ['speech', '"hi"'],
    ]);
    expect(spans('*她说“好”*')).toEqual([{ kind: 'action', text: '*她说“好”*' }]);
    expect(spans('"unclosed')).toEqual([]);
  });

  it('never crosses a line break', () => {
    expect(spans('*one\ntwo*')).toEqual([]);
    expect(spans('“one\ntwo”')).toEqual([]);
    expect(spans('（one\r\ntwo）')).toEqual([]);
    expect(spans('*one*\n*two*')).toHaveLength(2);
  });

  it('skips inline code and fenced code blocks', () => {
    expect(spans('run `*x*` then *nod*')).toEqual([{ kind: 'action', text: '*nod*' }]);
    expect(spans('``a ` *b* ``')).toEqual([]);
    expect(spans('a lone ` then *nod*')).toEqual([{ kind: 'action', text: '*nod*' }]);
    const fenced = '```js\nconst a = "*x*";\n\n（注释）\n```\n*after*';
    expect(spans(fenced)).toEqual([{ kind: 'action', text: '*after*' }]);
    expect(spans('~~~~\n"x"\n~~~\nstill code "y"\n~~~~\n"z"')).toEqual([{ kind: 'speech', text: '"z"' }]);
    expect(spans('```\nunclosed *x*\n"y"')).toEqual([]);
  });

  it('is lossless for any input', () => {
    const alphabet = ['*', '**', '(', ')', '（', '）', '“', '”', '「', '」', '『', '』', '"', '`', '```', '~~~', '\n', '\r\n', ' ', 'a', '月', '- '];
    const rng = seededRng('tokenizer');
    expect(tokenizeRoleplay('')).toEqual([]);
    for (let round = 0; round < 300; round += 1) {
      const text = Array.from({ length: Math.floor(rng() * 60) }, () => alphabet[Math.floor(rng() * alphabet.length)] ?? '').join('');
      const tokens = tokenizeRoleplay(text);
      expect(join(tokens)).toBe(text);
      expect(tokens.every(token => token.text.length > 0)).toBe(true);
    }
  });
});

describe('foldCardMarkup', () => {
  it('returns text without markup untouched', () => {
    expect(foldCardMarkup('plain 文本 a > b')).toEqual([{ kind: 'text', text: 'plain 文本 a > b' }]);
    expect(foldCardMarkup('')).toEqual([{ kind: 'text', text: '' }]);
  });

  it('removes style and script blocks', () => {
    expect(foldCardMarkup('x<style>.a { color: red }</style>y<SCRIPT type="module">alert(1)</script>z'))
      .toEqual([{ kind: 'text', text: 'xyz' }]);
    expect(foldCardMarkup('before<script>\nnever closed')).toEqual([{ kind: 'text', text: 'before' }]);
  });

  it('strips inline tags and keeps their text', () => {
    expect(foldCardMarkup('<b>粗</b>和<span style="color:red">红</span><font color=blue>蓝</font>'))
      .toEqual([{ kind: 'text', text: '粗和红蓝' }]);
    expect(foldCardMarkup('a<br>b<br/>c<BR />d')).toEqual([{ kind: 'text', text: 'a\nb\nc\nd' }]);
    expect(foldCardMarkup('<div>\nline\n</div>')).toEqual([{ kind: 'text', text: '\nline\n' }]);
  });

  it('folds a multi-line paired tag outside the inline list into one markup segment', () => {
    const block = '<details>\n<summary>状态栏</summary>\n<b>HP</b> 10\n</details>';
    expect(foldCardMarkup(`开场\n${block}\n结尾`)).toEqual([
      { kind: 'text', text: '开场\n' },
      { kind: 'markup', text: block },
      { kind: 'text', text: '\n结尾' },
    ]);
    const nested = '<status-bar>\n<status-bar>\ninner\n</status-bar>\n</status-bar>';
    expect(foldCardMarkup(`${nested}tail`)).toEqual([{ kind: 'markup', text: nested }, { kind: 'text', text: 'tail' }]);
  });

  it('keeps single-line, unpaired and unknown tags as text', () => {
    expect(foldCardMarkup('<details>one line</details>')).toEqual([{ kind: 'text', text: '<details>one line</details>' }]);
    expect(foldCardMarkup('<details>\nnever closed')).toEqual([{ kind: 'text', text: '<details>\nnever closed' }]);
    expect(foldCardMarkup('</details>\nstray')).toEqual([{ kind: 'text', text: '</details>\nstray' }]);
    expect(foldCardMarkup('a < b and <3 and <!-- note -->')).toEqual([{ kind: 'text', text: 'a < b and <3 and <!-- note -->' }]);
  });

  it('never throws and stays fast on hostile input', () => {
    const started = Date.now();
    for (const text of [`<${'a'.repeat(30000)}`, '<x>'.repeat(8000) + '\n</x>', '<style'.repeat(5000), '<'.repeat(30000)]) {
      expect(() => foldCardMarkup(text)).not.toThrow();
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('splitBubbles', () => {
  it('splits on blank lines, trims and drops empties', () => {
    expect(splitBubbles('在。\n\n怎么啦？')).toEqual(['在。', '怎么啦？']);
    expect(splitBubbles('\n\n  a  \n \n\n\n b\nc \n')).toEqual(['a', 'b\nc']);
    expect(splitBubbles('a\r\n\r\nb')).toEqual(['a', 'b']);
    expect(splitBubbles('one line')).toEqual(['one line']);
    expect(splitBubbles('')).toEqual([]);
    expect(splitBubbles(' \n\n ')).toEqual([]);
  });

  it('merges the adjacent pair with the smallest combined length while over the limit', () => {
    expect(splitBubbles('aaaa\n\nb\n\nc\n\ndddd\n\neeee')).toEqual(['aaaa', 'b\n\nc', 'dddd', 'eeee']);
    expect(splitBubbles('aaaa\n\nb\n\nc\n\ndddd\n\neeee\n\nffff')).toEqual(['aaaa\n\nb\n\nc', 'dddd', 'eeee', 'ffff']);
    expect(splitBubbles('a\n\nb\n\nc', 2)).toEqual(['a\n\nb', 'c']);
    expect(splitBubbles('a\n\nb\n\nc', 1)).toEqual(['a\n\nb\n\nc']);
    expect(splitBubbles('1\n\n2\n\n3\n\n4')).toHaveLength(4);
  });

  it('keeps fences, tables and lists in one bubble', () => {
    const fence = '看这个：\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n好了';
    expect(splitBubbles(fence)).toEqual([fence]);
    const table = '| 名称 | 数量 |\n| --- | :-: |\n| 茶 | 2 |\n\n就这些';
    expect(splitBubbles(table)).toEqual([table]);
    expect(splitBubbles('- 茶\n- 书\n\n先这样')).toHaveLength(1);
    expect(splitBubbles('1. one\n\n2. two')).toHaveLength(1);
    expect(splitBubbles('* a\n\nmore\n\n* b')).toHaveLength(1);
    expect(splitBubbles('- 只有一行\n\n先这样')).toEqual(['- 只有一行', '先这样']);
    expect(splitBubbles('a | b\n\n|---|')).toEqual(['a | b', '|---|']);
  });
});

describe('revealPlan', () => {
  it('starts at zero and clamps each gap to 600–2200 ms', () => {
    expect(revealPlan([])).toEqual([]);
    expect(revealPlan(['only'])).toEqual([0]);
    expect(revealPlan(['a', 'b'])).toEqual([0, 600]);
    expect(revealPlan(['a', 'x'.repeat(10)])).toEqual([0, 800]);
    expect(revealPlan(['a', 'x'.repeat(100)])).toEqual([0, 2200]);
    expect(revealPlan(['a', '😀'.repeat(10)])).toEqual([0, 800]);
  });

  it('caps offsets at 5000 ms', () => {
    const long = 'x'.repeat(100);
    expect(revealPlan([long, long, long, long])).toEqual([0, 2200, 4400, 5000]);
    expect(revealPlan(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])).toEqual([0, 600, 1200, 1800, 2400, 3000, 3600, 4200, 4800, 5000]);
  });
});
