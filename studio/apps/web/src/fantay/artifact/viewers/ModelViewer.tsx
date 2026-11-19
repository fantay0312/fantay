// SPDX-License-Identifier: AGPL-3.0-only
// 3D models (glTF / GLB, OBJ, STL, PLY, 3MF): one object on the canvas ground, framed to fit and
// lit like a neutral studio. Drag turns it, scroll or pinch zooms, right-drag or two fingers pan,
// a double click goes back to the framed view; the arrow keys, plus, minus and 0 do the same from
// the keyboard. The bar offers "reset view" and a wireframe; the overflow menu swaps the up axis,
// which 3D files do not state. three.js and each format's loader are imported when a model opens
// (model/model-stage.ts, model/model-load.ts). The camera, the wireframe and the up axis belong to
// the file, so they survive a tab switch and a rewrite. A glTF's external buffers and textures are
// read from the same project folder; formats without a reliable reader show the file card.
'use client';

import { Axis3d, Box, MonitorOff, RotateCcw, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useProjectCollabContext } from '../../../collab/collab-context';
import { workspaceProjectHeaders } from '../../../collab/workspace-identity';
import { useI18n, useT } from '../../../i18n';
import { projectFileUrl } from '../../../providers/registry';
import { ArtifactShell, type ArtifactAction, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, formatBytes, useArtifactBytes } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import styles from './ModelViewer.module.css';
import {
  MODEL_MAX_BYTES,
  MODEL_READERS,
  defaultUpAxis,
  formatExtents,
  inspectGltf,
  isModelFormat,
  type ModelFormat,
} from './model/model-format';
import type { CameraPose, ModelStage, ModelStats, Rgb, StageColors } from './model/model-stage';
import { FileCard } from './UnknownViewer';

const TURN = Math.PI / 12;

type Failure =
  | { kind: 'no-webgl' }
  | { kind: 'invalid' }
  | { kind: 'empty' }
  | { kind: 'timeout' }
  | { kind: 'missing'; files: readonly string[] }
  | { kind: 'feature'; name: string };

/** Shown until the reader has turned a model once; after that nobody needs telling. */
let hintSeen = false;

/** "rgb(205, 205, 205)" or "color(srgb 0.8 0.8 0.8)", as the browser reports a computed colour. */
function parseColor(value: string): Rgb | null {
  const numbers = value.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number);
  if (!numbers || numbers.length < 3) return null;
  const [red = 0, green = 0, blue = 0] = value.startsWith('color(') ? numbers : numbers.map((part) => part / 255);
  return [red, green, blue];
}

function ModelStageView({ projectId, file, format, active }: ArtifactViewerProps & { format: ModelFormat }): JSX.Element {
  const t = useT();
  const { locale } = useI18n();
  const { workspaceContext } = useProjectCollabContext();
  const fileActions = useArtifactFileActions(projectId, file);

  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: MODEL_MAX_BYTES[format] });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;

  // ── what the reader set ───────────────────────────────────────────────────────────────────────
  const [wireframe, setWireframe] = useArtifactViewState(projectId, file.name, 'wireframe', false);
  const [upAxis, setUpAxis] = useArtifactViewState<'y' | 'z'>(projectId, file.name, 'up', defaultUpAxis(format));

  // ── the stage ─────────────────────────────────────────────────────────────────────────────────
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clayRef = useRef<HTMLSpanElement | null>(null);
  const lineRef = useRef<HTMLSpanElement | null>(null);
  const stageRef = useRef<ModelStage | null>(null);
  /** The model on screen: its bytes, its numbers and the textures it had to do without. */
  const [shown, setShown] = useState<{ data: ArrayBuffer; stats: ModelStats; missing: string[] } | null>(null);
  const [failure, setFailure] = useState<{ data: ArrayBuffer; failure: Failure } | null>(null);
  const [hint, setHint] = useState(!hintSeen);
  // Read through refs by the loading effect, which must not start over when they change.
  const viewRef = useRef({ wireframe, upAxis });
  viewRef.current = { wireframe, upAxis };

  const readColors = useCallback((): StageColors | null => {
    const clay = clayRef.current ? parseColor(getComputedStyle(clayRef.current).color) : null;
    const line = lineRef.current ? parseColor(getComputedStyle(lineRef.current).color) : null;
    return clay && line ? { clay, line } : null;
  }, []);

  const name = file.name;
  useEffect(() => {
    if (!data) return;
    let current = true;
    const fail = (value: Failure): void => {
      if (current) setFailure({ data, failure: value });
    };
    void (async () => {
      // A glTF says up front when it needs a decoder the preview does not have.
      if (format === 'gltf') {
        const inspection = inspectGltf(data);
        if (!inspection) return fail({ kind: 'invalid' });
        if (inspection.unreadable) return fail({ kind: 'feature', name: inspection.unreadable });
      }
      try {
        const [{ ModelStage: Stage, StageError }, { loadModel, ModelLoadError }] = await Promise.all([
          import('./model/model-stage'),
          import('./model/model-load'),
        ]);
        let loaded;
        try {
          loaded = await loadModel({
            format,
            bytes: data,
            path: name,
            projectUrl: (path) => projectFileUrl(projectId, path, workspaceContext),
            headers: workspaceContext ? Object.fromEntries(new Headers(workspaceProjectHeaders(workspaceContext))) : undefined,
          });
        } catch (error) {
          if (!(error instanceof ModelLoadError)) return fail({ kind: 'invalid' });
          if (error.code === 'missing') return fail({ kind: 'missing', files: error.files });
          return fail({ kind: error.code === 'timeout' || error.code === 'empty' ? error.code : 'invalid' });
        }
        const host = hostRef.current;
        if (!current || !host) return;
        try {
          if (!stageRef.current) {
            stageRef.current = new Stage(host, {
              onPose: (pose) => writeArtifactViewState(projectId, name, 'camera', pose),
              onInteract: () => {
                hintSeen = true;
                setHint(false);
              },
            });
          }
          const stage = stageRef.current;
          const colors = readColors();
          if (colors) stage.setColors(colors);
          stage.setWireframe(viewRef.current.wireframe);
          const stats = stage.setModel(loaded.root, {
            bare: loaded.bare,
            upAxis: viewRef.current.upAxis,
            pose: readArtifactViewState<CameraPose | null>(projectId, name, 'camera') ?? null,
          });
          setFailure(null);
          setShown({ data, stats, missing: loaded.missing });
        } catch (error) {
          fail(error instanceof StageError ? { kind: error.code } : { kind: 'invalid' });
        }
      } catch {
        // The 3D code itself did not load.
        fail({ kind: 'invalid' });
      }
    })();
    return () => {
      current = false;
    };
  }, [data, format, name, projectId, workspaceContext, readColors]);

  useEffect(
    () => () => {
      stageRef.current?.dispose();
      stageRef.current = null;
    },
    [],
  );

  useEffect(() => {
    stageRef.current?.setActive(active);
  }, [active]);

  // The interface theme can change while a model is open: its neutral material follows.
  useEffect(() => {
    if (!shown || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      const colors = readColors();
      if (colors) stageRef.current?.setColors(colors);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => observer.disconnect();
  }, [shown, readColors]);

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  const toggleWireframe = useCallback(() => {
    const next = !viewRef.current.wireframe;
    setWireframe(next);
    stageRef.current?.setWireframe(next);
  }, [setWireframe]);

  const toggleUpAxis = useCallback(() => {
    const next = viewRef.current.upAxis === 'z' ? 'y' : 'z';
    setUpAxis(next);
    stageRef.current?.setUpAxis(next);
  }, [setUpAxis]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const stage = stageRef.current;
    if (!stage || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowLeft') stage.orbit(-TURN, 0);
    else if (event.key === 'ArrowRight') stage.orbit(TURN, 0);
    else if (event.key === 'ArrowUp') stage.orbit(0, -TURN);
    else if (event.key === 'ArrowDown') stage.orbit(0, TURN);
    else if (event.key === '+' || event.key === '=') stage.dolly(0.8);
    else if (event.key === '-' || event.key === '_') stage.dolly(1.25);
    else if (event.key === '0' || event.key === 'Home') stage.resetView();
    else return;
    event.preventDefault();
  };

  const ready = shown !== null;
  const actions = useMemo<ArtifactAction[]>(
    () => [
      { id: 'reset-view', label: t('artifact.model.resetView'), icon: RotateCcw, disabled: !ready, onSelect: () => stageRef.current?.resetView() },
      { id: 'wireframe', label: t('artifact.model.wireframe'), icon: Box, on: wireframe, disabled: !ready, onSelect: toggleWireframe },
      fileActions.download,
    ],
    [fileActions.download, ready, t, toggleWireframe, wireframe],
  );
  const menu = useMemo<ArtifactMenuEntry[]>(
    () => [
      {
        id: 'up-axis',
        label: t(upAxis === 'z' ? 'artifact.model.useYUp' : 'artifact.model.useZUp'),
        icon: Axis3d,
        disabled: !ready,
        onSelect: toggleUpAxis,
      },
      ...fileActions.menu.map((entry, index) => (index === 0 ? { ...entry, separated: true } : entry)),
    ],
    [fileActions.menu, ready, t, toggleUpAxis, upAxis],
  );

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const failed = failure && failure.data === data && shown?.data !== data ? failure.failure : null;
  const reading = data !== null && !shown && !failed;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!reading) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), ARTIFACT_SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [reading]);

  let state: ArtifactShellState | null = null;
  if (failed?.kind === 'no-webgl') {
    state = fileActions.unsupported(t('artifact.model.noWebgl'), t('artifact.model.noWebglHint'), MonitorOff);
  } else if (failed?.kind === 'timeout') {
    state = {
      kind: 'notice',
      icon: Box,
      title: t('artifact.model.timeout'),
      action: { label: t('fileViewer.reload'), onSelect: bytes.reload },
      secondaryAction: { label: t('fileViewer.download'), onSelect: fileActions.downloadFile },
    };
  } else if (failed?.kind === 'missing') {
    state = fileActions.unsupported(
      t('artifact.model.missingFiles'),
      t('artifact.model.missingFilesHint', { files: failed.files.slice(0, 4).join('、') }),
      Unplug,
    );
  } else if (failed?.kind === 'feature') {
    state = fileActions.unsupported(t('artifact.model.unsupportedFeature', { name: failed.name }), undefined, Box);
  } else if (failed?.kind === 'empty') {
    state = fileActions.unsupported(t('artifact.model.empty'), undefined, Box);
  } else if (failed) {
    state = fileActions.unsupported(t('artifact.model.failed'), t('artifact.model.failedHint'), Box);
  } else if (!shown) {
    state = reading
      ? slow
        ? { kind: 'loading', label: t('artifact.model.reading') }
        : { kind: 'loading', quiet: true }
      : fileActions.sourceState(bytes.source, bytes.reload);
  }

  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const stats = shown?.stats ?? null;
  const facts = [
    stats && stats.vertices > 0 ? t('artifact.model.vertices', { count: numberFormat.format(stats.vertices) }) : null,
    stats && stats.faces > 0 ? t('artifact.model.faces', { count: numberFormat.format(stats.faces) }) : null,
    stats && stats.points > 0 ? t('artifact.model.points', { count: numberFormat.format(stats.points) }) : null,
    stats ? formatExtents(stats.size) : null,
    formatBytes(file.size),
  ].filter(Boolean);

  return (
    <ArtifactShell
      viewer="model"
      path={file.name}
      stage="canvas"
      meta={facts.join(' · ')}
      actions={actions}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
      keepContentMounted
    >
      <div className={styles.stage}>
        <div
          ref={hostRef}
          className={styles.host}
          tabIndex={0}
          role="img"
          aria-label={t('artifact.model.stageLabel', { name: file.name.split('/').pop() ?? file.name })}
          data-model-stage=""
          onKeyDown={onKeyDown}
          onDoubleClick={() => stageRef.current?.resetView()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {/* Never drawn: they hand the theme's colours to the 3D material. */}
          <span ref={clayRef} className={styles.clayProbe} aria-hidden="true" />
          <span ref={lineRef} className={styles.lineProbe} aria-hidden="true" />
        </div>
        {shown && shown.missing.length > 0 ? (
          <p className={styles.note} role="note" title={shown.missing.join('\n')}>
            {t('artifact.model.missingTextures', { count: shown.missing.length })}
          </p>
        ) : null}
        <p className={styles.hint} data-shown={ready && hint ? '' : undefined} aria-hidden="true">
          {t('artifact.model.hint')}
        </p>
      </div>
    </ArtifactShell>
  );
}

export default function ModelViewer(props: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const format = props.family.format;
  if (!isModelFormat(format) || MODEL_READERS[format] === 'none') {
    return <FileCard {...props} reason={t('artifact.model.unsupportedFormat', { type: props.family.extension.toUpperCase() })} />;
  }
  return <ModelStageView {...props} format={format} />;
}
