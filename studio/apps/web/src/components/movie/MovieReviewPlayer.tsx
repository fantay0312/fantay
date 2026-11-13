// SPDX-License-Identifier: Apache-2.0
// Review player (spec 07 §6.2, §6.3): the rendered MP4 absorbs the free height, so the transport, the
// timeline (filmstrip, waveform, range selection, feedback markers) and the chapters always stay
// visible. Space plays, ←/→ step one source frame (Shift: ten), N leaves feedback at this moment.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { MessageSquare, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import type {
  MovieNoteTarget,
  MovieRender,
  MovieReviewAssets,
  MovieReviewNote,
  WorkspaceCollabContext,
} from "@open-design/contracts";

import { workspaceResourceUrl } from "../../collab/workspace-identity";
import { useT } from "../../i18n";
import { getMovieReviewAssets } from "../../providers/movie";
import { Button, Chip, Icon, IconButton, Kbd } from "../../fantay/ui";
import styles from "./MovieReview.module.css";

export interface MovieReviewPlayerHandle {
  seek: (time: number) => void;
  freeze: () => number;
}

const clock = (t: number) =>
  `${Math.floor(t / 60)
    .toString()
    .padStart(2, "0")}:${(t % 60).toFixed(2).padStart(5, "0")}`;

export const MovieReviewPlayer = forwardRef<
  MovieReviewPlayerHandle,
  {
    projectId: string;
    render: MovieRender;
    context?: WorkspaceCollabContext | null;
    notes: MovieReviewNote[];
    target: MovieNoteTarget;
    onTarget: (value: MovieNoteTarget) => void;
    onTime: (time: number) => void;
    onAnnotate: () => void;
    /** Writing feedback is held (e.g. unapplied shot edits): the action, the markers and N wait, with this reason. */
    annotateDisabledReason?: string;
  }
>(function MovieReviewPlayer(
  { projectId, render, context, notes, target, onTarget, onTime, onAnnotate, annotateDisabledReason },
  ref,
) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const [assets, setAssets] = useState<MovieReviewAssets | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const duration = assets?.duration ?? render.duration ?? 0;
  const fps = assets?.fps ?? 30;

  const seek = (value: number) => {
    const next = Math.max(0, Math.min(duration, value));
    if (video.current) {
      video.current.pause();
      video.current.currentTime = next;
    }
    setTime(next);
    setPlaying(false);
    onTime(next);
  };
  useImperativeHandle(ref, () => ({
    seek,
    freeze: () => {
      video.current?.pause();
      setPlaying(false);
      return video.current?.currentTime ?? time;
    },
  }));
  useEffect(() => {
    let cancelled = false;
    setAssets(null);
    setError("");
    setTime(0);
    setPlaying(false);
    getMovieReviewAssets(projectId, render.id, context)
      .then((next) => {
        if (!cancelled) setAssets(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, render.id, context, retry]);

  const toggle = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch((cause: unknown) => setError(String(cause)));
    else element.pause();
  };
  const atPointer = (x: number) => {
    const bounds = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((x - bounds.left) / bounds.width) * duration));
  };
  const select = (start: number, end?: number) =>
    onTarget({
      scope: end !== undefined && Math.abs(end - start) > 0.08 ? "range" : "time",
      renderId: render.id,
      time: Math.min(start, end ?? start),
      ...(end !== undefined && Math.abs(end - start) > 0.08 ? { endTime: Math.max(start, end) } : {}),
    });
  const annotate = () => {
    if (annotateDisabledReason) return;
    select(video.current?.currentTime ?? time);
    video.current?.pause();
    onAnnotate();
  };
  const keyboard = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button,input,textarea,select,a")) return;
    if (event.code === "Space") {
      event.preventDefault();
      toggle();
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seek(time + ((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1)) / fps);
    }
    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      annotate();
    }
  };
  const range = target.renderId === render.id && target.scope === "range";
  const percent = (value: number) => `${duration ? (value / duration) * 100 : 0}%`;
  const audioNote =
    assets?.audio === "none"
      ? t("motion.player.noAudio")
      : assets?.audio === "silent"
        ? t("motion.player.silentAudio")
        : "";

  return (
    <section
      className={styles.player}
      aria-label={t("motion.player.aria")}
      tabIndex={0}
      onKeyDown={keyboard}
      data-testid="movie-review-player"
    >
      <video
        tabIndex={0}
        key={render.id}
        ref={video}
        className={styles.video}
        src={workspaceResourceUrl(`/api/projects/${projectId}/raw/${render.file}`, context)}
        muted={muted}
        playsInline
        onLoadedMetadata={(event) => {
          const next =
            target.renderId === render.id ? Math.min(target.time, event.currentTarget.duration || duration) : 0;
          event.currentTarget.currentTime = next;
          setTime(next);
          onTime(next);
        }}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime);
          onTime(event.currentTarget.currentTime);
        }}
        aria-label={t("motion.player.videoAria")}
      />
      <div className={styles.transport} data-testid="movie-review-transport">
        <span className={styles.clock}>
          {clock(time)} <span className={styles.clockTotal}>/ {clock(duration)}</span>
        </span>
        <div className={styles.playButtons}>
          <IconButton size="md" aria-label={t("motion.player.prevFrame")} shortcut="left" onClick={() => seek(time - 1 / fps)}>
            <Icon icon={SkipBack} size="md" />
          </IconButton>
          <IconButton
            variant="primary"
            shape="round"
            size="lg"
            aria-label={t(playing ? "motion.common.pause" : "motion.common.play")}
            shortcut="space"
            onClick={toggle}
          >
            <Icon icon={playing ? Pause : Play} size="lg" />
          </IconButton>
          <IconButton size="md" aria-label={t("motion.player.nextFrame")} shortcut="right" onClick={() => seek(time + 1 / fps)}>
            <Icon icon={SkipForward} size="md" />
          </IconButton>
        </div>
        <div className={styles.transportEnd}>
          <Button
            variant="default"
            size="sm"
            aria-keyshortcuts="N"
            disabled={Boolean(annotateDisabledReason)}
            disabledReason={annotateDisabledReason}
            onClick={annotate}
          >
            <Icon icon={MessageSquare} size="sm" />
            <span className={styles.annotateLabel}>{t("motion.player.annotate")}</span>
            <Kbd aria-hidden="true" className={styles.annotateKey}>
              N
            </Kbd>
          </Button>
          <IconButton size="md" aria-label={t(muted ? "motion.player.unmute" : "motion.player.mute")} onClick={() => setMuted(!muted)}>
            <Icon icon={muted ? VolumeX : Volume2} size="md" />
          </IconButton>
        </div>
      </div>
      <div className={styles.timeline}>
        <div
          ref={track}
          className={styles.track}
          role="slider"
          aria-label={t("motion.player.timelineAria")}
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={time}
          aria-valuetext={`${clock(time)} / ${clock(duration)}`}
          tabIndex={0}
          onPointerDown={(event) => {
            if (!duration) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            anchor.current = atPointer(event.clientX);
            seek(anchor.current);
            select(anchor.current);
          }}
          onPointerMove={(event) => {
            if (anchor.current === null) return;
            select(anchor.current, atPointer(event.clientX));
          }}
          onPointerUp={(event) => {
            if (anchor.current === null) return;
            select(anchor.current, atPointer(event.clientX));
            anchor.current = null;
          }}
          onPointerCancel={() => {
            anchor.current = null;
          }}
        >
          <div className={styles.ticks} aria-hidden="true">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i}>{((duration * i) / 6).toFixed(duration < 10 ? 1 : 0)}s</span>
            ))}
          </div>
          <div
            className={styles.filmstrip}
            style={
              assets
                ? {
                    backgroundImage: `url("${workspaceResourceUrl(`/api/projects/${projectId}/raw/${assets.thumbnailFile}`, context)}")`,
                  }
                : undefined
            }
          >
            {!assets ? (
              <span className={styles.filmstripNote}>
                {t(error ? "motion.player.timelineUnavailable" : "motion.player.timelinePreparing")}
              </span>
            ) : null}
          </div>
          <svg
            className={styles.waveform}
            viewBox="0 0 1000 32"
            preserveAspectRatio="none"
            role="img"
            aria-label={t("motion.player.waveform")}
          >
            {assets?.peaks.length ? (
              assets.peaks.map((peak, i) => (
                <path key={i} d={`M${(i / assets.peaks.length) * 1000} ${16 - peak * 14}V${16 + peak * 14}`} />
              ))
            ) : (
              <path d="M0 16H1000" />
            )}
          </svg>
          {range ? (
            <div
              className={styles.selection}
              style={{
                left: percent(target.time),
                width: percent((target.endTime ?? target.time) - target.time),
              }}
            />
          ) : null}
          <div className={styles.playhead} style={{ left: percent(time) }} />
        </div>
        {notes
          .filter((note) => note.renderId === render.id)
          .map((note) => (
            <button
              type="button"
              key={note.id}
              className={styles.marker}
              data-resolved={note.resolved ? "" : undefined}
              style={{ left: percent(note.time) }}
              aria-label={t("motion.player.markerAria", { time: clock(note.time), text: note.text })}
              disabled={Boolean(annotateDisabledReason)}
              onClick={() => {
                seek(note.time);
                onTarget({
                  scope: note.scope ?? "time",
                  renderId: render.id,
                  time: note.time,
                  ...(note.endTime === undefined ? {} : { endTime: note.endTime }),
                  ...(note.shotId ? { shotId: note.shotId } : {}),
                });
                onAnnotate();
              }}
            />
          ))}
      </div>
      <div className={styles.timelineHint}>
        <span>{t("motion.player.hint")}</span>
        <span>{audioNote}</span>
      </div>
      {error ? (
        <Button variant="link" size="sm" className={styles.retry} onClick={() => setRetry((value) => value + 1)}>
          {t("motion.player.retryTimeline")}
        </Button>
      ) : null}
      {assets ? (
        <div className={styles.chapters}>
          {assets.shots.map((shot, i) => {
            const start = assets.shots.slice(0, i).reduce((n, s) => n + s.duration, 0);
            const targeted = target.scope === "shot" && target.shotId === shot.id;
            return (
              <Chip
                key={shot.id}
                size="sm"
                className={styles.chapter}
                on={targeted}
                aria-pressed={targeted}
                onClick={() => {
                  seek(start);
                  onTarget({ scope: "shot", renderId: render.id, shotId: shot.id, time: start, endTime: start + shot.duration });
                }}
              >
                <span className={styles.chapterNumber}>{String(i + 1).padStart(2, "0")}</span>
                <span className={styles.chapterTitle}>{shot.title}</span>
              </Chip>
            );
          })}
        </div>
      ) : null}
    </section>
  );
});
