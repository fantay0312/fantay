// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The Memory Center dialogs against a fake `/api/memory-center`: the inbox (accept, reject, edit before
// accepting, a disagreement opening the compare dialog), the compare dialog's four resolutions with the
// merge step, recall with its hits and the prompt block, engine settings that never echo a key and offer
// local models (download, progress, cancel), the detail dialog with clearing an archived memory's text,
// and the copy rules every dictionary must keep.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryConflictResolution } from '@open-design/contracts';

import { I18nProvider } from '../../../src/i18n';
import { memoryDialogEn, memoryDialogJa, memoryDialogZh } from '../../../src/i18n/memory-ui/dialogs';
import { memoryPageEn, memoryPageJa, memoryPageZh } from '../../../src/i18n/memory-ui/page';
import {
  MemoryCompareDialog,
  MemoryDetailDialog,
  MemoryEditorDialog,
  MemoryEngineDialog,
  MemoryInboxDialog,
  MemoryRecallDialog,
} from '../../../src/fantay/memory/dialogs';
import { Toaster, __resetToastsForTests } from '../../../src/fantay/ui';
import { NOW, RECALL, createMemoryService, makeItem, type MemoryService } from './memory-fake-service';

function wrap(service: MemoryService, ui: ReactNode, locale: 'zh-CN' | 'en' | 'ja' = 'zh-CN') {
  service.install();
  return render(
    <I18nProvider initial={locale}>
      {ui}
      <Toaster />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetToastsForTests();
});

describe('待处理 (inbox)', () => {
  it('accepts and rejects proposals, and folds the answered row away', async () => {
    const service = createMemoryService();
    const onChanged = vi.fn();
    wrap(service, <MemoryInboxDialog open onOpenChange={() => {}} onChanged={onChanged} />);

    const dialog = await screen.findByTestId('memory-inbox-dialog');
    const proposal = await within(dialog).findByTestId('memory-inbox-pending-item:p9');
    expect(proposal.textContent).toContain('周五前把配色方案发给你');
    expect(proposal.textContent).toContain('记到「小月」');
    expect(proposal.textContent).toContain('在群组「协作工作室」里学到的');
    expect(within(dialog).getByTestId('memory-inbox-conflicts').textContent).toContain('有分歧的记忆');

    fireEvent.click(within(dialog).getByTestId('memory-inbox-accept-item:p9'));
    await waitFor(() => expect(service.callsTo('/pending/item%3Ap9/resolve', 'POST')).toHaveLength(1));
    expect(service.callsTo('/pending/item%3Ap9/resolve', 'POST')[0]!.body).toEqual({ accept: true, revision: 1 });
    expect(await screen.findByText('已记下')).toBeTruthy();
    await waitFor(() => expect(within(dialog).queryByTestId('memory-inbox-pending-item:p9')).toBeNull());
    expect(onChanged).toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId('memory-inbox-reject-pa:cand-2'));
    await waitFor(() => expect(service.callsTo('/pending/pa%3Acand-2/resolve', 'POST')).toHaveLength(1));
    expect(service.callsTo('/pending/pa%3Acand-2/resolve', 'POST')[0]!.body).toEqual({ accept: false, revision: 4 });
    expect(await screen.findByText('这条建议不会被用到。')).toBeTruthy();
    await waitFor(() => expect(within(dialog).queryByTestId('memory-inbox-pending-pa:cand-2')).toBeNull());
    expect(within(dialog).getByTestId('memory-inbox-pending').textContent).toContain('没有等你确认的内容。');
  });

  it('lets a proposal be corrected before it is accepted', async () => {
    const service = createMemoryService();
    wrap(service, <MemoryInboxDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('memory-inbox-edit-item:p9'));
    const edit = await screen.findByTestId('memory-pending-edit-dialog');
    const content = within(edit).getByTestId('memory-pending-edit-content') as HTMLTextAreaElement;
    expect(content.value).toBe('周五前把配色方案发给你');
    fireEvent.change(content, { target: { value: '周四前把配色方案发给你' } });
    fireEvent.click(within(edit).getByTestId('memory-pending-edit-submit'));
    await waitFor(() => expect(service.callsTo('/pending/item%3Ap9/resolve', 'POST')).toHaveLength(1));
    expect(service.callsTo('/pending/item%3Ap9/resolve', 'POST')[0]!.body).toEqual({
      accept: true,
      revision: 1,
      content: '周四前把配色方案发给你',
    });
    await waitFor(() => expect(screen.queryByTestId('memory-pending-edit-dialog')).toBeNull());
  });

  it('opens a disagreement in the compare dialog on top, and shows the empty state once all is handled', async () => {
    const service = createMemoryService();
    const onChanged = vi.fn();
    wrap(service, <MemoryInboxDialog open onOpenChange={() => {}} onChanged={onChanged} />);
    const card = await screen.findByTestId('memory-inbox-conflict-k1');
    expect(card.textContent).toContain('首页主色用青绿');
    expect(card.textContent).toContain('首页主色用蓝色');

    for (const entry of ['item:p9', 'pa:cand-2']) {
      fireEvent.click(await screen.findByTestId(`memory-inbox-reject-${entry}`));
      await waitFor(() => expect(screen.queryByTestId(`memory-inbox-pending-${entry}`)).toBeNull());
    }

    fireEvent.click(screen.getByTestId('memory-inbox-conflict-k1'));
    const compare = await screen.findByTestId('memory-compare-dialog');
    // Both layers are open: the inbox stays underneath.
    expect(screen.getByTestId('memory-inbox-dialog')).toBeTruthy();
    fireEvent.click(await within(compare).findByTestId('memory-compare-keep-both'));
    await waitFor(() => expect(service.callsTo('/conflicts/k1/resolve', 'POST')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('memory-compare-dialog')).toBeNull());
    const empty = await screen.findByTestId('memory-inbox-empty');
    expect(empty.textContent).toContain('都处理完了');
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('对比 (compare)', () => {
  it('shows why the two were paired, the hint without preselecting it, and the differing words', async () => {
    const service = createMemoryService();
    wrap(service, <MemoryCompareDialog open onOpenChange={() => {}} conflictId="k1" onResolved={() => {}} />);
    const dialog = await screen.findByTestId('memory-compare-dialog');
    expect((await within(dialog).findByTestId('memory-compare-reason')).textContent).toContain('两条都在说首页主色，但颜色不同。');
    expect(within(dialog).getByTestId('memory-compare-hint').textContent).toContain('建议：保留新的');
    expect(within(dialog).getByTestId('memory-compare-existing').textContent).toContain('已有的记忆');
    expect(within(dialog).getByTestId('memory-compare-incoming').textContent).toContain('新的记忆');
    const marks = (testId: string) =>
      [...within(dialog).getByTestId(testId).querySelectorAll('mark')].map((mark) => mark.textContent);
    expect(marks('memory-compare-existing')).toEqual(['青绿', '0FB5AE']);
    expect(marks('memory-compare-incoming')).toEqual(['蓝色', '2F67C4']);
    for (const id of ['keep-old', 'keep-new', 'merge', 'keep-both']) {
      const button = within(dialog).getByTestId(`memory-compare-${id}`);
      expect(button.getAttribute('aria-describedby')).toBeTruthy();
      expect(button.getAttribute('aria-pressed')).toBeNull();
    }
    expect(dialog.textContent).not.toMatch(/删除|冲突/);
  });

  const direct: Array<[string, MemoryConflictResolution, string, string, [string, string]]> = [
    ['keep-old', 'keep_old', '已保留原来那条', '新的那条标记为未采用，仍留在记录里。', ['active', 'rejected']],
    ['keep-new', 'keep_new', '已保留新的那条', '旧的那条标记为已被取代，仍可在详情里查看。', ['superseded', 'active']],
    ['keep-both', 'keep_both', '两条都保留了', '这一对以后不会再出现在待处理里。', ['active', 'active']],
  ];

  it.each(direct)('%s resolves at once and says what happened', async (testId, resolution, title, body, [existing, incoming]) => {
    const service = createMemoryService();
    const onResolved = vi.fn();
    const onOpenChange = vi.fn();
    wrap(service, <MemoryCompareDialog open onOpenChange={onOpenChange} conflictId="k1" onResolved={onResolved} />);
    fireEvent.click(await screen.findByTestId(`memory-compare-${testId}`));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(service.callsTo('/conflicts/k1/resolve', 'POST')[0]!.body).toEqual({ resolution });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
    expect([service.item('i2')!.status, service.item('i4')!.status]).toEqual([existing, incoming]);
  });

  it('merge drafts a text, keeps both originals in view, and saves the edited text', async () => {
    const service = createMemoryService();
    const onResolved = vi.fn();
    wrap(service, <MemoryCompareDialog open onOpenChange={() => {}} conflictId="k1" onResolved={onResolved} />);
    const dialog = await screen.findByTestId('memory-compare-dialog');
    fireEvent.click(await within(dialog).findByTestId('memory-compare-merge'));

    const field = (await within(dialog).findByTestId('memory-compare-merge-content')) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe('首页主色用蓝色 #2F67C4，青绿 #0FB5AE 留作强调色'));
    expect(service.callsTo('/conflicts/k1/merge-draft', 'POST')).toHaveLength(1);
    expect(service.callsTo('/conflicts/k1/merge-draft', 'POST')[0]!.body).toEqual({});
    expect(dialog.textContent).toContain('这是模型起草的，请检查后再保存。');
    expect(within(dialog).getByTestId('memory-compare-existing').textContent).toContain('首页主色用青绿');
    expect(within(dialog).getByTestId('memory-compare-incoming').textContent).toContain('首页主色用蓝色');

    // Going back and forth keeps the draft; it is asked for once.
    fireEvent.click(within(dialog).getByTestId('memory-compare-merge-back'));
    fireEvent.click(await within(dialog).findByTestId('memory-compare-merge'));
    const again = (await within(dialog).findByTestId('memory-compare-merge-content')) as HTMLTextAreaElement;
    expect(again.value).toBe('首页主色用蓝色 #2F67C4，青绿 #0FB5AE 留作强调色');
    expect(service.callsTo('/conflicts/k1/merge-draft', 'POST')).toHaveLength(1);

    fireEvent.change(again, { target: { value: '首页主色用蓝色 #2F67C4；青绿只用在按钮悬停' } });
    fireEvent.click(within(dialog).getByTestId('memory-compare-merge-save'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(service.callsTo('/conflicts/k1/resolve', 'POST')[0]!.body).toEqual({
      resolution: 'merge',
      mergedContent: '首页主色用蓝色 #2F67C4；青绿只用在按钮悬停',
    });
    expect(await screen.findByText('已合并成一条新记忆')).toBeTruthy();
    expect(screen.getByText('原来两条标记为已被取代，都还留在记录里。')).toBeTruthy();
    expect([service.item('i2')!.status, service.item('i4')!.status]).toEqual(['superseded', 'superseded']);
  });

  it('falls back to joining the two texts when no draft comes back', async () => {
    const service = createMemoryService();
    service.override((call) =>
      call.path === '/conflicts/k1/merge-draft' ? { status: 503, body: { code: 'MEMORY_LLM_UNAVAILABLE', message: 'no model' } } : undefined,
    );
    wrap(service, <MemoryCompareDialog open onOpenChange={() => {}} conflictId="k1" onResolved={() => {}} />);
    fireEvent.click(await screen.findByTestId('memory-compare-merge'));
    const field = (await screen.findByTestId('memory-compare-merge-content')) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe('首页主色用青绿 #0FB5AE\n首页主色用蓝色 #2F67C4'));
    expect(screen.getByTestId('memory-compare-merge-retry')).toBeTruthy();
  });
});

describe('试试回忆 (recall)', () => {
  it('asks as a bot and shows hits with plain reasons and the prompt block verbatim', async () => {
    const service = createMemoryService();
    wrap(service, <MemoryRecallDialog open onOpenChange={() => {}} overview={null} initialScope={{ kind: 'bot', id: 'fantay' }} />);
    const dialog = await screen.findByTestId('memory-recall-dialog');
    await waitFor(() => expect(within(dialog).getByTestId('memory-recall-as').textContent).toContain('Fantay'));
    fireEvent.change(within(dialog).getByTestId('memory-recall-query'), { target: { value: '我喜欢怎样的回复？' } });
    fireEvent.click(within(dialog).getByTestId('memory-recall-run'));

    const first = await within(dialog).findByTestId('memory-recall-hit-0');
    expect(service.callsTo('/recall', 'POST')[0]!.body).toEqual({
      query: '我喜欢怎样的回复？',
      context: { surface: 'pa', agentId: 'fantay' },
      includeChunks: true,
    });
    expect(within(dialog).getByTestId('memory-recall-summary').textContent).toContain('想起 2 条相关内容');
    expect(first.textContent).toContain('关键词相同');
    expect(first.textContent).toContain('置顶');
    expect(first.textContent).toContain('很相关');
    const second = within(dialog).getByTestId('memory-recall-hit-1');
    expect(second.textContent).toContain('来自对话《配色讨论》');
    expect(second.textContent).toContain('意思相近');
    expect(second.textContent).toContain('有分歧');
    expect(within(dialog).getByTestId('memory-recall-standing').textContent).toContain('称呼我为老板');

    const disclosure = within(dialog).getByRole('button', { name: /交给模型的内容/ });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(within(dialog).getByTestId('memory-recall-prompt').textContent).toBe(RECALL.promptBlock);
    // No scores, ranks or ids in the result.
    expect(dialog.textContent).not.toMatch(/0\.72|fused|lexical|pa:conv9/);
  });

  it('searches chosen places directly', async () => {
    const service = createMemoryService();
    wrap(service, <MemoryRecallDialog open onOpenChange={() => {}} overview={null} initialScope={{ kind: 'bot', id: 'fantay' }} />);
    const dialog = await screen.findByTestId('memory-recall-dialog');
    await within(dialog).findByTestId('memory-recall-as');
    fireEvent.click(within(dialog).getByTestId('memory-recall-mode-scopes'));
    const group = (await within(dialog).findByTestId('memory-recall-scope-group:g1')) as HTMLInputElement;
    expect((within(dialog).getByTestId('memory-recall-scope-bot:fantay') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(group);
    expect(group.checked).toBe(true);
    fireEvent.change(within(dialog).getByTestId('memory-recall-query'), { target: { value: '群里定了什么' } });
    fireEvent.click(within(dialog).getByTestId('memory-recall-run'));
    await waitFor(() => expect(service.callsTo('/recall', 'POST')).toHaveLength(1));
    expect(service.callsTo('/recall', 'POST')[0]!.body).toEqual({
      query: '群里定了什么',
      scopes: [
        { kind: 'bot', id: 'fantay' },
        { kind: 'group', id: 'g1' },
      ],
      includeChunks: true,
    });
  });

  it('says plainly when nothing reaches the bar and nothing is handed over', async () => {
    const service = createMemoryService();
    service.override((call) =>
      call.path === '/recall' ? { status: 200, body: { ...RECALL, standing: [], hits: [], promptBlock: '', usedChars: 0 } } : undefined,
    );
    wrap(service, <MemoryRecallDialog open onOpenChange={() => {}} overview={null} initialScope={{ kind: 'bot', id: 'fantay' }} />);
    const dialog = await screen.findByTestId('memory-recall-dialog');
    await within(dialog).findByTestId('memory-recall-as');
    fireEvent.change(within(dialog).getByTestId('memory-recall-query'), { target: { value: '天气' } });
    fireEvent.click(within(dialog).getByTestId('memory-recall-run'));
    expect((await within(dialog).findByTestId('memory-recall-empty')).textContent).toContain('不会硬塞不相关的记忆');
    expect(within(dialog).getByTestId('memory-recall-prompt-empty')).toBeTruthy();
  });
});

describe('记忆引擎 (engine settings)', () => {
  it('shows the level in words and saves only what changed', async () => {
    const service = createMemoryService();
    const onChanged = vi.fn();
    wrap(service, <MemoryEngineDialog open onOpenChange={() => {}} onChanged={onChanged} />);
    expect((await screen.findByTestId('memory-engine-level')).textContent).toContain('关键词 + 语义');
    expect(screen.getByTestId('memory-engine-status').textContent).toContain('52 条');
    expect(screen.getByTestId('memory-engine-save').getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(screen.getByTestId('memory-engine-auto-mode-auto'));
    fireEvent.click(screen.getByTestId('memory-engine-save'));
    await waitFor(() => expect(service.callsTo('/engine', 'PUT')).toHaveLength(1));
    expect(service.callsTo('/engine', 'PUT')[0]!.body).toEqual({ autoMemory: 'auto' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('never shows a stored key, sends a new one only when typed, and can clear it', async () => {
    const service = createMemoryService();
    const { unmount } = wrap(service, <MemoryEngineDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    const key = (await screen.findByTestId('memory-engine-embedding-key')) as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(key.placeholder).toBe('已保存，留空则不修改');

    fireEvent.change(key, { target: { value: 'sk-test-123' } });
    fireEvent.click(screen.getByTestId('memory-engine-save'));
    await waitFor(() => expect(service.callsTo('/engine', 'PUT')).toHaveLength(1));
    expect(service.callsTo('/engine', 'PUT')[0]!.body).toEqual({ embedding: { apiKey: 'sk-test-123' } });
    // The service answers with `hasApiKey`, never the key.
    expect(JSON.stringify(service.engine())).not.toContain('sk-test-123');
    unmount();

    wrap(service, <MemoryEngineDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    const reopened = (await screen.findByTestId('memory-engine-embedding-key')) as HTMLInputElement;
    expect(reopened.value).toBe('');
    expect(document.body.textContent).not.toContain('sk-test-123');
    fireEvent.click(screen.getByRole('button', { name: '清除已保存的密钥' }));
    expect(reopened.placeholder).toBe('保存后会清除已保存的密钥');
    fireEvent.click(screen.getByTestId('memory-engine-save'));
    await waitFor(() => expect(service.callsTo('/engine', 'PUT')).toHaveLength(2));
    expect(service.callsTo('/engine', 'PUT')[1]!.body).toEqual({ embedding: { apiKey: '' } });
  });

  it('runs 重建索引 and 整理一遍 at once', async () => {
    const service = createMemoryService();
    wrap(service, <MemoryEngineDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('memory-engine-reindex'));
    expect(await screen.findByText('索引已重建')).toBeTruthy();
    expect(service.callsTo('/engine/reindex', 'POST')[0]!.body).toEqual({});
    fireEvent.click(screen.getByTestId('memory-engine-tidy'));
    expect(await screen.findByText('检查了 9 条，没有发现新的分歧。')).toBeTruthy();
  });

  it('offers 本机模型 first, downloads it with progress read again while it runs, and saves it as the choice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const service = createMemoryService();
      wrap(service, <MemoryEngineDialog open onOpenChange={() => {}} onChanged={() => {}} />);
      const choices = await screen.findByTestId('memory-engine-embedding-provider');
      expect(within(choices).getAllByRole('radio').map((item) => item.textContent)).toEqual(['本机模型', '关闭', 'Ollama', '自定义接口']);
      expect(within(screen.getByTestId('memory-engine-reranker-provider')).getAllByRole('radio')[0]!.textContent).toBe('本机模型');
      expect(screen.getByTestId('memory-engine-embedding').textContent).toContain('推荐用本机模型');

      fireEvent.click(screen.getByTestId('memory-engine-embedding-provider-local'));
      const id = 'qwen3-embedding-0.6b';
      const row = await screen.findByTestId(`memory-engine-model-${id}`);
      expect(row.textContent).toContain('Qwen3 Embedding 0.6B');
      expect(row.textContent).toContain('约 614 MB · Apache-2.0 许可');
      // Remote fields belong to the other choices.
      expect(screen.queryByTestId('memory-engine-embedding-url')).toBeNull();

      fireEvent.click(within(row).getByTestId(`memory-engine-model-download-${id}`));
      await waitFor(() => expect(service.callsTo(`/engine/models/${id}`, 'POST')).toHaveLength(1));
      expect(service.callsTo(`/engine/models/${id}`, 'POST')[0]!.body).toEqual({ action: 'download' });
      expect(await within(row).findByText('正在下载 25%')).toBeTruthy();
      expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
      expect(within(row).getByTestId(`memory-engine-model-cancel-${id}`)).toBeTruthy();

      const reads = service.callsTo('/engine', 'GET').length;
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(await within(row).findByText('正在下载 75%')).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(await within(row).findByText('已就绪')).toBeTruthy();
      expect(service.callsTo('/engine', 'GET').length).toBe(reads + 2);
      // Nothing downloads any more, so nothing is read again.
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(service.callsTo('/engine', 'GET').length).toBe(reads + 2);

      fireEvent.click(screen.getByTestId('memory-engine-save'));
      await waitFor(() => expect(service.callsTo('/engine', 'PUT')).toHaveLength(1));
      expect(service.callsTo('/engine', 'PUT')[0]!.body).toEqual({ embedding: { provider: 'local' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a download, and shows a model that is already there as ready', async () => {
    const service = createMemoryService();
    wrap(service, <MemoryEngineDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('memory-engine-embedding-provider-local'));
    const id = 'qwen3-embedding-0.6b';
    fireEvent.click(await screen.findByTestId(`memory-engine-model-download-${id}`));
    fireEvent.click(await screen.findByTestId(`memory-engine-model-cancel-${id}`));
    await waitFor(() => expect(service.callsTo(`/engine/models/${id}`, 'POST')).toHaveLength(2));
    expect(service.callsTo(`/engine/models/${id}`, 'POST')[1]!.body).toEqual({ action: 'cancel' });
    expect(await screen.findByTestId(`memory-engine-model-download-${id}`)).toBeTruthy();
    expect(service.localModel(id)!.state).toBe('absent');

    fireEvent.click(screen.getByTestId('memory-engine-reranker-provider-local'));
    const reranker = await screen.findByTestId('memory-engine-model-gte-multilingual-reranker');
    expect(reranker.textContent).toContain('已就绪');
    expect(reranker.textContent).toContain('约 1.2 GB');
    expect(within(reranker).queryByRole('button')).toBeNull();
  });

  it('hides 本机模型 when this build cannot run local models', async () => {
    const service = createMemoryService().withoutLocalRuntime();
    wrap(service, <MemoryEngineDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    const choices = await screen.findByTestId('memory-engine-embedding-provider');
    expect(within(choices).getAllByRole('radio').map((item) => item.textContent)).toEqual(['关闭', 'Ollama', '自定义接口']);
    expect(screen.queryByTestId('memory-engine-reranker-provider-local')).toBeNull();
    expect(screen.getByTestId('memory-engine-embedding').textContent).not.toContain('本机模型');
  });
});

describe('记忆详情 and 编辑 (detail and editor)', () => {
  it('shows provenance, every version with its change marked, related memories and the activity', async () => {
    const service = createMemoryService();
    const onOpenConflict = vi.fn();
    service.override((call) =>
      call.path === '/items/i1/history'
        ? {
            status: 200,
            body: {
              item: makeItem('i1', '回复用中文，结论先行', { kind: 'preference', versionCount: 2, revision: 3, openConflictIds: ['k1'] }),
              versions: [
                { version: 1, title: '', content: '回复用英文，结论先行', actor: 'owner', note: '', createdAt: NOW - 5 * 86_400_000 },
                { version: 2, title: '', content: '回复用中文，结论先行', actor: 'owner', note: '', createdAt: NOW - 3_600_000 },
              ],
              events: [
                { seq: 1, itemId: 'i1', conflictId: null, type: 'created', actor: 'owner', at: NOW - 5 * 86_400_000, data: {} },
                { seq: 2, itemId: 'i1', conflictId: 'k1', type: 'conflict_opened', actor: 'system', at: NOW - 1_000_000, data: {} },
              ],
              links: [{ fromId: 'i1', toId: 'pf1', relation: 'derived_from', createdAt: NOW }],
              related: [service.item('pf1')],
              conflicts: [service.conflict('k1')],
            },
          }
        : undefined,
    );
    wrap(service, <MemoryDetailDialog open onOpenChange={() => {}} itemId="i1" onEdit={() => {}} onChanged={() => {}} onOpenConflict={onOpenConflict} />);
    const dialog = await screen.findByTestId('memory-detail-dialog');
    expect((await within(dialog).findByTestId('memory-detail-text')).textContent).toBe('回复用中文，结论先行');
    expect(within(dialog).getByTestId('memory-detail-provenance').textContent).toContain('你亲自写下的 · 手动添加');
    const versions = within(dialog).getByTestId('memory-detail-versions');
    expect(versions.querySelector('del')?.textContent).toBe('英');
    expect(versions.querySelector('ins')?.textContent).toBe('中');
    expect(within(dialog).getByTestId('memory-detail-activity').textContent).toContain('发现和另一条记忆有分歧');
    expect(within(dialog).getByTestId('memory-detail-related').textContent).toContain('复制自');

    fireEvent.click(within(dialog).getByTestId('memory-detail-open-conflict'));
    expect(onOpenConflict).toHaveBeenCalledWith('k1');
    fireEvent.click(within(dialog).getByTestId('memory-detail-related-pf1'));
    expect(await within(dialog).findByTestId('memory-detail-back')).toBeTruthy();
    expect(service.callsTo('/items/pf1/history', 'GET')).toHaveLength(1);
    expect(dialog.textContent).not.toMatch(/删除|pf1|i1/);
  });

  it('offers 清除内容 only for an archived memory, behind a confirm that says it cannot be undone', async () => {
    const service = createMemoryService();
    const { unmount } = wrap(
      service,
      <MemoryDetailDialog open onOpenChange={() => {}} itemId="i3" onEdit={() => {}} onChanged={() => {}} onOpenConflict={() => {}} />,
    );
    await screen.findByTestId('memory-detail-text');
    expect(screen.getByTestId('memory-detail-archive')).toBeTruthy();
    expect(screen.queryByTestId('memory-detail-redact')).toBeNull();
    unmount();

    const onChanged = vi.fn();
    wrap(service, <MemoryDetailDialog open onOpenChange={() => {}} itemId="a1" onEdit={() => {}} onChanged={onChanged} onOpenConflict={() => {}} />);
    expect((await screen.findByTestId('memory-detail-text')).textContent).toBe('回复用英文');
    fireEvent.click(screen.getByTestId('memory-detail-redact'));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('清除这条记忆的文字？')).toBeTruthy();
    expect(confirm.textContent).toContain('无法撤销');
    expect(service.callsTo('/items/a1/action', 'POST')).toHaveLength(0);

    fireEvent.click(within(confirm).getByRole('button', { name: '清除内容' }));
    await waitFor(() => expect(service.callsTo('/items/a1/action', 'POST')).toHaveLength(1));
    expect(service.callsTo('/items/a1/action', 'POST')[0]!.body).toEqual({ action: 'redact', confirm: true, revision: 1 });
    expect(await screen.findByText('已清除内容')).toBeTruthy();
    expect(screen.getByText('记录和动态仍然保留。')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('memory-detail-text').textContent).toBe('这条的文字已被清除，记录和历史仍然保留。'),
    );
    expect(screen.queryByTestId('memory-detail-redact')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onChanged).toHaveBeenCalled();
    expect(service.item('a1')!.redacted).toBe(true);
  });

  it('creates a 约定 with a due date in a place picked from the grouped list', async () => {
    const service = createMemoryService();
    const onSaved = vi.fn();
    wrap(service, <MemoryEditorDialog open onOpenChange={() => {}} overview={null} mode={{ kind: 'create' }} onSaved={onSaved} />);
    const dialog = await screen.findByTestId('memory-editor-dialog');
    const scope = await within(dialog).findByTestId('memory-editor-scope');
    await waitFor(() => expect(scope.getAttribute('data-disabled')).toBeNull());
    fireEvent.keyDown(scope, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: /学习 Agent 落地页方向/ }));
    expect(within(dialog).getByText('这个项目下的每个对话都能读到，和这个项目关联的角色聊天也能读到。')).toBeTruthy();

    fireEvent.keyDown(within(dialog).getByTestId('memory-editor-kind'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: '约定' }));
    fireEvent.change(within(dialog).getByTestId('memory-editor-content'), { target: { value: '周五前交首页初稿' } });
    fireEvent.change(within(dialog).getByTestId('memory-editor-due'), { target: { value: '2026-11-20' } });
    fireEvent.click(within(dialog).getByTestId('memory-editor-submit'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(service.callsTo('/items', 'POST')[0]!.body).toEqual({
      scope: { kind: 'project', id: 'proj1' },
      content: '周五前交首页初稿',
      kind: 'promise',
      dueAt: new Date(2026, 10, 20).getTime(),
    });
  });
});

describe('copy', () => {
  it('renders the compare dialog in English and Japanese', async () => {
    const service = createMemoryService();
    const { unmount } = wrap(service, <MemoryCompareDialog open onOpenChange={() => {}} conflictId="k1" onResolved={() => {}} />, 'en');
    expect((await screen.findByTestId('memory-compare-keep-new')).textContent).toBe('Keep new');
    expect(screen.getByTestId('memory-compare-hint').textContent).toContain('Suggestion: keep the new one');
    unmount();
    wrap(service, <MemoryCompareDialog open onOpenChange={() => {}} conflictId="k1" onResolved={() => {}} />, 'ja');
    expect((await screen.findByTestId('memory-compare-keep-new')).textContent).toBe('新しいほうを残す');
  });

  it('keeps one key set in all three languages and none of the banned words', () => {
    for (const [zh, en, ja] of [
      [memoryPageZh, memoryPageEn, memoryPageJa],
      [memoryDialogZh, memoryDialogEn, memoryDialogJa],
    ] as const) {
      const keys = Object.keys(zh).sort();
      expect(Object.keys(en).sort()).toEqual(keys);
      expect(Object.keys(ja).sort()).toEqual(keys);
      const values = [...Object.values(zh), ...Object.values(en), ...Object.values(ja)].join('\n');
      // A memory is archived, never deleted; two memories disagree (有分歧), never "conflict".
      expect(values).not.toMatch(/删除|削除|冲突|\bdelet/i);
      expect(values).not.toMatch(/profileMount|owner_profile|persona_only|Raw Chunk|Reindex|Shadow|BM25|\btier\b/);
    }
  });
});
