export const FANTAY_RELEASE_TIME_ZONE = 'Asia/Taipei';

/** Public versions always preserve four date digits: January 1 is YY.0101.N. */
export function parseFantayVersion(version: string): { date: string; sequence: number } {
  const match = /^(\d{2})\.(\d{4})\.([1-9]\d*)$/.exec(version);
  if (!match) throw new Error('Fantay versions use YY.MMDD.N, for example 26.0101.1');
  const year = 2000 + Number(match[1]), dayCode = Number(match[2]);
  const month = Math.floor(dayCode / 100), day = dayCode % 100, sequence = Number(match[3]);
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || sequence > 65535) throw new Error('Invalid calendar date or daily sequence (1–65535)');
  return { date, sequence };
}

export function fantayReleaseDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FANTAY_RELEASE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function nextFantayVersion(versions: readonly string[], date = fantayReleaseDay()): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Use a real release date in 2000–2099');
  let count = 0;
  for (const version of versions) {
    const existing = parseFantayVersion(version);
    if (existing.date > date) throw new Error('The release date cannot move backwards');
    if (existing.date === date) count = Math.max(count, existing.sequence);
  }
  const version = `${date.slice(2, 4)}.${date.slice(5, 7)}${date.slice(8, 10)}.${count + 1}`;
  parseFantayVersion(version);
  return version;
}

/** npm/Electron's SemVer field cannot contain padded numbers. This is an internal encoding only. */
export function fantayPackageVersion(version: string): string {
  try { parseFantayVersion(version); } catch { return version; }
  return version.split('.').map(Number).join('.');
}

/** Restore the public date spelling at runtime/packaging boundaries; leave historical SemVer untouched. */
export function fantayDisplayVersion(version: string): string {
  const match = /^(\d{1,2})\.(\d{3,4})\.([1-9]\d*)$/.exec(version);
  if (!match) return version;
  const display = `${match[1]!.padStart(2, '0')}.${match[2]!.padStart(4, '0')}.${match[3]}`;
  try { parseFantayVersion(display); return display; } catch { return version; }
}
