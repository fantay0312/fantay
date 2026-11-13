import { createRequire } from 'node:module';

/** Kept external in packaged builds so the platform-specific executable remains intact. */
export function jianyingFfprobe(): string {
  const packageInfo = createRequire(import.meta.url)('@ffprobe-installer/ffprobe') as { path: string };
  return packageInfo.path;
}
