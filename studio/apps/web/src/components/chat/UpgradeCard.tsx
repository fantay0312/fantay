import type { ReactElement } from 'react';
import { Button } from '@open-design/components';
import { useT } from '../../i18n';
import styles from './UpgradeCard.module.css';

export interface UpgradeCardProps {
  balanceUsd: number;
  onRecharge?: () => void;
  pausedAudience?: 'owner' | 'member';
}

/** 余额按美元两位小数写,和稿子的 `$3.20` / `$0.00` 一致 */
export function formatBalanceUsd(balanceUsd: number): string {
  const safe = Number.isFinite(balanceUsd) ? Math.max(0, balanceUsd) : 0;
  return `$${safe.toFixed(2)}`;
}

export function UpgradeCard({ balanceUsd, onRecharge, pausedAudience }: UpgradeCardProps): ReactElement {
  const t = useT();
  const out = !(balanceUsd > 0);
  const paused = out && pausedAudience != null;
  return (
    <div className={styles.up} data-testid="chat-upgrade-card" data-out={out ? 'true' : 'false'}>
      {/* 卡头只报事实。稿子 `.up .h`:底下压一条细线,右侧留出 48px 给那枚辉光。 */}
      <div className={styles.head}>
        <span className={`${styles.amount}${out ? ` ${styles.out}` : ''}`}>
          <span>
            {t('chat.upgrade.balance')} <b>{formatBalanceUsd(balanceUsd)}</b>
          </span>
        </span>
      </div>
      {/* 底排:说明句在左、出口在右,窄卡时由 flex-wrap 自己折成两行。
          按钮不再是 `size="sm"` —— 稿子把它从卡头那枚方块换成了底排 44px 的
          触达档(`.up .up-bottom .btn`),尺寸在 Module 里对着祖先链写死。 */}
      <div className={styles.bottom}>
        <p className={styles.why}>
          {paused ? (
            <>
              <span className={styles.whyTitle}>
                {pausedAudience === 'member'
                  ? t('chat.upgrade.pausedTeamTitle')
                  : t('chat.upgrade.pausedTitle')}
              </span>
              <span className={styles.whyBody}>
                {pausedAudience === 'member'
                  ? t('chat.upgrade.pausedTeamMessage')
                  : t('chat.upgrade.pausedMessage')}
              </span>
            </>
          ) : out ? t('chat.upgrade.whyOut') : t('chat.upgrade.whyLow')}
        </p>
        <Button
          type="button"
          variant="primary"
          className={styles.cta}
          onClick={onRecharge}
          disabled={!onRecharge}
        >
          {t(pausedAudience === 'member' ? 'chat.amrBalanceOwner.contactAdmin' : 'chat.amrError.rechargeCta')}
        </Button>
      </div>
    </div>
  );
}
