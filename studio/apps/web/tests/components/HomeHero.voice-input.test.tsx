// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeHero } from '../../src/components/HomeHero';
import { setHomeHeroPrompt, homeHeroPromptText } from '../helpers/home-hero-lexical';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({ PlaceholderCarousel: () => null }));
vi.mock('../../src/components/composer/VoiceInputButton', () => ({ VoiceInputButton: ({onTranscript,onActiveChange}: {onTranscript(text:string):void;onActiveChange(active:boolean):void}) =>
  <><button onClick={()=>onActiveChange(true)}>Record</button><button onClick={()=>{onTranscript('voice text');onActiveChange(false);}}>Finish voice</button></>,
}));
afterEach(cleanup);

it('inserts recognition into the home draft without submitting or losing existing text', async () => {
  const submit = vi.fn();
  function Home() {
    const [prompt, setPrompt] = useState('');
    return <HomeHero prompt={prompt} onPromptChange={setPrompt} onSubmit={submit} activePluginTitle={null}
      activeChipId={null} onClearActivePlugin={()=>undefined} pluginOptions={[]} pluginsLoading={false}
      pendingPluginId={null} pendingChipId={null} onPickPlugin={()=>undefined} onPickChip={()=>undefined}
      contextItemCount={0} error={null} />;
  }
  render(<Home />);
  await act(async()=>undefined);
  setHomeHeroPrompt('Existing draft. ');
  fireEvent.click(screen.getByText('Record'));
  expect(screen.getByTestId('home-hero-submit')).toBeDisabled();
  fireEvent.click(screen.getByTestId('home-hero-submit'));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Finish voice'));
  await waitFor(()=>expect(homeHeroPromptText()).toBe('Existing draft. voice text'));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByTestId('home-hero-submit')).toBeEnabled();
});
