// SPDX-License-Identifier: AGPL-3.0-only
// The shared code pane plus the two things a file viewer needs around it: the reader's place is kept
// per file and view (a tab switch or a rewrite by the agent remounts the viewer, and must not send
// the reader back to line 1), and the runs a terminal log had coloured are tinted again.
'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';

import { readArtifactViewState, writeArtifactViewState } from '../../use-view-state';
import { CodePane } from '../parts/CodePane';
import type { AnsiSpan } from './ansi';
import type { CodeScrollSnapshot, CodeViewBinding } from './code-view-runtime';
import styles from './TextPane.module.css';

const NO_SPANS: readonly AnsiSpan[] = [];

export interface TextPaneProps {
  projectId: string;
  /** The file the place is remembered for. */
  fileName: string;
  /** Names the view of the file ("raw", "formatted"): each has its own document and its own place. */
  view: string;
  /** Picks the language; differs from `fileName` when the extension alone does not say it. */
  languageName?: string;
  text: string;
  wrap: boolean;
  /** Coloured runs of a terminal log, as offsets into `text`. */
  spans?: readonly AnsiSpan[];
  /** One quiet line above the text: why the file is not shown the usual way. */
  notice?: string | null;
}

export function TextPane({ projectId, fileName, view, languageName, text, wrap, spans = NO_SPANS, notice = null }: TextPaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<CodeViewBinding | null>(null);
  const spansRef = useRef(spans);
  spansRef.current = spans;
  const slot = `scroll:${view}`;

  // A layout effect, so the old view's listener is gone before the pane swaps documents and resets
  // its scroller: that reset must not be recorded as the reader's place in the view being left.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let observer: MutationObserver | null = null;

    void import('./code-view-runtime').then(
      ({ bindCodeView }) => {
        if (disposed) return;
        const bind = (): boolean => {
          const binding = bindCodeView(host, {
            restore: readArtifactViewState<CodeScrollSnapshot>(projectId, fileName, slot) ?? null,
            onScroll: (snapshot) => writeArtifactViewState(projectId, fileName, slot, snapshot),
          });
          if (!binding) return false;
          bindingRef.current = binding;
          binding.setSpans(spansRef.current);
          return true;
        };
        // The pane creates its editor after its own chunk has loaded: wait for it to appear.
        if (!bind()) {
          observer = new MutationObserver(() => {
            if (bind()) observer?.disconnect();
          });
          observer.observe(host, { childList: true, subtree: true });
        }
      },
      () => {
        // Without the bridge the text still shows; only the place and the tints are lost.
      },
    );

    return () => {
      disposed = true;
      observer?.disconnect();
      bindingRef.current?.release();
      bindingRef.current = null;
    };
  }, [projectId, fileName, slot]);

  // After the pane has taken a new text (its layout effect runs first), tint the new runs.
  useEffect(() => {
    bindingRef.current?.setSpans(spans);
  }, [spans, text]);

  return (
    <>
      {notice !== null ? (
        <p className={styles.notice} role="note">
          {notice}
        </p>
      ) : null}
      <div ref={hostRef} className={styles.host}>
        <CodePane docKey={`${fileName}:${view}`} fileName={languageName ?? fileName} text={text} wrap={wrap} />
      </div>
    </>
  );
}
