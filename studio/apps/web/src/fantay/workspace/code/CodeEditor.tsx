// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/features/cc-agent/workdir-browse/FileBodyView.tsx and
// components/markdown/useIsDarkMode.ts @ 88941ba7 (Apache-2.0): the React side of the read-only
// viewer. It owns one host element and feeds the CodeMirror view behind it; the view is created once
// and updated in place, so switching wrap, theme, view or file never rebuilds it.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { CodeEditorConfig, CodeEditorHandle } from './codemirror-runtime';
import styles from './CodeSurface.module.css';

export interface CodeEditorProps {
  /** Identity of the document; a new key starts at the top of the file. */
  docKey: string;
  /** Text with "\n" line breaks only. */
  text: string;
  fileName: string;
  wrap: boolean;
  /** The text before the turn; non-null shows the changes against it. */
  original: string | null;
  /** No syntax highlighting (a very large file). */
  plain: boolean;
  phrases: Readonly<Record<string, string>>;
}

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/** Follows `data-theme` on <html>, whoever sets it (the Fantay theme store or the legacy shell). */
function useIsDarkTheme(): boolean {
  return useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.getAttribute('data-theme') === 'dark',
    () => false,
  );
}

export function CodeEditor({ docKey, text, fileName, wrap, original, plain, phrases }: CodeEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CodeEditorHandle | null>(null);
  const dark = useIsDarkTheme();
  const [failed, setFailed] = useState(false);

  const config: CodeEditorConfig = { docKey, text, fileName, wrap, dark, original, plain, phrases };
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    // CodeMirror is loaded here, not at module scope: it stays out of the server render and out of
    // the workspace's first bundle, and loads the first time a file is actually read.
    void import('./codemirror-runtime').then(
      ({ mountCodeEditor }) => {
        if (disposed) return;
        try {
          handleRef.current = mountCodeEditor(host, configRef.current);
        } catch {
          setFailed(true);
        }
      },
      () => {
        if (!disposed) setFailed(true);
      },
    );
    return () => {
      disposed = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, []);

  // Layout effect: the view catches up before the browser paints the new header or tree state.
  useLayoutEffect(() => {
    try {
      handleRef.current?.update(configRef.current);
    } catch {
      setFailed(true);
    }
  }, [docKey, text, fileName, wrap, dark, original, plain, phrases]);

  if (failed) {
    // The editor could not start (a chunk failed to load). The file is still readable as plain text.
    return (
      <pre className={styles.plainText} data-wrap={wrap} tabIndex={0} aria-label={fileName}>
        {text}
      </pre>
    );
  }
  return <div ref={hostRef} className={styles.editor} data-testid="code-surface-editor" />;
}
