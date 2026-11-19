const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Rank metadata only. Catalog size never determines the size of one response. */
export function catalogPage<T>(
  rows: readonly T[], query: string, offset: number,
  metadata: (row: T) => { id: string; terms: readonly string[] },
) {
  const phrase = query.trim().toLowerCase();
  if (phrase.length > 240) throw new Error('query must be at most 240 characters');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  const words = [...new Set([...segmenter.segment(phrase.replace(/[_./-]+/gu, ' '))]
    .filter(part => part.isWordLike && part.segment.length > 1)
    .map(part => part.segment))];
  const ranked = rows.flatMap((row) => {
    const { id, terms } = metadata(row);
    const name = id.toLowerCase();
    const haystack = [name, ...terms].join(' ').toLowerCase();
    let score = 0;
    if (phrase) {
      if (name === phrase) score += 1000;
      if (haystack.includes(phrase)) score += 20;
      for (const word of words) {
        if (name.includes(word)) score += 6;
        else if (haystack.includes(word)) score += 2;
      }
      if (!score) return [];
    }
    return [{ row, id, score }];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'));
  const page = ranked.slice(offset, offset + 6);
  return {
    items: page.map(entry => entry.row),
    nextOffset: offset + page.length < ranked.length ? offset + page.length : null,
  };
}

export function shortDescription(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 180);
}
