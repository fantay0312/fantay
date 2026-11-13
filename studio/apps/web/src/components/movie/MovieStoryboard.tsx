// SPDX-License-Identifier: Apache-2.0
// Storyboard and samples grid (spec 07 §6.3): each shot shows its rendered sample (or a lazy live frame),
// a full-cover hit button to leave feedback for that shot — a sibling of the preview, never around an
// iframe (07 §6.1 rule 7) — and, under the picture, the note count and the edit action.
import { useMemo, type CSSProperties } from "react";
import { MessageSquare, Pencil } from "lucide-react";
import type { MovieDocument, MovieShot, WorkspaceCollabContext } from "@open-design/contracts";

import { workspaceResourceUrl } from "../../collab/workspace-identity";
import { useT } from "../../i18n";
import { MoviePreviewFrame } from "../../fantay/motion/MoviePreviewFrame";
import { motionFrameSize } from "../../fantay/motion/motion-model";
import { Button, Icon, IconButton } from "../../fantay/ui";
import styles from "./MovieReview.module.css";

/** The sample frames that belong to the current content: the style preview, else the production frames. */
function samplePreview(d: MovieDocument): { frames: string[]; times: number[] } | null {
  if (d.stylePreview?.contentRevision === d.contentRevision) return d.stylePreview;
  if (d.production?.contentRevision === d.contentRevision && d.production.frames?.length) {
    return {
      frames: d.production.frames,
      times: d.shots
        .slice(0, d.production.frames.length)
        .map(
          (shot, index) =>
            d.shots.slice(0, index).reduce((n, s) => n + s.duration, 0) + Math.min(0.85, shot.duration / 2),
        ),
    };
  }
  return null;
}

export function MovieStoryboard({
  document: d,
  projectId,
  context,
  selectedShotId,
  onSelect,
  onEdit,
  lockedReason,
  editLockedReason,
  variant = "samples",
}: {
  document: MovieDocument;
  projectId: string;
  context?: WorkspaceCollabContext | null;
  selectedShotId?: string;
  onSelect: (shot: MovieShot, time: number) => void;
  onEdit?: (shot: MovieShot) => void;
  /** Every shot action is held (e.g. unapplied shot edits): disabled with this reason. */
  lockedReason?: string;
  /** Only the edit action is held (e.g. an unsaved draft): disabled with this reason. */
  editLockedReason?: string;
  variant?: "storyboard" | "samples";
}) {
  const t = useT();
  const preview = samplePreview(d);
  // One single-shot film per shot, stable while the document is: a new object would rebuild its iframe.
  const shotDocuments = useMemo(() => new Map(d.shots.map((shot) => [shot.id, { ...d, shots: [shot] }])), [d]);
  const frame = motionFrameSize(d.aspect);
  const ratio = { "--movie-ratio": `${frame.width} / ${frame.height}` } as CSSProperties;
  let start = 0;
  return (
    <section className={styles.storyboard} aria-label={t("motion.storyboard.aria")} data-testid="movie-storyboard">
      <p className={styles.storyBrief}>{d.brief || d.title}</p>
      <p className={styles.storyHint}>{t("motion.storyboard.hint")}</p>
      <div className={variant === "storyboard" ? styles.storyList : styles.storyGrid}>
        {d.shots.map((s, i) => {
          const at = start;
          start += s.duration;
          const candidates = (preview?.times ?? [])
            .map((time, index) => ({ time, index }))
            .filter((p) => p.time >= at && p.time < at + s.duration)
            .sort((a, b) => Math.abs(a.time - at - s.duration / 2) - Math.abs(b.time - at - s.duration / 2));
          const image = candidates[0] ? preview!.frames[candidates[0].index] : undefined;
          const notes = d.notes.filter((n) => n.shotId === s.id && !n.resolved);
          return (
            <article
              key={s.id}
              className={styles.storyCard}
              data-selected={selectedShotId === s.id ? "" : undefined}
              data-testid="movie-storyboard-shot"
            >
              <div className={styles.shotVisual} style={ratio}>
                {image ? (
                  <img
                    className={styles.shotImage}
                    src={workspaceResourceUrl(`/api/projects/${projectId}/raw/${image}`, context)}
                    alt={s.title}
                  />
                ) : (
                  <MoviePreviewFrame
                    document={shotDocuments.get(s.id) ?? d}
                    projectId={projectId}
                    workspaceContext={context}
                    initialTime={s.duration / 2}
                    variant="card"
                    lazy
                    title={s.title}
                  />
                )}
                <span className={styles.shotNumber} aria-hidden="true">
                  {i + 1}
                </span>
                <Button
                  variant="bare"
                  className={styles.shotHit}
                  aria-label={t("motion.storyboard.feedbackFor", { n: i + 1, title: s.title })}
                  disabled={Boolean(lockedReason)}
                  disabledReason={lockedReason}
                  onClick={() => onSelect(s, at)}
                />
              </div>
              <div className={styles.shotMeta}>
                <span>{at.toFixed(1)}s</span>
                <span>{s.duration}s</span>
                <span className={styles.shotActions}>
                  <Button
                    variant="default"
                    size="sm"
                    className={styles.noteBadge}
                    aria-label={t("motion.storyboard.shotNotes", { n: i + 1 })}
                    disabled={Boolean(lockedReason)}
                    disabledReason={lockedReason}
                    onClick={() => onSelect(s, at)}
                  >
                    <Icon icon={MessageSquare} size="sm" />
                    {notes.length || "+"}
                  </Button>
                  {onEdit ? (
                    <IconButton
                      size="sm"
                      aria-label={t("motion.storyboard.editShot", { n: i + 1 })}
                      disabled={Boolean(lockedReason ?? editLockedReason)}
                      disabledReason={lockedReason ?? editLockedReason}
                      onClick={() => onEdit(s)}
                    >
                      <Icon icon={Pencil} size="sm" />
                    </IconButton>
                  ) : null}
                </span>
              </div>
              {s.clip ? (
                <div className={styles.shotMeta}>
                  <span>
                    {t("motion.storyboard.sourceRange", {
                      from: s.clip.in.toFixed(2),
                      to: (s.clip.in + s.duration * s.clip.rate).toFixed(2),
                    })}
                  </span>
                  <span>{s.clip.rate}×</span>
                </div>
              ) : null}
              <strong className={styles.shotName}>{s.title}</strong>
              <p className={styles.shotDirection}>{s.direction || s.body}</p>
            </article>
          );
        })}
      </div>
      {!d.shots.length ? <p className={styles.emptyNotes}>{t("motion.storyboard.empty")}</p> : null}
    </section>
  );
}
