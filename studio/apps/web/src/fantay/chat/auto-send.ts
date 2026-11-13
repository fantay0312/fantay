// SPDX-License-Identifier: AGPL-3.0-only
// One-shot first message for a newly created project (spec 07 §2.1(c)). Uses the same sessionStorage
// handshake App.tsx and DesignSystemFlow.tsx write; ProjectView sends the prompt once as the first user
// message when the conversation is ready, then clears the keys.

export function autoSendFirstMessageKey(projectId: string): string {
  return `od:auto-send-first:${projectId}`;
}

export function autoSendPromptKey(projectId: string): string {
  return `od:auto-send-prompt:${projectId}`;
}

/** Writes sessionStorage['od:auto-send-first:<id>'] = '1' and ['od:auto-send-prompt:<id>'] = prompt; false when storage throws. */
export function stageProjectAutoSend(projectId: string, prompt: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.sessionStorage.setItem(autoSendFirstMessageKey(projectId), '1');
    window.sessionStorage.setItem(autoSendPromptKey(projectId), prompt);
    return true;
  } catch {
    // Never leave the "send first" flag without its prompt (e.g. the second write hit the quota).
    try {
      window.sessionStorage.removeItem(autoSendFirstMessageKey(projectId));
    } catch {
      // Storage is unavailable altogether; nothing was staged.
    }
    return false;
  }
}
