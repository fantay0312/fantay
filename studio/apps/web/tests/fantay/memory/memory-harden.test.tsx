// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The Memory Center after the third hardening review, against the fake `/api/memory-center`: a pair with a side
// already put away (its state shown, the choice that would keep it disabled, a 409 handled), memories in use
// that recall skips (paused, kept, not yet started) and resuming one, the editor's reload keeping only what the
// person changed, errors shown where the person acted, Personal Agent proposals offering only what the service
// accepts, the enterprise access token, plain-word engine failures, English plurals and paging by kind.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryConflict, MemoryItem } from '@open-design/contracts';

import { I18nProvider } from '../../../src/i18n';
import { memoryPageEn, memoryPageZh } from '../../../src/i18n/memory-ui/page';
import { memoryApi } from '../../../src/fantay/memory/api';
import { MemoryCompareDialog, MemoryDetailDialog, MemoryEditorDialog, MemoryInboxDialog } from '../../../src/fantay/memory/dialogs';
import { failureSentence } from '../../../src/fantay/memory/dialogs/MemoryEngineDialog';
import { translateMemoryDialog } from '../../../src/fantay/memory/dialogs/i18n';
import { createMemoryT } from '../../../src/fantay/memory/i18n';
import { errorMessage } from '../../../src/fantay/memory/labels';
import { resetMemoryPendingCountForTests } from '../../../src/fantay/memory/memory-badge-store';
import { MemoryCenterView } from '../../../src/fantay/memory/MemoryCenterView';
import { PA_ACCESS_REQUIRED, setPaAccessToken } from '../../../src/fantay/pa/pa-api';
import { Toaster, __resetToastsForTests } from '../../../src/fantay/ui';
import { NOW, createMemoryService, failWith, makeItem, type MemoryService } from './memory-fake-service';

const DAY = 86_400_000;

function wrap(service: MemoryService, ui: ReactNode, locale: 'zh-CN' | 'en' = 'zh-CN') {
  service.install();
  return render(
    <I18nProvider initial={locale}>
      {ui}
      <Toaster />
    </I18nProvider>,
  );
}

function renderPage(service: MemoryService, scope: string) {
  window.localStorage.setItem('fantay.memory.scope.v1', scope);
  return wrap(service, <MemoryCenterView active projects={[]} />);
}

/** The pair k1 with one side changed. */
function pairWith(service: MemoryService, patch: { existing?: Partial<MemoryItem>; incoming?: Partial<MemoryItem>; suggestion?: MemoryConflict['suggestion'] }): MemoryConflict {
  const base = service.conflict('k1')!;
  return {
    ...base,
    existing: { ...base.existing, ...patch.existing },
    incoming: { ...base.incoming, ...patch.incoming },
    ...(patch.suggestion !== undefined ? { suggestion: patch.suggestion } : {}),
  };
}

async function choose(trigger: HTMLElement, option: string | RegExp) {
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetToastsForTests();
  resetMemoryPendingCountForTests();
  window.localStorage.clear();
  setPaAccessToken('');
});

describe('a pair with a side already put away', () => {
  it('shows the state, disables the choice that would keep it, and says the other choices leave it as it is', async () => {
    const service = createMemoryService();
    const conflict = pairWith(service, { existing: { status: 'archived' }, suggestion: 'keep_old' });
    service.override((call) => (call.method === 'GET' && call.path === '/conflicts/k1' ? { status: 200, body: { conflict } } : undefined));
    const onResolved = vi.fn();
    wrap(service, <MemoryCompareDialog open onOpenChange={() => {}} conflictId="k1" onResolved={onResolved} />);
    const dialog = await screen.findByTestId('memory-compare-dialog');

    expect((await within(dialog).findByTestId('memory-compare-existing-state')).textContent).toBe('已归档');
    expect(within(dialog).queryByTestId('memory-compare-incoming-state')).toBeNull();
    const keepOld = within(dialog).getByTestId('memory-compare-keep-old');
    expect(keepOld.getAttribute('aria-disabled')).toBe('true');
    expect(within(dialog).getByTestId('memory-compare-keep-old-help').textContent).toBe('这条已归档，先恢复才能保留它。');
    expect(within(dialog).getByTestId('memory-compare-keep-new-help').textContent).toBe('新的那条继续使用。旧的那条已归档，会保持原样。');
    expect(within(dialog).getByTestId('memory-compare-merge-help').textContent).toBe(
      '写一条包含两边内容的新记忆，在用的那条标记为已被取代。旧的那条已归档，会保持原样。',
    );
    expect(within(dialog).getByTestId('memory-compare-keep-both-help').textContent).toBe(
      '在用的那条继续使用，以后不会再问这一对。旧的那条已归档，会保持原样。',
    );
    // The hint pointed at the choice that is no longer possible, so it is left out.
    expect(within(dialog).queryByTestId('memory-compare-hint')).toBeNull();

    fireEvent.click(keepOld);
    expect(service.callsTo('/conflicts/k1/resolve', 'POST')).toHaveLength(0);
    fireEvent.click(within(dialog).getByTestId('memory-compare-keep-both'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(service.callsTo('/conflicts/k1/resolve', 'POST')[0]!.body).toEqual({ resolution: 'keep_both' });
  });

  it('handles the 409 when the kept side was put away meanwhile: says so, reloads, and disables that choice', async () => {
    const service = createMemoryService();
    const later = pairWith(service, { incoming: { status: 'archived' } });
    let reads = 0;
    service.override((call) => {
      if (call.method === 'GET' && call.path === '/conflicts/k1') {
        reads += 1;
        return reads === 1 ? undefined : { status: 200, body: { conflict: later } };
      }
      if (call.path === '/conflicts/k1/resolve') {
        return failWith(409, 'MEMORY_SIDE_PUT_AWAY', 'The new memory is archived, so it cannot be the one kept. Restore it first, or choose another option.');
      }
      return undefined;
    });
    const onResolved = vi.fn();
    wrap(service, <MemoryCompareDialog open onOpenChange={() => {}} conflictId="k1" onResolved={onResolved} />);
    fireEvent.click(await screen.findByTestId('memory-compare-keep-new'));

    expect((await screen.findByTestId('memory-compare-put-away')).textContent).toBe(
      '其中一条已经不在用了，不能作为保留的一条。已按现在的状态重新载入，请再选一次。',
    );
    await waitFor(() => expect(screen.getByTestId('memory-compare-keep-new').getAttribute('aria-disabled')).toBe('true'));
    expect(screen.getByTestId('memory-compare-incoming-state').textContent).toBe('已归档');
    expect(screen.getByTestId('memory-compare-keep-old-help').textContent).toBe('旧的那条继续使用。新的那条已归档，会保持原样。');
    expect(onResolved).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('The new memory is');
  });

  it('shows the state of a put-away side in the inbox row', async () => {
    const service = createMemoryService();
    const conflict = pairWith(service, { existing: { status: 'superseded' } });
    service.override((call) => (call.path === '/inbox' ? { status: 200, body: { conflicts: [conflict], pending: [] } } : undefined));
    wrap(service, <MemoryInboxDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    const card = await screen.findByTestId('memory-inbox-conflict-k1');
    expect(card.textContent).toContain('已被取代');
    expect(card.textContent).toContain('首页主色用青绿');
  });
});

describe('memories in use that recall skips', () => {
  it('tags paused, kept and not-yet-started rows', async () => {
    const service = createMemoryService();
    const now = Date.now();
    Object.assign(service.item('i3')!, { validUntil: now - 60_000 });
    Object.assign(service.item('i1')!, { validFrom: now + 3 * DAY });
    Object.assign(service.item('i4')!, { kind: 'promise', dueAt: now + DAY, validUntil: now - 60_000 });
    renderPage(service, 'bot:fantay');

    const paused = await screen.findByTestId('memory-row-hold-i3');
    expect(paused.textContent).toBe('暂停回忆');
    expect(screen.getByTestId('memory-row-i3').getAttribute('data-hold')).toBe('paused');
    expect(screen.getByTestId('memory-row-hold-i1').textContent).toMatch(/起生效$/);
    expect(screen.getByTestId('memory-row-hold-i4').textContent).toBe('已兑现');
    // A kept promise no longer reads as due.
    expect(screen.getByTestId('memory-row-i4').textContent).not.toContain('到期');
    expect(screen.queryByTestId('memory-row-hold-i2')).toBeNull();
  });

  it('says why a memory is paused and lets the owner recall it again', async () => {
    const service = createMemoryService();
    const pausedAt = Date.now() - 60_000;
    const note = '它依据的记忆已修改、取代或归档，暂不再被回忆';
    service.override((call) =>
      call.path === '/items/i3/history'
        ? {
            status: 200,
            body: {
              item: makeItem('i3', '提交前先跑一遍测试', { kind: 'rule', validUntil: pausedAt }),
              versions: [{ version: 1, title: '', content: '提交前先跑一遍测试', actor: 'owner', note: '', createdAt: NOW - 4 * DAY }],
              events: [
                { seq: 1, itemId: 'i3', conflictId: null, type: 'created', actor: 'owner', at: NOW - 4 * DAY, data: {} },
                {
                  seq: 2,
                  itemId: 'i3',
                  conflictId: null,
                  type: 'meta_changed',
                  actor: 'system',
                  at: pausedAt,
                  data: { changes: { validUntil: { from: null, to: pausedAt } }, note },
                },
              ],
              links: [],
              related: [],
              conflicts: [],
            },
          }
        : undefined,
    );
    const onChanged = vi.fn();
    wrap(service, <MemoryDetailDialog open onOpenChange={() => {}} itemId="i3" onEdit={() => {}} onChanged={onChanged} onOpenConflict={() => {}} />);
    const hold = await screen.findByTestId('memory-detail-hold');
    expect(hold.textContent).toContain(`暂停回忆 · ${note}`);
    fireEvent.click(within(hold).getByTestId('memory-detail-resume'));
    await waitFor(() => expect(service.callsTo('/items/i3', 'PATCH')).toHaveLength(1));
    expect(service.callsTo('/items/i3', 'PATCH')[0]!.body).toEqual({ validUntil: null, revision: 1 });
    expect(await screen.findByText('已恢复回忆')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it('calls a promise past its window kept, offers to undo that, and says when a future one starts', async () => {
    const service = createMemoryService();
    const kept = makeItem('k9', '周五前交初稿', { kind: 'promise', validUntil: Date.now() - 60_000 });
    const later = makeItem('f9', '下个月起周会改到周二', { validFrom: Date.now() + 10 * DAY });
    service.override((call) => {
      const item = call.path === '/items/k9/history' ? kept : call.path === '/items/f9/history' ? later : null;
      if (!item) return undefined;
      return { status: 200, body: { item, versions: [], events: [], links: [], related: [], conflicts: [] } };
    });
    const { unmount } = wrap(
      service,
      <MemoryDetailDialog open onOpenChange={() => {}} itemId="k9" onEdit={() => {}} onChanged={() => {}} onOpenConflict={() => {}} />,
    );
    const hold = await screen.findByTestId('memory-detail-hold');
    expect(hold.textContent).toContain('这个约定已兑现，不会再被想起。');
    expect(within(hold).getByTestId('memory-detail-resume').textContent).toBe('改回未兑现');
    unmount();

    wrap(service, <MemoryDetailDialog open onOpenChange={() => {}} itemId="f9" onEdit={() => {}} onChanged={() => {}} onOpenConflict={() => {}} />);
    const future = await screen.findByTestId('memory-detail-hold');
    expect(future.textContent).toMatch(/^从 .+ 起才会被想起。$/);
    expect(within(future).queryByRole('button')).toBeNull();
  });
});

describe('the editor after a 409', () => {
  it('moves untouched fields to the latest values and sends only what the person changed', async () => {
    const service = createMemoryService();
    const onSaved = vi.fn();
    wrap(
      service,
      <MemoryEditorDialog open onOpenChange={() => {}} overview={null} mode={{ kind: 'edit', item: { ...service.item('i1')! } }} onSaved={onSaved} />,
    );
    const dialog = await screen.findByTestId('memory-editor-dialog');
    await choose(within(dialog).getByTestId('memory-editor-kind'), '规则');
    // Meanwhile the text was changed elsewhere.
    Object.assign(service.item('i1')!, { content: '回复用中文，先给结论再给理由', revision: 2 });
    fireEvent.click(within(dialog).getByTestId('memory-editor-submit'));
    fireEvent.click(await within(dialog).findByTestId('memory-editor-reload'));

    await waitFor(() =>
      expect((within(dialog).getByTestId('memory-editor-content') as HTMLTextAreaElement).value).toBe('回复用中文，先给结论再给理由'),
    );
    expect(within(dialog).getByTestId('memory-editor-kind').textContent).toContain('规则');
    expect(within(dialog).getByTestId('memory-editor-reloaded').textContent).not.toContain('在别处也改过了');
    fireEvent.click(within(dialog).getByTestId('memory-editor-submit'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const patches = service.callsTo('/items/i1', 'PATCH').map((call) => call.body);
    expect(patches).toEqual([
      { revision: 1, kind: 'rule' },
      { revision: 2, kind: 'rule' },
    ]);
    expect(service.item('i1')!.content).toBe('回复用中文，先给结论再给理由');
  });

  it('keeps a changed field through the reload and says when it was changed elsewhere too', async () => {
    const service = createMemoryService();
    const onSaved = vi.fn();
    wrap(
      service,
      <MemoryEditorDialog open onOpenChange={() => {}} overview={null} mode={{ kind: 'edit', item: { ...service.item('i1')! } }} onSaved={onSaved} />,
    );
    const dialog = await screen.findByTestId('memory-editor-dialog');
    fireEvent.change(within(dialog).getByTestId('memory-editor-content'), { target: { value: '回复用中文' } });
    Object.assign(service.item('i1')!, { content: '回复用英文', kind: 'rule', revision: 2 });
    fireEvent.click(within(dialog).getByTestId('memory-editor-submit'));
    fireEvent.click(await within(dialog).findByTestId('memory-editor-reload'));

    const reloaded = await within(dialog).findByTestId('memory-editor-reloaded');
    expect(reloaded.textContent).toContain('内容在别处也改过了，保存会用你填的这一版。');
    expect((within(dialog).getByTestId('memory-editor-content') as HTMLTextAreaElement).value).toBe('回复用中文');
    expect(within(dialog).getByTestId('memory-editor-kind').textContent).toContain('规则');
    fireEvent.click(within(dialog).getByTestId('memory-editor-submit'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(service.callsTo('/items/i1', 'PATCH').at(-1)!.body).toEqual({ revision: 2, content: '回复用中文' });
    expect(service.item('i1')!.kind).toBe('rule');
  });
});

describe('the inbox', () => {
  it('shows a failure from 改一下 inside that dialog, and offers a character proposal only what the service accepts', async () => {
    const service = createMemoryService();
    service.override((call) =>
      call.path === '/pending/pa%3Acand-2/resolve' ? failWith(400, 'MEMORY_SECRET_BLOCKED', 'Looks like a secret.') : undefined,
    );
    wrap(service, <MemoryInboxDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('memory-inbox-edit-pa:cand-2'));
    const edit = await screen.findByTestId('memory-pending-edit-dialog');
    expect(edit.textContent).toContain('角色提出的建议只能记到个人画像、角色、群组或项目里。');

    const scope = await within(edit).findByTestId('memory-pending-edit-scope');
    fireEvent.keyDown(scope, { key: 'Enter' });
    const places = (await screen.findAllByRole('option')).map((option) => option.textContent ?? '');
    expect(places.some((place) => place.includes('Fantay'))).toBe(true);
    expect(places.some((place) => place.includes('协作工作室'))).toBe(true);
    expect(places.some((place) => place.includes('学习 Agent 落地页方向'))).toBe(true);
    expect(places.some((place) => place.includes('旅行者'))).toBe(false);
    expect(places.some((place) => place.includes('配色讨论'))).toBe(false);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    fireEvent.keyDown(within(edit).getByTestId('memory-pending-edit-kind'), { key: 'Enter' });
    const kinds = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(kinds).toEqual(['事实', '偏好', '约定', '方法', '经历', '关于我']);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    fireEvent.click(within(edit).getByTestId('memory-pending-edit-submit'));
    expect((await within(edit).findByTestId('memory-pending-edit-error')).textContent).toContain('这段内容看起来含有密码或密钥');
    expect(screen.getByTestId('memory-pending-edit-dialog')).toBeTruthy();
  });

  it('retries 改一下 after a 409 with the newer revision and the text it showed', async () => {
    const service = createMemoryService();
    let resolves = 0;
    service.override((call) => {
      // After the first answer the proposal was reworded elsewhere (revision 2).
      if (call.path === '/inbox' && resolves > 0) {
        return {
          status: 200,
          body: {
            conflicts: [],
            pending: [
              {
                id: 'item:p9',
                source: 'item',
                scope: { kind: 'bot', id: 'moon' },
                scopeLabel: '小月',
                kind: 'promise',
                content: '周五前把配色方案和字体发给你',
                sourceLabel: '群聊 · 协作工作室',
                via: null,
                revision: 2,
                createdAt: NOW,
              },
            ],
          },
        };
      }
      if (call.path === '/pending/item%3Ap9/resolve') {
        resolves += 1;
        if (resolves === 1) return failWith(409, 'MEMORY_REVISION_CONFLICT', 'changed elsewhere');
      }
      return undefined;
    });
    wrap(service, <MemoryInboxDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('memory-inbox-edit-item:p9'));
    const edit = await screen.findByTestId('memory-pending-edit-dialog');
    fireEvent.click(within(edit).getByTestId('memory-pending-edit-submit'));
    expect((await within(edit).findByTestId('memory-pending-edit-error')).textContent).toContain('这条记忆刚在别处有了变化');
    await waitFor(() => expect(service.callsTo('/inbox', 'GET').length).toBeGreaterThan(1));

    fireEvent.click(within(edit).getByTestId('memory-pending-edit-submit'));
    await waitFor(() => expect(service.callsTo('/pending/item%3Ap9/resolve', 'POST')).toHaveLength(2));
    expect(service.callsTo('/pending/item%3Ap9/resolve', 'POST')[1]!.body).toEqual({
      accept: true,
      revision: 2,
      content: '周五前把配色方案发给你',
    });
  });

  it('says in a toast when a row action fails', async () => {
    const service = createMemoryService();
    service.override((call) => (call.path === '/pending/item%3Ap9/resolve' ? failWith(403, 'MEMORY_FORBIDDEN', 'no') : undefined));
    wrap(service, <MemoryInboxDialog open onOpenChange={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('memory-inbox-accept-item:p9'));
    expect(await screen.findByText('只有你本人可以做这件事。')).toBeTruthy();
    expect(screen.getByTestId('memory-inbox-pending-item:p9')).toBeTruthy();
  });
});

describe('enterprise access', () => {
  it('sends the member token and asks for it again on PA_ENTERPRISE_AUTH', async () => {
    setPaAccessToken('tok-1');
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { code: 'PA_ENTERPRISE_AUTH', message: '需要企业访问令牌' } }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const asked = vi.fn();
    window.addEventListener(PA_ACCESS_REQUIRED, asked);
    try {
      const failure = await memoryApi.updateItem('i1', { pinned: true }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PA_ENTERPRISE_AUTH', status: 401 });
      const init = fetchMock.mock.calls[0]![1]!;
      expect(init.headers).toEqual({ Authorization: 'Bearer tok-1', 'content-type': 'application/json' });
      expect(asked).toHaveBeenCalledTimes(1);
      expect(errorMessage(createMemoryT('zh-CN'), failure)).toBe('需要企业访问令牌才能查看记忆。');
    } finally {
      window.removeEventListener(PA_ACCESS_REQUIRED, asked);
    }
  });
});

describe('copy', () => {
  it('limits the Settings switch sentence to project chats', () => {
    expect(memoryPageZh['memory.page.disabled']).toContain('项目里的对话');
    expect(memoryPageZh['memory.page.disabled']).toContain('「自动记忆」');
    expect(memoryPageEn['memory.page.disabled']).not.toMatch(/^Memory is turned off/);
  });

  it('picks the English word for the count', () => {
    const en = createMemoryT('en');
    expect(en('memory.page.inventoryItems', { count: 1 })).toBe('1 memory');
    expect(en('memory.page.inventoryItems', { count: 3 })).toBe('3 memories');
    expect(en('memory.notice.conflicts', { count: 1 })).toBe('1 disagreement');
    expect(translateMemoryDialog('en', 'recall.summary', { n: 1 })).toBe('Recalled 1 relevant item');
    expect(translateMemoryDialog('zh', 'recall.summary', { n: 1 })).toBe('想起 1 条相关内容');
  });

  it('puts engine failures in plain words', () => {
    const t = (key: Parameters<typeof translateMemoryDialog>[1], vars?: Record<string, string | number>) => translateMemoryDialog('zh', key, vars);
    expect(failureSentence('Embedding failed with HTTP 401: invalid key', t)).toBe('服务拒绝了请求，请检查密钥或权限。');
    expect(failureSentence('Downloading model.onnx failed with HTTP 404.', t)).toBe('服务返回了错误（404）。');
    expect(failureSentence('Qwen3 Embedding 0.6B: onnx/model.onnx did not match its checksum.', t)).toBe('下载的文件不完整，请重新下载。');
    expect(failureSentence('fetch failed', t)).toBe('连不上这个服务，请检查地址和网络。');
    expect(failureSentence('Reranker returned an unexpected response.', t)).toBe('服务的回应看不懂，可能是地址或模型名不对。');
  });
});

describe('a kind family pages as one list', () => {
  it('adds the next page at the bottom, in the same order as one list', async () => {
    const service = createMemoryService();
    const prefs = Array.from({ length: 60 }, (_, index) => makeItem(`p${index}`, `偏好 ${index}`, { kind: 'preference', updatedAt: NOW - index * 1000 }));
    const rules = Array.from({ length: 10 }, (_, index) => makeItem(`r${index}`, `规则 ${index}`, { kind: 'rule', updatedAt: NOW - 55_500 - index * 1000 }));
    service.override((call) => {
      const kind = call.query.get('kind');
      if (call.method !== 'GET' || call.path !== '/items' || call.query.get('scopeId') !== 'fantay' || !kind) return undefined;
      const list = kind === 'preference' ? prefs : kind === 'rule' ? rules : [];
      const offset = Number(call.query.get('offset') ?? 0);
      const limit = Number(call.query.get('limit') ?? 50);
      return { status: 200, body: { items: list.slice(offset, offset + limit), total: list.length } };
    });
    renderPage(service, 'bot:fantay');
    await screen.findByTestId('memory-row-i1');
    fireEvent.click(screen.getByTestId('memory-kind-preference'));
    await screen.findByTestId('memory-row-p0');

    const shown = () => screen.getAllByTestId(/^memory-row-[pr]\d+$/).map((row) => row.getAttribute('data-testid')!.slice('memory-row-'.length));
    // The rules are older than the 50th preference, so they wait for the next page.
    const first = shown();
    expect(first).toEqual(prefs.slice(0, 50).map((item) => item.id));

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-load-more'));
    });
    await waitFor(() => expect(shown()).toHaveLength(70));
    const all = [...prefs, ...rules].sort((a, b) => b.updatedAt - a.updatedAt).map((item) => item.id);
    expect(shown()).toEqual(all);
    expect(shown().slice(0, 50)).toEqual(first);
  });
});
