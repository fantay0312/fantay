// SPDX-License-Identifier: AGPL-3.0-only
// The order pages are drawn in. Several pages enter the window at once (a jump, a fast scroll); pdf.js
// draws on the main thread, so drawing them all together makes every one of them late. The queue
// runs one job at a time and always picks the page nearest to the middle of the window, asking for
// the distance when it picks, not when the job was queued, so the order follows the scroll.

export interface PdfRenderQueue {
  /**
   * Queues a job. `distance` is asked each time a job is picked; the lowest wins. Returns a function
   * that withdraws the job if it has not started; a job that has started stops through its own
   * cancellation.
   */
  enqueue(distance: () => number, run: () => Promise<void>): () => void;
  /** A paused queue starts nothing new (the tab is not the visible one). */
  setPaused(paused: boolean): void;
  /** Number of jobs waiting or running. */
  readonly size: number;
}

interface Job {
  distance: () => number;
  run: () => Promise<void>;
}

export function createPdfRenderQueue(concurrency = 1): PdfRenderQueue {
  const waiting = new Set<Job>();
  let running = 0;
  let paused = false;

  const pump = (): void => {
    while (!paused && running < concurrency && waiting.size > 0) {
      let next: Job | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const job of waiting) {
        const distance = job.distance();
        if (next === null || distance < best) {
          next = job;
          best = distance;
        }
      }
      if (next === null) return;
      waiting.delete(next);
      running += 1;
      // A job that throws is the job's own business (it shows its page as failed); the queue goes on.
      void next
        .run()
        .catch(() => undefined)
        .then(() => {
          running -= 1;
          pump();
        });
    }
  };

  return {
    enqueue(distance, run) {
      const job: Job = { distance, run };
      waiting.add(job);
      // Started on a microtask, so jobs queued in the same commit compete on distance.
      queueMicrotask(pump);
      return () => {
        waiting.delete(job);
      };
    },
    setPaused(next) {
      paused = next;
      if (!paused) pump();
    },
    get size() {
      return waiting.size + running;
    },
  };
}
