import type { Express, Request, RequestHandler } from 'express';
import { AsyncResource } from 'node:async_hooks';
import multer from 'multer';
import { z } from 'zod';
import { VOICE_INPUT_MAX_BYTES, VoiceInputUpdateSchema } from '@open-design/contracts/api/voice-input';
import { VoiceInputError, type VoiceInputService } from '../services/voice-input.js';

export interface RegisterVoiceInputRoutesDeps {
  voiceInput: VoiceInputService;
  requireLocalDaemonRequest: RequestHandler;
}

export function registerVoiceInputRoutes(app: Express, { voiceInput, requireLocalDaemonRequest }: RegisterVoiceInputRoutesDeps): void {
  const handle = (operation: (req: Request, signal: AbortSignal) => unknown | Promise<unknown>): RequestHandler => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close);
    try { res.json(await operation(req, controller.signal)); }
    catch (error) {
      if (controller.signal.aborted) return;
      const status = error instanceof VoiceInputError ? error.status
        : error instanceof z.ZodError ? 400
          : error instanceof Error && (error as Error & { status?: number }).status === 401 ? 401 : 502;
      const message = error instanceof VoiceInputError ? error.message
        : status === 400 ? '语音输入设置无效，请检查后重试。'
          : status === 401 ? '请先登录 TokenToSea。'
            : error instanceof Error && error.name === 'TimeoutError' ? '语音识别超时，请重试或更换模型。' : '语音识别暂时不可用，请检查服务设置后重试。';
      res.status(status).json({ error: { message } });
    } finally { res.off('close', close); }
  };
  app.get('/api/voice-input/settings', requireLocalDaemonRequest, handle(() => voiceInput.settings()));
  app.put('/api/voice-input/settings', requireLocalDaemonRequest, handle(req => voiceInput.update(VoiceInputUpdateSchema.parse(req.body))));
  app.get('/api/voice-input/models', requireLocalDaemonRequest, handle(async () => ({ models: await voiceInput.models() })));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: VOICE_INPUT_MAX_BYTES, files: 1, fields: 0 } }).single('file');
  const audioUpload: RequestHandler = (req, res, next) => {
    // Multipart stream events originate outside the request's account scope.
    upload(req, res, AsyncResource.bind(error => {
      if (error) { res.status(400).json({ error: { message: '请上传一段小于 10 MiB 的录音。' } }); return; }
      next();
    }));
  };
  app.post('/api/voice-input/transcribe', requireLocalDaemonRequest, audioUpload, handle((req, signal) => {
    if (!req.file) throw new VoiceInputError('请上传录音。');
    return voiceInput.transcribe(req.file.buffer, signal);
  }));
}
