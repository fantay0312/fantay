// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palmier, Inc.
// Swift -> TypeScript adaptation, modified 2026-10-29 for Fantay.
// Original: palmier-io/palmier-pro @ 8805801fa4df8bc2dbc57cb0a854a1f5108f95c6
// Sources: Timeline/SnapEngine.swift, Utilities/TimeFormatting.swift,
// Utilities/Constants.swift, UI/AppTheme.swift. AppKit haptics omitted.
// This file is distributed without warranty. See licenses/palmier-pro-GPL-3.0.txt.

export const PALMIER_LAYOUT = {
  mediaPanelDefault: 500, mediaPanelMin: 352, inspectorDefault: 340,
  inspectorMin: 300, previewMinWidth: 400, previewMinHeight: 320,
  panelHeaderHeight: 30, toolbarHeight: 36, timelineDefaultHeightFraction: 0.35,
  trackHeight: 44, rulerHeight: 28, trackHeaderWidth: 160,
  trackHeaderMinWidth: 112, trimHandleWidth: 4, clipLabelHeight: 16,
  inspectorLabelWidth: 88, inspectorRowHeight: 22,
} as const;
export const SNAP = { thresholdPixels: 8, stickyMultiplier: 1.5, playheadMultiplier: 1.5 } as const;
export interface SnapTarget { frame: number; kind: 'playhead' | 'clipEdge' | 'beat' | 'marker' }
export interface SnapState { currentlySnappedTo?: number; currentProbeOffset: number }
export interface SnapResult { frame: number; probeOffset: number; x: number }
export function collectTargets(tracks: { clips: { id: string; startFrame: number; endFrame: number }[] }[],
  playheadFrame = 0, excludeClipIds = new Set<string>(), includePlayhead = false,
  markerFrames: number[] = []): SnapTarget[] {
  const targets: SnapTarget[] = [];
  if (includePlayhead) targets.push({ frame: playheadFrame, kind: 'playhead' });
  targets.push(...markerFrames.map(frame => ({ frame, kind: 'marker' as const })));
  for (const track of tracks) for (const clip of track.clips) if (!excludeClipIds.has(clip.id)) {
    targets.push({ frame: clip.startFrame, kind: 'clipEdge' }, { frame: clip.endFrame, kind: 'clipEdge' });
  }
  return targets;
}
/** Port of SnapEngine.findSnap; iteration order intentionally resolves equal distances. */
export function findSnap(position: number, probeOffsets: number[], targets: SnapTarget[], state: SnapState,
  baseThreshold: number, pixelsPerFrame: number): SnapResult | null {
  if (!(pixelsPerFrame > 0)) return null;
  const baseFrameThreshold = baseThreshold / pixelsPerFrame;
  if (state.currentlySnappedTo !== undefined) {
    const snapped = state.currentlySnappedTo, holdThreshold = baseFrameThreshold * SNAP.stickyMultiplier;
    if (Math.abs(position + state.currentProbeOffset - snapped) <= holdThreshold && targets.some(t => t.frame === snapped))
      return { frame: snapped, probeOffset: state.currentProbeOffset, x: snapped * pixelsPerFrame };
    delete state.currentlySnappedTo; state.currentProbeOffset = 0;
  }
  let best: { probeOffset: number; target: SnapTarget; distance: number } | undefined;
  for (const probeOffset of probeOffsets) for (const target of targets) {
    const threshold = baseFrameThreshold * (target.kind === 'playhead' ? SNAP.playheadMultiplier : 1);
    const distance = Math.abs(position + probeOffset - target.frame);
    if (distance <= threshold && distance < (best?.distance ?? Infinity)) best = { probeOffset, target, distance };
  }
  if (!best) return null;
  state.currentlySnappedTo = best.target.frame; state.currentProbeOffset = best.probeOffset;
  return { frame: best.target.frame, probeOffset: best.probeOffset, x: best.target.frame * pixelsPerFrame };
}
export function formatTimecode(frame: number, fps: number): string {
  if (!(fps > 0)) return '00:00:00:00';
  const abs = Math.abs(Math.trunc(frame)), seconds = Math.trunc(abs / fps);
  return (frame < 0 ? '-' : '') + [Math.trunc(seconds / 3600), Math.trunc(seconds / 60) % 60, seconds % 60, abs % fps].map(n => String(n).padStart(2, '0')).join(':');
}
export function parseTimecode(value: string, fps: number): number | null {
  const fields = value.split(':');
  if (!Number.isInteger(fps) || fps < 1 || fps > 1000 || fields.length !== 4 || fields.some(s => !/^[+]?[0-9]+$/.test(s))) return null;
  const [h, m, s, f] = fields.map(Number);
  if (h! >= 1000 || m! >= 60 || s! >= 60 || f! >= fps) return null;
  return (h! * 3600 + m! * 60 + s!) * fps + f!;
}
export const secondsToFrame = (seconds: number, fps: number): number => Math.trunc(seconds * fps);
