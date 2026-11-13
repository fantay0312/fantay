// SPDX-License-Identifier: AGPL-3.0-only
// One playing `<audio>` on the board (spec 03 §3.5 counting, §4.5): audio never counts against the live budget,
// but starting one stops whichever audio played before.
export interface AudioPlayer {
  pause(): void;
}

let current: { id: string; player: AudioPlayer } | null = null;

/** Marks `id` as the playing audio and pauses the previous one. */
export function claimAudio(id: string, player: AudioPlayer): void {
  if (current && current.id !== id) {
    try {
      current.player.pause();
    } catch {
      /* the element may be gone */
    }
  }
  current = { id, player };
}

/** Releases `id` (paused, ended or unmounted). */
export function releaseAudio(id: string): void {
  if (current?.id === id) current = null;
}

export function playingAudioId(): string | null {
  return current?.id ?? null;
}

/** Test helper. */
export function resetAudioManagerForTests(): void {
  current = null;
}
