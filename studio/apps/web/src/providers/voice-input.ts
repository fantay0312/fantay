import type { VoiceInputModel, VoiceInputSettings, VoiceInputTranscript, VoiceInputUpdate } from '@open-design/contracts/api/voice-input';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/voice-input/${path}`, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Voice input request failed');
  return data as T;
}
export const fetchVoiceInputSettings = (signal?: AbortSignal) => request<VoiceInputSettings>('settings', { signal });
export const fetchVoiceInputModels = (signal?: AbortSignal) => request<{ models: VoiceInputModel[] }>('models', { signal });
export const saveVoiceInputSettings = (config: VoiceInputUpdate) => request<VoiceInputSettings>('settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config),
});
export function transcribeVoiceInput(blob: Blob, signal: AbortSignal): Promise<VoiceInputTranscript> {
  const form = new FormData();
  form.set('file', blob, 'recording');
  return request('transcribe', { method: 'POST', body: form, signal });
}
