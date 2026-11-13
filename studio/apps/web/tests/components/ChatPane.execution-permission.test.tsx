// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHAT_EXECUTION_PERMISSION_AGENT_IDS } from '@open-design/contracts';
import { ChatPane } from '../../src/components/ChatPane';
import { DesignSystemPicker } from '../../src/components/DesignSystemPicker';
import type { AppConfig, Conversation } from '../../src/types';

const patchConversationMock = vi.fn();

vi.mock('../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projects')>();
  return {
    ...actual,
    patchConversation: (...args: unknown[]) => patchConversationMock(...args),
  };
});

const translate = (key: string) => key;
vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: translate }),
  useT: () => translate,
}));

afterEach(() => {
  cleanup();
  patchConversationMock.mockReset();
});

function renderChatPaneWithAgent(
  agentId: string,
  options?: {
    selectedAgentBaseId?: string | null;
    executionPermission?: Conversation['executionPermission'];
    mode?: AppConfig['mode'];
    apiProtocol?: AppConfig['apiProtocol'];
    onExecutionPermissionSaved?: (id: string, permission: Conversation['executionPermission']) => void;
  },
) {
  const onExecutionPermissionSaved = options?.onExecutionPermissionSaved ?? vi.fn();
  const conversations: Conversation[] = [
    {
      id: 'conv-1',
      projectId: 'project-1',
      title: 'Test conversation',
      createdAt: 0,
      updatedAt: 0,
      executionPermission: options?.executionPermission ?? null,
    },
  ];
  return render(
    <ChatPane
      projectKindForTracking="prototype"
      messages={[]}
      streaming={false}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      conversations={conversations}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      onExecutionPermissionSaved={onExecutionPermissionSaved}
      selectedAgentBaseId={options?.selectedAgentBaseId}
      projectMetadata={{} as never}
      error={null}
      config={{
        mode: options?.mode ?? 'daemon',
        agentId,
        ...(options?.apiProtocol ? { apiProtocol: options.apiProtocol } : {}),
      } as unknown as AppConfig}
    />,
  );
}

describe('ChatPane ExecutionPermissionPicker support', () => {
  it.each(['antigravity', 'grok-build', 'opencode', 'cursor-agent', 'pi', 'deepseek-harness'])(
    'exposes the execution permission picker for %s in daemon mode',
    (agentId) => {
      expect(CHAT_EXECUTION_PERMISSION_AGENT_IDS).toContain(agentId);
      renderChatPaneWithAgent(agentId);
      const trigger = screen.getByRole('button', { name: 'chat.permission.label' });
      expect(trigger).toBeTruthy();
      expect(trigger.getAttribute('data-permission')).toBe('default');
      expect(trigger.closest('.composer-row__start')).not.toBeNull();
      expect(trigger.closest('.composer-row__end')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('folds the design-system picker into the + menu and opens its popover from there', () => {
    const onChangeDesignSystem = vi.fn();
    render(
      <ChatPane
        projectKindForTracking="prototype"
        messages={[]}
        streaming={false}
        projectId="project-1"
        projectFiles={[]}
        onEnsureProject={async () => 'project-1'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={[
          {
            id: 'conv-1',
            projectId: 'project-1',
            title: 'Test conversation',
            createdAt: 0,
            updatedAt: 0,
            executionPermission: 'danger-full-access',
          },
        ]}
        activeConversationId="conv-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        onExecutionPermissionSaved={vi.fn()}
        designSystemPicker={
          <DesignSystemPicker
            variant="home"
            designSystems={[
              {
                id: 'editorial-noir',
                title: 'Editorial Noir',
                category: 'Editorial',
                summary: 'High-contrast serif layout.',
                swatches: ['#111111', '#f5f5f0', '#c85a32'],
              },
            ]}
            selectedId={null}
            onChange={onChangeDesignSystem}
          />
        }
        projectMetadata={{} as never}
        error={null}
        config={{ mode: 'daemon', agentId: 'deepseek-harness' } as unknown as AppConfig}
      />,
    );

    const dsTrigger = screen.getByTestId('home-hero-design-system-trigger');
    expect(dsTrigger.closest('.composer-ds-folded')).not.toBeNull();

    const permissionTrigger = screen.getByRole('button', {
      name: 'chat.permission.label · chat.permission.fullAccess',
    });
    expect(permissionTrigger.closest('.composer-row__start')).not.toBeNull();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    const plusDesignSystemItem = screen.getByTestId('composer-plus-design-system');
    expect(plusDesignSystemItem).toBeTruthy();

    fireEvent.click(plusDesignSystemItem);
    expect(screen.getByTestId('project-ds-picker-popover')).toBeTruthy();
  });

  it('supports custom local profiles via selectedAgentBaseId without showing an unsupported alert', () => {
    renderChatPaneWithAgent('custom-grok-profile', {
      selectedAgentBaseId: 'grok-build',
      executionPermission: 'read-only',
    });

    const trigger = screen.getByRole('button', {
      name: 'chat.permission.label · chat.permission.readOnly',
    });
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('data-permission')).toBe('read-only');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['openai', 'anthropic', 'ollama'] as const)(
    'exposes the execution permission picker in BYOK API mode (%s) identically to TokenToSea',
    (apiProtocol) => {
      renderChatPaneWithAgent('tokentosea', {
        mode: 'api',
        apiProtocol,
        executionPermission: 'workspace-write',
      });

      const trigger = screen.getByRole('button', {
        name: 'chat.permission.label · chat.permission.workspaceWrite',
      });
      expect(trigger).toBeTruthy();
      expect(trigger.getAttribute('data-permission')).toBe('workspace-write');
      expect(trigger.closest('.composer-row__start')).not.toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('flags saved permissions as unsupported on Bedrock BYOK where bundled-pi proxy is unavailable', () => {
    renderChatPaneWithAgent('antigravity', {
      mode: 'api',
      apiProtocol: 'bedrock',
      executionPermission: 'workspace-write',
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('chat.permission.unsupported');
  });
});
