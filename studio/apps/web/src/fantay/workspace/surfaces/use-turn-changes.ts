// SPDX-License-Identifier: AGPL-3.0-only
// What the latest assistant turn changed, for the 代码 surface and the start page's suggestion.
// "Latest turn" is the last assistant message only: once a later turn edits nothing, the list is
// empty again rather than showing an older turn's edits under 本轮更改.
import { useMemo } from 'react';

import type { ChatMessage, ProjectFile } from '../../../types';
import type { TurnFileChange } from './surface-types';
import { collectTurnFileChanges } from './turn-changes';

const NO_CHANGES: readonly TurnFileChange[] = [];

export function useLatestTurnChanges(
  messages: readonly ChatMessage[],
  files: readonly ProjectFile[],
  resolvedDir: string | null,
): readonly TurnFileChange[] {
  let latest: ChatMessage | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      latest = message;
      break;
    }
  }
  const events = latest?.events;
  // A streaming message is replaced on every delta, but only a new event can change the answer, so the
  // memo keys on the event count instead of the message identity.
  const eventCount = events?.length ?? 0;
  const messageId = latest?.id ?? null;
  // Only the names matter. The file list is replaced on every refresh (new mtimes), and the 代码
  // surface rebuilds a file's before-text whenever this result changes identity, so the memo keys
  // on the names and not on the array.
  const fileNamesKey = files.map((file) => file.name).join('\n');
  // The names the project had when the turn started tell a new file from an overwritten one.
  const preTurnKey = latest?.preTurnFileNames?.join('\n') ?? null;
  return useMemo(() => {
    if (!events || eventCount === 0) return NO_CHANGES;
    const changes = collectTurnFileChanges(events, {
      resolvedDir,
      fileNames: fileNamesKey ? fileNamesKey.split('\n') : [],
      preTurnFileNames: preTurnKey === null ? null : new Set(preTurnKey ? preTurnKey.split('\n') : []),
    });
    return changes.length > 0 ? changes : NO_CHANGES;
    // `events` is read through the count/id key on purpose (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, eventCount, fileNamesKey, preTurnKey, resolvedDir]);
}
