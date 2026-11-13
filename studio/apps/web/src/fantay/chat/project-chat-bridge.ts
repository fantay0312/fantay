// SPDX-License-Identifier: AGPL-3.0-only
// Project chat bridge (spec 07 §2.1(b)). ProjectView registers its programmatic send path once
// (`useProjectChatBridge`); in-workspace surfaces (motion editor, create flow, motion node) send AI tasks
// into the project's main chat column instead of owning a chat of their own.
import { useEffect, useRef } from 'react';

export interface ProjectChatSendOptions {
  /** Extra skills for this one turn; the motion editor always passes ['fantay-movie']. */
  skillIds?: string[];
  source: 'motion-editor' | 'motion-create' | 'motion-node';
}

export type ProjectChatSendResult =
  | { accepted: true }
  | { accepted: false; reason: 'no-chat' | 'busy' | 'rejected' };

export type ProjectChatSender = (prompt: string, options: { skillIds: string[] }) => Promise<boolean>;

interface SenderEntry {
  projectId: string;
  sender: ProjectChatSender;
  hooks: { busy: () => boolean; reveal: () => void };
}

// Stack: the most recent registration for a project wins; unregistering restores the previous one.
const entries: SenderEntry[] = [];

function senderFor(projectId: string): SenderEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.projectId === projectId) return entry;
  }
  return null;
}

export function registerProjectChatSender(
  projectId: string,
  sender: ProjectChatSender,
  hooks: { busy: () => boolean; reveal: () => void },
): () => void {
  const entry: SenderEntry = { projectId, sender, hooks };
  entries.push(entry);
  return () => {
    const index = entries.lastIndexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  };
}

/** 'no-chat' when no ProjectView is mounted for projectId; 'busy' when a run is in flight; 'rejected' when the send fails. */
export async function sendToProjectChat(
  projectId: string,
  prompt: string,
  options: ProjectChatSendOptions,
): Promise<ProjectChatSendResult> {
  const entry = senderFor(projectId);
  if (!entry) return { accepted: false, reason: 'no-chat' };
  if (entry.hooks.busy()) return { accepted: false, reason: 'busy' };
  let accepted = false;
  try {
    accepted = (await entry.sender(prompt, { skillIds: [...(options.skillIds ?? [])] })) === true;
  } catch {
    accepted = false;
  }
  return accepted ? { accepted: true } : { accepted: false, reason: 'rejected' };
}

/** Un-collapses the chat column (workspace focus mode off). Returns false when no chat is mounted. */
export function revealProjectChat(projectId: string): boolean {
  const entry = senderFor(projectId);
  if (!entry) return false;
  entry.hooks.reveal();
  return true;
}

/** React wrapper used once in ProjectView. Registers per projectId; always calls the latest send/busy/reveal. */
export function useProjectChatBridge(args: {
  projectId: string;
  busy: boolean;
  send: ProjectChatSender;
  reveal: () => void;
}): void {
  const latest = useRef(args);
  latest.current = args;
  const { projectId } = args;
  useEffect(
    () => registerProjectChatSender(
      projectId,
      (prompt, options) => latest.current.send(prompt, options),
      { busy: () => latest.current.busy, reveal: () => latest.current.reveal() },
    ),
    [projectId],
  );
}

export function resetProjectChatBridgeForTests(): void {
  entries.length = 0;
}
