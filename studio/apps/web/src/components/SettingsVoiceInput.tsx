import { useEffect, useRef, useState } from 'react';
import type { VoiceInputModel, VoiceInputSettings } from '@open-design/contracts/api/voice-input';
import { useVoiceInputCopy } from '../i18n/voice-input';
import { fetchVoiceInputModels, fetchVoiceInputSettings, saveVoiceInputSettings } from '../providers/voice-input';
import { SettingsSelect } from './SettingsSelect';
import type { AppConfig } from '../types';

export function SettingsVoiceInput({ byok }: { byok: Pick<AppConfig, 'baseUrl' | 'apiKey'> }) {
  const copy = useVoiceInputCopy();
  const [settings, setSettings] = useState<VoiceInputSettings | null>(null);
  const [draft, setDraft] = useState<VoiceInputSettings | null>(null);
  const [models, setModels] = useState<VoiceInputModel[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [modelError, setModelError] = useState('');
  const [notice, setNotice] = useState('');
  const modelRequest = useRef<AbortController | null>(null);

  async function loadModels() {
    modelRequest.current?.abort();
    const controller = new AbortController();
    modelRequest.current = controller;
    setLoadingModels(true);
    setModelError('');
    try {
      const result = await fetchVoiceInputModels(controller.signal);
      if (!controller.signal.aborted) setModels(result.models);
    } catch (cause) {
      if (!controller.signal.aborted) setModelError((cause as Error).message);
    } finally { if (!controller.signal.aborted) setLoadingModels(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    fetchVoiceInputSettings(controller.signal).then(value => {
      setSettings(value); setDraft(value);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    void loadModels();
    return () => { controller.abort(); modelRequest.current?.abort(); };
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const value = await saveVoiceInputSettings({ ...draft, custom: { ...draft.custom, apiKey }, clearApiKey });
      setSettings(value); setDraft(value); setApiKey(''); setClearApiKey(false); setNotice(copy.saved);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }
  function changeCustom(key: 'baseUrl' | 'model', value: string) {
    setDraft(current => current && ({ ...current, custom: { ...current.custom, [key]: value } }));
    setNotice('');
  }
  if (!draft) return <div className="voice-settings"><p role={error ? 'alert' : 'status'}>{error || copy.loading}</p></div>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || Boolean(apiKey) || clearApiKey;
  const storedKeyApplies = draft.custom.apiKeyConfigured && !clearApiKey
    && URL.canParse(draft.custom.baseUrl) && URL.canParse(settings?.custom.baseUrl ?? '')
    && new URL(draft.custom.baseUrl).origin === new URL(settings!.custom.baseUrl).origin;
  const options = [{ value: '', label: copy.automatic }, ...models.map(model => ({ value: model.id, label: model.name }))];
  if (draft.model && !models.some(model => model.id === draft.model)) options.push({ value: draft.model, label: draft.model });

  return <section className="voice-settings" aria-label={copy.title}>
    <p className="voice-settings__intro">{copy.intro}</p>
    <div className="voice-settings__field">
      <label id="voice-provider-label">{copy.provider}</label>
      <SettingsSelect aria-labelledby="voice-provider-label" value={draft.provider} disabled={saving}
        options={[{ value: 'tokentosea', label: 'TokenToSea' }, { value: 'custom', label: copy.custom }]}
        onChange={provider => { setDraft({ ...draft, provider: provider as 'tokentosea' | 'custom' }); setNotice(''); }} />
    </div>
    {draft.provider === 'tokentosea' ? <>
      <div className="voice-settings__field">
        <label id="voice-model-label">{copy.model}</label>
        <div className="voice-settings__model">
          <SettingsSelect aria-labelledby="voice-model-label" value={draft.model} options={options} disabled={saving}
            onChange={model => { setDraft({ ...draft, model }); setNotice(''); }} />
          <button type="button" className="btn" disabled={loadingModels} onClick={() => void loadModels()}>{loadingModels ? copy.loading : copy.refresh}</button>
        </div>
      </div>
      {modelError ? <p className="voice-settings__hint" role="status">{modelError}</p> : !loadingModels && models.length === 0 ? <p className="voice-settings__hint" role="status">{copy.noModels}</p> : null}
    </> : <>
      <p className="voice-settings__hint">{copy.compatible}</p>
      {byok.baseUrl ? <button type="button" className="btn voice-settings__reuse" disabled={saving} onClick={() => {
        changeCustom('baseUrl', byok.baseUrl); setApiKey(byok.apiKey); setClearApiKey(false);
      }}>{copy.reuseByok}</button> : null}
      <div className="voice-settings__field"><label htmlFor="voice-base-url">{copy.baseUrl}</label>
        <input id="voice-base-url" type="url" placeholder="https://api.example.com/v1" value={draft.custom.baseUrl} disabled={saving} onChange={event => changeCustom('baseUrl', event.target.value)} spellCheck={false} autoComplete="off" /></div>
      <div className="voice-settings__field"><label htmlFor="voice-custom-model">{copy.modelId}</label>
        <input id="voice-custom-model" value={draft.custom.model} disabled={saving} onChange={event => changeCustom('model', event.target.value)} spellCheck={false} autoComplete="off" /></div>
      <div className="voice-settings__field"><label htmlFor="voice-api-key">{copy.apiKey}</label>
        <input id="voice-api-key" type="password" value={apiKey} disabled={saving} placeholder={storedKeyApplies ? copy.keySaved : ''}
          onChange={event => { setApiKey(event.target.value); setClearApiKey(false); setNotice(''); }} autoComplete="new-password" /></div>
      {draft.custom.apiKeyConfigured ? <label className="voice-settings__clear"><input type="checkbox" checked={clearApiKey} disabled={saving}
        onChange={event => { setClearApiKey(event.target.checked); setApiKey(''); setNotice(''); }} />{copy.clearKey}</label> : null}
    </>}
    <p className="voice-settings__hint">{copy.privacy}</p>
    {error ? <p className="voice-settings__error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <button type="button" className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? copy.loading : copy.save}</button>
  </section>;
}
