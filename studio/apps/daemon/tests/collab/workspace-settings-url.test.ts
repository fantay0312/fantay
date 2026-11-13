import { describe, expect, it } from 'vitest';
import {
  parseWorkspaceCollabContext,
  resolveWorkspaceSettingsUrl,
} from '../../src/collab/workspace-context.js';
import { TOKENTOSEA_CONSOLE_ORIGIN } from '../../src/integrations/vela-console-origin.js';

// B's web console takes ?workspaceId deep links (target page opens directly
// when it matches the account's Active Workspace; otherwise the web asks the
// user to confirm the switch). Console links must pin the id — a bare
// /settings link depends on whatever workspace another device left active.
//
// Fantaydesign pins the console origin to TokenToSea: the upstream per-profile
// console URLs (OD_VELA_WEB_URL / OD_VELA_WEB_URLS) are never used.
const TOKENTOSEA_SETTINGS = `${TOKENTOSEA_CONSOLE_ORIGIN}/settings?workspaceId=ws-1&source=open_design`;

describe('resolveWorkspaceSettingsUrl', () => {
  it('builds the settings deep link on the TokenToSea console with the workspace id pinned', () => {
    expect(
      resolveWorkspaceSettingsUrl('ws-1', undefined, {
        OD_VELA_WEB_URL: 'https://web.example',
      } as NodeJS.ProcessEnv),
    ).toBe(TOKENTOSEA_SETTINGS);
  });

  it('appends the id to an explicit URL that lacks it and preserves one that has it', () => {
    expect(resolveWorkspaceSettingsUrl('ws-1', 'https://web.example/settings')).toBe(
      'https://web.example/settings?workspaceId=ws-1&source=open_design',
    );
    expect(
      resolveWorkspaceSettingsUrl('ws-1', 'https://web.example/settings?workspaceId=ws-other'),
    ).toBe('https://web.example/settings?workspaceId=ws-other&source=open_design');
    expect(
      resolveWorkspaceSettingsUrl(
        'ws-1',
        'https://web.example/settings?source=vela',
      ),
    ).toBe('https://web.example/settings?source=vela&workspaceId=ws-1');
  });

  it('falls back to the TokenToSea console without an explicit URL and leaves unparseable explicit values alone', () => {
    expect(
      resolveWorkspaceSettingsUrl('ws-1', undefined, {} as NodeJS.ProcessEnv),
    ).toBe(TOKENTOSEA_SETTINGS);
    expect(resolveWorkspaceSettingsUrl('ws-1', 'not-a-url')).toBe('not-a-url');
  });

  it('ignores upstream per-profile console origins for a selected runtime profile', () => {
    expect(resolveWorkspaceSettingsUrl('ws-1', undefined, {
      OPEN_DESIGN_AMR_PROFILE: 'prod',
      OD_VELA_WEB_URL: 'https://prod.example',
      OD_VELA_WEB_URLS: JSON.stringify({
        prod: 'https://prod.example',
        test: 'https://test.example',
      }),
    }, {
      OPEN_DESIGN_AMR_PROFILE: 'test',
    })).toBe(TOKENTOSEA_SETTINGS);
  });

  it('does not let a URL from workspace context override the console origin once a runtime profile is selected', () => {
    expect(resolveWorkspaceSettingsUrl('ws-1', 'https://prod.example/settings', {
      OPEN_DESIGN_AMR_PROFILE: 'prod',
      OD_VELA_WEB_URL: 'https://prod.example',
      OD_VELA_WEB_URLS: JSON.stringify({
        prod: 'https://prod.example',
        'feature-test': 'https://feature.example',
      }),
    }, {
      OPEN_DESIGN_AMR_PROFILE: 'feature-test',
    })).toBe(TOKENTOSEA_SETTINGS);
    expect(resolveWorkspaceSettingsUrl('ws-1', 'https://prod.example/settings', {
      OPEN_DESIGN_AMR_PROFILE: 'prod',
      OD_VELA_WEB_URL: 'https://prod.example',
      OD_VELA_WEB_URLS: JSON.stringify({ prod: 'https://prod.example' }),
    }, {
      OPEN_DESIGN_AMR_PROFILE: 'feature-test',
    })).toBe(TOKENTOSEA_SETTINGS);
  });
});

describe('parseWorkspaceCollabContext', () => {
  it('preserves the Personal workspace console link used by team actions', () => {
    const context = parseWorkspaceCollabContext({
      workspaceId: 'ws-personal',
      workspaceType: 'personal',
      workspaceMemberId: 'wm-owner',
      role: 'owner',
      memberStatus: 'active',
      lifecycleState: 'active',
      workspaceSettingsUrl: 'https://web.example/settings',
    });

    expect(context?.workspaceSettingsUrl).toBe(
      'https://web.example/settings?workspaceId=ws-personal&source=open_design',
    );
  });
});
