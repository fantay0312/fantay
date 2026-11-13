import type { CSSProperties } from 'react';
import { MediaSurface } from './plugins-home/cards/MediaSurface';
import type { DesignPreviewSpec, PluginPreviewSpec } from './plugins-home/preview';
import { useInView } from './plugins-home/useInView';

export interface MarketplaceVisualStageProps {
  id: string;
  title: string;
  categorySlug: string | null;
  categoryLabel: string | null;
  accent: string;
  preview: PluginPreviewSpec | null;
  mode: 'plugins' | 'skills';
  skillMode?: string | null;
}

type StageArchetype =
  | 'bento-6up'
  | 'editorial-aplus'
  | 'brand-sheet'
  | 'triptych-board'
  | 'cinema-reel';

interface StagePalette {
  stageBg: string;
  stageSecondary: string;
  sheetBg: string;
  ink: string;
  muted: string;
  accent: string;
  accentSoft: string;
  swatches: readonly [string, string, string, string, string];
}

const STAGE_PALETTES: readonly StagePalette[] = [
  {
    stageBg: '#8c8c8a',
    stageSecondary: '#7a7a78',
    sheetBg: '#ffffff',
    ink: '#18181b',
    muted: '#686763',
    accent: '#c26d4a',
    accentSoft: '#f4e7e0',
    swatches: ['#18181b', '#c26d4a', '#d8b48f', '#8d9b87', '#f3efe9'],
  },
  {
    stageBg: '#f3dc7d',
    stageSecondary: '#e8cb5c',
    sheetBg: '#faf8f2',
    ink: '#191815',
    muted: '#655f4d',
    accent: '#23395b',
    accentSoft: '#e4ebf5',
    swatches: ['#191815', '#23395b', '#d9a441', '#6b8e78', '#f2ede2'],
  },
  {
    stageBg: '#4b321f',
    stageSecondary: '#3b2617',
    sheetBg: '#f6f2e9',
    ink: '#2d2118',
    muted: '#7a6855',
    accent: '#5c3c24',
    accentSoft: '#ebe3d4',
    swatches: ['#2d2118', '#5c3c24', '#8b684c', '#c4a787', '#e8dfd1'],
  },
  {
    stageBg: '#deb37c',
    stageSecondary: '#cfa166',
    sheetBg: '#fbf8f3',
    ink: '#2b241d',
    muted: '#7a6b5b',
    accent: '#9c6b43',
    accentSoft: '#f3eadf',
    swatches: ['#2b241d', '#9c6b43', '#c89d74', '#879680', '#f5efe6'],
  },
  {
    stageBg: '#0a1230',
    stageSecondary: '#05091c',
    sheetBg: '#121c42',
    ink: '#f8fafc',
    muted: '#94a3b8',
    accent: '#60a5fa',
    accentSoft: '#1e293b',
    swatches: ['#0a1230', '#1d4ed8', '#60a5fa', '#e2e8f0', '#f59e0b'],
  },
  {
    stageBg: '#6e7b74',
    stageSecondary: '#58645d',
    sheetBg: '#f8f7f3',
    ink: '#1e2622',
    muted: '#647069',
    accent: '#2f5241',
    accentSoft: '#e6ede9',
    swatches: ['#1e2622', '#2f5241', '#7d9486', '#c9b48c', '#f2efe9'],
  },
  {
    stageBg: '#cbb4a8',
    stageSecondary: '#b89d8f',
    sheetBg: '#fcfaf8',
    ink: '#2a211d',
    muted: '#75645c',
    accent: '#8c4a36',
    accentSoft: '#f4e8e3',
    swatches: ['#2a211d', '#8c4a36', '#c48d75', '#889389', '#f7f2ee'],
  },
];

const DESIGN_STAGE_BACKDROPS = [
  '#4b321f',
  '#23312b',
  '#262b38',
  '#633a2c',
  '#746f67',
  '#382c3e',
] as const;

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function selectArchetype(
  id: string,
  categorySlug: string | null,
  skillMode?: string | null,
): StageArchetype {
  const slug = (categorySlug ?? skillMode ?? '').toLowerCase();
  const lowerId = id.toLowerCase();
  if (
    slug.includes('video') ||
    slug.includes('motion') ||
    slug.includes('audio') ||
    slug.includes('vfx') ||
    slug.includes('hyperframes') ||
    lowerId.includes('video') ||
    lowerId.includes('frame-') ||
    lowerId.includes('vfx-') ||
    lowerId.includes('motion')
  ) {
    return 'cinema-reel';
  }
  if (
    slug.includes('slide') ||
    slug.includes('deck') ||
    lowerId.includes('deck-') ||
    lowerId.includes('ppt') ||
    lowerId.includes('slide')
  ) {
    return 'triptych-board';
  }
  if (
    slug.includes('brand') ||
    slug.includes('design') ||
    lowerId.includes('brand') ||
    lowerId.includes('logo') ||
    lowerId.includes('hallmark')
  ) {
    return 'brand-sheet';
  }
  if (
    slug.includes('document') ||
    slug.includes('doc') ||
    slug.includes('article') ||
    lowerId.includes('doc-') ||
    lowerId.includes('article')
  ) {
    return 'editorial-aplus';
  }
  const archetypes: readonly StageArchetype[] = [
    'bento-6up',
    'editorial-aplus',
    'brand-sheet',
    'triptych-board',
    'cinema-reel',
  ];
  return archetypes[hashSeed(id) % archetypes.length] ?? 'bento-6up';
}

function selectPalette(id: string, archetype: StageArchetype): StagePalette {
  const h = hashSeed(id);
  if (archetype === 'cinema-reel') return STAGE_PALETTES[4]!;
  if (archetype === 'brand-sheet') {
    return STAGE_PALETTES[h % 2 === 0 ? 2 : 5]!;
  }
  if (archetype === 'editorial-aplus') {
    return STAGE_PALETTES[h % 2 === 0 ? 1 : 6]!;
  }
  if (archetype === 'triptych-board') {
    return STAGE_PALETTES[h % 2 === 0 ? 3 : 5]!;
  }
  return STAGE_PALETTES[h % STAGE_PALETTES.length]!;
}

function isVideoLike(
  preview: PluginPreviewSpec | null,
  archetype: StageArchetype,
  categorySlug: string | null,
  skillMode?: string | null,
): boolean {
  if (preview?.kind === 'media' && Boolean(preview.videoUrl)) return true;
  if (archetype === 'cinema-reel') return true;
  const s = `${categorySlug ?? ''} ${skillMode ?? ''}`.toLowerCase();
  return s.includes('video') || s.includes('motion') || s.includes('hyperframes');
}

export function MarketplaceVisualStage({
  id,
  title,
  categorySlug,
  categoryLabel,
  preview,
  skillMode,
}: MarketplaceVisualStageProps) {
  const { ref: mountRef, inView } = useInView<HTMLDivElement>({
    rootMargin: '600px',
    once: false,
  });
  const { ref: playRef, inView: visible } = useInView<HTMLDivElement>({
    rootMargin: '80px',
    once: false,
  });

  const archetype = selectArchetype(id, categorySlug, skillMode);
  const palette = selectPalette(id, archetype);
  const showVideoBadge = isVideoLike(preview, archetype, categorySlug, skillMode);

  const hasMediaPoster = preview?.kind === 'media' && Boolean(preview.poster);

  return (
    <div
      ref={(node) => {
        mountRef.current = node;
        playRef.current = node;
      }}
      className="plugin-marketplace__cover-stage"
    >
      {hasMediaPoster && preview?.kind === 'media' ? (
        <MediaSurface
          preview={preview}
          pluginTitle={title}
          inView={inView}
          visible={visible}
        />
      ) : preview?.kind === 'design' ? (
        <DesignBrandStage id={id} title={title} preview={preview} />
      ) : (
        <ArtDirectedSpecimenStage
          id={id}
          title={title}
          categoryLabel={categoryLabel}
          archetype={archetype}
          palette={palette}
        />
      )}

      <span className="plugin-marketplace__media-badge" aria-hidden="true">
        {showVideoBadge ? (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.35" />
            <path d="M6.6 5.7L10.4 8L6.6 10.3V5.7Z" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
            <rect x="1.75" y="2.5" width="12.5" height="11" rx="2.25" stroke="currentColor" strokeWidth="1.35" />
            <circle cx="5.4" cy="6.1" r="1.15" fill="currentColor" />
            <path
              d="M2.6 11.8L6.1 8.6L8.8 11L10.9 9.2L13.4 11.8"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
    </div>
  );
}

const SPECIMEN_BRANDS = [
  'L’ÉCHELON',
  'VARELLE',
  'ELORA',
  'MONOLITH',
  'ATELIER',
  'KINETIC',
] as const;

function specimenBrandName(id: string): string {
  return SPECIMEN_BRANDS[hashSeed(id) % SPECIMEN_BRANDS.length] ?? 'ATELIER';
}

function DesignBrandStage({
  id,
  preview,
}: {
  id: string;
  title: string;
  preview: DesignPreviewSpec;
}) {
  const h = hashSeed(id);
  const stageBackdrop = DESIGN_STAGE_BACKDROPS[h % DESIGN_STAGE_BACKDROPS.length]!;
  const swatches = (
    preview.swatches.length > 0
      ? preview.swatches
      : ['#18181b', '#c26d4a', '#d8b48f', '#8d9b87', '#f3efe9']
  ).slice(0, 5);
  const primaryAccent = swatches[0] ?? '#4b321f';
  const markLabel = specimenBrandName(id);

  return (
    <div
      className="plugin-marketplace__artboard plugin-marketplace__artboard--brand"
      style={{ '--stage-bg': stageBackdrop } as CSSProperties}
      aria-hidden="true"
    >
      <div className="plugin-marketplace__brand-sheet">
        <div className="plugin-marketplace__brand-sheet-head">
          <strong>{markLabel}</strong>
          <span>BRAND &amp; DESIGN SYSTEM</span>
          <em>DESIGN.MD</em>
        </div>

        <div className="plugin-marketplace__brand-sheet-grid">
          <div className="plugin-marketplace__brand-cell">
            <small>01 · PRIMARY MARK</small>
            <div
              className="plugin-marketplace__brand-seal"
              style={{ borderColor: primaryAccent, color: '#231911' }}
            >
              <span>{markLabel}</span>
            </div>
            <div className="plugin-marketplace__brand-mini-lockups">
              <span style={{ borderColor: primaryAccent, color: '#231911' }}>
                MARK
              </span>
              <span style={{ background: primaryAccent, color: '#fff' }}>
                SYSTEM
              </span>
            </div>
          </div>

          <div className="plugin-marketplace__brand-cell">
            <small>02 · TYPOGRAPHY &amp; UI</small>
            <div className="plugin-marketplace__brand-type-sample">
              Aa Bb Cc
            </div>
            <div className="plugin-marketplace__brand-ui-sample">
              <span
                className="plugin-marketplace__brand-ui-cta"
                style={{ background: primaryAccent }}
              />
              <span className="plugin-marketplace__brand-ui-pill" />
            </div>
          </div>

          <div className="plugin-marketplace__brand-cell">
            <small>03 · COLOR PALETTE</small>
            <div className="plugin-marketplace__brand-swatches">
              {swatches.map((hex, idx) => (
                <i
                  key={`${hex}-${idx}`}
                  style={{ background: hex }}
                />
              ))}
            </div>
            <div className="plugin-marketplace__brand-bars">
              <span style={{ width: '82%' }} />
              <span style={{ width: '64%' }} />
              <span style={{ width: '90%' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtDirectedSpecimenStage({
  id,
  categoryLabel,
  archetype,
  palette,
}: {
  id: string;
  title: string;
  categoryLabel: string | null;
  archetype: StageArchetype;
  palette: StagePalette;
}) {
  const shortTitle = specimenBrandName(id);
  const tag = (categoryLabel || 'STUDIO').toUpperCase();

  if (archetype === 'bento-6up') {
    return (
      <div
        className="plugin-marketplace__artboard plugin-marketplace__artboard--bento"
        style={
          {
            '--stage-bg': palette.stageBg,
            '--stage-secondary': palette.stageSecondary,
            '--stage-accent': palette.accent,
            '--stage-accent-soft': palette.accentSoft,
            '--stage-ink': palette.ink,
          } as CSSProperties
        }
        aria-hidden="true"
      >
        <div className="plugin-marketplace__bento-grid">
          <div className="plugin-marketplace__bento-tile">
            <svg viewBox="0 0 64 52" className="plugin-marketplace__bento-svg">
              <rect x="14" y="6" width="36" height="40" rx="6" fill={palette.accentSoft} />
              <path
                d="M24 14L32 20L40 14L44 22V40H20V22L24 14Z"
                fill={palette.accent}
                opacity="0.88"
              />
            </svg>
          </div>
          <div className="plugin-marketplace__bento-tile">
            <svg viewBox="0 0 64 52" className="plugin-marketplace__bento-svg">
              <path
                d="M20 12H44L50 22L43 26L40 20V42H24V20L21 26L14 22L20 12Z"
                fill={palette.ink}
                opacity="0.86"
              />
            </svg>
          </div>
          <div className="plugin-marketplace__bento-tile">
            <svg viewBox="0 0 64 52" className="plugin-marketplace__bento-svg">
              <rect x="10" y="22" width="44" height="18" rx="4" fill={palette.swatches[3]} opacity="0.45" />
              <rect x="14" y="15" width="36" height="12" rx="3" fill={palette.accentSoft} />
              <rect x="18" y="12" width="12" height="6" rx="2" fill="#ffffff" />
              <rect x="34" y="12" width="12" height="6" rx="2" fill="#ffffff" />
            </svg>
          </div>
          <div className="plugin-marketplace__bento-tile">
            <svg viewBox="0 0 64 52" className="plugin-marketplace__bento-svg">
              <rect x="12" y="10" width="22" height="30" rx="3" fill="#f3c65f" />
              <rect x="30" y="16" width="22" height="24" rx="3" fill={palette.accent} opacity="0.85" />
              <circle cx="23" cy="25" r="5" fill="#ffffff" opacity="0.7" />
            </svg>
          </div>
          <div className="plugin-marketplace__bento-tile">
            <svg viewBox="0 0 64 52" className="plugin-marketplace__bento-svg">
              <path
                d="M19 28V24C19 16.8 24.8 11 32 11C39.2 11 45 16.8 45 24V28"
                fill="none"
                stroke={palette.ink}
                strokeWidth="3.5"
                strokeLinecap="round"
              />
              <rect x="15" y="25" width="7" height="14" rx="3.5" fill={palette.ink} opacity="0.75" />
              <rect x="42" y="25" width="7" height="14" rx="3.5" fill={palette.ink} opacity="0.75" />
            </svg>
          </div>
          <div className="plugin-marketplace__bento-tile">
            <svg viewBox="0 0 64 52" className="plugin-marketplace__bento-svg">
              <rect x="27" y="8" width="10" height="28" rx="4" fill={palette.accent} opacity="0.78" />
              <rect x="28.5" y="36" width="7" height="8" rx="1.5" fill={palette.ink} opacity="0.75" />
            </svg>
          </div>
        </div>
      </div>
    );
  }

  if (archetype === 'editorial-aplus') {
    return (
      <div
        className="plugin-marketplace__artboard plugin-marketplace__artboard--aplus"
        style={
          {
            '--stage-bg': palette.stageBg,
            '--stage-secondary': palette.stageSecondary,
            '--stage-accent': palette.accent,
            '--stage-accent-soft': palette.accentSoft,
            '--stage-ink': palette.ink,
          } as CSSProperties
        }
        aria-hidden="true"
      >
        <div className="plugin-marketplace__aplus-board">
          <div className="plugin-marketplace__aplus-col">
            <div className="plugin-marketplace__aplus-card plugin-marketplace__aplus-card--warm">
              <div className="plugin-marketplace__aplus-copy">
                <small>{tag}</small>
                <strong>{shortTitle}</strong>
                <span />
              </div>
              <div className="plugin-marketplace__aplus-figure" />
            </div>
            <div className="plugin-marketplace__aplus-card">
              <div className="plugin-marketplace__aplus-copy">
                <small>01 · VISUAL STORY</small>
                <strong>Editorial Flow</strong>
                <span />
              </div>
              <div className="plugin-marketplace__aplus-figure plugin-marketplace__aplus-figure--soft" />
            </div>
            <div className="plugin-marketplace__aplus-card">
              <div className="plugin-marketplace__aplus-figure plugin-marketplace__aplus-figure--accent" />
              <div className="plugin-marketplace__aplus-copy">
                <small>02 · CRAFT</small>
                <strong>Modular Grid</strong>
                <span />
              </div>
            </div>
          </div>

          <div className="plugin-marketplace__aplus-col">
            <div className="plugin-marketplace__aplus-spec-card">
              <div className="plugin-marketplace__aplus-spec-top">
                <span className="plugin-marketplace__aplus-dot" />
                <div>
                  <small>PRECISION SPEC</small>
                  <strong>{shortTitle}</strong>
                </div>
              </div>
              <div className="plugin-marketplace__aplus-spec-mid">
                <div className="plugin-marketplace__aplus-rings">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="plugin-marketplace__aplus-spec-foot">
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (archetype === 'brand-sheet') {
    return (
      <div
        className="plugin-marketplace__artboard plugin-marketplace__artboard--brand"
        style={{ '--stage-bg': palette.stageBg } as CSSProperties}
        aria-hidden="true"
      >
        <div className="plugin-marketplace__brand-sheet">
          <div className="plugin-marketplace__brand-sheet-head">
            <strong>{shortTitle}</strong>
            <span>IDENTITY &amp; SYSTEM</span>
            <em>{tag}</em>
          </div>
          <div className="plugin-marketplace__brand-sheet-grid">
            <div className="plugin-marketplace__brand-cell">
              <small>01 · PRIMARY MARK</small>
              <div
                className="plugin-marketplace__brand-seal"
                style={{ borderColor: palette.accent, color: palette.ink }}
              >
                <span>{shortTitle.slice(0, 8).toUpperCase()}</span>
              </div>
              <div className="plugin-marketplace__brand-mini-lockups">
                <span style={{ borderColor: palette.accent, color: palette.ink }}>
                  {tag.slice(0, 6)}
                </span>
                <span style={{ background: palette.accent, color: '#fff' }}>
                  SYSTEM
                </span>
              </div>
            </div>
            <div className="plugin-marketplace__brand-cell">
              <small>02 · TYPOGRAPHY</small>
              <div className="plugin-marketplace__brand-type-sample">Aa Bb Cc</div>
              <div className="plugin-marketplace__brand-ui-sample">
                <span
                  className="plugin-marketplace__brand-ui-cta"
                  style={{ background: palette.accent }}
                />
                <span className="plugin-marketplace__brand-ui-pill" />
              </div>
            </div>
            <div className="plugin-marketplace__brand-cell">
              <small>03 · PALETTE</small>
              <div className="plugin-marketplace__brand-swatches">
                {palette.swatches.map((hex, idx) => (
                  <i key={`${hex}-${idx}`} style={{ background: hex }} />
                ))}
              </div>
              <div className="plugin-marketplace__brand-bars">
                <span style={{ width: '80%' }} />
                <span style={{ width: '60%' }} />
                <span style={{ width: '92%' }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (archetype === 'cinema-reel') {
    return (
      <div
        className="plugin-marketplace__artboard plugin-marketplace__artboard--cinema"
        style={
          {
            '--stage-bg': palette.stageBg,
            '--stage-accent': palette.accent,
          } as CSSProperties
        }
        aria-hidden="true"
      >
        <div className="plugin-marketplace__cinema-frames">
          {[0, 1, 2].map((frameIdx) => (
            <div key={frameIdx} className="plugin-marketplace__cinema-frame">
              <span className="plugin-marketplace__cinema-kicker">
                0{frameIdx + 1} · {tag.slice(0, 10)}
              </span>
              <div className="plugin-marketplace__cinema-halo" />
              <div className="plugin-marketplace__cinema-silhouette" />
              <div className="plugin-marketplace__cinema-caption">
                <small>SCENE 0{frameIdx + 1}</small>
                <strong>{shortTitle}</strong>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // triptych-board (Lovart Card #4: 品牌应用 / Presentation Triptych)
  return (
    <div
      className="plugin-marketplace__artboard plugin-marketplace__artboard--triptych"
      style={
        {
          '--stage-bg': palette.stageBg,
          '--stage-accent': palette.accent,
          '--stage-accent-soft': palette.accentSoft,
          '--stage-ink': palette.ink,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <div className="plugin-marketplace__triptych">
        <div className="plugin-marketplace__triptych-panel">
          <small>{tag}</small>
          <div className="plugin-marketplace__triptych-ShowcaseBox">
            <i style={{ background: palette.accent }} />
            <span />
          </div>
          <strong>{shortTitle}</strong>
        </div>
        <div className="plugin-marketplace__triptych-panel plugin-marketplace__triptych-panel--featured">
          <small>COLLECTION</small>
          <div className="plugin-marketplace__triptych-bag">
            <span>{shortTitle.slice(0, 6).toUpperCase()}</span>
          </div>
          <div className="plugin-marketplace__triptych-lines">
            <span />
            <span />
          </div>
        </div>
        <div className="plugin-marketplace__triptych-panel">
          <small>SPECIMEN</small>
          <div className="plugin-marketplace__triptych-mini-grid">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="plugin-marketplace__triptych-lines">
            <span />
            <span />
          </div>
        </div>
      </div>
    </div>
  );
}
