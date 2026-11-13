import { useId } from 'react';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { Icon, type IconName } from '../Icon';
import styles from './WorkspaceToolsPanel.module.css';

export interface WorkspaceTool {
  id: string;
  iconName: IconName;
  labelKey: keyof Dict;
  run: () => void;
}

export function WorkspaceToolsPanel({ tools }: { tools: readonly WorkspaceTool[] }) {
  const t = useT();
  const titleId = useId();
  if (tools.length === 0) return null;

  return (
    <section className={styles.panel} aria-labelledby={titleId} data-testid="workspace-tools-panel">
      <h2 id={titleId} className={styles.title}>{t('connectors.toolsSection')}</h2>
      <div className={styles.grid}>
        {tools.map(({ id, iconName, labelKey, run }) => (
          <button key={id} type="button" className={styles.card} onClick={run} data-testid={`workspace-tool-${id}`}>
            <Icon name={iconName} size={16} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
