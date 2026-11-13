// SPDX-License-Identifier: AGPL-3.0-only
// Chat-to-shell bridge (spec 02 §5.4 + plan R21). ProjectView publishes its live session (chats, design
// system, read-only state, project metadata, media providers) with one unconditional hook call; the
// sidebar, the project design-system tab and the board generation environment read it, and run commands
// through ProjectView's own handlers. Module-level session + listeners via `useSyncExternalStore`;
// handlers live in a ref refreshed every render, so commands never call a stale closure.
import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { SettingsSection } from '../../components/SettingsDialog';
import type {
  Conversation,
  DesignSystemSummary,
  MediaProviderCredentials,
  ProjectMetadata,
} from '../../types';
import { useFantayShellEnabled } from './flags';

export interface FantayProjectSession {
  projectId: string;
  projectName: string;
  designSystemId: string | null;
  designSystems: readonly DesignSystemSummary[];
  conversations: readonly Conversation[];
  activeConversationId: string | null;
  runningConversationIds: readonly string[]; // [streamingConversationId] when set
  readOnly: boolean;
  /** R21: board generation environment (project kind, platform, …). */
  projectMetadata: ProjectMetadata | null;
  /** R21: configured media providers (App config) for generation availability. */
  mediaProviders: Record<string, MediaProviderCredentials> | undefined;
}

export interface FantayProjectBridgeInput extends FantayProjectSession {
  onNewConversation(): void | Promise<void>;
  onSelectConversation(id: string): void;
  onConversationUpdated?(conversation: Conversation): void;
  onConversationDeleted?(id: string): void | Promise<void>;
  onChangeDesignSystem(id: string | null): void;
  /** R21: App.openSettings, e.g. Settings ▸ 媒体 / 账户 from generation or account surfaces. */
  onOpenSettings(section: SettingsSection): void;
}

export type FantayProjectCommand =
  | { kind: 'newConversation' }
  | { kind: 'selectConversation'; conversationId: string }
  | { kind: 'conversationUpdated'; conversation: Conversation }
  | { kind: 'conversationDeleted'; conversationId: string }
  | { kind: 'changeDesignSystem'; designSystemId: string | null }
  | { kind: 'openSettings'; section: SettingsSection };

/** Stable empty list for `runningConversationIds` when nothing streams (spec 02 §7.7). */
export const NO_RUNNING_CONVERSATIONS = Object.freeze([] as const);

type ProjectHandlers = Pick<
  FantayProjectBridgeInput,
  'onNewConversation' | 'onSelectConversation' | 'onConversationUpdated' | 'onConversationDeleted' | 'onChangeDesignSystem' | 'onOpenSettings'
>;

interface Publication {
  owner: object;
  session: FantayProjectSession;
  handlers: { readonly current: ProjectHandlers };
}

let publication: Publication | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSessionSnapshot(): FantayProjectSession | null {
  return publication?.session ?? null;
}

function getServerSessionSnapshot(): FantayProjectSession | null {
  return null;
}

/** Non-hook read of the live session (null when none is published). */
export function getActiveProjectSession(): FantayProjectSession | null {
  return getSessionSnapshot();
}

/** Call unconditionally from ProjectView; no-op when the shell is off. Publishes on change, clears on unmount if still owner. */
export function useFantayProjectBridge(input: FantayProjectBridgeInput): void {
  const enabled = useFantayShellEnabled();
  const ownerRef = useRef<object | null>(null);
  if (ownerRef.current === null) ownerRef.current = {};
  const handlersRef = useRef<ProjectHandlers>(input);
  handlersRef.current = {
    onNewConversation: input.onNewConversation,
    onSelectConversation: input.onSelectConversation,
    onConversationUpdated: input.onConversationUpdated,
    onConversationDeleted: input.onConversationDeleted,
    onChangeDesignSystem: input.onChangeDesignSystem,
    onOpenSettings: input.onOpenSettings,
  };

  const {
    projectId,
    projectName,
    designSystemId,
    designSystems,
    conversations,
    activeConversationId,
    runningConversationIds,
    readOnly,
    projectMetadata,
    mediaProviders,
  } = input;
  const runningIdsKey = runningConversationIds.join('\u0000');
  const runningIdsRef = useRef(runningConversationIds);
  runningIdsRef.current = runningConversationIds;

  useEffect(() => {
    if (!enabled) return;
    publication = {
      owner: ownerRef.current as object,
      handlers: handlersRef,
      session: {
        projectId,
        projectName,
        designSystemId,
        designSystems,
        conversations,
        activeConversationId,
        runningConversationIds: runningIdsRef.current,
        readOnly,
        projectMetadata,
        mediaProviders,
      },
    };
    emit();
  }, [
    enabled,
    projectId,
    projectName,
    designSystemId,
    designSystems,
    conversations,
    activeConversationId,
    runningIdsKey,
    readOnly,
    projectMetadata,
    mediaProviders,
  ]);

  // Separate from the publish effect so a field change republishes without a transient null.
  useEffect(() => {
    if (!enabled) return undefined;
    const owner = ownerRef.current;
    return () => {
      if (publication?.owner !== owner) return;
      publication = null;
      emit();
    };
  }, [enabled]);
}

/** Live session for `projectId` (or the current one when omitted); null when none / other project. */
export function useActiveProjectSession(projectId?: string): FantayProjectSession | null {
  const session = useSyncExternalStore(subscribe, getSessionSnapshot, getServerSessionSnapshot);
  if (!session) return null;
  if (projectId !== undefined && session.projectId !== projectId) return null;
  return session;
}

/** Runs through ProjectView's own handlers; false when no live session for projectId. */
export function runProjectCommand(projectId: string, command: FantayProjectCommand): boolean {
  const current = publication;
  if (!current || current.session.projectId !== projectId) return false;
  const handlers = current.handlers.current;
  switch (command.kind) {
    case 'conversationUpdated':
      handlers.onConversationUpdated?.(command.conversation);
      return true;
    case 'conversationDeleted':
      void handlers.onConversationDeleted?.(command.conversationId);
      return true;
    case 'newConversation':
      void handlers.onNewConversation();
      return true;
    case 'selectConversation':
      handlers.onSelectConversation(command.conversationId);
      return true;
    case 'changeDesignSystem':
      handlers.onChangeDesignSystem(command.designSystemId);
      return true;
    case 'openSettings':
      handlers.onOpenSettings(command.section);
      return true;
    default: {
      const unknownCommand: never = command;
      void unknownCommand;
      return false;
    }
  }
}

export function resetFantayProjectBridgeForTests(): void {
  publication = null;
  emit();
}
