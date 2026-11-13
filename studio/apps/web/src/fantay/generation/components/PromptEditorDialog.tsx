// SPDX-License-Identifier: AGPL-3.0-only
// The expanded prompt editor (spec 05 §5.3): the same chip editor in a 760 px modal, bound to the same
// value as the panel's editor.
import type { CompiledInput } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { Modal, ModalTitle } from '../../ui';
import { BOARD_INTERACTIVE_PROPS } from './board-interactive';
import { PromptChipEditor } from './PromptChipEditor';

export interface PromptEditorDialogProps {
  open: boolean;
  onClose(): void;
  value: string;
  inputs: CompiledInput[];
  previews: Record<string, string | undefined>;
  onChange(next: string): void;
  onSubmit?(): void;
  placeholder: string;
  onPreview?(nodeId: string): void;
}

export function PromptEditorDialog({ open, onClose, value, inputs, previews, onChange, onSubmit, placeholder, onPreview }: PromptEditorDialogProps) {
  const t = useT();
  return (
    <Modal open={open} onClose={onClose} size="xl" aria-describedby={undefined} data-testid="fx-gen-prompt-dialog" {...BOARD_INTERACTIVE_PROPS}>
      <ModalTitle>{t('fantay.gen.prompt.editorTitle')}</ModalTitle>
      <div className="mt-3">
        {open ? (
          <PromptChipEditor
            value={value}
            inputs={inputs}
            previews={previews}
            onChange={onChange}
            {...(onSubmit ? { onSubmit } : {})}
            {...(onPreview ? { onPreview } : {})}
            onEscape={onClose}
            placeholder={placeholder}
            ariaLabel={t('fantay.gen.prompt.label')}
            autoFocus
            minHeight={320}
            maxHeight={560}
            className="h-[min(52dvh,560px)]"
          />
        ) : null}
      </div>
    </Modal>
  );
}
