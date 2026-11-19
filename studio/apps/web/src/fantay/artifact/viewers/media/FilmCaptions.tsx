// SPDX-License-Identifier: AGPL-3.0-only
// The subtitle line over a film. It follows the element's own clock while the film plays, moves up
// out of the way when the controls are showing, and is plain text: nothing from the subtitle file
// is ever inserted as markup.
'use client';

import { useEffect, useState } from 'react';

import { captionAt, type Cue } from './captions';
import styles from './FilmCaptions.module.css';

export interface FilmCaptionsProps {
  cues: readonly Cue[];
  playing: boolean;
  /** Seconds; the position while the film is not playing. */
  time: number;
  liveTime(): number;
  /** True while the controls are showing: the line sits above them. */
  raised: boolean;
  /** Width of the picture in CSS pixels; the text scales with it. */
  width: number;
}

export function FilmCaptions({ cues, playing, time, liveTime, raised, width }: FilmCaptionsProps): JSX.Element | null {
  const [live, setLive] = useState('');

  // A cue can start between two of the element's time reports, so the clock is read every frame.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function step() {
      setLive(captionAt(cues, liveTime()));
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, cues, liveTime]);

  const text = playing ? live : captionAt(cues, time);
  if (text === '') return null;
  return (
    <div
      className={styles.captions}
      data-raised={raised || undefined}
      data-media-captions=""
      style={{ fontSize: Math.round(Math.min(26, Math.max(13, width * 0.026))) }}
    >
      <span className={styles.line}>{text}</span>
    </div>
  );
}
