"""Check that the Fantay design system still mirrors Studio's UI tokens and that 素材库 uses it.

Run from the workspace root: mise run system:check. Exits 1 when any check fails.
The design system (studio/design-systems/fantay/tokens.css) is the single source of truth;
this script reports drift after an upstream merge instead of fixing anything.
"""
from pathlib import Path
from urllib.parse import unquote
import os
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
STUDIO = ROOT / 'studio'
PACKAGE = STUDIO / 'design-systems' / 'fantay'
APP_STYLES = STUDIO / 'apps' / 'web' / 'src' / 'styles'
LIBRARY = ROOT / '素材库'
SUPPORT = LIBRARY / '导览支持'

# Fantay token -> the product token it mirrors (apps/web/src/styles/tokens.css + base.css).
MIRRORS = {
    '--bg': '--bg', '--surface': '--bg-panel', '--surface-warm': '--bg-subtle',
    '--fg': '--text-strong', '--fg-2': '--text', '--muted': '--text-muted', '--meta': '--text-soft',
    '--border': '--border', '--border-soft': '--border-soft',
    '--accent': '--accent', '--accent-on': '--accent-contrast', '--accent-hover': '--accent-hover',
    '--success': '--green', '--warn': '--amber', '--danger': '--red',
    '--font-display': '--serif', '--font-body': '--sans',
    '--text-xs': '--font-size-12', '--text-sm': '--font-size-13', '--text-base': '--font-size-14',
    '--text-lg': '--font-size-16', '--text-xl': '--font-size-20', '--text-2xl': '--font-size-24',
    '--text-3xl': '--font-size-32', '--text-4xl': '--font-size-48',
    '--leading-body': '--prose-line-height',
    '--space-1': '--spacing-4', '--space-2': '--spacing-8', '--space-3': '--spacing-12',
    '--space-4': '--spacing-16', '--space-5': '--spacing-20', '--space-6': '--spacing-24',
    '--space-8': '--spacing-32', '--space-12': '--spacing-48',
    '--radius-sm': '--radius-sm', '--radius-md': '--radius-md', '--radius-lg': '--radius-lg',
    '--radius-pill': '--radius-pill',
    '--elev-raised': '--shadow-md', '--motion-base': '--dur-enter',
}
# Fantay token -> (studio file, literal the product rule must still contain, fantay value).
# These come from a CSS rule or a written rule rather than a product :root token.
RULES = {
    '--leading-tight': ('apps/web/src/styles/base.css', 'line-height: 125%', '1.25'),
    '--tracking-display': ('apps/web/src/styles/home/home-hero.css', 'letter-spacing: -0.02em', '-0.02em'),
    '--ease-standard': ('AGENTS.md', 'cubic-bezier(0.23, 1, 0.32, 1)', 'cubic-bezier(0.23,1,0.32,1)'),
    '--motion-fast': ('AGENTS.md', 'exit around 140ms', '140ms'),
    '--container-max': ('apps/web/src/styles/home/entry-layout.css', 'calc(1600px + 48px)', '1648px'),
}
# Must equal the schema defaults byte for byte (A2 fallbacks).
SCHEMA_DEFAULTS = ('--elev-flat', '--elev-ring')
# Picked from several product spacings; DESIGN.md §Provenance marks them derived. Not compared.
DERIVED = {
    '--accent-active', '--section-y-desktop', '--section-y-tablet', '--section-y-phone',
    '--container-gutter-desktop', '--container-gutter-tablet', '--container-gutter-phone',
}
# Deliberate departures from the product: token -> reason. A token listed here is reported
# as SKIP instead of FAIL, so restyling a mirrored token (or declining an upstream change)
# is a recorded decision rather than a red check.
DIVERGED = {}
# Product colors with no schema slot that tokens.css must still name as literals.
LITERALS = ('--brand', '--brand-weak', '--brand-soft', '--brand-text', '--send-ground', '--border-strong', '--blue')

failures = []


def skipped(token, label):
    if token in DIVERGED:
        print(f'SKIP {label} — diverged: {DIVERGED[token]}')
        return True
    return False


def report(ok, label, detail=''):
    print(('PASS ' if ok else 'FAIL ') + label + (f' — {detail}' if detail and not ok else ''))
    if not ok:
        failures.append(label)


def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def split_top(text, sep):
    """Split on sep outside quotes and parentheses (data: URIs carry ';' and ',')."""
    parts, buf, depth, quote = [], [], 0, ''
    for ch in text:
        if quote:
            quote = '' if ch == quote else quote
        elif ch in '"\'':
            quote = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append(''.join(buf)); buf = []
            continue
        buf.append(ch)
    parts.append(''.join(buf))
    return parts


def root_blocks(css):
    """Declarations of every top-level `:root { … }` block, in source order."""
    css, tokens, depth, start, selector_start = strip_comments(css), {}, 0, None, 0
    for i, ch in enumerate(css):
        if ch == '{':
            if depth == 0:
                start = i if css[selector_start:i].strip() == ':root' else None
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                if start is not None:
                    for decl in split_top(css[start + 1:i], ';'):
                        name, _, value = decl.partition(':')
                        if name.strip().startswith('--'):
                            tokens[name.strip()] = value.strip()
                selector_start, start = i + 1, None
    return tokens


def resolve(value, table, seen=()):
    def swap(match):
        name, fallback = match.group(1), match.group(2)
        if name in table and name not in seen:
            return resolve(table[name], table, seen + (name,))
        return fallback.strip() if fallback else match.group(0)
    previous = None
    while previous != value:
        previous, value = value, re.sub(r'var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)', swap, value)
    return value


def normal(value):
    value = value.strip().lower().replace("'", '"')
    value = re.sub(r'\s+', ' ', value)
    value = re.sub(r'\s*([,()])\s*', r'\1', value)
    return re.sub(r'#([0-9a-f])([0-9a-f])([0-9a-f])\b', r'#\1\1\2\2\3\3', value)


def families(stack):
    return [normal(x) for x in split_top(stack, ',')]


def check_tokens():
    fantay = root_blocks((PACKAGE / 'tokens.css').read_text())
    app = {**root_blocks((APP_STYLES / 'tokens.css').read_text()), **root_blocks((APP_STYLES / 'base.css').read_text())}
    report(len(fantay) == 56, 'fantay tokens.css :root declares the 56 schema tokens', f'{len(fantay)} found')
    covered = set(MIRRORS) | set(RULES) | set(SCHEMA_DEFAULTS) | DERIVED | {'--font-mono', '--focus-ring'}
    unmapped = sorted(set(fantay) - covered)
    report(not unmapped, 'every fantay token has a product mapping', ', '.join(unmapped))
    for ours, theirs in MIRRORS.items():
        if skipped(ours, f'{ours} ↔ {theirs}'):
            continue
        if theirs not in app:
            report(False, f'{ours} ↔ {theirs}', 'product token missing (renamed upstream?)')
            continue
        want, have = normal(resolve(app[theirs], app)), normal(fantay.get(ours, ''))
        report(want == have, f'{ours} ↔ {theirs}', f'fantay {have!r}, product {want!r}')
    for ours, (rel, literal, value) in RULES.items():
        if skipped(ours, f'{ours} ↔ {rel}'):
            continue
        source = (STUDIO / rel).read_text()
        report(literal in source, f'{ours}: {rel} still says {literal!r}', 'product rule changed')
        report(normal(fantay.get(ours, '')) == normal(value), f'{ours} is {value}', f'fantay {fantay.get(ours)!r}')
    defaults = root_blocks((STUDIO / 'design-systems/_schema/defaults.css').read_text())
    for name in SCHEMA_DEFAULTS:
        report(normal(fantay.get(name, '')) == normal(defaults.get(name, '?')), f'{name} equals _schema/defaults.css',
               f'fantay {fantay.get(name)!r}, defaults {defaults.get(name)!r}')
    product_mono = [f for f in families(resolve(app.get('--mono', ''), app)) if f != 'monospace']
    ours_mono = families(fantay.get('--font-mono', ''))
    report(bool(product_mono) and ours_mono[:len(product_mono)] == product_mono,
           '--font-mono starts with the product --mono stack', f'product {product_mono}')
    blue = normal(resolve(app.get('--blue', ''), app))
    report(bool(blue) and blue in normal(fantay.get('--focus-ring', '')), '--focus-ring uses the product --blue', blue)
    text = normal((PACKAGE / 'tokens.css').read_text())
    for name in LITERALS:
        value = normal(resolve(app.get(name, ''), app))
        report(bool(value) and value in text, f'tokens.css names the product {name} literal', value or 'product token missing')
    return set(fantay)


def css_urls(text):
    """url(...) references plus <link rel="stylesheet" href> targets, without query strings."""
    found = re.findall(r'url\(\s*["\']?([^"\')]+)', text) + re.findall(r'<link rel="stylesheet" href="([^"]+)"', text)
    return [unquote(u.split('?')[0]) for u in found if not u.startswith('data:')]


def check_library(schema_tokens):
    link = ROOT / '设计系统'
    report(link.is_symlink() and link.resolve() == PACKAGE.resolve(), '设计系统 links to studio/design-systems/fantay')
    index = (LIBRARY / 'index.html').read_text()
    hrefs = [unquote(h.split('?')[0]) for h in re.findall(r'<link rel="stylesheet" href="([^"]+)"', index)]
    token_href = next((h for h in hrefs if h.endswith('design-systems/fantay/tokens.css')), None)
    report(bool(token_href) and (LIBRARY / token_href).resolve() == (PACKAGE / 'tokens.css').resolve(),
           '素材库/index.html loads the fantay tokens.css', token_href or 'no link')
    if token_href and hrefs.index(token_href) != 0:
        report(False, 'fantay tokens.css is the first stylesheet', 'page styles would load before the tokens')
    served = set()
    # What each page must load from the package (index.html carries tokens.css for the gallery).
    required = {
        SUPPORT / 'archive.css': ('fonts/AlbertSans-VariableFont_wght.ttf', 'fonts/AlbertSans-Italic-VariableFont_wght.ttf'),
        SUPPORT / 'websites.css': (),
        LIBRARY / '风格参考' / '交互风格导览.html': ('tokens.css', 'fonts/AlbertSans-VariableFont_wght.ttf'),
    }
    for page, needs in required.items():
        text = page.read_text()
        # Each src lists the real path first and an old-link fallback second; the first must resolve.
        first = [u for u in css_urls(text) if 'design-systems/fantay/' in u and 'fantay-design/studio' not in u]
        for url in first:
            target = (page.parent / url).resolve()
            report(target.is_file() and target.is_relative_to(PACKAGE.resolve()), f'{page.name} → {url}', 'file missing')
            # The server sees the lexical URL path, so compute it without following symlinks.
            served.add('/' + Path(os.path.normpath(page.parent / url)).relative_to(ROOT).as_posix())
        for need in needs:
            report(any(u.endswith('design-systems/fantay/' + need) for u in first), f'{page.name} loads fantay {need}', 'reference missing')
        redefined = sorted(n for n in re.findall(r'(--[\w-]+)\s*:', strip_comments(text)) if n in schema_tokens)
        report(not redefined, f'{page.name} does not redefine schema tokens', ', '.join(redefined))
    served.add('/studio/design-systems/fantay/tokens.css')
    serve = (SUPPORT / 'scripts' / 'serve.py').read_text()
    trusted = {'/studio/design-systems/fantay/' + n for n in re.findall(r"'([^']+)'", serve.split("'/studio/design-systems/fantay/'+name", 1)[-1].split('}', 1)[0])}
    missing = sorted(served - trusted)
    report(not missing, 'serve.py editor allowlist covers every shell token/font path', ', '.join(missing))


def check_studio_defaults():
    pick = (STUDIO / 'apps/web/src/state/default-design-system.ts').read_text()
    report("['fantay', 'default']" in pick, 'web picks fantay first when nothing is saved')
    app_tsx = (STUDIO / 'apps/web/src/App.tsx').read_text()
    report('pickDefaultDesignSystemId(designSystems)' in app_tsx, 'App.tsx auto-pick still calls pickDefaultDesignSystemId')
    cli = (STUDIO / 'apps/daemon/src/cli.ts').read_text()
    report("flags['design-system'] ?? 'fantay'" in cli, 'od run redesign defaults to fantay')
    report('"id": "fantay"' in (PACKAGE / 'manifest.json').read_text(), 'manifest id is fantay')


if __name__ == '__main__':
    schema = check_tokens()
    check_library(schema)
    check_studio_defaults()
    print(f'\n{len(failures)} failed' if failures else '\nAll Fantay checks passed.')
    sys.exit(1 if failures else 0)
