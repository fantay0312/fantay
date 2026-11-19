// SPDX-License-Identifier: AGPL-3.0-only
// Fonts (.ttf .otf .woff .woff2): a specimen. The family name is set large in the font itself, then
// one line the reader can retype, shown at six sizes, then the characters the font has, grouped by
// script, and what the file says about itself (version, designer, licence, variable axes).
// The browser's font loader draws everything (CSS `FontFace`, which sanitises the file); the names
// and the character list are read from the font's own tables (font/font-file.ts). The default line
// and the grid follow what the font can draw: a Chinese font opens on Chinese, an icon font on its
// icons. Bytes that are not a font, and font collections, show the file card.
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { useI18n, useT } from '../../../i18n';
import { Input } from '../../ui';
import { ArtifactShell, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, formatBytes, useArtifactBytes } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import styles from './FontViewer.module.css';
import { coverageCount, coverageFirst, coverageHas, readFontFacts, type FontFacts } from './font/font-file';
import { defaultSample, glyphSections, isVisibleCodePoint, type GlyphSection, type SpecimenInput } from './font/font-specimen';
import { createMeasuredGlyphTest } from './font/measure-glyphs';
import { FileCard } from './UnknownViewer';

/** Chinese fonts run to tens of megabytes; past this the browser's loader is no longer quick. */
const MAX_FONT_BYTES = 64 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 20_000;
const SIZES = [72, 48, 32, 24, 18, 14] as const;

/** Each loaded file gets a family name of its own, so two open fonts never answer for each other. */
let faceCounter = 0;

interface Specimen {
  sections: GlyphSection[];
  sample: string;
}

function formatLabel(facts: FontFacts): string {
  const outlines = facts.outlines === 'cff' ? 'OpenType (CFF)' : 'TrueType';
  if (facts.container === 'woff') return `WOFF · ${outlines}`;
  if (facts.container === 'woff2') return `WOFF2 · ${outlines}`;
  return outlines;
}

function axisRange(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export default function FontViewer(props: ArtifactViewerProps): JSX.Element {
  const { projectId, file, active } = props;
  const t = useT();
  const { locale } = useI18n();
  const fileActions = useArtifactFileActions(projectId, file);

  // ── the file ──────────────────────────────────────────────────────────────────────────────────
  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: MAX_FONT_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;
  /** null: the bytes are not a font. */
  const facts = useMemo(() => (data ? readFontFacts(data, locale) : null), [data, locale]);
  const loadable = facts !== null && facts.container !== 'collection';
  /** The weight axis of a variable font, kept inside what CSS accepts (1 to 1000). */
  const weightAxis = useMemo(() => {
    const axis = facts?.axes.find((item) => item.tag === 'wght');
    if (!axis) return null;
    const clamp = (value: number): number => Math.min(1000, Math.max(1, Math.round(value)));
    return { min: clamp(axis.min), max: clamp(axis.max), default: clamp(axis.default) };
  }, [facts]);

  // ── the face the browser draws with ───────────────────────────────────────────────────────────
  const [face, setFace] = useState<{ data: ArrayBuffer; family: string } | null>(null);
  const [faceFailed, setFaceFailed] = useState<ArrayBuffer | null>(null);
  /** The face on screen. It is dropped only once its replacement is in, so an update never flashes. */
  const shownFace = useRef<FontFace | null>(null);

  useEffect(() => {
    if (!data || !loadable || typeof FontFace === 'undefined') return;
    let current = true;
    faceCounter += 1;
    const family = `fx-artifact-font-${faceCounter}`;
    const timer = window.setTimeout(() => {
      if (current) setFaceFailed(data);
    }, LOAD_TIMEOUT_MS);
    // A variable font is registered with its whole weight range, so the specimen can ask for the
    // weight the file opens at instead of the browser's 400.
    const descriptors: FontFaceDescriptors = weightAxis ? { weight: `${weightAxis.min} ${weightAxis.max}` } : {};
    // A copy: the loader may keep or detach the buffer, and the tables are still read from `data`.
    new FontFace(family, data.slice(0), descriptors).load().then(
      (loaded) => {
        window.clearTimeout(timer);
        if (!current) return;
        document.fonts.add(loaded);
        if (shownFace.current) document.fonts.delete(shownFace.current);
        shownFace.current = loaded;
        setFace({ data, family });
      },
      () => {
        window.clearTimeout(timer);
        if (current) setFaceFailed(data);
      },
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [data, loadable, weightAxis]);

  useEffect(
    () => () => {
      if (shownFace.current) document.fonts.delete(shownFace.current);
      shownFace.current = null;
    },
    [],
  );

  // ── what the font can draw ────────────────────────────────────────────────────────────────────
  const fromTables = useMemo<Specimen | null>(() => {
    const coverage = facts?.coverage;
    if (!coverage) return null;
    const input: SpecimenInput = {
      has: (codePoint) => coverageHas(coverage, codePoint),
      firstCovered: (limit) => coverageFirst(coverage, limit, isVisibleCodePoint),
      countIn: (from, to) => coverageCount(coverage, from, to),
    };
    return { sections: glyphSections(input), sample: defaultSample(input) };
  }, [facts]);

  /** For a font whose tables could not be read: found out by drawing, after the first paint. */
  const [measured, setMeasured] = useState<{ family: string; specimen: Specimen } | null>(null);
  const faceFamily = face?.family ?? null;
  const needsMeasuring = loadable && facts.coverage === null;
  useEffect(() => {
    if (!needsMeasuring || !faceFamily) return;
    const timer = window.setTimeout(() => {
      const input: SpecimenInput = { has: createMeasuredGlyphTest(faceFamily) };
      setMeasured({ family: faceFamily, specimen: { sections: glyphSections(input), sample: defaultSample(input) } });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [needsMeasuring, faceFamily]);

  const specimen = fromTables ?? (measured && measured.family === faceFamily ? measured.specimen : null);

  // ── what the reader set ───────────────────────────────────────────────────────────────────────
  /** null until the reader types: the font's own default line shows. */
  const [typed, setTyped] = useArtifactViewState<string | null>(projectId, file.name, 'sample', null);
  const sample = typed !== null && typed.trim() !== '' ? typed : (specimen?.sample ?? '');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ready = face !== null && loadable;
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !ready) return;
    element.scrollTop = readArtifactViewState<number>(projectId, file.name, 'scroll') ?? 0;
  }, [ready, projectId, file.name]);

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const [slow, setSlow] = useState(false);
  const loadingFace = data !== null && loadable && face === null && faceFailed !== data;
  useEffect(() => {
    if (!loadingFace) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), ARTIFACT_SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [loadingFace]);

  if (data !== null && facts === null) return <FileCard {...props} reason={t('artifact.font.notFont')} />;
  if (facts?.container === 'collection') return <FileCard {...props} reason={t('artifact.font.collection')} />;
  if (data !== null && faceFailed === data && face?.data !== data) return <FileCard {...props} reason={t('artifact.font.notFont')} />;

  let state: ArtifactShellState | null = null;
  if (data === null) state = fileActions.sourceState(bytes.source, bytes.reload);
  else if (face === null) state = slow ? { kind: 'loading', label: t('artifact.font.loading') } : { kind: 'loading', quiet: true };

  const numberFormat = new Intl.NumberFormat(locale);
  const names = facts?.names ?? null;
  const baseName = (file.name.split('/').pop() ?? file.name).replace(/\.[^.]+$/, '');
  const title = names?.localizedFamily ?? names?.family ?? baseName;
  const stack = face ? `"${face.family}", var(--font-ui)` : undefined;
  const glyphCount = facts?.glyphCount ? t('artifact.font.glyphs', { count: numberFormat.format(facts.glyphCount) }) : null;

  const styleFacts = facts
    ? [
        names?.localizedFamily ? names.family : null,
        names?.subfamily,
        facts.weight !== null ? t('artifact.font.weight', { value: facts.weight }) : null,
        facts.italic && !/italic|oblique/i.test(names?.subfamily ?? '') ? t('artifact.font.italic') : null,
        facts.axes.length > 0 ? t('artifact.font.variable') : null,
        glyphCount,
      ].filter(Boolean)
    : [];

  const about: Array<[string, string]> = facts
    ? (
        [
          [t('artifact.font.about.name'), names?.fullName ?? null],
          [t('artifact.font.about.format'), formatLabel(facts)],
          [t('artifact.font.about.characters'), facts.coverage ? numberFormat.format(facts.coverage.count) : null],
          [
            t('artifact.font.about.axes'),
            facts.axes.length > 0 ? facts.axes.map((axis) => `${axis.tag.trim()} ${axisRange(axis.min)}–${axisRange(axis.max)}`).join(' · ') : null,
          ],
          [t('artifact.font.about.version'), names?.version ?? null],
          [t('artifact.font.about.designer'), names?.designer ?? null],
          [t('artifact.font.about.manufacturer'), names?.manufacturer ?? null],
          [t('artifact.font.about.license'), names?.license ?? null],
          [t('artifact.font.about.copyright'), names?.copyright ?? null],
        ] as Array<[string, string | null]>
      ).filter((row): row is [string, string] => row[1] !== null && row[1] !== '')
    : [];

  const meta = facts ? [formatLabel(facts), glyphCount, formatBytes(file.size)].filter(Boolean).join(' · ') : formatBytes(file.size);

  return (
    <ArtifactShell
      viewer="font"
      path={file.name}
      stage="page"
      meta={meta}
      actions={[fileActions.download]}
      menu={fileActions.menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {facts && face ? (
        <div
          ref={scrollRef}
          className={styles.scroller}
          onScroll={(event) => writeArtifactViewState(projectId, file.name, 'scroll', event.currentTarget.scrollTop)}
        >
          <article
            className={styles.page}
            aria-label={t('artifact.font.specimen')}
            style={{ ['--specimen-font' as string]: stack, ['--specimen-weight' as string]: weightAxis?.default ?? 400 }}
          >
            <header className={styles.hero}>
              <h1 className={styles.title}>{title}</h1>
              {styleFacts.length > 0 ? <p className={styles.style}>{styleFacts.join(' · ')}</p> : null}
            </header>

            <Input
              className={styles.sampleInput}
              value={typed ?? ''}
              placeholder={specimen?.sample || t('artifact.font.samplePlaceholder')}
              aria-label={t('artifact.font.sample')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />

            <section className={styles.waterfall} aria-label={t('artifact.font.section.sizes')}>
              {SIZES.map((size) => (
                <div key={size} className={styles.line} data-size={size}>
                  <span className={styles.lineSize}>{size}</span>
                  <span className={styles.lineText} style={{ fontSize: size }}>
                    {sample}
                  </span>
                </div>
              ))}
            </section>

            {specimen?.sections.map((section) => (
              <section key={section.id} className={styles.section}>
                <h2 className={styles.sectionTitle}>
                  {t(`artifact.font.section.${section.id}`)}
                  {section.total !== null ? (
                    <span className={styles.sectionCount}>
                      {t('artifact.font.shownOf', { shown: numberFormat.format(section.chars.length), total: numberFormat.format(section.total) })}
                    </span>
                  ) : null}
                </h2>
                <div className={styles.glyphs} role="list">
                  {section.chars.map((char) => (
                    <span
                      key={char}
                      role="listitem"
                      className={styles.glyph}
                      title={`U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`}
                    >
                      {char}
                    </span>
                  ))}
                </div>
              </section>
            ))}

            {about.length > 0 ? (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>{t('artifact.font.section.about')}</h2>
                <dl className={styles.about}>
                  {about.map(([label, value]) => (
                    <div key={label} className={styles.aboutRow}>
                      <dt>{label}</dt>
                      <dd title={value.length > 160 ? value : undefined}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}
          </article>
        </div>
      ) : null}
    </ArtifactShell>
  );
}
