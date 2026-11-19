/**
 * `<od-focus …/>` 的**协议侧**:标记进来,事件出去,正文里什么都不留。
 *
 * 三件事必须成立:
 *   1. `artifact_focus` 事件能落库 —— 刷新之后卡片还是那几张,和实时一样;
 *   2. 没有这个事件的老消息**原样回放** —— 旧会话退回 host 自己的推断,
 *      不是空面板(这是产品拍的板:「不发标记要么按现在规则展示」);
 *   3. 标记不进 `content` —— `content` 是复制 / 导出 / 旧渲染路径读的东西。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendMessageAgentEvent,
  closeDatabase,
  finalizeMessageAgentEvents,
  insertConversation,
  insertProject,
  listMessages,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import { daemonAgentPayloadToPersistedAgentEvent } from '../src/runtimes/chat-run-messages.js';
import { createArtifactFocusMarkerStripper } from '../src/artifact-focus-marker.js';
import {
  foldArtifactFocusSelections,
  renderArtifactFocusMarkerExample,
  parseArtifactFocusMarker,
  stripArtifactFocusMarkers,
  type ArtifactFocusSelection,
} from '@open-design/contracts';

/** 真实录制里的 done_key 形状(16 位十六进制) */
const KEY = 'a7f3c91ed2b40561';

describe('artifact-focus marker · 契约形状', () => {
  it('提示词里的例子和解析器读的是同一份格式', () => {
    const rendered = renderArtifactFocusMarkerExample(KEY, {
      open: 'index.html',
      show: ['index.html', 'report.md'],
    });
    expect(rendered).toBe(
      `<od-focus key="${KEY}" open="index.html" show="index.html, report.md"/>`,
    );
    // 例子必须能被自己的解析器读回来 —— 两边各写一份迟早会分家
    const parsed = parseArtifactFocusMarker(rendered);
    expect(parsed.key).toBe(KEY);
    expect(parsed.open).toBe('index.html');
    expect(parsed.show).toEqual(['index.html', 'report.md']);
  });

  it('剥离整条,连没写 key 的、闭合歪了的也一起吃掉', () => {
    expect(
      stripArtifactFocusMarkers(`好了。${renderArtifactFocusMarkerExample(KEY, { open: 'a.html' })}`),
    ).toBe('好了。');
    expect(stripArtifactFocusMarkers('好了。<od-focus open="a.html"/>')).toBe('好了。');
    expect(stripArtifactFocusMarkers('好了。</od-focus>')).toBe('好了。');
    // 正面对照:没有标记的正文一个字都不许动
    expect(stripArtifactFocusMarkers('没有标记的正文')).toBe('没有标记的正文');
    expect(stripArtifactFocusMarkers('多一截的 <od-focused> 不算')).toBe('多一截的 <od-focused> 不算');
  });
});

describe('artifact_focus 载荷 · 翻成可落库的事件', () => {
  it('open / show 各自独立带过去', () => {
    expect(
      daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', open: 'index.html' }),
    ).toEqual({ kind: 'artifact_focus', open: 'index.html' });
    expect(
      daemonAgentPayloadToPersistedAgentEvent({
        type: 'artifact_focus',
        show: ['index.html', 'report.md'],
      }),
    ).toEqual({ kind: 'artifact_focus', show: ['index.html', 'report.md'] });
    expect(
      daemonAgentPayloadToPersistedAgentEvent({
        type: 'artifact_focus',
        open: 'index.html',
        show: ['index.html'],
      }),
    ).toEqual({ kind: 'artifact_focus', open: 'index.html', show: ['index.html'] });
  });

  it('两个字段都空的载荷不落库 —— 落一条空事件只会让下游多一次跳过', () => {
    expect(daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus' })).toBeNull();
    expect(
      daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', open: '', show: [] }),
    ).toBeNull();
    expect(
      daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', show: ['  ', ''] }),
    ).toBeNull();
  });

  it('非字符串条目被丢掉,好条目留下', () => {
    expect(
      daemonAgentPayloadToPersistedAgentEvent({
        type: 'artifact_focus',
        show: ['index.html', 42, null, 'report.md'],
      }),
    ).toEqual({ kind: 'artifact_focus', show: ['index.html', 'report.md'] });
  });

  it('tool 跟着 open 一起落库;browser 的地址也一起', () => {
    expect(
      daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', open: 'src/app.ts', tool: 'code' }),
    ).toEqual({ kind: 'artifact_focus', open: 'src/app.ts', tool: 'code' });
    expect(
      daemonAgentPayloadToPersistedAgentEvent({
        type: 'artifact_focus',
        tool: 'browser',
        url: 'https://example.com/docs',
      }),
    ).toEqual({ kind: 'artifact_focus', tool: 'browser', url: 'https://example.com/docs' });
  });

  /*
   * 「显示文件面板」不开任何文件、也不列任何卡,但它是一条完整的展示意图 ——
   * 旧的「open 和 show 都空就不落库」会把它当成空事件丢掉,刷新之后工具就没了。
   */
  it('只有 tool 的载荷也要落库', () => {
    for (const tool of ['code', 'files', 'board', 'design-system', 'preview', 'browser'] as const) {
      expect(daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', tool })).toEqual({
        kind: 'artifact_focus',
        tool,
      });
    }
  });

  it('认不出的 tool 不落库 —— 其余字段照旧;只剩它一个时整条不落', () => {
    expect(
      daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', open: 'index.html', tool: 'terminal' }),
    ).toEqual({ kind: 'artifact_focus', open: 'index.html' });
    expect(daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', tool: 'terminal' })).toBeNull();
    expect(daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', tool: 42 })).toBeNull();
  });

  /*
   * 落库这一步不信载荷:地址重新过一遍契约的校验。否则任何能往这条通道里塞
   * 载荷的路径,都能把一个 `javascript:` 地址存进会话,等刷新时再交给浏览器。
   */
  it('不合格的地址、或不属于 browser 的地址,不落库', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com/', 42, null]) {
      expect(
        daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', tool: 'browser', url: bad }),
        `${JSON.stringify(bad)} 不许落库`,
      ).toEqual({ kind: 'artifact_focus', tool: 'browser' });
    }
    expect(
      daemonAgentPayloadToPersistedAgentEvent({
        type: 'artifact_focus',
        tool: 'code',
        open: 'src/app.ts',
        url: 'https://example.com/',
      }),
    ).toEqual({ kind: 'artifact_focus', open: 'src/app.ts', tool: 'code' });
    // 没有 tool 的地址无处可去,整条不落
    expect(
      daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', url: 'https://example.com/' }),
    ).toBeNull();
  });
});

describe('artifact_focus 事件 · 落库与回放', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-focus-proto-'));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed(db: ReturnType<typeof openDatabase>) {
    const now = Date.now();
    insertProject(db, { id: 'p1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, { id: 'c1', projectId: 'p1', title: 'T', createdAt: now, updatedAt: now });
    upsertMessage(db, 'c1', { id: 'm1', role: 'assistant', content: '', runId: 'r1' });
  }

  it('事件跟着这一轮存下来,刷新之后卡片还是那几张', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    seed(db);
    appendMessageAgentEvent(db, 'm1', { kind: 'text', text: '页面写好了。' });
    appendMessageAgentEvent(db, 'm1', { kind: 'artifact_focus', open: 'index.html' });
    appendMessageAgentEvent(db, 'm1', { kind: 'artifact_focus', show: ['index.html'] });
    finalizeMessageAgentEvents(db, 'm1');

    const message = listMessages(db, 'c1').find((m) => m.id === 'm1');
    expect(message?.content).toBe('页面写好了。');
    // 一轮可以发好几枚,两枚都要留着 —— 折叠是消费者的事(按字段取最后一个)
    expect(message?.events ?? []).toContainEqual({ kind: 'artifact_focus', open: 'index.html' });
    expect(message?.events ?? []).toContainEqual({ kind: 'artifact_focus', show: ['index.html'] });
  });

  /**
   * 整条链走一遍:标记 → 剥离器发出的载荷 → 落库 → 回放。
   *
   * 载荷的拼法照抄 `server.ts` 的 `send('agent', { type: 'artifact_focus',
   * ...selection })`。回放出来的事件必须和实时发出去的**逐条相等**,折叠结果
   * 也因此相同 —— 刷新前后侧栏停在同一个工具、同一个文件上。
   */
  it('带 tool / url 的事件:刷新之后回放的和实时发的是同一条', async () => {
    const projectRoot = realpathSync(mkdtempSync(path.join(tempDir, 'project-')));
    mkdirSync(path.join(projectRoot, 'src'));
    writeFileSync(path.join(projectRoot, 'src/app.ts'), 'export const x = 1;\n');

    const live: ArtifactFocusSelection[] = [];
    const stripper = createArtifactFocusMarkerStripper({
      key: KEY,
      projectRoot,
      emit: (selection) => live.push(selection),
    });
    let visible = stripper.strip(
      `先看代码。<od-focus key="${KEY}" tool="code" open="src/app.ts" show="src/app.ts"/>`,
    );
    // show 立刻发;open 连同它的 tool 等 stat 回来
    await vi.waitFor(() => expect(live).toHaveLength(2));
    visible += stripper.strip(`再看文档。<od-focus key="${KEY}" tool="browser" url="https://example.com/docs"/>`);
    visible += stripper.flush();
    expect(live).toHaveLength(3);
    expect(visible).toBe('先看代码。再看文档。');

    const db = openDatabase(tempDir, { dataDir: tempDir });
    seed(db);
    const persisted = live.map((selection) =>
      daemonAgentPayloadToPersistedAgentEvent({ type: 'artifact_focus', ...selection }),
    );
    for (const event of persisted) {
      expect(event).not.toBeNull();
      appendMessageAgentEvent(db, 'm1', event!);
    }
    finalizeMessageAgentEvents(db, 'm1');

    const replayed = (listMessages(db, 'c1').find((m) => m.id === 'm1')?.events ?? []).filter(
      (event) => event.kind === 'artifact_focus',
    );
    expect(replayed).toEqual(live.map((selection) => ({ kind: 'artifact_focus', ...selection })));
    expect(replayed).toContainEqual({ kind: 'artifact_focus', open: 'src/app.ts', tool: 'code' });
    expect(replayed).toContainEqual({
      kind: 'artifact_focus',
      tool: 'browser',
      url: 'https://example.com/docs',
    });
    // 折叠是消费者的事,但两边折出来必须一样
    const fold = (events: readonly ArtifactFocusSelection[]) => foldArtifactFocusSelections(events);
    expect(fold(replayed as ArtifactFocusSelection[])).toEqual(fold(live));
  });

  /**
   * 旧会话兼容(产品硬要求)。改动之前的消息里没有这个事件,回放出来必须和
   * 改动前**逐字一致** —— 不许因为「没有声明」就把面板清空。
   */
  it('没有这个事件的老消息原样回放', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    seed(db);
    appendMessageAgentEvent(db, 'm1', { kind: 'text', text: '页面写好了。' });
    finalizeMessageAgentEvents(db, 'm1');

    const message = listMessages(db, 'c1').find((m) => m.id === 'm1');
    expect(message?.content).toBe('页面写好了。');
    expect((message?.events ?? []).some((e) => e.kind === 'artifact_focus')).toBe(false);
  });

  /**
   * 兜底:流式那一层已经把标记剥掉了,所以正常路径下 text 事件里不会有它。
   * 这条守的是「万一有别的路径绕过了剥离器」—— `content` 是复制 / 导出读的
   * 东西,一个裸协议标记落在那里就是屏幕上的协议标记。
   */
  it('万一有别的路径把标记塞进 text,content 里也不许留下它', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    seed(db);
    appendMessageAgentEvent(db, 'm1', {
      kind: 'text',
      text: `页面写好了。<od-focus key="${KEY}" open="index.html"/>收工。`,
    });
    finalizeMessageAgentEvents(db, 'm1');

    const message = listMessages(db, 'c1').find((m) => m.id === 'm1');
    expect(message?.content).toBe('页面写好了。收工。');
    expect(message?.content ?? '').not.toContain('od-focus');
    expect(message?.content ?? '').not.toContain(KEY);
  });
});
