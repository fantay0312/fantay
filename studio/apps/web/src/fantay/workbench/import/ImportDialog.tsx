/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — 导入账号. Paste a homepage or share link from 小红书、抖音、B站、TikTok、Instagram or X; the
 * daemon reads the account's recent public posts through TokenToSea 社媒数据 (billed to the signed-in
 * account), files them into 内容 and 复盘, and distils a writing style from them.
 * Derived from dsh-media-desk client/connect.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu. The Monid setup flow is replaced by the TokenToSea account.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Coins, LogIn, RefreshCw, ShieldCheck } from 'lucide-react';
import type { WorkbenchImportPlatform, WorkbenchSocialImportResponse, WorkbenchSocialStatus } from '@open-design/contracts';
import { WORKBENCH_IMPORT_PLATFORMS } from '@open-design/contracts';

import { Button } from '../../ui/button';
import { Callout } from '../../ui/callout';
import { cn } from '../../ui/cn';
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Progress } from '../../ui/progress';
import { Skeleton } from '../../ui/skeleton';
import { Textarea } from '../../ui/textarea';
import { workbenchApi } from '../api';
import { useL, useWorkbenchLang } from '../lang';
import { useWorkbenchShell } from '../shell/context';
import { platformName } from '../shared/format';
import { errorMessage, useWorkbench, workbench } from '../store';
import styles from './Import.module.css';

/** Which platform a pasted link or share text points at. */
export function detectPlatform(text: string): WorkbenchImportPlatform | null {
  const value = String(text ?? '');
  if (/xiaohongshu\.com|xhslink\.com/i.test(value)) return '小红书';
  if (/douyin\.com|iesdouyin\.com/i.test(value)) return '抖音';
  if (/bilibili\.com|b23\.tv/i.test(value)) return 'B站';
  if (/tiktok\.com/i.test(value)) return 'TikTok';
  if (/instagram\.com/i.test(value)) return 'Instagram';
  if (/(?:^|[/.\s@])(?:x|twitter)\.com/i.test(value)) return 'X';
  return null;
}

const STEPS: Array<[string, string]> = [
  ['正在识别账号', 'Finding the account'],
  ['正在读取最近的公开内容', 'Reading recent public posts'],
  ['正在整理进内容和复盘', 'Filing into content and insights'],
  ['正在提炼写作风格', 'Distilling the writing style'],
];

export interface ImportDialogProps {
  open: boolean;
  onClose(): void;
}

type Phase = { kind: 'form' } | { kind: 'running'; step: number } | { kind: 'done'; result: WorkbenchSocialImportResponse };

export function ImportDialog({ open, onClose }: ImportDialogProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const shell = useWorkbenchShell();
  const snapshot = useWorkbench();
  const [status, setStatus] = useState<WorkbenchSocialStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const check = async () => {
    setChecking(true);
    setStatusError(null);
    try {
      setStatus(await workbenchApi.socialStatus());
    } catch (err) {
      setStatusError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setText('');
    setError(null);
    setPhase({ kind: 'form' });
    setStatus(null);
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, snapshot.signedIn]);

  useEffect(() => () => window.clearInterval(timer.current), []);

  const found = detectPlatform(text);
  const saved = useMemo(() => (snapshot.state?.accounts ?? []).filter(account => account.externalId && account.url), [snapshot.state?.accounts]);
  const ready = Boolean(status?.signedIn && status.available);
  const estimate = found ? status?.estimatedUsd[found] : undefined;
  const running = phase.kind === 'running';

  const run = async () => {
    if (!text.trim() || running) return;
    setError(null);
    setPhase({ kind: 'running', step: 0 });
    // The daemon does not stream this run; the steps advance on a gentle clock and stop at the last one.
    window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      setPhase(current => (current.kind === 'running' ? { kind: 'running', step: Math.min(current.step + 1, STEPS.length - 1) } : current));
    }, 4500);
    try {
      const result = await workbenchApi.importAccount(text.trim());
      workbench.setState(result.state);
      setPhase({ kind: 'done', result });
    } catch (err) {
      setError(errorMessage(err));
      setPhase({ kind: 'form' });
    } finally {
      window.clearInterval(timer.current);
    }
  };

  const close = () => {
    if (running) return;
    onClose();
  };

  return (
    <Modal open={open} onClose={close} size="md" className={styles.dialog} onEscapeKeyDown={event => { if (running) event.preventDefault(); }} onPointerDownOutside={event => { if (running) event.preventDefault(); }}>
      <ModalTitle>{phase.kind === 'done' ? L('导入完成', 'Import complete') : L('导入我的账号', 'Import my account')}</ModalTitle>
      <ModalLede>
        {phase.kind === 'done'
          ? L('内容已放进「内容」和「复盘」，风格可以在「风格」里查看和修改。', 'Posts are in Content and Insights; the style is on the Style page.')
          : L('读取你账号最近的公开内容和互动数据，放进内容和复盘，并提炼成你的写作风格。', 'Reads your recent public posts and engagement into Content and Insights, and distils your writing style.')}
      </ModalLede>

      {phase.kind === 'done' ? (
        <ImportResult result={phase.result} />
      ) : (
        <div className={styles.body}>
          <StatusBlock
            status={status}
            error={statusError}
            checking={checking}
            found={found}
            onRetry={() => { void check(); }}
          />

          <label className={styles.field}>
            <span className={styles.fieldLabel}>{L('账号主页链接', 'Profile link')}</span>
            <Textarea
              rows={3}
              value={text}
              disabled={running || !ready}
              placeholder={L('小红书、抖音、B站、TikTok、Instagram 或 X 的主页链接，App 里分享出来的整段文字也可以', 'A profile link from Xiaohongshu, Douyin, Bilibili, TikTok, Instagram or X; pasted share text works too')}
              onChange={event => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void run();
                }
              }}
            />
          </label>

          {saved.length && !running ? (
            <div className={styles.saved}>
              <span className={styles.savedLabel}>{L('再导入一次', 'Import again')}</span>
              {saved.map(account => (
                <Button variant="bare" size="sm" key={account.id} className={styles.savedChip} onClick={() => setText(account.url ?? '')}>
                  <Icon icon={RefreshCw} size={12} />
                  {platformName(account.platform, lang)} · {account.handle}
                </Button>
              ))}
            </div>
          ) : null}

          {running ? (
            <div className={styles.progress} role="status" aria-live="polite">
              <Progress value={null} />
              <ol className={styles.steps}>
                {STEPS.map(([zh, en], index) => (
                  <li key={index} data-state={index < phase.step ? 'done' : index === phase.step ? 'active' : 'wait'}>
                    <i aria-hidden>{index < phase.step ? <Icon icon={Check} size={10} strokeWidth={2.6} /> : null}</i>
                    <span>{L(zh, en)}</span>
                  </li>
                ))}
              </ol>
              <p className={styles.progressNote}>{L('一般需要半分钟到两分钟，请不要关闭窗口。', 'Usually 30 seconds to 2 minutes. Keep this open.')}</p>
            </div>
          ) : null}

          {error ? (
            <Callout tone="error" className={styles.error}>
              <Icon icon={CircleAlert} size={14} />
              <span>{error}</span>
            </Callout>
          ) : null}

          <ul className={styles.notes}>
            <li>
              <Icon icon={ShieldCheck} size={14} />
              <span>{L('请只导入自己的账号。只能读到公开内容，后台才有的数据（比如小红书和抖音的播放量）读不到。', 'Import only your own account. Only public data is readable; back-office numbers such as view counts are not.')}</span>
            </li>
            <li>
              <Icon icon={Coins} size={14} />
              <span>{L('通过 TokenToSea 社媒数据读取，费用从你的 TokenToSea 账户扣除，以导入结果为准。', 'Read through TokenToSea social data and billed to your TokenToSea account; the result shows the actual charge.')}</span>
            </li>
          </ul>
        </div>
      )}

      <ModalActions>
        {phase.kind === 'done' ? (
          <>
            <Button variant="ghost" onClick={() => { onClose(); shell.navigate('content'); }}>{L('去看内容', 'Open Content')}</Button>
            <ModalSpacer />
            {phase.result.styleName ? <Button variant="secondary" onClick={() => { onClose(); shell.navigate('style'); }}>{L('去看风格', 'Open Style')}</Button> : null}
            <Button variant="primary" onClick={onClose}>{L('完成', 'Done')}</Button>
          </>
        ) : (
          <>
            <ModalSpacer />
            <Button variant="ghost" disabled={running} onClick={onClose}>{L('取消', 'Cancel')}</Button>
            {!status?.signedIn && status ? (
              <Button variant="primary" loading={shell.signingIn} onClick={shell.signIn}>
                <Icon icon={LogIn} size={14} />
                {L('登录 TokenToSea', 'Sign in to TokenToSea')}
              </Button>
            ) : (
              <Button
                variant="primary"
                loading={running}
                disabled={!ready || !text.trim()}
                disabledReason={!ready ? L('TokenToSea 社媒数据暂时不可用', 'TokenToSea social data is unavailable') : undefined}
                onClick={() => { void run(); }}
              >
                {found
                  ? estimate
                    ? L(`导入${platformName(found, lang)}（约 $${estimate}）`, `Import ${platformName(found, lang)} (~$${estimate})`)
                    : L(`导入${platformName(found, lang)}`, `Import ${platformName(found, lang)}`)
                  : L('导入', 'Import')}
              </Button>
            )}
          </>
        )}
      </ModalActions>
    </Modal>
  );
}

function StatusBlock({ status, error, checking, found, onRetry }: {
  status: WorkbenchSocialStatus | null;
  error: string | null;
  checking: boolean;
  found: WorkbenchImportPlatform | null;
  onRetry(): void;
}) {
  const L = useL();
  const lang = useWorkbenchLang();
  if (!status && checking) {
    return (
      <div className={styles.status}>
        <Skeleton shape="line" />
        <Skeleton shape="line" index={1} />
      </div>
    );
  }
  if (error || !status) {
    return (
      <Callout tone="error" className={styles.statusError}>
        <span>{L(`没能检查 TokenToSea 社媒数据：${error ?? ''}`, `Could not check TokenToSea social data: ${error ?? ''}`)}</span>
        <Button size="sm" variant="ghost" loading={checking} onClick={onRetry}>{L('重试', 'Retry')}</Button>
      </Callout>
    );
  }
  const platforms = status.platforms.length ? status.platforms : [...WORKBENCH_IMPORT_PLATFORMS];
  const tone = !status.signedIn ? 'off' : status.available ? 'on' : 'warn';
  return (
    <div className={styles.status} data-tone={tone}>
      <div className={styles.statusHead}>
        <i className={styles.statusDot} aria-hidden />
        <span className={styles.statusText}>
          {!status.signedIn
            ? L('还没登录 TokenToSea。导入用的是你的 TokenToSea 账户。', 'Not signed in. Import uses your TokenToSea account.')
            : status.available
              ? L('TokenToSea 社媒数据已就绪', 'TokenToSea social data is ready')
              : status.reason || L('当前账户暂时用不了社媒数据', 'Social data is unavailable for this account')}
        </span>
        {status.signedIn && !status.available ? (
          <Button size="sm" variant="ghost" loading={checking} onClick={onRetry}>{L('重新检查', 'Check again')}</Button>
        ) : null}
      </div>
      <div className={styles.platforms} aria-label={L('支持的平台和预估费用', 'Supported platforms and estimates')}>
        {platforms.map(platform => (
          <span key={platform} className={cn(styles.platform, found === platform && styles.platformOn)}>
            <span>{platformName(platform, lang)}</span>
            {status.estimatedUsd[platform] ? <b>≈ ${status.estimatedUsd[platform]}</b> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function ImportResult({ result }: { result: WorkbenchSocialImportResponse }) {
  const L = useL();
  const lang = useWorkbenchLang();
  return (
    <div className={styles.result}>
      <div className={styles.resultHead}>
        <span className={styles.resultBadge}><Icon icon={Check} size={16} strokeWidth={2.4} /></span>
        <div className={styles.resultWho}>
          <b>{result.nickname || L('未命名账号', 'Unnamed account')}</b>
          <span>{platformName(result.platform, lang)}</span>
        </div>
      </div>
      <dl className={styles.stats}>
        <div>
          <dt>{L('读取', 'Read')}</dt>
          <dd>{result.count}<small>{L('条', ' posts')}</small></dd>
        </div>
        <div>
          <dt>{L('新增', 'New')}</dt>
          <dd>{result.added}<small>{L('条', ' posts')}</small></dd>
        </div>
        <div>
          <dt>{L('实际扣费', 'Charged')}</dt>
          <dd>${result.chargedUsd}</dd>
        </div>
      </dl>
      {result.styleName ? (
        <div className={styles.style}>
          <span className={styles.styleLabel}>{L('提炼的风格', 'Distilled style')}</span>
          <b>{result.styleName}</b>
          <span className={styles.styleHint}>{L('之后成稿会按这个风格写，可以在「风格」里切换。', 'New productions follow it; switch on the Style page.')}</span>
        </div>
      ) : null}
      {result.styleError ? (
        <Callout tone="error">{L(`风格没提炼成：${result.styleError}`, `The style could not be distilled: ${result.styleError}`)}</Callout>
      ) : null}
    </div>
  );
}
