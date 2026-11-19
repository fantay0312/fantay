import { AsyncLocalStorage } from 'node:async_hooks';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { expect, it } from 'vitest';
import { registerVoiceInputRoutes } from '../../src/routes/voice-input.js';
import type { VoiceInputService } from '../../src/services/voice-input.js';

it('preserves the signed-in account across multipart upload callbacks', async () => {
  const scope = new AsyncLocalStorage<string>();
  const app = express();
  app.use((_req, _res, next) => scope.run('signed-in-account', next));
  registerVoiceInputRoutes(app, {
    requireLocalDaemonRequest: (_req, _res, next) => next(),
    voiceInput: { transcribe: async () => ({ text: scope.getStore() ?? 'missing-account', model: 'asr' }) } as unknown as VoiceInputService,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const form = new FormData();
    form.set('file', new Blob(['audio']), 'recording.webm');
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice-input/transcribe`, { method: 'POST', body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'signed-in-account', model: 'asr' });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
