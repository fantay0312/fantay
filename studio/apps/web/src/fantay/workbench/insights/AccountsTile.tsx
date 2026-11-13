/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 复盘 — the creator's own accounts: profile, followers, last refresh, and
 * 刷新档案 (re-read the public profile through TokenToSea). Importing goes through the shell's
 * import dialog.
 */
import { useState } from 'react';
import { RefreshCw, UserPlus } from 'lucide-react';
import type { WorkbenchAccount } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';
import { Button, Icon, IconButton, cn, toast } from '../../ui';
import { workbenchApi } from '../api';
import { useL, useWorkbenchLang } from '../lang';
import { compact, fmtDate, platformName, relativeDay } from '../shared/format';
import { reportError, workbench } from '../store';
import page from '../pages-shared/page.module.css';
import styles from './InsightsPage.module.css';

function Avatar({ account }: { account: WorkbenchAccount }) {
  const url = workbenchMediaUrl(account.avatar ?? null);
  const [failed, setFailed] = useState(false);
  const name = account.title || account.handle || account.platform;
  return (
    <span className={styles.avatar} aria-hidden>
      {url && !failed ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : Array.from(name.trim())[0] ?? '·'}
    </span>
  );
}

export function AccountsTile({ accounts, onImport, className }: { accounts: WorkbenchAccount[]; onImport(): void; className?: string }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const refresh = async (account: WorkbenchAccount) => {
    if (!account.url || refreshing) return;
    setRefreshing(account.id);
    try {
      const response = await workbenchApi.refreshAccount({ id: account.id, url: account.url, platform: account.platform, handle: account.handle });
      workbench.setState(response.state);
      if (response.fetchError || response.errors.length) {
        toast({ title: L('没能刷新档案', 'Could not refresh the profile'), description: response.fetchError ?? response.errors[0], tone: 'danger' });
      } else {
        toast({ title: L(`已刷新「${account.title || account.handle}」`, `Refreshed “${account.title || account.handle}”`) });
      }
    } catch (error) {
      reportError(error, L('没能刷新档案', 'Could not refresh the profile'));
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <section className={cn(page.tile, page.rise, className)} aria-label={L('我的账号', 'My accounts')}>
      <header className={page.tileHead}>
        <h2 className={page.tileTitle}>{L('我的账号', 'My accounts')}</h2>
        {accounts.length ? <span className={page.tileMeta}>{accounts.length}</span> : null}
        <span className={page.grow} />
        <Button size="sm" variant="ghost" onClick={onImport}>
          <Icon icon={UserPlus} />
          {L('导入账号', 'Import account')}
        </Button>
      </header>
      {accounts.length ? (
        <ul className={styles.accounts}>
          {accounts.map((account) => {
            const name = account.title || account.handle || platformName(account.platform, lang);
            return (
              <li key={account.id} className={styles.account}>
                <Avatar account={account} />
                <div className={styles.accountBody}>
                  <strong>{name}</strong>
                  <small>
                    {[
                      platformName(account.platform, lang),
                      account.handle && account.handle !== name ? `@${account.handle.replace(/^@/, '')}` : null,
                      account.fetchedAt ? L(`${relativeDay(account.fetchedAt, lang)}更新`, `refreshed ${fmtDate(account.fetchedAt, lang)}`) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                  {account.fetchError ? <small className={styles.accountError}>{account.fetchError}</small> : null}
                </div>
                <div className={styles.accountFollowers}>
                  <b>{typeof account.followers === 'number' ? compact(account.followers, lang) : '—'}</b>
                  <small>{L('粉丝', 'followers')}</small>
                </div>
                <IconButton
                  size="sm"
                  aria-label={L(`刷新「${name}」的档案`, `Refresh “${name}”`)}
                  tooltip={L('刷新档案', 'Refresh profile')}
                  disabled={!account.url || (refreshing !== null && refreshing !== account.id)}
                  disabledReason={!account.url ? L('没有主页链接', 'No profile link') : undefined}
                  onClick={() => void refresh(account)}
                >
                  <Icon icon={RefreshCw} className={refreshing === account.id ? styles.spin : undefined} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.accountsEmpty}>
          <p className={styles.quietLine}>
            {L('导入自己的小红书、抖音、B 站、TikTok、Instagram 或 X 账号，最近的内容和互动会直接进复盘，也能顺手提炼你的风格。', 'Import your own Xiaohongshu, Douyin, Bilibili, TikTok, Instagram or X account: recent posts and engagement flow into the review, and your style can be extracted too.')}
          </p>
          <Button size="sm" variant="primary" onClick={onImport}>
            <Icon icon={UserPlus} />
            {L('导入账号', 'Import account')}
          </Button>
        </div>
      )}
    </section>
  );
}
