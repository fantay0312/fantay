/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — daemon client for `/api/workbench/*` (contract: packages/contracts/src/api/workbench.ts).
 * Workflow adapted from dsh-media-desk (MIT, Copyright (c) 2026 woniuniuniu, see THIRD_PARTY_NOTICES.md).
 */
import type {
  WorkbenchAssetTarget,
  WorkbenchCaptureResponse,
  WorkbenchCaptureUrlRequest,
  WorkbenchChatResponse,
  WorkbenchInsights,
  WorkbenchModelsResponse,
  WorkbenchOp,
  WorkbenchOpsResponse,
  WorkbenchOrganizeResponse,
  WorkbenchProduceResponse,
  WorkbenchProductionResponse,
  WorkbenchPublicSettings,
  WorkbenchReaderResponse,
  WorkbenchSaveResponse,
  WorkbenchSearchMode,
  WorkbenchSearchResponse,
  WorkbenchSettingsPatch,
  WorkbenchSettingsTestResponse,
  WorkbenchSkillsExportResponse,
  WorkbenchSkillsLearnResponse,
  WorkbenchSocialImportResponse,
  WorkbenchSocialStatus,
  WorkbenchState,
  WorkbenchStateResponse,
  WorkbenchStyleExtractRequest,
  WorkbenchStyleExtractResponse,
  WorkbenchUndoResponse,
  WorkbenchUploadResponse,
} from '@open-design/contracts';

export class WorkbenchRequestError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'WorkbenchRequestError';
    this.status = status;
  }
}

/** UI language for daemon-side copy (receipts, prompts, sample data). Set by the store from the app locale. */
let requestLang: 'zh' | 'en' = 'zh';
export function setWorkbenchRequestLang(lang: 'zh' | 'en'): void {
  requestLang = lang;
}
export function getWorkbenchRequestLang(): 'zh' | 'en' {
  return requestLang;
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`/api/workbench/${path}`, {
      ...rest,
      headers: {
        'x-workbench-lang': requestLang,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(json !== undefined ? { method: rest.method ?? 'POST', body: JSON.stringify(json) } : {}),
    });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    throw new WorkbenchRequestError(requestLang === 'en' ? 'Fantay is not reachable' : '连不上 Fantay 本地服务', null);
  }
  const text = await response.text();
  let value: unknown = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = null; }
  if (!response.ok) {
    const message = value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
      ? (value as { error: string }).error
      : `${response.status}`;
    throw new WorkbenchRequestError(message, response.status);
  }
  return value as T;
}

const post = <T>(path: string, json: unknown = {}, signal?: AbortSignal) => request<T>(path, { json, ...(signal ? { signal } : {}) });

export const workbenchApi = {
  state: (signal?: AbortSignal) => request<WorkbenchStateResponse>('state', signal ? { signal } : {}),
  ops: (ops: WorkbenchOp[], options: { label?: string; undoable?: boolean } = {}) =>
    post<WorkbenchOpsResponse>('ops', { ops, ...options }),
  undo: () => post<WorkbenchUndoResponse>('undo'),

  chat: (message: string, focusId?: string, signal?: AbortSignal) =>
    post<WorkbenchChatResponse>('chat', { message, ...(focusId ? { focusId } : {}) }, signal),
  clearChat: () => post<{ state: WorkbenchState }>('chat/clear'),

  produce: (id: string, withImages?: boolean) =>
    post<WorkbenchProduceResponse>('produce', { id, ...(typeof withImages === 'boolean' ? { withImages } : {}) }),
  production: (id: string, signal?: AbortSignal) =>
    request<WorkbenchProductionResponse>(`production?id=${encodeURIComponent(id)}`, signal ? { signal } : {}),
  cancelProduce: (id: string) => post<{ ok: true }>('produce/cancel', { id }),
  regen: (id: string, target: WorkbenchAssetTarget) => post<{ state: WorkbenchState }>('produce/regen', { id, target }),
  save: (id: string, videoCover?: string) => post<WorkbenchSaveResponse>('produce/save', { id, ...(videoCover ? { videoCover } : {}) }),
  reveal: (id: string) => post<{ path: string }>('produce/reveal', { id }),

  extractStyle: (body: WorkbenchStyleExtractRequest) => post<WorkbenchStyleExtractResponse>('style/extract', body),
  socialStatus: () => request<WorkbenchSocialStatus>('social/status'),
  importAccount: (text: string) => post<WorkbenchSocialImportResponse>('social/import', { text }),
  refreshAccount: (body: { id?: string; url: string; platform?: string; handle?: string }) =>
    post<{ state: WorkbenchState; errors: string[]; fetchError: string | null }>('account/refresh', body),

  settings: () => request<WorkbenchPublicSettings>('settings'),
  updateSettings: (patch: WorkbenchSettingsPatch) => post<WorkbenchPublicSettings>('settings', patch),
  testImage: () => post<WorkbenchSettingsTestResponse>('settings/test'),
  models: () => request<WorkbenchModelsResponse>('models'),

  captureUrl: (body: WorkbenchCaptureUrlRequest) => post<WorkbenchCaptureResponse>('capture-url', body),
  upload: async (file: Blob): Promise<WorkbenchUploadResponse> =>
    request<WorkbenchUploadResponse>('upload', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } }),

  organize: (ids: string[]) => post<WorkbenchOrganizeResponse>('library/organize', { ids }),
  reader: (id: string) => post<WorkbenchReaderResponse>('library/reader', { id }),
  search: (q: string, mode: WorkbenchSearchMode = 'text', signal?: AbortSignal) =>
    request<WorkbenchSearchResponse>(`library/search?q=${encodeURIComponent(q)}&mode=${mode}`, signal ? { signal } : {}),

  insights: () => request<WorkbenchInsights>('insights'),
  learnSkills: () => post<WorkbenchSkillsLearnResponse>('skills/learn'),
  exportSkills: () => post<WorkbenchSkillsExportResponse>('skills/export'),
};
