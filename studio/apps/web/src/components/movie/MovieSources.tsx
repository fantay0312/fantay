// SPDX-License-Identifier: Apache-2.0
// The film's source videos (spec 07 §6.3): one open Disclosure per imported video with its real
// duration, size, audio state, the native player and the inspected frames.
import { useEffect, useState } from "react";
import type { MovieVideoSource, WorkspaceCollabContext } from "@open-design/contracts";

import { workspaceResourceUrl } from "../../collab/workspace-identity";
import { useT } from "../../i18n";
import { getMovieVideoSources } from "../../providers/movie";
import { Callout, Disclosure } from "../../fantay/ui";
import styles from "./MovieSources.module.css";

const SHOWN_FRAMES = 6;

/** At most six frames, one from the middle of each equal span of what the daemon sampled. */
function spacedFrames<T>(frames: readonly T[]): T[] {
  if (frames.length <= SHOWN_FRAMES) return [...frames];
  return Array.from({ length: SHOWN_FRAMES }, (_, index) => frames[Math.floor(((index + 0.5) * frames.length) / SHOWN_FRAMES)]!);
}

export function MovieSources({
  projectId,
  revision,
  context,
}: {
  projectId: string;
  revision: string;
  context?: WorkspaceCollabContext | null;
}) {
  const t = useT();
  const [sources, setSources] = useState<MovieVideoSource[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    getMovieVideoSources(projectId, context)
      .then((next) => {
        if (!active) return;
        setSources(next);
        setError("");
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [projectId, revision, context]);
  const raw = (path: string) => workspaceResourceUrl(`/api/projects/${projectId}/raw/${path}`, context);
  return (
    <section className={styles.sources} aria-label={t("motion.sources.title")} data-testid="movie-sources">
      {error ? (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      ) : null}
      {sources.map((source) => (
        <Disclosure
          key={source.assetId}
          defaultOpen
          label={
            <span className={styles.label}>
              <span className={styles.name}>{source.label}</span>
              <span className={styles.meta}>
                {source.duration.toFixed(1)}s · {source.width}×{source.height} ·{" "}
                {t(source.hasAudio ? "motion.sources.hasAudio" : "motion.sources.silent")}
              </span>
            </span>
          }
        >
          <video className={styles.video} controls preload="metadata" src={raw(source.path)} />
          <div className={styles.frames}>
            {spacedFrames(source.frames).map((frame) => (
              <figure key={frame.path} className={styles.frame}>
                <img className={styles.frameImage} src={raw(frame.path)} alt={`${frame.time.toFixed(1)}s`} />
                <figcaption className={styles.frameTime}>{frame.time.toFixed(1)}s</figcaption>
              </figure>
            ))}
          </div>
        </Disclosure>
      ))}
    </section>
  );
}
