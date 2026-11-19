// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { TokenToSeaServices } from '../../src/components/tokentosea/TokenToSeaServices';
import { I18nProvider } from '../../src/i18n';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('TokenToSea services', () => {
  it('uses the same purpose icon in the tool list and selected detail', async () => {
    const tool = { id: 'tool_6bce09133ba9995a9d7e9b08abcda670', name: '智能处理 6BCE', category: 'ai', description: '车辆年款与评级查询' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/models?')) return Response.json({ data: [] });
      if (/\/tools(?:\?|$)/.test(url)) return Response.json({ items: [tool], total: 1 });
      if (url.endsWith('/actions')) return Response.json([]);
      throw new Error(`Unexpected request ${url}`);
    }));
    const { container } = render(<I18nProvider initial="zh-CN"><TokenToSeaServices active variant="embedded" accountSignedIn /></I18nProvider>);
    fireEvent.click(await screen.findByRole('radio', { name: /工具/ }));
    const row = await screen.findByRole('button', { name: /智能处理 6BCE/ });
    expect(row.querySelector('[data-tool-icon="Car"]')).not.toBeNull();
    fireEvent.click(row);
    expect(await screen.findByRole('heading', { name: tool.name })).toBeTruthy();
    expect(container.querySelectorAll('[data-tool-icon="Car"]')).toHaveLength(2);
    expect(container.querySelector('[data-tool-icon="Cpu"]')).toBeNull();
  });

  it('shows only video models and imports a completed video through the movie callback', async () => {
    const assetId = `asset_${'a'.repeat(64)}`;
    const onVideoImport = vi.fn(async () => {});
    vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/status')) return Response.json({ signedIn: true });
      if (url.includes('/models?')) return Response.json({ data: [
        { id: 'video', model: 'test-video', displayName: 'Video model', provider: 'test', modality: 'video', executionKind: 'official', priceVersion: 'v1', examples: [{ path: '/v1/videos', mode: 'json', body: { prompt: 'sample' } }] },
        { id: 'chat', model: 'test-chat', displayName: 'Chat model', provider: 'test', modality: 'chat' },
      ] });
      if (url.endsWith('/wallet')) return Response.json({ availableUsd: '1.00' });
      if (url.endsWith('/prepare')) return Response.json({ id: 'run-video', status: 'prepared' });
      if (url.endsWith('/invoke')) return Response.json({ id: 'run-video', status: 'succeeded', deliveryState: 'available', output: { assets: [{ asset_id: assetId }] } });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<I18nProvider initial="zh-CN"><TokenToSeaServices active videoOnly onVideoImport={onVideoImport} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Video model/ }));
    expect(screen.queryByRole('button', { name: /Chat model/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '开始调用' }));
    fireEvent.click(await screen.findByRole('button', { name: '加入当前影片素材' }));
    await waitFor(() => expect(onVideoImport).toHaveBeenCalledWith('run-video', assetId));
    expect(await screen.findByRole('button', { name: '已加入素材' })).toBeDisabled();
  });
  it('keeps account secrets out of the browser request and pairs prepare with the exact native input', async () => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, ...(body ? { body } : {}) });
      if (url.endsWith('/status')) return Response.json({ configured: true, signedIn: true, user: { id: 'test', name: 'Test' } });
      if (url.includes('/models?')) return Response.json({ data: [{ id: 'official:test-image', model: 'test-image', displayName: 'Test image model', provider: 'test', modality: 'image', executionKind: 'official', priceVersion: 'test-v1', examples: [{ id: 'image', path: '/v1/images/generations', mode: 'json', body: { model: 'test-image', prompt: 'sample', n: 1 } }] }] });
      if (url.endsWith('/tools')) return Response.json({ items: [], total: 0 });
      if (url.endsWith('/wallet')) return Response.json({ availableUsd: '1.000000' });
      if (url.endsWith('/official/prepare')) return Response.json({ id: 'run-1', status: 'prepared' });
      if (url.endsWith('/official/runs/run-1/invoke')) return Response.json({ id: 'run-1', status: 'succeeded', output: { result: 'test' } });
      throw new Error(`Unexpected request ${url}`);
    }));
    // The labels are i18n keys now (spec 07 §8); zh-CN keeps the strings this test selects by.
    render(<I18nProvider initial="zh-CN"><TokenToSeaServices active /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Test image model/ }));
    fireEvent.change(screen.getByPlaceholderText('描述你的设计、图片或内容要求'), { target: { value: 'A green poster' } });
    fireEvent.click(screen.getByRole('button', { name: '开始调用' }));
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/invoke'))).toBe(true));
    const prepare = calls.find(call => call.url.endsWith('/official/prepare'))!.body!;
    const invoke = calls.find(call => call.url.endsWith('/invoke'))!.body!;
    expect(invoke.input).toEqual({ model: 'test-image', prompt: 'A green poster', n: 1 });
    const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(invoke)))).toString('hex');
    expect(prepare.payloadHash).toBe(hash);
    expect(prepare.maxCostUsd).toBe('0.10');
    expect(JSON.stringify(calls)).not.toMatch(/access_token|refresh_token|apiKey/);
  });

  it('embedded: shows no signed-out caption while the status is pending, only after a signed-out answer', async () => {
    let answer: (signedIn: boolean) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/status')) {
        return new Promise<Response>(resolve => { answer = signedIn => resolve(Response.json({ configured: true, signedIn, user: null })); });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<I18nProvider initial="zh-CN"><TokenToSeaServices active variant="embedded" /></I18nProvider>);
    expect(screen.getByTestId('tokentosea-services').getAttribute('data-variant')).toBe('embedded');
    expect(screen.queryByText('登录 TokenToSea 后可浏览模型与工具')).toBeNull();
    answer(false);
    expect(await screen.findByText('登录 TokenToSea 后可浏览模型与工具')).toBeTruthy();
  });
});
