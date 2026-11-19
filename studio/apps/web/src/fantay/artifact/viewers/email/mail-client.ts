// SPDX-License-Identifier: AGPL-3.0-only
// Reads a message off the main thread and against the clock: a file that takes longer than the limit
// ends in a notice, never a frozen tab. The same shape as `document/read-document.ts`.
import type { MailReadRequest } from './mail.worker';
import type { MailReadResult } from './mail-types';

const READ_TIMEOUT_MS = 12_000;

export type MailOutcome = MailReadResult | { ok: false; code: 'timeout' };

/** Never rejects. `signal` ends the worker early (the viewer went away or the file changed). */
export function parseMail(bytes: ArrayBuffer, signal: AbortSignal): Promise<MailOutcome> {
  return new Promise<MailOutcome>((resolve) => {
    const worker = new Worker(new URL('./mail.worker.ts', import.meta.url), { type: 'module' });
    const finish = (outcome: MailOutcome): void => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      resolve(outcome);
    };
    const onAbort = (): void => finish({ ok: false, code: 'failed' });
    const timer = window.setTimeout(() => finish({ ok: false, code: 'timeout' }), READ_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort);
    worker.addEventListener('message', (event: MessageEvent<MailReadResult>) => finish(event.data));
    worker.addEventListener('error', () => finish({ ok: false, code: 'failed' }));
    // Copied, not transferred: the viewer keeps the bytes to tell one version of the file from the next.
    worker.postMessage({ bytes } satisfies MailReadRequest);
  });
}
