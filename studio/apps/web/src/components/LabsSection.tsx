import { useI18n } from '../i18n';
import styles from './LabsSection.module.css';

export function LabsSection(_props?: { autosave?: unknown }) {
  const { t } = useI18n();
  return (
    <div className="settings-section">
      <ul className={styles.list}>
        <li className={styles.row}>
          <div className={styles.head}>
            <span className={styles.name}>{t('labs.harnessName')}</span>
            <span className={styles.status}>{t('common.default')}</span>
          </div>
          <p className={styles.hint}>{t('labs.harnessTooltip')}</p>
          <p className={styles.scope}>{t('labs.harnessScope')}</p>
        </li>
      </ul>
    </div>
  );
}
