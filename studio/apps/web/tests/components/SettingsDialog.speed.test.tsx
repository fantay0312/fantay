// @vitest-environment jsdom
//
// Settings → 本机 CLI: one 速度 select per agent card, beside the model and effort pickers. It offers
// Standard plus only the tiers the effective model lists (Fast = Codex `priority` or a folded family's
// `fast`, Ultrafast = Codex `ultrafast`), each with its cost line, and keeps a tier the effort cannot run
// listed but disabled, naming the efforts that do run it. A folded family (Cursor Agent lists
// `gpt-5.3-codex-low`, `-high-fast` … as separate ids) shows as one model, and a concrete id saved before
// the daemon folded them reads as that family instead of dropping into the custom-model input.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchCodexPets: vi.fn(async () => ({ pets: [], rootDir: '' })),
    syncCommunityPets: vi.fn(async () => ({ wrote: 0, skipped: 0, failed: 0, total: 0, rootDir: '', errors: [] })),
    fetchSkills: vi.fn(async () => []),
    fetchDesignSystems: vi.fn(async () => []),
    fetchDesignTemplates: vi.fn(async () => []),
    fetchConnectors: vi.fn(async () => []),
    fetchLatestGithubReleaseInfo: vi.fn(async () => null),
    openExternalUrl: vi.fn(),
  };
});

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: vi.fn(),
    setConsent: () => undefined,
    setIdentity: () => undefined,
    setConfigureGlobals: () => undefined,
    anonymousId: 'test-anonymous',
    sessionId: 'test-session',
    newRequestId: () => 'test-request',
  }),
}));

const originalFetch = globalThis.fetch;
beforeEach(() => {
  // No daemon behind these cards: every side request (CLI updates, workspace,
  // account status) fails the way an unreachable endpoint does.
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'cursor-agent',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

const cursorAgent: AgentInfo = {
  id: 'cursor-agent',
  name: 'Cursor Agent',
  bin: 'cursor-agent',
  available: true,
  version: '1.0.0',
  modelsSource: 'live',
  models: [
    { id: 'default', label: 'Default' },
    {
      id: 'gpt-5.3-codex',
      label: 'GPT-5.3 Codex',
      reasoningOptions: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium', default: true },
        { id: 'high', label: 'High' },
      ],
      serviceTierOptions: [{ id: 'fast', label: 'Fast' }],
      variants: [
        { id: 'gpt-5.3-codex-low', reasoning: 'low' },
        { id: 'gpt-5.3-codex' },
        { id: 'gpt-5.3-codex-high', reasoning: 'high' },
        { id: 'gpt-5.3-codex-high-fast', reasoning: 'high', serviceTier: 'fast' },
      ],
    },
  ],
};

// `codex debug models` on 2026-11-09: gpt-6.1-sol lists both flag tiers; gpt-6.1-terra only priority.
const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.80.0',
  modelsSource: 'live',
  models: [
    {
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      reasoningOptions: [{ id: 'medium', label: 'Medium', default: true }, { id: 'high', label: 'High' }],
      serviceTierOptions: [
        { id: 'priority', label: 'Fast', description: '2x speed, increased usage' },
        { id: 'ultrafast', label: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' },
      ],
    },
    {
      id: 'gpt-6.1-terra',
      label: 'GPT-6.1-Terra',
      reasoningOptions: [{ id: 'medium', label: 'Medium', default: true }],
      serviceTierOptions: [{ id: 'priority', label: 'Fast', description: '1.5x speed' }],
    },
    { id: 'gpt-legacy', label: 'GPT Legacy', reasoningOptions: [{ id: 'medium', label: 'Medium', default: true }] },
  ],
};

function renderCli(initial: Partial<AppConfig>, agents: AgentInfo[]) {
  const onPersist = vi.fn();
  render(
    <I18nProvider initial="en">
      <SettingsDialog
        initial={{ ...baseConfig, ...initial }}
        agents={agents}
        daemonLive
        appVersionInfo={null}
        initialSection="execution"
        onPersist={onPersist}
        onSilentUpdatePreferenceChange={async () => undefined}
        onPersistComposioKey={vi.fn()}
        onClose={vi.fn()}
        onRefreshAgents={vi.fn()}
      />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole('tab', { name: /Local CLI/i }));
  return onPersist;
}

const speedSelect = () => screen.getByTestId('speed-select');
/** Opens the 速度 select and returns its rows, in order. */
function openSpeed() {
  fireEvent.click(speedSelect());
  return within(document.body).getAllByRole('option') as HTMLButtonElement[];
}
const optionName = (option: HTMLElement) =>
  option.querySelector('.model-select-searchable__option-label')?.textContent;
const lastAgentModels = (onPersist: ReturnType<typeof vi.fn>) =>
  (onPersist.mock.calls.at(-1)?.[0] as AppConfig | undefined)?.agentModels;

describe('Settings speed select', () => {
  it('reads a saved concrete id as its family and keeps an off-limits Fast listed, disabled', () => {
    renderCli({ agentModels: { 'cursor-agent': { model: 'gpt-5.3-codex-low' } } }, [cursorAgent]);

    expect(screen.getByRole('combobox', { name: en['settings.modelPicker'] }).textContent).toContain('GPT-5.3 Codex');
    expect(screen.queryByLabelText(en['settings.modelCustomLabel'])).toBeNull();
    expect(screen.getByTestId('reasoning-select').textContent).toContain(en['settings.reasoning.low']);
    expect(speedSelect().textContent).toContain(en['settings.speedStandard']);
    expect(screen.queryByRole('switch', { name: /fast/i })).toBeNull();

    const options = openSpeed();
    expect(options.map(optionName)).toEqual([en['settings.speedStandard'], en['settings.speedFast']]);
    expect(options[0]!.textContent).toContain(en['settings.speedStandardHint']);
    expect(options[1]!.disabled).toBe(true);
    expect(options[1]!.textContent).toContain(
      en['settings.fastModeAvailableAt'].replace('{efforts}', en['settings.reasoning.high']),
    );
  });

  it('keeps Fast off-limits at the default-flagged effort when nothing is saved', () => {
    renderCli({ agentModels: { 'cursor-agent': { model: 'gpt-5.3-codex' } } }, [cursorAgent]);
    expect(screen.getByTestId('reasoning-select').textContent).toContain(en['settings.reasoning.medium']);
    // Medium has no fast id in this catalog.
    expect(openSpeed()[1]!.disabled).toBe(true);
  });

  it('picks Fast at an effort that has a fast id and drops it when the effort cannot run it', async () => {
    const onPersist = renderCli({ agentModels: { 'cursor-agent': { model: 'gpt-5.3-codex-high' } } }, [cursorAgent]);

    const fast = openSpeed()[1]!;
    expect(fast.disabled).toBe(false);
    // No provider copy for a folded fast id: the row says what the tier is for.
    expect(fast.textContent).toContain(en['settings.speedFastHint']);
    fireEvent.click(fast);
    await waitFor(() => {
      expect(lastAgentModels(onPersist)?.['cursor-agent']).toEqual({
        model: 'gpt-5.3-codex',
        reasoning: 'high',
        serviceTier: 'fast',
      });
    });
    expect(speedSelect().textContent).toContain(en['settings.speedFast']);

    fireEvent.click(screen.getByTestId('reasoning-select'));
    fireEvent.click(within(document.body).getByRole('option', { name: en['settings.reasoning.low'] }));
    await waitFor(() => {
      expect(lastAgentModels(onPersist)?.['cursor-agent']).toEqual({
        model: 'gpt-5.3-codex',
        reasoning: 'low',
      });
    });
    expect(speedSelect().textContent).toContain(en['settings.speedStandard']);
  });

  it('keeps a Grok fast id at every effort, since its effort is a flag, with the cache copy', async () => {
    // As foldGrokBuildModels emits it: the ids differ only by speed tier.
    const grokAgent: AgentInfo = {
      id: 'grok-build',
      name: 'Grok Build',
      bin: 'grok',
      available: true,
      version: '1.0.0',
      modelsSource: 'live',
      models: [
        {
          id: 'grok-4.7',
          label: 'Grok 4.7',
          reasoningOptions: [
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium', default: true },
            { id: 'high', label: 'High' },
            { id: 'xhigh', label: 'XHigh' },
          ],
          serviceTierOptions: [{ id: 'fast', label: 'Fast', description: 'Fast variant. 2x the price.' }],
          variants: [{ id: 'grok-4.7' }, { id: 'grok-4.7-build-fast', serviceTier: 'fast' }],
        },
      ],
    };
    const onPersist = renderCli(
      {
        agentId: 'grok-build',
        agentModels: { 'grok-build': { model: 'grok-4.7-build-fast', reasoning: 'high' } },
      },
      [grokAgent],
    );

    expect(screen.getByTestId('reasoning-select').textContent).toContain(en['settings.reasoning.high']);
    expect(speedSelect().textContent).toContain(en['settings.speedFast']);
    const fast = openSpeed()[1]!;
    expect(fast.textContent).toContain('Fast variant. 2x the price.');
    fireEvent.click(speedSelect());

    fireEvent.click(screen.getByTestId('reasoning-select'));
    fireEvent.click(within(document.body).getByRole('option', { name: en['settings.reasoning.xhigh'] }));
    await waitFor(() => {
      expect(lastAgentModels(onPersist)?.['grok-build']).toEqual({
        model: 'grok-4.7',
        reasoning: 'xhigh',
        serviceTier: 'fast',
      });
    });
    expect(speedSelect().textContent).toContain(en['settings.speedFast']);
  });

  it('gives Codex Standard / Fast / Ultrafast with the catalog copy and writes the flag tier', async () => {
    const onPersist = renderCli(
      { agentId: 'codex', agentModels: { codex: { model: 'gpt-6.1-sol' } } },
      [codexAgent],
    );
    const options = openSpeed();
    expect(options.map(optionName)).toEqual([
      en['settings.speedStandard'],
      en['settings.speedFast'],
      en['settings.speedUltrafast'],
    ]);
    expect(options[1]!.textContent).toContain('2x speed, increased usage');
    expect(options[2]!.textContent).toContain('The fastest available responses for latency-sensitive work.');
    fireEvent.click(options[2]!);
    await waitFor(() => {
      expect(lastAgentModels(onPersist)?.codex).toEqual({ model: 'gpt-6.1-sol', serviceTier: 'ultrafast' });
    });

    fireEvent.click(openSpeed()[0]!);
    await waitFor(() => {
      expect(lastAgentModels(onPersist)?.codex).toEqual({ model: 'gpt-6.1-sol' });
    });
  });

  it('lists only Fast for a single-tier model and no speed select for a model without tiers', () => {
    renderCli({ agentId: 'codex', agentModels: { codex: { model: 'gpt-6.1-terra' } } }, [codexAgent]);
    const options = openSpeed();
    expect(options.map(optionName)).toEqual([en['settings.speedStandard'], en['settings.speedFast']]);
    expect(options[1]!.textContent).toContain('1.5x speed');
    cleanup();

    renderCli({ agentId: 'codex', agentModels: { codex: { model: 'gpt-legacy' } } }, [codexAgent]);
    expect(screen.queryByTestId('speed-select')).toBeNull();
  });
});
