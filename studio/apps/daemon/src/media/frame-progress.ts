import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The desktop records completed frame writes beside the frames shared with the daemon. */
export function watchFrameCaptureProgress(outputDir: string, report?: (message: string) => void): () => void {
  let active = true, reading = false;
  const timer = setInterval(async () => {
    if (!active || reading || !report) return;
    reading = true;
    try {
      const { completed, total } = JSON.parse(await readFile(path.join(outputDir, 'capture-progress.json'), 'utf8'));
      if (active && Number.isInteger(completed) && Number.isInteger(total) && total > 0 && completed >= 0 && completed <= total) report(`Frames ${completed}/${total}`);
    } catch { /* Capture setup or an in-flight progress write; try the next tick. */ }
    finally { reading = false; }
  }, 750);
  timer.unref?.();
  return () => { active = false; clearInterval(timer); };
}
