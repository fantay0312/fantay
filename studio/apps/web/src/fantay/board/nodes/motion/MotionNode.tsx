'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Motion face (spec 03 §4.11, plan R5): a film (`source.type === 'movie'`) renders 07's MotionNode through
// `extensions.renderMotionBody`; a HyperFrames composition renders as an HTML face on the URL transport with
// `odMotionPreview=1`. Not live → cover (board cover or chat snapshot) or the clapperboard placeholder ("not
// rendered yet") with a Play glyph. Double-click / Enter open the studio (engine `enterNode`).
import { useCallback, useMemo, useRef } from 'react';
import { Play } from 'lucide-react';
import { MOVIE_DOCUMENT_FILE } from '@open-design/contracts';

import { useT } from '../../../../i18n';
import { useBoardEngine, useBoardHost } from '../../context';
import { resolveCover } from '../../engine/covers';
import { FRAME_SANDBOX } from '../../engine/frame-transport';
import type { BoardMotionBodyProps } from '../../extensions';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { CoverImage } from '../common/CoverImage';
import { PlaceholderFace } from '../common/PlaceholderFace';
import { ICON_STROKE } from '../common/kind-icons';
import { FrameSurface } from '../frame/FrameSurface';
import { basenameOf, projectFileFor, projectFilePathSet } from '../frame/project-files';
import { useFrameLive } from '../frame/use-frame-live';
import { useNodeBodyProps } from '../media/body-props';
import styles from './motion.module.css';

export function MotionNode({ view }: NodeFaceProps) {
  const node = view.node as EngineNodeOf<'motion'>;
  if (node.data.source.type === 'movie') return <MovieFace view={view} />;
  return <CompositionFace view={view} />;
}

function NotRendered({ title }: { title: string }) {
  const t = useT();
  return (
    <div className={styles.placeholder}>
      <PlaceholderFace kind="motion" caption={title || t('board.node.state.notRendered')} />
      <span className={styles.play} aria-hidden>
        <Play size={22} strokeWidth={ICON_STROKE} />
      </span>
    </div>
  );
}

function MovieFace({ view }: NodeFaceProps) {
  const engine = useBoardEngine();
  const { env, extensions } = useBoardHost();
  const t = useT();
  const node = view.node as EngineNodeOf<'motion'>;
  const source = node.data.source;
  const movieProjectId = source.type === 'movie' ? source.projectId : env.projectId;
  const body = useNodeBodyProps(view, 'motion');
  const movieFile = movieProjectId === env.projectId ? projectFileFor(env.files, MOVIE_DOCUMENT_FILE) : undefined;
  const nodeId = node.id;
  const onOpenEditor = useCallback(() => extensions?.openMotionStudio?.(movieProjectId), [extensions, movieProjectId]);
  const onDataChange = useCallback(
    (patch: { title?: string; aspect?: '16:9' | '9:16' | '1:1' }) => {
      engine.commands.updateNode(
        nodeId,
        {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.aspect !== undefined ? { data: { aspect: patch.aspect } } : {}),
        },
        { origin: 'system', label: 'style' },
      );
    },
    [engine, nodeId],
  );
  const motionProps = useMemo<BoardMotionBodyProps>(
    () => ({
      ...body,
      movie: {
        projectId: movieProjectId,
        ...(node.title ? { title: node.title } : {}),
        ...(node.data.aspect ? { aspect: node.data.aspect } : {}),
      },
      ...(movieFile ? { fileVersion: movieFile.mtime } : {}),
      onOpenEditor,
      onDataChange,
    }),
    [body, movieProjectId, node.title, node.data.aspect, movieFile, onOpenEditor, onDataChange],
  );
  if (extensions?.renderMotionBody) {
    return (
      <div className={styles.body} data-testid="board-motion-body">
        {extensions.renderMotionBody(motionProps)}
      </div>
    );
  }
  const cover = resolveCover({ node, messages: env.messages, projectId: env.projectId, workspaceContext: env.workspaceContext });
  const title = node.title ?? t('board.kind.motion');
  return (
    <div className={styles.motion} data-testid="board-motion">
      {cover ? <CoverImage src={cover.url} alt={title} /> : <NotRendered title={title} />}
    </div>
  );
}

function CompositionFace({ view }: NodeFaceProps) {
  const { env } = useBoardHost();
  const t = useT();
  const node = view.node as EngineNodeOf<'motion'>;
  const path = node.data.source.type === 'composition' ? node.data.source.ref.path : null;
  const file = projectFileFor(env.files, path);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const live = useFrameLive({
    live: view.live && path !== null,
    projectId: env.projectId,
    path,
    liveArtifactId: null,
    file,
    building: path !== null && env.buildingPaths.has(path),
    filesRefreshKey: env.filesRefreshKey,
    isDeckProject: false,
    projectFilePaths: projectFilePathSet(env.files),
    workspaceContext: env.workspaceContext,
    motion: true,
    editingSource: null,
    reload: 0,
  });
  const cover = resolveCover({ node, file, messages: env.messages, projectId: env.projectId, workspaceContext: env.workspaceContext });
  const title = node.title ?? (path ? basenameOf(path) : t('board.kind.motion'));
  const underlay = cover ? <CoverImage src={cover.url} alt={title} /> : <NotRendered title={title} />;
  return (
    <div className={styles.motion} data-testid="board-motion" data-selected={view.selected ? '' : undefined}>
      <FrameSurface
        title={title}
        width={node.w}
        height={node.h}
        layoutZoom={view.layoutZoom}
        sandbox={FRAME_SANDBOX}
        current={view.live ? live.current : null}
        pending={view.live ? live.pending : null}
        active={view.active}
        // an explicit Pause (context bar) wins over the select/hover preview
        motionActive={view.runtime.playing === true || (view.runtime.playing !== false && (view.selected || view.hovered))}
        motionMuted={!view.selected}
        underlay={underlay}
        ready={live.ready}
        onFrame={(iframe, role) => {
          if (role === 'current') iframeRef.current = iframe;
        }}
        onFrameGone={(iframe) => {
          if (iframeRef.current === iframe) iframeRef.current = null;
        }}
        onLoad={live.onLoad}
      />
    </div>
  );
}
