'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Note face (spec 03 §4.6, plan R1/R3c): palette colour, sm/md/lg text, in-place editing (double-click, Enter,
// or creation) committed as one `text` transaction.
import { useT } from '../../../../i18n';
import { useBoardEngine } from '../../context';
import { NOTE_DEFAULT_SIZE, NOTE_FONT_SIZES, noteColorCss } from '../../model/defaults';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { TextEditor } from '../TextEditor';
import styles from './note.module.css';

export function NoteNode({ view }: NodeFaceProps) {
  const t = useT();
  const { commands } = useBoardEngine();
  const node = view.node as EngineNodeOf<'note'>;
  const fontSize = NOTE_FONT_SIZES[node.data.size ?? NOTE_DEFAULT_SIZE];
  const placeholder = t('board.node.notePlaceholder');
  return (
    <div className={styles.note} style={{ background: noteColorCss(node.data.color), fontSize }} data-testid="board-note">
      {view.editingText ? (
        <TextEditor
          initial={node.data.text}
          placeholder={placeholder}
          ariaLabel={t('board.kind.note')}
          className={styles.editor}
          onCommit={(text) => {
            commands.stopTextEdit();
            if (text !== node.data.text) commands.updateNode(node.id, { data: { text } }, { label: 'text' });
          }}
          onCancel={() => commands.stopTextEdit()}
        />
      ) : (
        <div className={styles.text}>
          {node.data.text.length > 0 ? node.data.text : <span className={styles.placeholder}>{placeholder}</span>}
        </div>
      )}
    </div>
  );
}
