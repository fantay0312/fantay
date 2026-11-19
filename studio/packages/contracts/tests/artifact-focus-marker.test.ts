import { describe, it, expect } from 'vitest';
import {
  ARTIFACT_FOCUS_TOOLS,
  MAX_ARTIFACT_FOCUS_SHOW,
  MAX_ARTIFACT_FOCUS_URL_LENGTH,
  foldArtifactFocusSelections,
  declaredArtifactCards,
  narrowProducedFilesToFocus,
  normalizeArtifactFocusPath,
  normalizeArtifactFocusTool,
  normalizeArtifactFocusUrl,
  parseArtifactFocusMarker,
  parseArtifactFocusPathList,
  renderArtifactFocusInstruction,
  renderArtifactFocusMarkerExample,
  stripArtifactFocusMarkers,
  type ArtifactFocusSelection,
} from '../src/api/artifact-focus-marker';

/**
 * Fixtures follow the shapes in real recordings under `.od/runs/*'/events.jsonl`:
 * `producedFiles` entries are `ProjectFile` objects (name/path/size/mtime/kind/mime),
 * never bare strings, and the turn key is the 16-hex nonce the daemon mints
 * (`{"type":"done_key","key":"c07a83a9bc73cbd6"}`).
 */
const KEY = 'c07a83a9bc73cbd6';

function file(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    path: name,
    size: 2048,
    mtime: 1787787535451,
    kind: name.endsWith('.html') ? 'html' : 'text',
    mime: name.endsWith('.html') ? 'text/html' : 'text/plain',
    ...extra,
  };
}

describe('normalizeArtifactFocusPath — the untrusted-path boundary', () => {
  it('keeps an ordinary project-relative path', () => {
    expect(normalizeArtifactFocusPath('index.html')).toBe('index.html');
    expect(normalizeArtifactFocusPath('site/zh/index.html')).toBe('site/zh/index.html');
  });

  it('normalizes the shapes models actually write', () => {
    expect(normalizeArtifactFocusPath('./index.html')).toBe('index.html');
    expect(normalizeArtifactFocusPath('  index.html  ')).toBe('index.html');
    expect(normalizeArtifactFocusPath('`index.html`')).toBe('index.html');
    expect(normalizeArtifactFocusPath('"report.md"')).toBe('report.md');
    expect(normalizeArtifactFocusPath('site\\zh\\index.html')).toBe('site/zh/index.html');
    expect(normalizeArtifactFocusPath('site//zh///index.html')).toBe('site/zh/index.html');
  });

  /*
   * The security half. Each of these is a path the host would otherwise READ
   * and render, so every one must come back null — not "sanitized".
   */
  it('refuses anything that escapes the project root', () => {
    for (const hostile of [
      '../../../etc/passwd',
      '..',
      '../secrets.env',
      'a/../../b',
      'site/../../etc/hosts',
      '/etc/passwd',
      '/Users/elian/.ssh/id_rsa',
      'C:/Windows/System32/config/SAM',
      'C:\\Windows\\System32\\config\\SAM',
      '//evil-host/share/x',
      'file:///etc/passwd',
      'data:text/html,<script>x</script>',
      'https://example.com/x.html',
      'index.html\u0000.png',
      '',
      '   ',
    ]) {
      expect(normalizeArtifactFocusPath(hostile), `${JSON.stringify(hostile)} must be refused`).toBeNull();
    }
  });

  it('refuses a path past the length and depth ceilings', () => {
    expect(normalizeArtifactFocusPath('a/'.repeat(40) + 'x.html')).toBeNull();
    expect(normalizeArtifactFocusPath('x'.repeat(2000) + '.html')).toBeNull();
  });

  it('refuses non-strings rather than coercing them', () => {
    expect(normalizeArtifactFocusPath(null)).toBeNull();
    expect(normalizeArtifactFocusPath(undefined)).toBeNull();
    expect(normalizeArtifactFocusPath(42)).toBeNull();
    expect(normalizeArtifactFocusPath({ toString: () => 'index.html' })).toBeNull();
  });
});

describe('parseArtifactFocusPathList', () => {
  it('splits on commas and trims', () => {
    expect(parseArtifactFocusPathList('index.html, report.md')).toEqual(['index.html', 'report.md']);
  });

  it('drops one bad entry without discarding its neighbours', () => {
    expect(parseArtifactFocusPathList('index.html, ../../etc/passwd, report.md')).toEqual([
      'index.html',
      'report.md',
    ]);
  });

  it('dedupes and caps', () => {
    expect(parseArtifactFocusPathList('a.html, ./a.html, a.html')).toEqual(['a.html']);
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.html`).join(', ');
    expect(parseArtifactFocusPathList(many)).toHaveLength(MAX_ARTIFACT_FOCUS_SHOW);
  });

  it('returns [] for nothing usable', () => {
    expect(parseArtifactFocusPathList('')).toEqual([]);
    expect(parseArtifactFocusPathList('  ,  , ')).toEqual([]);
    expect(parseArtifactFocusPathList(null)).toEqual([]);
  });
});

describe('parseArtifactFocusMarker', () => {
  it('reads key, open, and show off one self-closing tag', () => {
    const parsed = parseArtifactFocusMarker(
      `<od-focus key="${KEY}" open="index.html" show="index.html, report.md"/>`,
    );
    expect(parsed.key).toBe(KEY);
    expect(parsed.open).toBe('index.html');
    expect(parsed.show).toEqual(['index.html', 'report.md']);
  });

  it('tolerates single quotes and unquoted values — model formatting drifts', () => {
    const parsed = parseArtifactFocusMarker(`<od-focus key='${KEY}' open=index.html>`);
    expect(parsed.key).toBe(KEY);
    expect(parsed.open).toBe('index.html');
  });

  it('surfaces an absolute open as rawOpen so the daemon can rebase it', () => {
    const parsed = parseArtifactFocusMarker(
      `<od-focus key="${KEY}" open="/Users/elian/proj/index.html"/>`,
    );
    // Absolute is refused by the pure normalizer — only the daemon knows the root.
    expect(parsed.open).toBeNull();
    expect(parsed.rawOpen).toBe('/Users/elian/proj/index.html');
  });

  it('an attribute-less marker parses to an empty selection, not a throw', () => {
    const parsed = parseArtifactFocusMarker('<od-focus/>');
    expect(parsed.key).toBe('');
    expect(parsed.open).toBeNull();
    expect(parsed.show).toEqual([]);
  });
});

describe('normalizeArtifactFocusTool', () => {
  it('accepts every listed tool, whatever the case or padding', () => {
    for (const tool of ARTIFACT_FOCUS_TOOLS) {
      expect(normalizeArtifactFocusTool(tool)).toBe(tool);
      expect(normalizeArtifactFocusTool(`  ${tool.toUpperCase()} `)).toBe(tool);
    }
  });

  it('forgives the two spellings models write instead of the hyphen', () => {
    expect(normalizeArtifactFocusTool('design_system')).toBe('design-system');
    expect(normalizeArtifactFocusTool('DesignSystem')).toBe('design-system');
  });

  it('refuses anything else rather than guessing', () => {
    for (const unknown of ['terminal', 'editor', 'design system', 'codes', '', '   ', null, undefined, 3, ['code']]) {
      expect(normalizeArtifactFocusTool(unknown), `${JSON.stringify(unknown)} must be refused`).toBeNull();
    }
  });
});

describe('normalizeArtifactFocusUrl — the untrusted-address boundary', () => {
  it('keeps an ordinary http(s) address', () => {
    expect(normalizeArtifactFocusUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeArtifactFocusUrl('http://localhost:5173/app?tab=2#top')).toBe(
      'http://localhost:5173/app?tab=2#top',
    );
    expect(normalizeArtifactFocusUrl('  https://example.com/docs  ')).toBe('https://example.com/docs');
  });

  /*
   * What comes back is the parser's serialization, so what was validated is
   * exactly what gets loaded — and a second pass changes nothing, which is what
   * lets the daemon, the stored event and the web agree on one string.
   */
  it('returns the canonical spelling, and normalizing twice is a no-op', () => {
    const once = normalizeArtifactFocusUrl('HTTPS://Example.COM');
    expect(once).toBe('https://example.com/');
    expect(normalizeArtifactFocusUrl(once)).toBe(once);
  });

  /*
   * Why the serialization and not the input: these spellings read as one site
   * to a person (or to a naive `split('@')`) and load another. Handing back the
   * parser's own reading means the string shown and the string loaded cannot
   * disagree, whichever component reads it next.
   */
  it('hands back the parser\'s reading of a spelling that could be read two ways', () => {
    // A backslash is a path separator for http(s): the host is example.com.
    expect(normalizeArtifactFocusUrl('https://example.com\\@evil.example/')).toBe(
      'https://example.com/@evil.example/',
    );
    // Extra slashes are skipped, not turned into an empty host.
    expect(normalizeArtifactFocusUrl('https:///example.com/a')).toBe('https://example.com/a');
    // An internationalized host comes back in its ASCII form, so a look-alike
    // letter cannot pass for the name it imitates.
    expect(normalizeArtifactFocusUrl('https://аpple.com/')).toBe('https://xn--pple-43d.com/');
    // The plain credential form is refused outright rather than rewritten.
    expect(normalizeArtifactFocusUrl('https://example.com@evil.example/')).toBeNull();
  });

  /* Each of these is an address the host would otherwise NAVIGATE to. */
  it('refuses everything that is not a plain http(s) address with a host', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'chrome://settings',
      '//example.com/x',
      'example.com/docs',
      'index.html',
      'http:example.com',
      'http:\\\\example.com',
      'https://',
      'https://user:pass@example.com/',
      'https://user@example.com/',
      'https://example.com/a b',
      'https://example.com/\nmalicious',
      'https://exa\tmple.com/',
      'https://example.com/\u0000',
      `https://example.com/${'a'.repeat(MAX_ARTIFACT_FOCUS_URL_LENGTH)}`,
      '',
      '   ',
    ]) {
      expect(normalizeArtifactFocusUrl(hostile), `${JSON.stringify(hostile)} must be refused`).toBeNull();
    }
  });

  it('refuses non-strings rather than coercing them', () => {
    expect(normalizeArtifactFocusUrl(null)).toBeNull();
    expect(normalizeArtifactFocusUrl(undefined)).toBeNull();
    expect(normalizeArtifactFocusUrl(new URL('https://example.com/'))).toBeNull();
  });
});

describe('parseArtifactFocusMarker — tool and url', () => {
  it('reads tool next to open', () => {
    const parsed = parseArtifactFocusMarker(`<od-focus key="${KEY}" tool="code" open="src/app.ts"/>`);
    expect(parsed.key).toBe(KEY);
    expect(parsed.tool).toBe('code');
    expect(parsed.open).toBe('src/app.ts');
    expect(parsed.url).toBeUndefined();
  });

  it('a marker with tool and neither open nor show is a valid marker', () => {
    for (const tool of ['code', 'files', 'board', 'design-system', 'preview'] as const) {
      const parsed = parseArtifactFocusMarker(`<od-focus key="${KEY}" tool="${tool}"/>`);
      expect(parsed.key).toBe(KEY);
      expect(parsed.tool).toBe(tool);
      expect(parsed.open).toBeNull();
      expect(parsed.show).toEqual([]);
    }
  });

  it('reads url next to tool="browser"', () => {
    const parsed = parseArtifactFocusMarker(
      `<od-focus key="${KEY}" tool="browser" url="https://example.com/docs"/>`,
    );
    expect(parsed.tool).toBe('browser');
    expect(parsed.url).toBe('https://example.com/docs');
    expect(parsed.open).toBeNull();
  });

  it('tolerates single quotes, no quotes and a different attribute order', () => {
    expect(
      parseArtifactFocusMarker(`<od-focus url='https://example.com/a/b' tool='browser' key='${KEY}'/>`),
    ).toMatchObject({ key: KEY, tool: 'browser', url: 'https://example.com/a/b' });
    // Bare: the address keeps its slashes and stops at the tag's own `/>`.
    expect(
      parseArtifactFocusMarker(`<od-focus key=${KEY} tool=browser url=https://example.com/a/b/>`),
    ).toMatchObject({ key: KEY, tool: 'browser', url: 'https://example.com/a/b' });
    expect(
      parseArtifactFocusMarker(`<od-focus key=${KEY} url=https://example.com/a tool=Browser>`),
    ).toMatchObject({ key: KEY, tool: 'browser', url: 'https://example.com/a' });
  });

  /*
   * 「An unknown tool value is dropped and the rest of the marker behaves
   * exactly as before」— compared field by field against the same marker
   * without the attribute, so "as before" is checked rather than restated.
   */
  it('drops an unknown tool and leaves the rest of the marker exactly as it was', () => {
    const without = parseArtifactFocusMarker(
      `<od-focus key="${KEY}" open="index.html" show="index.html, report.md"/>`,
    );
    const withUnknown = parseArtifactFocusMarker(
      `<od-focus key="${KEY}" tool="terminal" open="index.html" show="index.html, report.md"/>`,
    );
    expect(withUnknown).toEqual(without);
    expect('tool' in withUnknown).toBe(false);
  });

  it('keeps url only for the browser tool', () => {
    const parsed = parseArtifactFocusMarker(
      `<od-focus key="${KEY}" tool="code" open="src/app.ts" url="https://example.com/"/>`,
    );
    expect(parsed.tool).toBe('code');
    expect(parsed.open).toBe('src/app.ts');
    expect('url' in parsed).toBe(false);
    // …and never without a tool at all.
    expect('url' in parseArtifactFocusMarker(`<od-focus key="${KEY}" url="https://example.com/"/>`)).toBe(false);
  });

  it('drops a bad url but keeps the browser tool it came with', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com/', 'index.html']) {
      const parsed = parseArtifactFocusMarker(`<od-focus key="${KEY}" tool="browser" url="${bad}"/>`);
      expect(parsed.tool, `${bad} must not cost the tool`).toBe('browser');
      expect('url' in parsed, `${bad} must be dropped`).toBe(false);
    }
  });

  /*
   * A query string is made of `name=value` pairs, and the attribute regexes
   * match a name anywhere in the tag. Without cutting the address out first,
   * `?open=readme.md` becomes the marker's `open` — which the daemon then
   * holds, waiting for a file, and the browser never opens.
   */
  it('never reads the address\'s query string as the marker\'s own attributes', () => {
    const parsed = parseArtifactFocusMarker(
      `<od-focus url="https://example.com/s?key=zzzz9999&open=readme.md&show=a.md&tool=code" tool="browser" key="${KEY}"/>`,
    );
    expect(parsed.key).toBe(KEY);
    expect(parsed.tool).toBe('browser');
    expect(parsed.open).toBeNull();
    expect(parsed.rawOpen).toBe('');
    expect(parsed.show).toEqual([]);
    expect(parsed.url).toBe('https://example.com/s?key=zzzz9999&open=readme.md&show=a.md&tool=code');
  });

  /*
   * The other direction of the same hazard. `tool` and `url` arrived after
   * markers were already being written, so a path that happens to contain
   * `tool=` or `url=` must parse exactly as it did before they existed.
   */
  it('never grows a tool or url out of a path\'s own value', () => {
    // `tool=code` sits last so a name-anywhere match would read a VALID tool.
    const value = 'pages/view.html?url=x&tool=code';
    const parsed = parseArtifactFocusMarker(`<od-focus key="${KEY}" open="${value}"/>`);
    // The value is read whole — nothing was cut out of it.
    expect(parsed.rawOpen).toBe(value);
    expect(parsed.open).toBe(value);
    expect('tool' in parsed).toBe(false);
    expect('url' in parsed).toBe(false);
  });

  it('is still stripped whole, whatever it carries', () => {
    expect(
      stripArtifactFocusMarkers(
        `前。<od-focus key="${KEY}" tool="browser" url="https://example.com/a?b=1&c=2"/>后。`,
      ),
    ).toBe('前。后。');
  });
});

describe('stripArtifactFocusMarkers — the marker never reaches the reader', () => {
  it('removes the tag and every attribute fragment with it', () => {
    const out = stripArtifactFocusMarkers(
      `已完成。<od-focus key="${KEY}" open="index.html" show="index.html"/>\n文件已保存。`,
    );
    expect(out).not.toContain('<od-focus');
    expect(out).not.toContain('od-focus');
    expect(out).not.toContain('key=');
    expect(out).not.toContain('open=');
    expect(out).not.toContain(KEY);
    expect(out).toContain('已完成。');
    expect(out).toContain('文件已保存。');
  });

  it('removes a wrongly-keyed, unkeyed, or unclosed marker just the same', () => {
    for (const marker of [
      '<od-focus key="not-this-turns-key" open="index.html"/>',
      '<od-focus open="index.html"/>',
      '<od-focus>',
      '</od-focus>',
      '<od-focus key="' + KEY + '">',
    ]) {
      const out = stripArtifactFocusMarkers(`前。${marker}后。`);
      expect(out, `${marker} leaked`).not.toContain('od-focus');
      expect(out).toBe('前。后。');
    }
  });

  /*
   * Positive control. Without this, replacing the pattern with `/<[^>]*>/g`
   * would turn every assertion above green while destroying real prose — the
   * exact fake fix the `<MUST_FIX>` leak taught us to test against.
   */
  it('leaves everything that merely looks like the marker alone', () => {
    const innocent = [
      '普通 HTML:<div class="x">hi</div> 和 <span>y</span>。',
      '复数或多一截的拼法 <od-focuses> / <od-focused> 不是这个标记。',
      '别的协议标记 <od-done key="x"/> 不归这里管。',
      '正文里裸写 od-focus 这个词(没有尖括号)要留着。',
      '数学写法 a<b 和 5 < 7 也要留着。',
    ].join('\n');
    expect(stripArtifactFocusMarkers(innocent)).toBe(innocent);
  });

  it('is a no-op on text with no angle bracket at all', () => {
    expect(stripArtifactFocusMarkers('就是一句普通的话。')).toBe('就是一句普通的话。');
  });
});

describe('renderArtifactFocusMarkerExample — prompt and parser cannot drift', () => {
  it('round-trips through the parser', () => {
    const rendered = renderArtifactFocusMarkerExample(KEY, {
      open: 'index.html',
      show: ['index.html', 'report.md'],
    });
    const parsed = parseArtifactFocusMarker(rendered);
    expect(parsed.key).toBe(KEY);
    expect(parsed.open).toBe('index.html');
    expect(parsed.show).toEqual(['index.html', 'report.md']);
  });

  it('omits an attribute it was not given', () => {
    expect(renderArtifactFocusMarkerExample(KEY, { open: 'index.html' })).toBe(
      `<od-focus key="${KEY}" open="index.html"/>`,
    );
  });

  it('writes tool and url in the wire format, and they read back', () => {
    const code = renderArtifactFocusMarkerExample(KEY, { tool: 'code', open: 'src/app.ts' });
    expect(code).toBe(`<od-focus key="${KEY}" tool="code" open="src/app.ts"/>`);
    expect(parseArtifactFocusMarker(code)).toMatchObject({ key: KEY, tool: 'code', open: 'src/app.ts' });

    const browser = renderArtifactFocusMarkerExample(KEY, { tool: 'browser', url: 'https://example.com/docs' });
    expect(browser).toBe(`<od-focus key="${KEY}" tool="browser" url="https://example.com/docs"/>`);
    expect(parseArtifactFocusMarker(browser)).toMatchObject({
      key: KEY,
      tool: 'browser',
      url: 'https://example.com/docs',
    });

    expect(renderArtifactFocusMarkerExample(KEY, { tool: 'files' })).toBe(
      `<od-focus key="${KEY}" tool="files"/>`,
    );
  });

  it('never writes a url the parser would drop', () => {
    expect(
      renderArtifactFocusMarkerExample(KEY, { tool: 'code', open: 'src/app.ts', url: 'https://example.com/' }),
    ).toBe(`<od-focus key="${KEY}" tool="code" open="src/app.ts"/>`);
    expect(renderArtifactFocusMarkerExample(KEY, { url: 'https://example.com/' })).toBe(
      `<od-focus key="${KEY}"/>`,
    );
  });
});

describe('foldArtifactFocusSelections — last wins, per field', () => {
  it('keeps an early open when a late marker only declares show', () => {
    expect(
      foldArtifactFocusSelections([{ open: 'index.html' }, { show: ['index.html', 'report.md'] }]),
    ).toEqual({ open: 'index.html', show: ['index.html', 'report.md'] });
  });

  it('the later value of the same field wins', () => {
    expect(foldArtifactFocusSelections([{ open: 'a.html' }, { open: 'b.html' }])).toEqual({
      open: 'b.html',
    });
    expect(
      foldArtifactFocusSelections([{ show: ['a.html'] }, { show: ['b.html', 'c.md'] }]),
    ).toEqual({ show: ['b.html', 'c.md'] });
  });

  it('no events folds to an empty selection', () => {
    expect(foldArtifactFocusSelections([])).toEqual({});
  });
});

/**
 * `tool` is not last-wins on its own: it says how the SAME marker's target is
 * shown, so it follows `open` rather than outliving it.
 */
describe('foldArtifactFocusSelections — tool follows its marker\'s open', () => {
  it('an event with open carries its tool into the fold', () => {
    expect(foldArtifactFocusSelections([{ open: 'src/app.ts', tool: 'code' }])).toEqual({
      open: 'src/app.ts',
      tool: 'code',
    });
  });

  /*
   * The case the rule exists for. Per-field last-wins would leave
   * `{ open: 'index.html', tool: 'code' }` — the page shown in the code tool,
   * which no marker ever asked for.
   */
  it('a later open without a tool clears the earlier tool', () => {
    expect(
      foldArtifactFocusSelections([{ open: 'src/app.ts', tool: 'code' }, { open: 'index.html' }]),
    ).toEqual({ open: 'index.html' });
  });

  it('a later open with another tool replaces it', () => {
    expect(
      foldArtifactFocusSelections([
        { open: 'index.html', tool: 'preview' },
        { open: 'src/app.ts', tool: 'code' },
      ]),
    ).toEqual({ open: 'src/app.ts', tool: 'code' });
  });

  it('a tool without open sets the tool and leaves open alone', () => {
    expect(foldArtifactFocusSelections([{ open: 'index.html' }, { tool: 'files' }])).toEqual({
      open: 'index.html',
      tool: 'files',
    });
    expect(
      foldArtifactFocusSelections([
        { open: 'index.html' },
        { tool: 'browser', url: 'https://example.com/docs' },
      ]),
    ).toEqual({ open: 'index.html', tool: 'browser', url: 'https://example.com/docs' });
  });

  it('a show-only event touches neither open nor tool', () => {
    expect(
      foldArtifactFocusSelections([{ open: 'src/app.ts', tool: 'code' }, { show: ['src/app.ts'] }]),
    ).toEqual({ open: 'src/app.ts', tool: 'code', show: ['src/app.ts'] });
    expect(
      foldArtifactFocusSelections([{ tool: 'board' }, { show: ['a.png', 'b.png'] }]),
    ).toEqual({ tool: 'board', show: ['a.png', 'b.png'] });
  });

  it('the address goes when its tool goes', () => {
    const browser: ArtifactFocusSelection = { tool: 'browser', url: 'https://example.com/docs' };
    expect(foldArtifactFocusSelections([browser, { tool: 'files' }])).toEqual({ tool: 'files' });
    expect(foldArtifactFocusSelections([browser, { open: 'index.html' }])).toEqual({ open: 'index.html' });
    // A later browser marker with no address means "the browser, wherever it is".
    expect(foldArtifactFocusSelections([browser, { tool: 'browser' }])).toEqual({ tool: 'browser' });
  });

  /*
   * Events come back from storage, so a value this build does not know is
   * possible. It is read as absent — which for an event with `open` means the
   * tool is cleared, the same as a marker that never named one.
   */
  it('reads a stored tool or address it does not know as absent', () => {
    const stored = [
      { open: 'src/app.ts', tool: 'code' },
      { open: 'index.html', tool: 'terminal' },
    ] as unknown as ArtifactFocusSelection[];
    expect(foldArtifactFocusSelections(stored)).toEqual({ open: 'index.html' });

    const unknownAlone = [{ open: 'index.html' }, { tool: 'terminal' }] as unknown as ArtifactFocusSelection[];
    expect(foldArtifactFocusSelections(unknownAlone)).toEqual({ open: 'index.html' });

    expect(
      foldArtifactFocusSelections([
        { tool: 'browser', url: 'javascript:alert(1)' },
        { tool: 'code', url: 'https://example.com/' },
      ]),
    ).toEqual({ tool: 'code' });
  });
});

describe('narrowProducedFilesToFocus — narrow only, never widen, never empty', () => {
  const produced = [
    file('index.html'),
    file('styles.css'),
    file('app.js'),
    file('hero.png', { kind: 'image', mime: 'image/png' }),
    file('logo.svg', { kind: 'image', mime: 'image/svg+xml' }),
    file('report.md'),
  ];

  /*
   * The product ruling, verbatim: 一个 html 可能会有 js 或 css 文件或者一堆图片
   * 文件,但最终主要的是这个 html。
   */
  it('a marker naming one html yields exactly that card', () => {
    expect(narrowProducedFilesToFocus(produced, ['index.html']).map((f) => f.name)).toEqual([
      'index.html',
    ]);
  });

  it('a marker naming two deliverables yields exactly those two, in list order', () => {
    expect(
      narrowProducedFilesToFocus(produced, ['report.md', 'index.html']).map((f) => f.name),
    ).toEqual(['index.html', 'report.md']);
  });

  /*
   * The fallback ruling, verbatim: 不发标记要么按现在规则展示。
   * Paired with the positive above so neither assertion can pass vacuously.
   */
  it('no marker leaves the inferred list byte-identical', () => {
    expect(narrowProducedFilesToFocus(produced, undefined)).toBe(produced);
    expect(narrowProducedFilesToFocus(produced, null)).toBe(produced);
    expect(narrowProducedFilesToFocus(produced, [])).toBe(produced);
  });

  it('never widens: a declared file the turn did not produce adds no card', () => {
    expect(
      narrowProducedFilesToFocus(produced, ['index.html', 'never-produced.html']).map((f) => f.name),
    ).toEqual(['index.html']);
  });

  it('an entirely unmatched declaration keeps the inferred list rather than emptying the panel', () => {
    expect(narrowProducedFilesToFocus(produced, ['nothing-here.html'])).toBe(produced);
    expect(narrowProducedFilesToFocus(produced, ['../../etc/passwd'])).toBe(produced);
  });

  it('matches a nested file by full path or by basename', () => {
    const nested = [file('site/index.html', { name: 'site/index.html', path: 'site/index.html' }), file('site/app.js')];
    expect(narrowProducedFilesToFocus(nested, ['site/index.html']).map((f) => f.name)).toEqual([
      'site/index.html',
    ]);
    expect(narrowProducedFilesToFocus(nested, ['index.html']).map((f) => f.name)).toEqual([
      'site/index.html',
    ]);
  });

  it('an empty produced list stays empty — narrowing cannot invent a turn', () => {
    expect(narrowProducedFilesToFocus([], ['index.html'])).toEqual([]);
  });
});

describe('declaredArtifactCards — the conversation lists what the turn declared', () => {
  const produced = [
    file('index.html'),
    file('styles.css'),
    file('app.js'),
    file('hero.png', { kind: 'image', mime: 'image/png' }),
    file('logo.svg', { kind: 'image', mime: 'image/svg+xml' }),
    file('report.md'),
  ];

  /*
   * This function is the NARROWING half and nothing else: a pure filter that
   * can only ever shrink the list it was handed. "No usable declaration" is
   * therefore `[]` here — but `[]` is not what the user sees on an undeclared
   * turn. The caller falls back to `pickPrimaryArtifacts` over the files the
   * turn wrote (see artifact-focus-primary.test.ts), because the original
   * ruling 「一张都不显示那就不显示呗」measured out at a 22% declaration rate on
   * edit-only turns, i.e. mostly empty panels (OPEND-2550).
   *
   * It still REVERSES `narrowProducedFilesToFocus`, which is why the two live
   * side by side rather than one calling the other: that one answers "what did
   * this turn deliver" for the Share / Download / next-step anchor, where an
   * undeclared turn must keep its inferred list.
   */
  it('no declaration lists nothing', () => {
    expect(declaredArtifactCards(produced, undefined)).toEqual([]);
    expect(declaredArtifactCards(produced, null)).toEqual([]);
    expect(declaredArtifactCards(produced, [])).toEqual([]);
  });

  /*
   * Paired with the negative above on purpose. On its own, "no declaration
   * lists nothing" is satisfied by a function that always returns `[]`.
   */
  it('a declaration naming one html lists exactly that card', () => {
    expect(declaredArtifactCards(produced, ['index.html']).map((f) => f.name)).toEqual([
      'index.html',
    ]);
  });

  it('a declaration naming two deliverables lists exactly those two, in list order', () => {
    expect(
      declaredArtifactCards(produced, ['report.md', 'index.html']).map((f) => f.name),
    ).toEqual(['index.html', 'report.md']);
  });

  it('never widens: a declared file the turn did not produce adds no card', () => {
    expect(
      declaredArtifactCards(produced, ['index.html', 'never-produced.html']).map((f) => f.name),
    ).toEqual(['index.html']);
  });

  /*
   * The cliff this closes: under a "fall back to the full list" rule, a typo
   * would show SIX cards where declaring nothing shows none.
   */
  it('an entirely unmatched declaration lists nothing, not the full list', () => {
    expect(declaredArtifactCards(produced, ['nothing-here.html'])).toEqual([]);
  });

  it('a declaration of only unusable paths counts as no declaration', () => {
    expect(declaredArtifactCards(produced, ['../../etc/passwd'])).toEqual([]);
    expect(declaredArtifactCards(produced, ['', '   '])).toEqual([]);
  });

  it('matches a nested file by full path or by basename', () => {
    const nested = [
      file('site/index.html', { name: 'site/index.html', path: 'site/index.html' }),
      file('site/app.js'),
    ];
    expect(declaredArtifactCards(nested, ['site/index.html']).map((f) => f.name)).toEqual([
      'site/index.html',
    ]);
    expect(declaredArtifactCards(nested, ['index.html']).map((f) => f.name)).toEqual([
      'site/index.html',
    ]);
  });

  it('an empty produced list stays empty — a declaration cannot invent a card', () => {
    expect(declaredArtifactCards([], ['index.html'])).toEqual([]);
  });
});

/**
 * The instruction body itself.
 *
 * `grep -c od-focus` across the recorded runs is 0: everything downstream of
 * this marker was built and tested before anything ever told a model to write
 * one. This suite pins the four things the instruction has to say, so a later
 * trim cannot quietly drop one and leave the protocol unreachable again.
 */
describe('renderArtifactFocusInstruction — what the model is actually told', () => {
  const body = renderArtifactFocusInstruction(KEY);

  it('shows the exact wire format the parser accepts, with this turn\'s key', () => {
    expect(body).toContain(renderArtifactFocusMarkerExample(KEY, { open: 'index.html' }));
    expect(body).toContain(
      renderArtifactFocusMarkerExample(KEY, { show: ['index.html', 'report.md'] }),
    );
    // Round-trips through the parser: the example is not merely key-shaped.
    const parsed = parseArtifactFocusMarker(
      renderArtifactFocusMarkerExample(KEY, { open: 'index.html', show: ['index.html'] }),
    );
    expect(parsed.key).toBe(KEY);
    expect(parsed.open).toBe('index.html');
    expect(parsed.show).toEqual(['index.html']);
  });

  /* 「不要在空的时候打开…能看到产物有内容了再打开?但也不要等完全写完再打开」 */
  it('times `open` at "has real content", between "created" and "turn over"', () => {
    expect(body).toMatch(/real content/i);
    expect(body).toMatch(/still empty/i);
    expect(body).toMatch(/end of the turn|turn ends|until the turn/i);
  });

  /* 「最终主要的是这个 html,而不是其他杂七杂八的东西」 */
  it('says `show` names the deliverable, not its sidecars', () => {
    expect(body).toMatch(/stylesheet/i);
    expect(body).toMatch(/ONE deliverable/);
  });

  /*
   * The root cause of the 22% declaration rate on edit-only turns, fixed in the
   * text itself.
   *
   * The instruction used to speak only of "a file you created this turn" and
   * "this turn's deliverables". A model that read that literally and decided a
   * small edit was not a delivery was reading it CORRECTLY — the measured rate
   * was 100% on turns that created a file and 22–25% on turns that only edited
   * one. Nothing downstream can recover a declaration the instruction talked
   * the model out of making, so this is pinned here.
   */
  it('says an edit is a delivery, not only a creation', () => {
    expect(body).toMatch(/created OR changed/);
    expect(body).toMatch(/Changing an existing file is delivering it/i);
    expect(body).toMatch(/only edited `index\.html`/);
  });

  /*
   * What silence actually does, stated truthfully.
   *
   * This used to assert `/no cards/i`, matching the original opt-in ruling. The
   * host now falls back to the main artifacts among the files the turn wrote,
   * so telling the model "declare nothing and you get no cards" is a lie —
   * and a lie the model has no way to detect. What it must be told instead is
   * that its declaration BEATS the fallback, which is what earns compliance
   * without misdescribing the panel.
   */
  it('states that `show` narrows, and that silence hands the pick to the host', () => {
    expect(body).toMatch(/`show` NARROWS/);
    expect(body).toMatch(/the host answers for you/i);
    expect(body).not.toMatch(/no cards at all/i);
  });

  it('says paths are project-relative', () => {
    expect(body).toMatch(/relative to the project root/i);
  });

  it('carries the turn key verbatim and forbids inventing one', () => {
    expect(body).toContain(KEY);
    expect(body).toMatch(/never invent one/i);
  });

  it('is empty without a key — an unkeyed marker is never accepted, so never taught', () => {
    expect(renderArtifactFocusInstruction('')).toBe('');
  });

  /*
   * The tool block. Every example line is fed back through the parser, so the
   * prompt cannot teach a spelling the daemon then drops — the drift that
   * `renderArtifactFocusMarkerExample` exists to rule out, checked for `tool`
   * and `url` the way the lines above check it for `open` and `show`.
   */
  describe('workspace tools', () => {
    const lines = body.split('\n');
    const start = lines.indexOf('Workspace tools:');
    const examples = lines.filter((line) => line.startsWith('<od-focus') && line.includes(' tool="'));

    it('teaches the tools in one block, after the artifact rules', () => {
      expect(start).toBeGreaterThan(0);
      expect(lines.filter((line) => line === 'Workspace tools:')).toHaveLength(1);
      expect(body.indexOf('Artifact focus:')).toBeLessThan(body.indexOf('Workspace tools:'));
    });

    it('shows one parseable example per tool, each with this turn\'s key', () => {
      const taught = examples.map((line) => parseArtifactFocusMarker(line.slice(0, line.indexOf('/>') + 2)));
      for (const parsed of taught) expect(parsed.key).toBe(KEY);
      // `preview` is the default and is taught as "leave tool out", not as a line.
      expect(taught.map((parsed) => parsed.tool)).toEqual(
        ARTIFACT_FOCUS_TOOLS.filter((tool) => tool !== 'preview'),
      );
      expect(taught.find((parsed) => parsed.tool === 'code')?.open).toBe('src/app.ts');
      expect(taught.find((parsed) => parsed.tool === 'browser')?.url).toBe('https://example.com/');
    });

    it('says when each tool fits, in the model\'s terms', () => {
      const block = lines.slice(start).join('\n');
      expect(block).toMatch(/tool="code"[^\n]*source work/);
      expect(block).toMatch(/tool="browser"[^\n]*web page/);
      expect(block).toMatch(/tool="files"[^\n]*no single main one/);
      expect(block).toMatch(/tool="board"[^\n]*side by side/);
      expect(block).toMatch(/tool="design-system"[^\n]*design system changed/);
    });

    /*
     * The default has to be restated, or the block reads as "always pick a
     * tool" and every page turn starts opening the code tool.
     */
    it('keeps previewing as the default and one tool marker as the norm', () => {
      expect(body).toMatch(/Leave tool out for a page, document, deck or image/);
      expect(body).toMatch(/One tool marker per turn is the norm/);
    });

    /*
     * This text is re-sent on every turn (the key is a per-run nonce, so it can
     * never sit in the cached prompt head). The block is eight lines today; the
     * ceiling leaves room to reword one, not to grow a paragraph per tool.
     */
    it('stays compact', () => {
      const end = lines.findIndex((line, index) => index > start && line.startsWith("This turn's key is"));
      const block = lines.slice(start, end);
      expect(block).toHaveLength(8);
      expect(block.join('\n').length).toBeLessThan(900);
    });
  });
});
