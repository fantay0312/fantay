// SPDX-License-Identifier: AGPL-3.0-only
export const PA_ACCESS_REQUIRED = 'fantay-pa-access-required';
let accessToken = '';
export function setPaAccessToken(value: string): void { accessToken = value; }
function paAccessHeader(): Record<string, string> { return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}; }
export class PaRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PaRequestError';
  }
}

export async function paRequest<T>(path = "", method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/pa${path}`, {
    method,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...paAccessHeader() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (result?.error?.code === 'PA_ENTERPRISE_AUTH' && typeof window !== 'undefined')
      window.dispatchEvent(new Event(PA_ACCESS_REQUIRED));
    throw new PaRequestError(
      result?.error?.message ?? `Fantay request failed (${response.status})`,
      typeof result?.error?.code === 'string' ? result.error.code : null,
      response.status,
    );
  }
  return result as T;
}

export function isRevisionConflict(error: unknown): boolean {
  return error instanceof PaRequestError && error.code === 'PA_REVISION_CONFLICT';
}

export function isRecoveryRequired(error: unknown): boolean {
  return error instanceof PaRequestError && error.code === 'PA_RECOVERY_REQUIRED';
}

export function isExecutorRunning(error: unknown): boolean {
  return error instanceof PaRequestError && error.code === 'PA_EXECUTOR_RUNNING';
}

export async function downloadPaArtifact(id: string, name: string): Promise<void> {
  const response = await fetch(`/api/pa/artifacts/${encodeURIComponent(id)}/download`, { cache: 'no-store', headers: paAccessHeader() });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new PaRequestError(result?.error?.message ?? `Fantay request failed (${response.status})`, null, response.status);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
