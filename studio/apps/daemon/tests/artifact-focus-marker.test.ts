/**
 * `<od-focus …/>` 的**流式那一半**:标记进来,事件出去,正文里什么都不留。
 *
 * 三件事必须成立,少一件这个功能就不能上:
 *   1. 标记**一个字符都不许上屏** —— 包括被 SSE 切成两半的时候;
 *   2. 标记**不许让 host 读到项目外的文件** —— 声明的路径是不可信输入;
 *   3. 文件还空着的时候**不许开预览** —— 空白页在用户眼里就是 bug。
 *
 * 分片样本不是编的:真实录制 `.od/runs/*'/events.jsonl` 里 `<od-done>` 就是这么
 * 断的 —— `{"type":"text_delta","delta":"<od-done"}` 单独一帧,
 * `"<od-done key=\"89a"` 又是一帧,`"<od-done key=\"8"` 再一帧。
 * `<od-focus` 走同一条流,断法完全一样。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createArtifactFocusMarkerStripper,
  resolveArtifactFocusProjectPath,
} from '../src/artifact-focus-marker.js';
import { foldArtifactFocusSelections, type ArtifactFocusSelection } from '@open-design/contracts';

/** 真实录制里的 done_key 就是 16 位十六进制,`<od-focus>` 复用同一枚 */
const KEY = 'c07a83a9bc73cbd6';

function makeProject(): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'od-focus-')));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface Harness {
  strip: (delta: string) => string;
  settle: () => Promise<boolean>;
  flush: () => string;
  emitted: ArtifactFocusSelection[];
  probed: string[];
}

function harness(
  root: string | null,
  opts: { key?: string | null } = {},
): Harness {
  const emitted: ArtifactFocusSelection[] = [];
  const probed: string[] = [];
  const stripper = createArtifactFocusMarkerStripper({
    key: opts.key === undefined ? KEY : opts.key,
    projectRoot: root,
    emit: (selection) => emitted.push(selection),
    probeFile: async (absolutePath) => {
      probed.push(absolutePath);
      const fs = await import('node:fs');
      try {
        const real = fs.realpathSync(absolutePath);
        if (!root) return null;
        const rel = path.relative(realpathSync(root), real);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        const st = fs.statSync(real);
        return st.isFile() ? { size: st.size } : null;
      } catch {
        return null;
      }
    },
  });
  return { ...stripper, emitted, probed };
}

/* ─────────────────────────────────────────────────────────────────────────
 * 1. 标记不许上屏
 * ──────────────────────────────────────────────────────────────────────── */

describe('标记一个字符都不许进正文', () => {
  it('一帧里的完整标记,连同属性一起吃掉', () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html><body>hi</body>');
    const h = harness(p.root);
    const out = h.strip(`已完成。<od-focus key="${KEY}" open="index.html" show="index.html"/>\n文件已保存。`);
    expect(out).not.toContain('od-focus');
    expect(out).not.toContain('key=');
    expect(out).not.toContain(KEY);
    expect(out).toBe('已完成。\n文件已保存。');
    expect(h.flush()).toBe('');
    p.cleanup();
  });

  it('被切成两半:半截标签一个字都不许露出来', () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), 'x'.repeat(100));
    const h = harness(p.root);
    // 真实录制里 `<od-done` 就是这样单独成帧的
    expect(h.strip('先说一句。<od-focus')).toBe('先说一句。');
    expect(h.strip(` key="${KEY}`)).toBe('');
    expect(h.strip('" open="index.html"/>收工。')).toBe('收工。');
    expect(h.flush()).toBe('');
    p.cleanup();
  });

  it('切在最刁钻的位置(尖括号后第一个字符)也不闪', () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'a.html'), 'content');
    const h = harness(p.root);
    const whole = `前。<od-focus key="${KEY}" open="a.html"/>后。`;
    for (let cut = 1; cut < whole.length; cut += 1) {
      const one = harness(p.root);
      const first = one.strip(whole.slice(0, cut));
      const second = one.strip(whole.slice(cut));
      const tail = one.flush();
      const shown = first + second + tail;
      expect(shown, `切在第 ${cut} 个字符时漏了`).not.toContain('od-focus');
      expect(shown).toBe('前。后。');
    }
    expect(h.flush()).toBe('');
    p.cleanup();
  });

  it('key 不对 / 没写 key / 没闭合,照样吃掉 —— 剥离不看 key', () => {
    const p = makeProject();
    const h = harness(p.root);
    for (const marker of [
      '<od-focus key="not-this-turns-key" open="index.html"/>',
      '<od-focus open="index.html"/>',
      '<od-focus>',
      '</od-focus>',
    ]) {
      const one = harness(p.root);
      expect(one.strip(`前。${marker}后。`), `${marker} 漏了`).toBe('前。后。');
      expect(one.emitted).toEqual([]);
    }
    expect(h.flush()).toBe('');
    p.cleanup();
  });

  it('流结束时还卡着半个标记 —— 丢掉标记,不是打在屏幕上', () => {
    const p = makeProject();
    const h = harness(p.root);
    expect(h.strip(`结论在这里。<od-focus key="${KEY}" open="ind`)).toBe('结论在这里。');
    expect(h.flush()).toBe('');
    p.cleanup();
  });

  /*
   * 正面对照 —— 防的是「凡是尖括号一律删掉」这种糊弄式修法。
   * 少了这一条,把匹配换成 `/<[^>]*>/g` 也能让上面几条全绿。
   */
  it('长得像但不是的东西,一个字都不许动', () => {
    const p = makeProject();
    const h = harness(p.root);
    const innocent = [
      '普通 HTML:<div class="x">hi</div> 和 <span>y</span>。',
      '多一截的 <od-focused> / 复数的 <od-focuses> 都不是这个标记。',
      '别的协议标记 <od-done key="x"/> 不归这里管。',
      '正文里裸写 od-focus 这个词(没有尖括号)要留着。',
      '数学写法 a<b 和 5 < 7 也要留着。',
    ].join('\n');
    expect(h.strip(innocent)).toBe(innocent);
    expect(h.flush()).toBe('');
    p.cleanup();
  });

  it('攒着的半截最终是人话时,flush 原样吐回去 —— 不吞用户的字', () => {
    const p = makeProject();
    const h = harness(p.root);
    expect(h.strip('这里有个孤立的 <')).toBe('这里有个孤立的 ');
    expect(h.flush()).toBe('<');
    const two = harness(p.root);
    expect(two.strip('半截 <od')).toBe('半截 ');
    expect(two.flush()).toBe('<od');
    p.cleanup();
  });

  it('孤立的 `<` 后面跟上普通字符就立刻放行,不把回答憋住', () => {
    const p = makeProject();
    const h = harness(p.root);
    expect(h.strip('比较 5 <')).toBe('比较 5 ');
    expect(h.strip(' 7 的时候')).toBe('< 7 的时候');
    expect(h.flush()).toBe('');
    p.cleanup();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 2. 路径安全 —— 声明的路径是不可信输入
 * ──────────────────────────────────────────────────────────────────────── */

describe('resolveArtifactFocusProjectPath', () => {
  it('把项目内的绝对路径折回相对路径(真实 Write 给的就是绝对路径)', () => {
    expect(resolveArtifactFocusProjectPath('/proj/site/index.html', '/proj')).toBe(
      'site/index.html',
    );
  });

  it('项目外的绝对路径一律拒绝', () => {
    for (const hostile of [
      '/etc/passwd',
      '/proj/../etc/passwd',
      '/Users/elian/.ssh/id_rsa',
      '/projX/index.html',
      '//evil-host/share/x',
      'C:/Windows/System32/config/SAM',
    ]) {
      expect(
        resolveArtifactFocusProjectPath(hostile, '/proj'),
        `${hostile} 必须拒绝`,
      ).toBeNull();
    }
  });

  it('相对路径里的 `..` 一律拒绝,不管在第几段', () => {
    expect(resolveArtifactFocusProjectPath('../secrets.env', '/proj')).toBeNull();
    expect(resolveArtifactFocusProjectPath('a/../../b', '/proj')).toBeNull();
  });

  it('没有项目根时,绝对路径无从校验,拒绝', () => {
    expect(resolveArtifactFocusProjectPath('/proj/index.html', null)).toBeNull();
    // 相对路径不需要根就能判安全,照常通过
    expect(resolveArtifactFocusProjectPath('index.html', null)).toBe('index.html');
  });
});

describe('标记不许让 host 读到项目外的文件', () => {
  it('穿越路径不 probe、不发事件', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" open="../../../etc/passwd"/>`);
    await h.settle();
    expect(h.emitted).toEqual([]);
    // 关键:根本没去碰文件系统 —— 拒绝发生在 stat 之前
    expect(h.probed).toEqual([]);
    p.cleanup();
  });

  it('项目外的绝对路径不 probe、不发事件', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" open="/etc/passwd"/>`);
    await h.settle();
    expect(h.emitted).toEqual([]);
    expect(h.probed).toEqual([]);
    p.cleanup();
  });

  /*
   * 字符串校验挡得住 `../`,挡不住软链 —— `assets/logo.png` 可以是指向
   * `~/.ssh/id_rsa` 的软链。所以 probe 里还要再按 realpath 判一次归属。
   */
  it('项目内的软链指向项目外时,probe 之后仍然拒绝', async () => {
    const p = makeProject();
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'od-outside-')));
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP SECRET');
    symlinkSync(secret, path.join(p.root, 'leak.html'));

    const root = p.root;
    const h = harness(root);
    h.strip(`<od-focus key="${KEY}" open="leak.html"/>`);
    await h.settle();
    // 路径本身合法,所以确实去碰了文件系统(和上面两条「压根不 probe」相反),
    // 但 realpath 之后判出界 —— 一次事件都不发
    expect(h.probed.length).toBeGreaterThan(0);
    expect(h.probed.every((p) => p.startsWith(path.join(root, path.sep)))).toBe(true);
    expect(h.emitted).toEqual([]);

    // 正面对照:同一个项目里的真文件必须放行,否则上面那条可能只是「什么都拒绝」
    writeFileSync(path.join(p.root, 'real.html'), 'hello');
    const ok = harness(p.root);
    ok.strip(`<od-focus key="${KEY}" open="real.html"/>`);
    await ok.settle();
    expect(ok.emitted).toEqual([{ open: 'real.html' }]);

    rmSync(outside, { recursive: true, force: true });
    p.cleanup();
  });

  it('show 里的越界路径被逐条丢掉,好路径留下', () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" show="index.html, ../../etc/passwd, report.md"/>`);
    expect(h.emitted).toEqual([{ show: ['index.html', 'report.md'] }]);
    p.cleanup();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 3. 空文件不许开预览
 * ──────────────────────────────────────────────────────────────────────── */

describe('空的时候不开,有内容了才开', () => {
  it('文件还不存在时不发事件 —— 但标记留着,等字节', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" open="index.html"/>`);
    await h.settle();
    expect(h.emitted).toEqual([]);

    // 字节落盘之后,settle 才把它放出来
    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html><body>ok</body>');
    expect(await h.settle()).toBe(true);
    expect(h.emitted).toEqual([{ open: 'index.html' }]);
    p.cleanup();
  });

  it('0 字节的文件不算「有内容」', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), '');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" open="index.html"/>`);
    await h.settle();
    expect(h.emitted).toEqual([]);

    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html>');
    await h.settle();
    expect(h.emitted).toEqual([{ open: 'index.html' }]);
    p.cleanup();
  });

  it('文件已经有内容时,标记一到就发 —— 不等回合结束', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html><body>done</body>');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" open="index.html"/>`);
    // 不调 settle:标记那一刻就该发出去
    await vi.waitFor(() => expect(h.emitted).toEqual([{ open: 'index.html' }]));
    p.cleanup();
  });

  it('目录不是产物 —— 指向目录不发事件', async () => {
    const p = makeProject();
    mkdirSync(path.join(p.root, 'assets'));
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" open="assets"/>`);
    await h.settle();
    expect(h.emitted).toEqual([]);
    p.cleanup();
  });

  it('settle 幂等:放行之后再调不会重复发', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), 'x');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" open="index.html"/>`);
    await h.settle();
    expect(await h.settle()).toBe(false);
    expect(await h.settle()).toBe(false);
    expect(h.emitted).toEqual([{ open: 'index.html' }]);
    p.cleanup();
  });

  /*
   * show 走的是另一条路:它只**收窄** host 自己算出来的清单,不会让 host 去
   * 读任何文件,所以不需要 stat 门。这条钉住这个区别 —— 否则有人「顺手统一」
   * 成两边都 stat,show 就会在文件还没落盘时被丢掉。
   */
  it('show 不受空文件门约束:文件不存在也照样下发', () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" show="index.html"/>`);
    expect(h.emitted).toEqual([{ show: ['index.html'] }]);
    expect(h.probed).toEqual([]);
    p.cleanup();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 4. key 与幂等
 * ──────────────────────────────────────────────────────────────────────── */

describe('只认这一轮的 key', () => {
  it('key 不匹配不发事件,但正文照样干净', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), 'x');
    const h = harness(p.root);
    expect(h.strip(`<od-focus key="deadbeefdeadbeef" open="index.html"/>好了。`)).toBe('好了。');
    await h.settle();
    expect(h.emitted).toEqual([]);
    p.cleanup();
  });

  it('这一轮压根没有 key 时,所有标记都只剥不认', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), 'x');
    const h = harness(p.root, { key: null });
    expect(h.strip(`<od-focus key="${KEY}" open="index.html"/>好了。`)).toBe('好了。');
    await h.settle();
    expect(h.emitted).toEqual([]);
    p.cleanup();
  });

  it('一轮里发了好几枚:各字段分别以最后一枚为准', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'a.html'), 'a');
    writeFileSync(path.join(p.root, 'b.html'), 'b');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" open="a.html"/>`);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1));
    h.strip(`<od-focus key="${KEY}" open="b.html" show="b.html"/>`);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(3));
    // 折叠留给消费者(contracts 的 foldArtifactFocusSelections);daemon 只如实上报
    expect(h.emitted).toEqual([
      { open: 'a.html' },
      { show: ['b.html'] },
      { open: 'b.html' },
    ]);
    p.cleanup();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 5. tool / url —— 标记点名「在哪个工具里看」
 *
 * 规矩只有两条:
 *   · 标记带了能用的 open → tool 跟着这枚 open 一起过文件系统门,一起发;
 *   · 标记没有能用的 open → tool 没有字节可等,key 对上就立刻发。
 * ──────────────────────────────────────────────────────────────────────── */

describe('tool:没有 open 时立刻发', () => {
  it('只有 tool 的标记,key 对上就发 —— 不碰文件系统,也不等 settle', () => {
    const p = makeProject();
    for (const tool of ['code', 'files', 'board', 'design-system', 'preview'] as const) {
      const h = harness(p.root);
      expect(h.strip(`看这里。<od-focus key="${KEY}" tool="${tool}"/>`)).toBe('看这里。');
      // 同步断言:strip 返回时事件已经发出去了
      expect(h.emitted, `${tool} 应该立刻发`).toEqual([{ tool }]);
      expect(h.probed).toEqual([]);
    }
    p.cleanup();
  });

  it('browser 带着校验过的地址一起发', () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="browser" url="https://example.com/docs"/>`);
    expect(h.emitted).toEqual([{ tool: 'browser', url: 'https://example.com/docs' }]);
    expect(h.probed).toEqual([]);
    p.cleanup();
  });

  it('地址不合格:丢掉地址,browser 这个工具照发', () => {
    const p = makeProject();
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com/', 'index.html']) {
      const h = harness(p.root);
      h.strip(`<od-focus key="${KEY}" tool="browser" url="${bad}"/>`);
      expect(h.emitted, `${bad} 不许出现在事件里`).toEqual([{ tool: 'browser' }]);
    }
    p.cleanup();
  });

  it('地址只跟 browser 走 —— 别的工具带了 url 也不下发', () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="files" url="https://example.com/"/>`);
    expect(h.emitted).toEqual([{ tool: 'files' }]);
    p.cleanup();
  });

  /*
   * 地址的查询串里全是 `名字=值`。少了契约里「先把 url 属性切出去」那一步,
   * `?open=readme.md` 会被读成这枚标记自己的 open —— 然后被攒着等一个永远不会
   * 出现的文件,浏览器永远不开。这里连「文件真的存在」的情况也一并钉住。
   */
  it('地址查询串里的 open= 不会被当成这枚标记的 open', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'readme.md'), '# hi');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="browser" url="https://example.com/s?open=readme.md&show=readme.md"/>`);
    expect(h.emitted).toEqual([
      { tool: 'browser', url: 'https://example.com/s?open=readme.md&show=readme.md' },
    ]);
    await h.settle();
    expect(h.emitted).toHaveLength(1);
    expect(h.probed).toEqual([]);
    p.cleanup();
  });

  it('tool 和 show 写在同一枚上:一条事件,一起立刻发', () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="files" show="a.png, b.png"/>`);
    expect(h.emitted).toEqual([{ show: ['a.png', 'b.png'], tool: 'files' }]);
    p.cleanup();
  });

  /*
   * open 越界被拒,不等于整枚标记作废:路径丢掉,它点名的工具照发。
   * 关键是**不 probe** —— 拒绝发生在 stat 之前,这条和第 2 组是同一道门。
   */
  it('open 被路径门拒掉时,tool 按「没有 open」处理,立刻发', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="../../../etc/passwd"/>`);
    expect(h.emitted).toEqual([{ tool: 'code' }]);
    await h.settle();
    expect(h.emitted).toEqual([{ tool: 'code' }]);
    expect(h.probed).toEqual([]);
    p.cleanup();
  });
});

describe('tool:带着 open 时跟 open 一起等', () => {
  it('文件还没字节:tool 不许先发,连同 open 一起攒着', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="src/app.ts"/>`);
    await h.settle();
    // 两样都没发 —— 尤其 tool 没有抢跑成一条 `{ tool: 'code' }`
    expect(h.emitted).toEqual([]);

    mkdirSync(path.join(p.root, 'src'));
    writeFileSync(path.join(p.root, 'src/app.ts'), 'export const x = 1;\n');
    expect(await h.settle()).toBe(true);
    // 放行时是**一条**事件,tool 骑在 open 上
    expect(h.emitted).toEqual([{ open: 'src/app.ts', tool: 'code' }]);
    p.cleanup();
  });

  it('0 字节同样不放行 —— 空文件开在代码工具里一样是空白', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'app.ts'), '');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    await h.settle();
    expect(h.emitted).toEqual([]);
    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    await h.settle();
    expect(h.emitted).toEqual([{ open: 'app.ts', tool: 'code' }]);
    p.cleanup();
  });

  it('文件已经有内容:标记一到,open 和 tool 一条事件发出去', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'app.ts'), 'export {};\n');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    await vi.waitFor(() => expect(h.emitted).toEqual([{ open: 'app.ts', tool: 'code' }]));
    p.cleanup();
  });

  it('tool="preview" open=… 和单写 open 走同一道门,只是事件里多一个 tool', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html>');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="preview" open="index.html"/>`);
    await h.settle();
    expect(h.emitted).toEqual([{ open: 'index.html', tool: 'preview' }]);
    p.cleanup();
  });

  it('软链出界:open 不放行,骑在它上面的 tool 也不会漏出去', async () => {
    const p = makeProject();
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'od-outside-')));
    writeFileSync(path.join(outside, 'secret.ts'), 'TOP SECRET');
    symlinkSync(path.join(outside, 'secret.ts'), path.join(p.root, 'leak.ts'));
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="leak.ts"/>`);
    await h.settle();
    expect(h.probed.length).toBeGreaterThan(0);
    expect(h.emitted).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
    p.cleanup();
  });

  it('show 照旧立刻发,open 连同 tool 等字节 —— 两条事件,各走各的钟', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts" show="app.ts"/>`);
    expect(h.emitted).toEqual([{ show: ['app.ts'] }]);
    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    await h.settle();
    expect(h.emitted).toEqual([{ show: ['app.ts'] }, { open: 'app.ts', tool: 'code' }]);
    p.cleanup();
  });
});

describe('tool:认不出来的值', () => {
  /*
   * 「未知 tool 丢掉,其余照旧」。拿同一枚标记去掉 tool 之后的结果当基准比,
   * 而不是把期望值再抄一遍 —— 这样「照旧」是被验证的,不是被复述的。
   */
  it('未知 tool 被丢掉,这枚标记和没写 tool 时逐字段一样', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html>');
    const baseline = harness(p.root);
    baseline.strip(`<od-focus key="${KEY}" open="index.html" show="index.html"/>`);
    await baseline.settle();

    const h = harness(p.root);
    expect(h.strip(`好了。<od-focus key="${KEY}" tool="terminal" open="index.html" show="index.html"/>`)).toBe('好了。');
    await h.settle();
    expect(h.emitted).toEqual(baseline.emitted);
    expect(h.emitted).toEqual([{ show: ['index.html'] }, { open: 'index.html' }]);
    p.cleanup();
  });

  it('只有一个未知 tool 的标记什么都不发 —— 但照样剥干净', () => {
    const p = makeProject();
    const h = harness(p.root);
    expect(h.strip(`前。<od-focus key="${KEY}" tool="terminal"/>后。`)).toBe('前。后。');
    expect(h.emitted).toEqual([]);
    p.cleanup();
  });
});

describe('tool:key 与剥离的规矩不变', () => {
  it('key 不对:tool 和地址一个都不采纳,正文照样干净', async () => {
    const p = makeProject();
    const h = harness(p.root);
    expect(
      h.strip(`<od-focus key="deadbeefdeadbeef" tool="browser" url="https://evil.example/"/>好了。`),
    ).toBe('好了。');
    expect(h.strip(`<od-focus tool="files"/>完。`)).toBe('完。');
    await h.settle();
    expect(h.emitted).toEqual([]);
    p.cleanup();
  });

  it('这一轮没有 key 时,带 tool 的标记同样只剥不认', () => {
    const p = makeProject();
    const h = harness(p.root, { key: null });
    expect(h.strip(`<od-focus key="${KEY}" tool="code"/>好了。`)).toBe('好了。');
    expect(h.emitted).toEqual([]);
    p.cleanup();
  });

  /*
   * 「不采纳」不只是「不发事件」:key 不对的标记也不许改动剥离器里攒着的状态。
   * 只有 tool 的标记会把自己的 tool 交给还在等字节的 open —— 这条路要是排在
   * key 校验前面,一段被模型读到的文字就能改写一枚真标记最后在哪个工具里打开。
   */
  it('key 不对的 tool 标记不许改写还在等字节的那枚 open', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    h.strip(`<od-focus key="deadbeefdeadbeef" tool="browser" url="https://evil.example/"/>`);
    h.strip(`<od-focus tool="files"/>`);
    await h.settle();
    expect(h.emitted).toEqual([]);

    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    expect(await h.settle()).toBe(true);
    expect(h.emitted).toEqual([{ open: 'app.ts', tool: 'code' }]);
    p.cleanup();
  });

  it('key 不对的标记也不许解开「重复不再发」的门闩', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    const h = harness(p.root);
    const real = `<od-focus key="${KEY}" tool="code" open="app.ts"/>`;
    h.strip(real);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1));
    // 要是这枚被采纳,面板就「去过别处」了,下面那枚原样重发会再开一次
    h.strip(`<od-focus key="deadbeefdeadbeef" tool="files"/>`);
    h.strip(real);
    expect(await h.settle()).toBe(false);
    expect(h.emitted).toEqual([{ open: 'app.ts', tool: 'code' }]);
    p.cleanup();
  });

  it('带地址的标记被切在任何位置,地址的任何一截都不许上屏', () => {
    const p = makeProject();
    // 地址里有 `/`、`?`、`&`、`=` —— 每一个都是流式扫描器可能误判成标签边界的字符
    const whole = `前。<od-focus key="${KEY}" tool="browser" url="https://example.com/a?b=1&c=2"/>后。`;
    for (let cut = 1; cut < whole.length; cut += 1) {
      const one = harness(p.root);
      const shown = one.strip(whole.slice(0, cut)) + one.strip(whole.slice(cut)) + one.flush();
      expect(shown, `切在第 ${cut} 个字符时漏了`).toBe('前。后。');
      expect(one.emitted).toEqual([{ tool: 'browser', url: 'https://example.com/a?b=1&c=2' }]);
    }
    p.cleanup();
  });
});

describe('tool:一轮里发了好几枚', () => {
  it('同一个文件换一个工具再开一次,是一次真的请求', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1));
    // 路径一样、工具不同 —— 旧的「同一路径不重发」门闩不许把它吞掉
    h.strip(`<od-focus key="${KEY}" open="app.ts"/>`);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(2));
    expect(h.emitted).toEqual([{ open: 'app.ts', tool: 'code' }, { open: 'app.ts' }]);
    p.cleanup();
  });

  it('一模一样的标记再发一遍是空操作 —— 面板不会原地再跳一次', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1));
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    expect(await h.settle()).toBe(false);
    expect(h.emitted).toEqual([{ open: 'app.ts', tool: 'code' }]);
    p.cleanup();
  });

  /*
   * 中间插了一枚只有 tool 的标记之后,面板已经不在原来那个文件上了,所以原样
   * 重发前一枚 open 是真的请求,不是重复。
   */
  it('中间换过工具之后,原样重发前一枚 open 会再发一次', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1));
    h.strip(`<od-focus key="${KEY}" tool="files"/>`);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(3));
    expect(h.emitted).toEqual([
      { open: 'app.ts', tool: 'code' },
      { tool: 'files' },
      { open: 'app.ts', tool: 'code' },
    ]);
    p.cleanup();
  });

  /*
   * 只有 tool 的标记走同一条「重复是空操作」的规矩。模型常在收尾的总结旁边把
   * 标记再写一遍;浏览器被叫去加载它已经停着的那一页,就是在用户眼前刷新一次。
   */
  it('只有 tool 的标记原样再发一遍是空操作 —— 同一页不会被重新加载', () => {
    const p = makeProject();
    const h = harness(p.root);
    const marker = `<od-focus key="${KEY}" tool="browser" url="https://example.com/docs"/>`;
    h.strip(marker);
    h.strip(marker);
    expect(h.emitted).toEqual([{ tool: 'browser', url: 'https://example.com/docs' }]);

    // 换一个地址、或者这次不带地址,说的都不是同一件事 —— 照发
    h.strip(`<od-focus key="${KEY}" tool="browser" url="https://example.com/other"/>`);
    h.strip(`<od-focus key="${KEY}" tool="browser"/>`);
    expect(h.emitted).toEqual([
      { tool: 'browser', url: 'https://example.com/docs' },
      { tool: 'browser', url: 'https://example.com/other' },
      { tool: 'browser' },
    ]);
    p.cleanup();
  });

  it('面板去过别处之后,同一枚 tool 标记是真的请求', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html>');
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="files"/>`);
    h.strip(`<od-focus key="${KEY}" tool="board"/>`);
    h.strip(`<od-focus key="${KEY}" tool="files"/>`);
    expect(h.emitted).toEqual([{ tool: 'files' }, { tool: 'board' }, { tool: 'files' }]);

    // 中间隔的是一枚 open 也一样:面板已经跳去那个文件了
    h.strip(`<od-focus key="${KEY}" open="index.html"/>`);
    await vi.waitFor(() => expect(h.emitted).toHaveLength(4));
    h.strip(`<od-focus key="${KEY}" tool="files"/>`);
    expect(h.emitted.slice(3)).toEqual([{ open: 'index.html' }, { tool: 'files' }]);
    p.cleanup();
  });

  it('重复的 tool 标记只吞掉 tool,同一枚上的 show 照发', () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="files"/>`);
    h.strip(`<od-focus key="${KEY}" tool="files" show="a.png, b.png"/>`);
    expect(h.emitted).toEqual([{ tool: 'files' }, { show: ['a.png', 'b.png'] }]);
    p.cleanup();
  });

  /*
   * 重复的 tool 标记不发事件,但它仍然写在那枚等字节的 open **之后** —— 所以
   * open 落地时带的必须是它的 tool,折叠结果才和标记的书写顺序一致。
   */
  it('重复的 tool 标记不发事件,但照样交给还在等字节的 open', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="files"/>`);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    h.strip(`<od-focus key="${KEY}" tool="files"/>`);
    await h.settle();
    expect(h.emitted).toEqual([{ tool: 'files' }]);

    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    expect(await h.settle()).toBe(true);
    expect(h.emitted).toEqual([{ tool: 'files' }, { open: 'app.ts', tool: 'files' }]);
    expect(foldArtifactFocusSelections(h.emitted)).toEqual(
      foldArtifactFocusSelections([
        { tool: 'files' },
        { open: 'app.ts', tool: 'code' },
        { tool: 'files' },
      ]),
    );
    p.cleanup();
  });

  /*
   * 一种事件要等字节、另一种不等,所以它们**出门的先后**可以和标记的先后不同。
   * 保证的是结果:发出去的事件折叠之后,等于按标记书写顺序折叠的结果。
   *
   * 这里前一枚 open 还在等字节,后一枚只有 tool 的标记先发了出去。open 事件会
   * 设置折叠后的 tool —— 要是它落地时还带着自己那枚旧的 `code`,就会把模型后说
   * 的 `browser` 顶掉。所以等着的 open 接过后一枚的 tool 再发。
   */
  it('等字节的 open 落地时不会把后说的 tool 顶掉 —— 折叠结果以标记顺序为准', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="app.ts"/>`);
    h.strip(`<od-focus key="${KEY}" tool="browser" url="https://example.com/docs"/>`);
    await h.settle();
    // 只有 tool 的标记既不替那枚 open 放行,也不把它作废
    expect(h.emitted).toEqual([{ tool: 'browser', url: 'https://example.com/docs' }]);

    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    expect(await h.settle()).toBe(true);
    expect(h.emitted).toEqual([
      { tool: 'browser', url: 'https://example.com/docs' },
      { open: 'app.ts', tool: 'browser', url: 'https://example.com/docs' },
    ]);
    expect(foldArtifactFocusSelections(h.emitted)).toEqual(
      foldArtifactFocusSelections([
        { open: 'app.ts', tool: 'code' },
        { tool: 'browser', url: 'https://example.com/docs' },
      ]),
    );
    p.cleanup();
  });

  /*
   * 同一件事的最常见形态:文件早就有内容,两枚标记挤在同一个 delta 里(有些
   * 运行时整条消息只发一帧)。前一枚的 stat 还没回来,后一枚已经发了。
   */
  it('两枚标记挤在同一帧里,结果仍然以后一枚的 tool 为准', async () => {
    const p = makeProject();
    writeFileSync(path.join(p.root, 'app.ts'), 'x');
    const h = harness(p.root);
    h.strip(
      `<od-focus key="${KEY}" tool="code" open="app.ts"/>中间一句。<od-focus key="${KEY}" tool="files"/>`,
    );
    await vi.waitFor(() => expect(h.emitted).toHaveLength(2));
    expect(foldArtifactFocusSelections(h.emitted)).toEqual({ open: 'app.ts', tool: 'files' });
    p.cleanup();
  });

  it('反过来:先说 tool、后说 open,open 落地时清掉前面的 tool', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="browser" url="https://example.com/docs"/>`);
    h.strip(`<od-focus key="${KEY}" open="index.html"/>`);
    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html>');
    await h.settle();
    expect(h.emitted).toEqual([
      { tool: 'browser', url: 'https://example.com/docs' },
      { open: 'index.html' },
    ]);
    expect(foldArtifactFocusSelections(h.emitted)).toEqual({ open: 'index.html' });
    p.cleanup();
  });

  /*
   * 以标记的先后为准,不以 stat 返回的先后为准:后一枚 open 顶掉前一枚还没放行
   * 的 open,前一枚之后即使有了字节也不再发。
   */
  it('后一枚 open 顶掉还在等字节的前一枚,连同它的 tool', async () => {
    const p = makeProject();
    const h = harness(p.root);
    h.strip(`<od-focus key="${KEY}" tool="code" open="a.ts"/>`);
    await h.settle();
    h.strip(`<od-focus key="${KEY}" open="index.html"/>`);
    await h.settle();
    expect(h.emitted).toEqual([]);

    writeFileSync(path.join(p.root, 'a.ts'), 'x');
    writeFileSync(path.join(p.root, 'index.html'), '<!doctype html>');
    expect(await h.settle()).toBe(true);
    expect(await h.settle()).toBe(false);
    expect(h.emitted).toEqual([{ open: 'index.html' }]);
    p.cleanup();
  });
});
