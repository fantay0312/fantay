// SPDX-License-Identifier: AGPL-3.0-only
// The film create panel (spec 07 §5.2), controlled by MotionCreateHost (dialog) or the embedded
// MCP surface. Left: creation type, start mode, style search and grid, style fields (remix / my
// style) or the footage list. Right: the selected style, brief, title, aspect and design system.
// Footer: one primary — 一句话生成影片 with a brief, 创建空白项目 without; C6 disables the former
// with a reason when the daemon cannot render frames and keeps 先看分镜 as the manual path.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  MOVIE_SAMPLE_MEDIA,
  MOVIE_STYLES,
  movieDuration,
  type LibraryAsset,
  type MovieStartMode,
  type MovieStyle,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { libraryAssetRawUrl } from '../../providers/registry';
import {
  Button,
  Callout,
  EmptyState,
  FX,
  Icon,
  IconButton,
  Input,
  SearchField,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  cn,
} from '../ui';
import { MotionCover } from './MotionCover';
import {
  motionCreateBlockedKey,
  movieStylePreview,
  type MotionCreateDraft,
  type MotionCreateTask,
} from './motion-create';
import type { MotionCreateTarget } from './motion-create-store';
import { resolveMotionCover, type MovieAspect } from './motion-model';
import { MoviePreviewFrame, type MoviePreviewFrameHandle } from './MoviePreviewFrame';
import { StyleFields } from './StyleFields';
import styles from './MotionCreatePanel.module.css';

type DictKey = keyof Dict;

export interface MotionCreatePanelProps {
  variant: 'dialog' | 'embedded';
  target: MotionCreateTarget;
  draft: MotionCreateDraft;
  onDraftChange: (next: MotionCreateDraft) => void;
  personalStyles: MovieStyle[];
  designSystems?: Array<{ id: string; title: string }>; // Legacy caller compatibility; not a movie-style source.
  busy: boolean;
  error: string | null;
  onSubmit: (task: MotionCreateTask) => void;
  onChooseVideos: () => void;
  onCancel?: () => void;
  /** C6: this daemon cannot render frames, so one-step film generation is unavailable. */
  generateUnavailable?: boolean;
  /** C5: footage paths from the board are still being matched to library videos. */
  footageLoading?: boolean;
  workspaceContext?: WorkspaceCollabContext | null;
}

const START_MODES: ReadonlyArray<{ mode: MovieStartMode; label: DictKey }> = [
  { mode: 'library', label: 'motion.startMode.library' },
  { mode: 'remix', label: 'motion.startMode.remix' },
  { mode: 'personal', label: 'motion.startMode.personal' },
  { mode: 'blank', label: 'motion.startMode.blank' },
];
const ASPECTS: readonly MovieAspect[] = ['16:9', '9:16', '1:1'];
/** Radix Select reserves '' for "nothing chosen"; the style palette is a real choice. */

function footageName(asset: LibraryAsset, fallback: string): string {
  return asset.sourceTitle || asset.caption || asset.relPath?.split('/').pop() || fallback;
}

export function MotionCreatePanel({
  variant,
  target,
  draft,
  onDraftChange,
  personalStyles,
  busy,
  error,
  onSubmit,
  onChooseVideos,
  onCancel,
  generateUnavailable = false,
  footageLoading = false,
  workspaceContext,
}: MotionCreatePanelProps) {
  const t = useT();
  const [playingStyle, setPlayingStyle] = useState<string | null>(null);
  const update = (patch: Partial<MotionCreateDraft>) => onDraftChange({ ...draft, ...patch });
  const hasBrief = draft.brief.trim().length > 0;
  const blockedKey = motionCreateBlockedKey(draft, personalStyles);
  const blockedReason = blockedKey ? t(blockedKey) : undefined;
  const waiting = busy || footageLoading;

  const gallery = useMemo(() => {
    if (draft.startMode === 'personal') return personalStyles;
    return [...MOVIE_STYLES].sort((a, b) => Number(!!b.demoShots) - Number(!!a.demoShots));
  }, [draft.startMode, personalStyles]);
  const query = draft.styleQuery.trim().toLowerCase();
  const visibleStyles = query
    ? gallery.filter((style) => `${style.name} ${style.description}`.toLowerCase().includes(query))
    : gallery;
  const selectedPreview = useMemo(() => movieStylePreview(draft.style), [draft.style]);

  const primaryReason = blockedReason ?? (hasBrief && generateUnavailable ? t('motion.create.generateUnavailable') : undefined);

  return (
    <div
      className={cn(variant === 'embedded' && FX, styles.panel)}
      data-testid="motion-create-panel"
      data-variant={variant}
      data-target={target.kind}
    >
      <div className={styles.body}>
        {error ? (
          <Callout tone="error" role="alert" className={styles.error}>
            {error}
          </Callout>
        ) : null}
        <div className={styles.columns}>
          <section className={styles.main}>
            <Segmented
              className={styles.segmented}
              aria-label={t('motion.create.kindAria')}
              value={draft.kind}
              onValueChange={(next) =>
                update(next === 'footage' ? { kind: 'footage', startMode: 'blank' } : { kind: 'code' })
              }
            >
              <SegmentedItem value="code">{t('motion.create.kindCode')}</SegmentedItem>
              <SegmentedItem value="footage">{t('motion.create.kindFootage')}</SegmentedItem>
            </Segmented>

            {draft.kind === 'footage' ? (
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <h3 className={styles.heading}>{t('motion.create.footageTitle')}</h3>
                  <Button variant="default" size="sm" onClick={onChooseVideos} disabled={busy}>
                    <Icon icon={Plus} size="sm" />
                    {t('motion.create.chooseVideos')}
                  </Button>
                </div>
                <p className={styles.copy}>{t('motion.create.footageBody')}</p>
                {footageLoading ? (
                  <Spinner size="sm" label={t('fantay.ui.loading')} />
                ) : draft.footage.length ? (
                  <ul className={styles.footage} data-testid="motion-create-footage">
                    {draft.footage.map((asset) => {
                      const name = footageName(asset, t('motion.section.film'));
                      return (
                        <li key={asset.id} className={styles.footageRow}>
                          <video className={styles.footageVideo} src={libraryAssetRawUrl(asset.id)} preload="metadata" muted playsInline />
                          <span className={styles.footageName}>{name}</span>
                          <IconButton
                            variant="danger"
                            size="sm"
                            aria-label={t('motion.create.removeVideo', { name })}
                            disabled={busy}
                            onClick={() => update({ footage: draft.footage.filter((item) => item.id !== asset.id) })}
                          >
                            <Icon icon={Trash2} size="sm" />
                          </IconButton>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className={styles.caption}>{t('motion.create.noVideos')}</p>
                )}
              </div>
            ) : (
              <div className={styles.section}>
                <Segmented
                  size="sm"
                  className={cn(styles.segmented, styles.startModes)}
                  aria-label={t('motion.create.startModeAria')}
                  value={draft.startMode}
                  onValueChange={(next) => update({ startMode: next as MovieStartMode })}
                >
                  {START_MODES.map(({ mode, label }) => (
                    <SegmentedItem key={mode} value={mode}>
                      {t(label)}
                    </SegmentedItem>
                  ))}
                </Segmented>
                <div className={styles.sectionHead}>
                  <h3 className={styles.heading}>
                    {t(
                      draft.startMode === 'personal'
                        ? 'motion.create.myStyles'
                        : draft.startMode === 'blank'
                          ? 'motion.create.blankTitle'
                          : 'motion.create.chooseStyle',
                    )}
                  </h3>
                  <span className={styles.caption}>
                    {draft.startMode === 'blank'
                      ? t('motion.create.blankHint')
                      : t('motion.create.styleCount', { count: gallery.length })}
                  </span>
                </div>
                {draft.startMode === 'blank' ? (
                  <EmptyState
                    variant="dashed"
                    title={t('motion.create.blankCanvasTitle')}
                    description={t('motion.create.blankCanvasBody')}
                  />
                ) : (
                  <>
                    <SearchField
                      aria-label={t('motion.create.styleSearchLabel')}
                      placeholder={t('motion.create.styleSearchPlaceholder')}
                      value={draft.styleQuery}
                      onChange={(event) => update({ styleQuery: event.target.value })}
                    />
                    {draft.startMode === 'personal' && personalStyles.length === 0 ? (
                      <EmptyState variant="dashed" title={t('motion.create.myStyles')} description={t('motion.create.noSavedStyles')} />
                    ) : (
                      <div className={styles.grid} data-testid="motion-create-styles">
                        {visibleStyles.map((style) => (
                          <StyleCard
                            key={style.id}
                            style={style}
                            selected={draft.style.id === style.id}
                            playing={playingStyle === style.id}
                            workspaceContext={workspaceContext}
                            onSelect={() => update({ style, ...(style.aspect ? { aspect: style.aspect } : {}) })}
                            onPlayingChange={(play) =>
                              setPlayingStyle((current) => (play ? style.id : current === style.id ? null : current))
                            }
                          />
                        ))}
                      </div>
                    )}
                    {draft.startMode === 'remix' || draft.startMode === 'personal' ? (
                      <StyleFields value={draft.style} onChange={(style) => update({ style })} disabled={busy} />
                    ) : null}
                  </>
                )}
              </div>
            )}
          </section>

          <aside className={styles.side}>
            {draft.kind === 'code' && draft.startMode !== 'blank' ? (
              <div className={styles.selected} data-testid="motion-create-selected-style">
                <span className={styles.caption}>{t('motion.create.selectedStyle')}</span>
                <MoviePreviewFrame
                  document={selectedPreview}
                  projectId={draft.style.sourceProjectId}
                  workspaceContext={workspaceContext}
                  variant="card"
                  lazy
                  title={draft.style.name}
                  className={styles.selectedFrame}
                />
                <strong className={styles.selectedName}>{draft.style.name}</strong>
                <p className={styles.caption}>{draft.style.description}</p>
              </div>
            ) : null}
            <h3 className={styles.heading}>{t('motion.create.briefTitle')}</h3>
            <Textarea
              aria-label={t('motion.create.briefLabel')}
              placeholder={t('motion.create.briefPlaceholder')}
              rows={4}
              value={draft.brief}
              disabled={busy}
              onChange={(event) => update({ brief: event.target.value })}
            />
            {hasBrief ? (
              <p className={styles.caption} data-testid="motion-create-produce-hint">
                {t(generateUnavailable ? 'motion.create.generateUnavailable' : 'motion.create.produceHint')}
              </p>
            ) : null}
            <Input
              aria-label={t('motion.common.filmTitle')}
              placeholder={t('motion.create.titlePlaceholder')}
              value={draft.title}
              disabled={busy}
              onChange={(event) => update({ title: event.target.value })}
            />
            <div className={styles.selects}>
              <Select value={draft.aspect} disabled={busy} onValueChange={(next) => update({ aspect: next as MovieAspect })}>
                <SelectTrigger size="sm" aria-label={t('motion.common.aspectRatio')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASPECTS.map((aspect) => (
                    <SelectItem key={aspect} value={aspect}>
                      {aspect}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </aside>
        </div>
      </div>

      <footer className={styles.footer}>
        <p className={styles.note}>
          {t(draft.kind === 'footage' ? 'motion.create.footageDraftNote' : 'motion.create.draftNote')}
        </p>
        <div className={styles.actions}>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          ) : null}
          {draft.kind === 'code' ? (
            <Button
              variant="default"
              disabled={waiting || blockedKey !== null}
              disabledReason={waiting ? undefined : blockedReason}
              onClick={() => onSubmit('refine-style')}
            >
              <Icon icon={Sparkles} size="md" />
              {t(draft.startMode === 'blank' ? 'motion.create.designStyleFirst' : 'motion.create.aiNewStyle')}
            </Button>
          ) : null}
          {hasBrief ? (
            <Button
              variant="default"
              disabled={waiting || blockedKey !== null}
              disabledReason={waiting ? undefined : blockedReason}
              onClick={() => onSubmit('storyboard')}
            >
              {t('motion.create.storyboardFirst')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={waiting || primaryReason !== undefined}
            disabledReason={waiting ? undefined : primaryReason}
            onClick={() => onSubmit(hasBrief ? 'produce' : 'storyboard')}
          >
            {busy ? t('motion.create.creating') : t(hasBrief ? 'motion.create.generate' : 'motion.create.createBlank')}
          </Button>
        </div>
      </footer>
    </div>
  );
}

/** A style choice: cover (sample video, poster, or a live frame while hovered/playing) under a
 *  full-card toggle; the preview is a sibling of the toggle, never inside it (07 §6.1 rule 7). */
function StyleCard({
  style,
  selected,
  playing,
  workspaceContext,
  onSelect,
  onPlayingChange,
}: {
  style: MovieStyle;
  selected: boolean;
  playing: boolean;
  workspaceContext?: WorkspaceCollabContext | null;
  onSelect: () => void;
  onPlayingChange: (playing: boolean) => void;
}) {
  const t = useT();
  const sample = MOVIE_SAMPLE_MEDIA[style.id];
  const preview = useMemo(() => movieStylePreview(style), [style]);
  const [hovered, setHovered] = useState(false);
  const frameRef = useRef<MoviePreviewFrameHandle>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const restTime = style.demoShots?.length ? movieDuration({ shots: style.demoShots }) * 0.5 : 0.8;
  const live = !sample && (hovered || playing);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      if (playing) void video.play()?.catch(() => onPlayingChange(false));
      else if (!video.paused) video.pause();
      return;
    }
    if (playing) {
      frameRef.current?.seek(0);
      frameRef.current?.play({ loop: true });
    } else {
      frameRef.current?.pause();
      frameRef.current?.seek(restTime);
    }
    // onPlayingChange is recreated by the parent on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, restTime]);

  const cover = useMemo(
    () => resolveMotionCover({ projectId: style.sourceProjectId ?? '', doc: preview, strip: null, workspaceContext }),
    [style.sourceProjectId, preview, workspaceContext],
  );

  return (
    <div
      className={styles.styleCard}
      data-selected={selected ? '' : undefined}
      data-testid="motion-style-card"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className={styles.styleCover}>
        {sample ? (
          <video
            ref={videoRef}
            className={styles.styleVideo}
            muted
            loop
            playsInline
            preload="metadata"
            src={sample.video}
            poster={sample.poster}
            aria-label={t('motion.styleCard.sampleAria', { name: style.name })}
            onPause={() => onPlayingChange(false)}
          />
        ) : live ? (
          <MoviePreviewFrame
            ref={frameRef}
            document={preview}
            projectId={style.sourceProjectId}
            workspaceContext={workspaceContext}
            initialTime={restTime}
            variant="fill"
            title={style.name}
            onReady={() => {
              if (playingRef.current) {
                frameRef.current?.seek(0);
                frameRef.current?.play({ loop: true });
              }
            }}
          />
        ) : (
          <MotionCover cover={cover} aspect={preview.aspect} />
        )}
      </div>
      <Button
        variant="bare"
        className={styles.styleChoose}
        aria-pressed={selected}
        aria-label={style.name}
        onClick={onSelect}
      />
      <IconButton
        variant="frosted"
        shape="round"
        size="sm"
        className={styles.stylePlay}
        aria-label={t(playing ? 'motion.styleCard.pause' : 'motion.styleCard.play', { name: style.name })}
        onClick={() => onPlayingChange(!playing)}
      >
        <Icon icon={playing ? Pause : Play} size="sm" />
      </IconButton>
      <div className={styles.styleText}>
        <strong className={styles.styleName}>{style.name}</strong>
        {style.demoShots?.length ? (
          <span className={styles.styleMeta}>
            {t('motion.styleCard.meta', { duration: movieDuration({ shots: style.demoShots }), count: style.demoShots.length })}
          </span>
        ) : null}
        <p className={styles.styleDescription}>{style.description}</p>
      </div>
    </div>
  );
}
