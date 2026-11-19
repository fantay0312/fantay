// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsVoiceInput } from '../../src/components/SettingsVoiceInput';
import { fetchVoiceInputSettings, fetchVoiceInputModels, saveVoiceInputSettings } from '../../src/providers/voice-input';

vi.mock('../../src/providers/voice-input', () => ({ fetchVoiceInputSettings: vi.fn(), fetchVoiceInputModels: vi.fn(), saveVoiceInputSettings: vi.fn() }));
vi.mock('../../src/components/SettingsSelect', () => ({ SettingsSelect: (props: {value:string;options:Array<{value:string;label:string}>;onChange(value:string):void;'aria-labelledby':string}) =>
  <select aria-labelledby={props['aria-labelledby']} value={props.value} onChange={event=>props.onChange(event.target.value)}>{props.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>,
}));
const saved = { provider: 'tokentosea' as const, model: '', custom: { baseUrl: 'https://existing.example/v1', model: 'saved-asr', apiKeyConfigured: true } };
beforeEach(() => {
  vi.mocked(fetchVoiceInputSettings).mockResolvedValue(saved);
  vi.mocked(fetchVoiceInputModels).mockResolvedValue({ models: [{ id: 'official:asr', name: 'Speech model' }] });
  vi.mocked(saveVoiceInputSettings).mockImplementation(async input => ({ ...input, custom: { baseUrl: input.custom.baseUrl, model: input.custom.model, apiKeyConfigured: true } }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('defaults to TokenToSea and saves a model selected from its current catalog', async () => {
  render(<SettingsVoiceInput byok={{baseUrl:'',apiKey:''}} />);
  const provider = await screen.findByLabelText('Recognition provider');
  expect(provider).toHaveValue('tokentosea');
  await screen.findByText('Speech model');
  fireEvent.change(screen.getByLabelText('Recognition model'), { target: { value: 'official:asr' } });
  fireEvent.click(screen.getByRole('button', {name:'Save'}));
  await waitFor(() => expect(saveVoiceInputSettings).toHaveBeenCalledWith(expect.objectContaining({model:'official:asr',provider:'tokentosea'})));
});
it('can reuse BYOK settings while keeping a saved secret out of the form', async () => {
  render(<SettingsVoiceInput byok={{baseUrl:'https://byok.example/v1',apiKey:'new-private-key'}} />);
  fireEvent.change(await screen.findByLabelText('Recognition provider'), {target:{value:'custom'}});
  expect(screen.getByLabelText('API key')).toHaveValue('');
  fireEvent.click(screen.getByRole('button',{name:'Use current BYOK address and key'}));
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://byok.example/v1');
  fireEvent.change(screen.getByLabelText('Model ID'), {target:{value:'custom-asr'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(saveVoiceInputSettings).toHaveBeenCalledWith(expect.objectContaining({provider:'custom',custom:expect.objectContaining({model:'custom-asr',apiKey:'new-private-key'})})));
  await waitFor(()=>expect(screen.getByLabelText('API key')).toHaveValue(''));
});
