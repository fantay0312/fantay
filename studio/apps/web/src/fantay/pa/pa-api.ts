// SPDX-License-Identifier: AGPL-3.0-only
export const PA_ACCESS_REQUIRED = 'fantay-pa-access-required';
let accessToken = '';
export function setPaAccessToken(value: string): void { accessToken = value; }
/** The enterprise access token as a header; the Memory Center client sends it too. */
export function paAccessHeader(): Record<string, string> { return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}; }
/** Asks the workspace for the enterprise access token (again). */
export function signalPaAccessRequired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PA_ACCESS_REQUIRED));
}
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
    if (result?.error?.code === 'PA_ENTERPRISE_AUTH') signalPaAccessRequired();
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
  savePaBlob(name, await response.blob());
}

/** Hands the viewer a file to save under `name`. */
export function savePaBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A portrait URL. `data:` URLs pass through unchanged, so lab fixtures can use inline SVG portraits. */
export function paSoulAssetUrl(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.startsWith('data:') ? id : `/api/pa/soul/assets/${encodeURIComponent(id)}`;
}

/** A generated speech file's URL. `data:` URLs pass through unchanged (the lab's generated tone). */
export function paSoulSpeechUrl(id: string): string {
  return id.startsWith('data:') ? id : `/api/pa/soul/speech/${encodeURIComponent(id)}`;
}
