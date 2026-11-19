// SPDX-License-Identifier: AGPL-3.0-only
// The message is read here, one worker per file version. The file is untrusted: a parse that loops or
// runs out of memory takes this worker with it, not the tab, and the viewer ends the worker when it
// takes too long (`mail-client.ts`). The attachments' bytes are handed over, not copied.
/// <reference lib="webworker" />
import type { MailReadResult } from './mail-types';
import { readMail } from './read-mail';

export interface MailReadRequest {
  bytes: ArrayBuffer;
}

self.addEventListener('message', (event: MessageEvent<MailReadRequest>) => {
  void readMail(event.data.bytes).then(
    (result: MailReadResult) => {
      const transfer = result.ok ? result.message.attachments.map((attachment) => attachment.content) : [];
      self.postMessage(result, transfer);
    },
    () => self.postMessage({ ok: false, code: 'failed' } satisfies MailReadResult),
  );
});
