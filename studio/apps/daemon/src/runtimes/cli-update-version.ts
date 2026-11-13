/** Extract only known numeric or date/hash version formats; never guess ordering. */
export function normalizeCliVersion(raw: string | null | undefined): string | null {
  const match = raw?.trim().match(/(?:^|\s|v)(\d{4}\.\d{2}\.\d{2}-[a-zA-Z0-9]+|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|\s|\))/);
  return match?.[1] ?? null;
}

/** null means versions are incomparable, including different hashes on the same date. */
export function compareCliVersions(left: string, right: string): number | null {
  const a = normalizeCliVersion(left);
  const b = normalizeCliVersion(right);
  if (!a || !b) return null;
  if (a === b) return 0;
  const date = /^\d{4}\.\d{2}\.\d{2}-/;
  if (date.test(a) || date.test(b)) {
    if (!date.test(a) || !date.test(b)) return null;
    return a.slice(0, 10) === b.slice(0, 10) ? null : a.slice(0, 10).localeCompare(b.slice(0, 10));
  }
  const parts = (v: string): [string, string | undefined] => {
    const [base = '', pre] = v.split('+')[0]!.split(/-(.*)/s);
    return [base, pre];
  };
  const [baseA, preA] = parts(a);
  const [baseB, preB] = parts(b);
  const numbersA = baseA.split('.').map(Number);
  const numbersB = baseB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (numbersA[i] !== numbersB[i]) return numbersA[i]! < numbersB[i]! ? -1 : 1;
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const aa = preA.split('.');
  const bb = preB.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i]; const bv = bb[i];
    if (av === bv) continue;
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) < Number(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}
