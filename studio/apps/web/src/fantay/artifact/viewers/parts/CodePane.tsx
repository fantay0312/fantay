// SPDX-License-Identifier: AGPL-3.0-only
// Read-only text with line numbers, highlighting and find: the 代码 surface's CodeMirror view, hosted
// in an artifact stage. One implementation serves source files, data files and the "source" side of
// SVG, CSV and notebooks, so text looks the same wherever it is shown.
'use client';

import { useMemo } from 'react';

import { useT } from '../../../../i18n';
import { CodeEditor } from '../../../workspace/code/CodeEditor';
import { normalizeNewlines } from '../../../workspace/code/original-text';
import { LARGE_TEXT_BYTES } from '../../../workspace/code/text-preview';
import styles from './CodePane.module.css';

export interface CodePaneProps {
  /** Identity of the document; a new key starts at the top. */
  docKey: string;
  /** Picks the language from its extension. */
  fileName: string;
  text: string;
  wrap?: boolean;
}

export function CodePane({ docKey, fileName, text, wrap = false }: CodePaneProps): JSX.Element {
  const t = useT();
  const normalized = useMemo(() => normalizeNewlines(text), [text]);
  const phrases = useMemo(
    () => ({
      Find: t('common.search'),
      close: t('common.close'),
      next: t('workspace.code.findNext'),
      previous: t('workspace.code.findPrevious'),
    }),
    [t],
  );
  return (
    <div className={styles.pane} data-artifact-code="">
      <CodeEditor
        docKey={docKey}
        text={normalized}
        fileName={fileName}
        wrap={wrap}
        original={null}
        plain={normalized.length > LARGE_TEXT_BYTES}
        phrases={phrases}
      />
    </div>
  );
}
