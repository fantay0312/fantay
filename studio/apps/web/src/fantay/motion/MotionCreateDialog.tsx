// SPDX-License-Identifier: AGPL-3.0-only
// The create dialog (spec 07 §5.2): the 960px Modal (01 `2xl`, amendment B4) around
// MotionCreatePanel; the panel's footer is the action row.
import { useT } from '../../i18n';
import { Modal, ModalTitle } from '../ui';
import { MotionCreatePanel, type MotionCreatePanelProps } from './MotionCreatePanel';
import styles from './MotionCreatePanel.module.css';

export interface MotionCreateDialogProps extends Omit<MotionCreatePanelProps, 'variant' | 'onCancel'> {
  open: boolean;
  onClose: () => void;
}

export function MotionCreateDialog({ open, onClose, ...panel }: MotionCreateDialogProps) {
  const t = useT();
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      className={styles.dialog}
      data-testid="motion-create-dialog"
      aria-describedby={undefined}
    >
      <ModalTitle>
        {t(panel.target.kind === 'existing-project' ? 'motion.create.titleExisting' : 'motion.create.title')}
      </ModalTitle>
      <MotionCreatePanel variant="dialog" onCancel={onClose} {...panel} />
    </Modal>
  );
}
