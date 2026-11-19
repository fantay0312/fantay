// SPDX-License-Identifier: AGPL-3.0-only
// One worker holds one open deck. Parsing and drawing happen here because the file is untrusted
// and may be large: a deck that hangs the engine or exhausts memory takes this worker with it, and
// the viewer ends it after a time limit. Each engine is loaded on first use, so an OpenDocument
// outline never downloads the PowerPoint renderer.
/// <reference lib="webworker" />
import type { OpenDeck } from './pptx-deck';
import type { DeckFailure, DeckRequest, DeckResponse } from './protocol';

let deck: OpenDeck | null = null;

function reply(response: DeckResponse): void {
  self.postMessage(response);
}

/** Engine errors carry a `failure` code; anything else means the file could not be read. */
function failureOf(error: unknown): DeckFailure {
  const code = (error as { failure?: unknown } | null)?.failure;
  return code === 'too-large' || code === 'empty' || code === 'invalid' ? code : 'invalid';
}

async function handle(request: DeckRequest): Promise<void> {
  try {
    if (request.type === 'open') {
      if (request.kind === 'odp') {
        const { openOdp } = await import('./odp-outline');
        reply({ id: request.id, type: 'opened', deck: openOdp(request.bytes) });
        return;
      }
      const { openPptx } = await import('./pptx-deck');
      deck = await openPptx(request.bytes);
      reply({ id: request.id, type: 'opened', deck: deck.info });
      return;
    }
    if (!deck) throw new Error('no deck');
    const { svg, unsupported } = deck.render(request.index);
    reply({
      id: request.id,
      type: 'rendered',
      index: request.index,
      image: new Blob([svg], { type: 'image/svg+xml' }),
      unsupported,
    });
  } catch (error) {
    reply({ id: request.id, type: 'failed', failure: failureOf(error) });
  }
}

self.addEventListener('message', (event: MessageEvent<DeckRequest>) => {
  void handle(event.data);
});
