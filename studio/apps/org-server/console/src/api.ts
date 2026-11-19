// SPDX-License-Identifier: AGPL-3.0-only
// The console's one way to the server: bearer-authenticated JSON calls. The token lives in sessionStorage, so it ends
// with the tab.
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const KEY = 'fantay.org.token';
export const storedToken = (): string => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } };
export const storeToken = (token: string): void => { try { if (token) sessionStorage.setItem(KEY, token); else sessionStorage.removeItem(KEY); } catch { /* the session then lasts until reload */ } };

export class Api {
  constructor(private readonly token: string, private readonly onSignedOut: () => void) {}
  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(path, {
        method, cache: 'no-store',
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, 'NETWORK', '无法连接服务器，请检查网络后重试');
    }
    if (response.ok) return response;
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (response.status === 401 && this.token) this.onSignedOut();
    throw new ApiError(response.status, payload?.error?.code ?? 'ORG_ERROR', payload?.error?.message ?? `请求失败（${response.status}）`);
  }
  async get<T>(path: string): Promise<T> { return await (await this.send('GET', path)).json() as T; }
  async post<T>(path: string, body?: unknown): Promise<T> { return await (await this.send('POST', path, body)).json() as T; }
  async patch<T>(path: string, body: unknown): Promise<T> { return await (await this.send('PATCH', path, body)).json() as T; }
  async put<T>(path: string, body: unknown): Promise<T> { return await (await this.send('PUT', path, body)).json() as T; }
  async remove(path: string): Promise<void> { await this.send('DELETE', path); }
  async blob(path: string): Promise<Blob> { return await (await this.send('GET', path)).blob(); }
}
