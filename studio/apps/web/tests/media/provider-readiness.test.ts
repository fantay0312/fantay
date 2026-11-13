import { describe, expect, it } from 'vitest';
import { isMediaModelPickerReady, isMediaProviderPickerReady } from '../../src/media/provider-readiness';

describe('media provider picker readiness', () => {
  it('requires a ComfyUI workflow and a proxy endpoint before showing those models', () => {
    expect(isMediaProviderPickerReady('comfyui')).toBe(false);
    expect(isMediaProviderPickerReady('comfyui', { comfyui: { apiKey: '', baseUrl: '', model: '{"nodes":{}}' } })).toBe(true);
    expect(isMediaProviderPickerReady('suno', { suno: { apiKey: 'key', baseUrl: '' } })).toBe(false);
    expect(isMediaProviderPickerReady('suno', { suno: { apiKey: '', baseUrl: 'http://127.0.0.1:3000' } })).toBe(true);
    expect(isMediaProviderPickerReady('udio', { udio: { apiKey: 'key', baseUrl: 'https://gateway.example.test' } })).toBe(true);
  });
  it('only offers Vertex Veo with a Vertex endpoint', () => {
    expect(isMediaModelPickerReady('veo-3.1-generate-001', { google: { apiKey: 'key', baseUrl: '' } })).toBe(false);
    expect(isMediaModelPickerReady('veo-3.1-generate-001', { google: { apiKey: 'token', baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google' } })).toBe(true);
    expect(isMediaModelPickerReady('gemini-nano-banana-2.1', { google: { apiKey: 'key', baseUrl: '' } })).toBe(true);
  });
  it('does not treat missing configuration, a URL or a suggested model as credentials', () => {
    expect(isMediaProviderPickerReady('openai')).toBe(false);
    expect(isMediaProviderPickerReady('openai', { openai: { apiKey: '', baseUrl: 'https://example.test', model: 'gpt-image-2' } })).toBe(false);
  });
  it('accepts a key or daemon-owned secure credential marker', () => {
    expect(isMediaProviderPickerReady('openai', { openai: { apiKey: 'test-key', baseUrl: '' } })).toBe(true);
    expect(isMediaProviderPickerReady('openai', { openai: { apiKey: '', baseUrl: '', apiKeyConfigured: true } })).toBe(true);
    expect(isMediaProviderPickerReady('openai', { openai: { apiKey: '', baseUrl: '', source: 'oauth-codex' } })).toBe(false);
  });
});
