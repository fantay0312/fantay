// Non-grid states shared by the Materials view and the material picker: the
// library is not configured / unreadable, or the daemon request failed.

import { useId } from 'react';
import type { MaterialLibraryStatus } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { MATERIAL_REASON_KEYS } from './material-model';
import styles from './MaterialStates.module.css';

export function MaterialUnavailable({
  status,
  compact = false,
  onRetry,
}: {
  status: MaterialLibraryStatus;
  compact?: boolean;
  onRetry?: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const reasonKey = status.reason ? MATERIAL_REASON_KEYS[status.reason] : null;
  return (
    <section
      className={`${styles.state}${compact ? ` ${styles.compact}` : ''}`}
      data-testid="materials-unavailable"
      aria-labelledby={titleId}
    >
      <span className={styles.mark} aria-hidden>
        <Icon name="inbox-archive" size={22} />
      </span>
      <h2 id={titleId} className={styles.title}>
        {t('materials.unavailableTitle')}
      </h2>
      {reasonKey ? <p className={styles.reason}>{t(reasonKey)}</p> : null}
      <p className={styles.body}>{t('materials.libraries.emptyHint')}</p>
      {status.root ? (
        <p className={styles.path}>
          {t('materials.checkedPath', { path: status.root })}
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('materials.retry')}
        </Button>
      ) : null}
    </section>
  );
}

export function MaterialRequestFailed({
  detail,
  compact = false,
  onRetry,
}: {
  detail: string;
  compact?: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <section
      className={`${styles.state}${compact ? ` ${styles.compact}` : ''}`}
      data-testid="materials-error"
      role="alert"
    >
      <span className={styles.mark} aria-hidden>
        <Icon name="alert-triangle" size={22} />
      </span>
      <h2 className={styles.title}>{t('materials.errorTitle')}</h2>
      <p className={styles.body}>{t('materials.errorBody', { detail })}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t('materials.retry')}
      </Button>
    </section>
  );
}
