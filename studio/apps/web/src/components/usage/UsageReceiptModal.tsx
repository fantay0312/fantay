'use client';
/* SPDX-License-Identifier: AGPL-3.0-only */
/* AI 用量小票弹窗：支持日期范围快选（含昨天/今天）、费用与 Token 口径切换、五种分享画布皮肤（山雾/海汐/洞石/夜墨/透明），以及 2× 高清 PNG
   复制、下载与纯文本复制。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AiUsageScope, AiUsageSummary, WorkspaceCollabContext } from '@open-design/contracts';
import { Check, Copy, Download, FileText } from 'lucide-react';
import { workspaceProjectHeaders } from '../../collab/workspace-identity';
import { Button, Icon, Modal, ModalTitle, Segmented, SegmentedItem, toast } from '../../fantay/ui';
import { AgentIcon } from '../AgentIcon';
import { formatRange, presetRange, shiftDay, type UsageRange } from './usage-format';
import {
  RECEIPT_FOOTER_DOMAIN,
  RECEIPT_FOOTER_URL,
  buildUsageReceipt,
  copyReceiptImage,
  defaultReceiptMetric,
  downloadReceiptPng,
  formatReceiptPlainText,
  loadBackdropSkinImage,
  type ReceiptBackdrop,
  type ReceiptMetricMode,
} from './usage-receipt';
import styles from './UsageReceiptModal.module.css';

type QuickRangeId = 'current' | 'today' | 'yesterday' | '7d' | '30d' | 'mtd';

const TEETH_COUNT = 28;
const TEETH_PATH = (() => {
  const width = 384;
  const height = 7;
  const step = width / TEETH_COUNT;
  const parts = [`M0,0 H${width}`];
  for (let i = TEETH_COUNT - 1; i >= 0; i -= 1) {
    const tipX = ((i + 0.5) * step).toFixed(2);
    const leftX = (i * step).toFixed(2);
    parts.push(`L${tipX},${height} L${leftX},0`);
  }
  parts.push('Z');
  return parts.join(' ');
})();

function legacyCopyText(text: string): boolean {
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
  }
}

function matchQuickRange(range: UsageRange, today: string): QuickRangeId {
  const yesterday = shiftDay(today, -1);
  if (range.from === today && range.to === today) return 'today';
  if (range.from === yesterday && range.to === yesterday) return 'yesterday';
  const r7 = presetRange('7d', today);
  if (range.from === r7.from && range.to === r7.to) return '7d';
  const r30 = presetRange('30d', today);
  if (range.from === r30.from && range.to === r30.to) return '30d';
  const mtd = presetRange('mtd', today);
  if (range.from === mtd.from && range.to === mtd.to) return 'mtd';
  return 'current';
}

function resolveQuickRange(id: QuickRangeId, today: string, fallback: UsageRange): { from: string; to: string; preset?: string } {
  const yesterday = shiftDay(today, -1);
  switch (id) {
    case 'today':
      return { from: today, to: today, preset: 'today' };
    case 'yesterday':
      return { from: yesterday, to: yesterday, preset: 'yesterday' };
    case '7d':
      return presetRange('7d', today);
    case '30d':
      return presetRange('30d', today);
    case 'mtd':
      return presetRange('mtd', today);
    case 'current':
      return { from: fallback.from, to: fallback.to, preset: fallback.preset };
  }
}

export interface UsageReceiptModalProps {
  open: boolean;
  onClose: () => void;
  dashboardRange: UsageRange;
  today: string;
  provider: string | null;
  scope?: AiUsageScope;
  projectId?: string;
  projectName?: string;
  context?: WorkspaceCollabContext | null;
  dashboardData: AiUsageSummary | null;
  activity: AiUsageSummary['activity'] | null;
  zh: boolean;
}

export function UsageReceiptModal({
  open,
  onClose,
  dashboardRange,
  today,
  provider,
  scope = 'fantay',
  projectId,
  projectName,
  context,
  dashboardData,
  activity,
  zh,
}: UsageReceiptModalProps) {
  const initialQuick = matchQuickRange(dashboardRange, today);
  const [quickRange, setQuickRange] = useState<QuickRangeId>(initialQuick);
  const [userMetric, setUserMetric] = useState<ReceiptMetricMode | null>(null);
  const [backdrop, setBackdrop] = useState<ReceiptBackdrop>('mist');
  const [issuedAt, setIssuedAt] = useState(() => Date.now());
  const [fetchedData, setFetchedData] = useState<AiUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [savingPng, setSavingPng] = useState(false);

  // Copy feedback state (kept outside buttons for reliable screen reader announcements).
  const [copiedTarget, setCopiedTarget] = useState<'image' | 'text' | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; visible: boolean; failed: boolean }>({
    text: '',
    visible: false,
    failed: false,
  });
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAnnouncedRef = useRef('');

  // Sync to the dashboard's active range each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setQuickRange(matchQuickRange(dashboardRange, today));
    setUserMetric(null);
    setIssuedAt(Date.now());
    setFetchError('');
  }, [open, dashboardRange, today]);

  useEffect(() => () => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
  }, []);

  const targetBounds = useMemo(
    () => resolveQuickRange(quickRange, today, dashboardRange),
    [quickRange, today, dashboardRange],
  );

  const matchesDashboard = Boolean(
    dashboardData
      && dashboardData.from === targetBounds.from
      && dashboardData.to === targetBounds.to
      && (dashboardData.provider ?? null) === (provider ?? null),
  );

  useEffect(() => {
    if (!open) return;
    if (matchesDashboard) {
      setFetchedData(null);
      setLoading(false);
      setFetchError('');
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setFetchError('');
    const query = new URLSearchParams({
      from: targetBounds.from,
      to: targetBounds.to,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      limit: '0',
      scope,
    });
    if (projectId) query.set('projectId', projectId);
    if (provider) query.set('provider', provider);

    void fetch(`/api/usage?${query}`, {
      headers: context ? workspaceProjectHeaders(context) : {},
      signal: controller.signal,
    })
      .then(async (res) => {
        const payload = (await res.json()) as AiUsageSummary & { error?: string };
        if (!res.ok) throw new Error(payload.error ?? (zh ? '无法读取小票数据' : 'Usage is unavailable'));
        return payload;
      })
      .then((payload) => {
        if (!active) return;
        setFetchedData(payload);
        setIssuedAt(Date.now());
      })
      .catch((cause) => {
        if (active && (cause as { name?: string } | null)?.name !== 'AbortError') {
          setFetchError(String((cause as { message?: string } | null)?.message ?? cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [open, matchesDashboard, targetBounds.from, targetBounds.to, projectId, provider, context, zh, scope]);

  const activeData = matchesDashboard ? dashboardData : fetchedData;
  const metric: ReceiptMetricMode = userMetric ?? defaultReceiptMetric(activeData?.totals);

  const receipt = useMemo(() => {
    if (!activeData || activeData.totals.requests === 0 && !activeData.totals.sessionRecords) return null;
    return buildUsageReceipt({
      data: activeData,
      activity: activity ?? activeData.activity,
      metric,
      zh,
      today,
      issuedAt,
      preset: targetBounds.preset,
      projectName,
    });
  }, [activeData, activity, metric, zh, today, issuedAt, targetBounds.preset, projectName]);

  // Preload the active 2× photographic skin while previewing so PNG copy/download responds instantaneously.
  useEffect(() => {
    if (!open || backdrop === 'paper') return;
    void loadBackdropSkinImage(backdrop);
  }, [open, backdrop]);

  const announce = (rawMessage: string, failed = false, target: 'image' | 'text' | null = null) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    let message = rawMessage;
    if (message === lastAnnouncedRef.current) message += '\u00A0';
    lastAnnouncedRef.current = message;
    setCopiedTarget(failed ? null : target);
    setFeedback({ text: message, visible: true, failed });
    feedbackTimerRef.current = setTimeout(() => {
      setCopiedTarget(null);
      setFeedback({ text: '', visible: false, failed: false });
    }, 2400);
  };

  const handleCopyText = async () => {
    if (!receipt) return;
    const text = formatReceiptPlainText(receipt, zh);
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = legacyCopyText(text);
      }
    } catch {
      ok = legacyCopyText(text);
    }
    if (ok) {
      announce(zh ? '已复制文本' : 'Copied text', false, 'text');
      toast({ title: zh ? '已复制文本' : 'Receipt text copied', tone: 'success' });
    } else {
      announce(zh ? '复制失败' : 'Copy failed', true);
    }
  };

  const handleCopyImage = async () => {
    if (!receipt) return;
    const status = await copyReceiptImage(receipt, { backdrop, scale: 2 });
    if (status === 'copied') {
      announce(zh ? '已复制图片' : 'Copied image', false, 'image');
      toast({ title: zh ? '已复制图片' : 'Receipt image copied', tone: 'success' });
      return;
    }
    announce(
      status === 'denied'
        ? (zh ? '剪贴板受限，请保存图片' : 'Clipboard blocked; save PNG instead')
        : (zh ? '复制失败' : 'Image copy failed'),
      true,
    );
  };

  const handleSavePng = async () => {
    if (!receipt || savingPng) return;
    setSavingPng(true);
    try {
      await downloadReceiptPng(receipt, { backdrop, scale: 2 });
      announce(zh ? '已保存图片' : 'Saved PNG');
      toast({ title: zh ? '已保存图片' : 'Receipt PNG saved', tone: 'success' });
    } catch {
      announce(zh ? '导出图片失败' : 'Export failed', true);
    } finally {
      setSavingPng(false);
    }
  };

  const showCustomChip = initialQuick === 'current';

  return (
    <Modal open={open} onClose={onClose} size="lg" className={styles.modal}>
      <div className={styles.header}>
        <ModalTitle>{zh ? 'AI 用量小票' : 'AI Usage Receipt'}</ModalTitle>
      </div>

      <div className={styles.controls}>
        <Segmented
          size="sm"
          value={quickRange}
          onValueChange={(next) => {
            setQuickRange(next as QuickRangeId);
            setUserMetric(null);
          }}
          aria-label={zh ? '小票统计范围' : 'Receipt range'}
        >
          {showCustomChip ? (
            <SegmentedItem value="current">{formatRange(dashboardRange.from, dashboardRange.to, zh, today)}</SegmentedItem>
          ) : null}
          <SegmentedItem value="today">{zh ? '今天' : 'Today'}</SegmentedItem>
          <SegmentedItem value="yesterday">{zh ? '昨天' : 'Yesterday'}</SegmentedItem>
          <SegmentedItem value="7d">{zh ? '7 天' : '7d'}</SegmentedItem>
          <SegmentedItem value="30d">{zh ? '30 天' : '30d'}</SegmentedItem>
          <SegmentedItem value="mtd">{zh ? '本月' : 'Month'}</SegmentedItem>
        </Segmented>

        <div className={styles.controlGroup}>
          <Segmented
            size="sm"
            value={metric}
            onValueChange={(next) => setUserMetric(next as ReceiptMetricMode)}
            aria-label={zh ? '主指标口径' : 'Primary metric'}
          >
            <SegmentedItem value="cost">{zh ? '费用' : 'Cost'}</SegmentedItem>
            <SegmentedItem value="tokens">Token</SegmentedItem>
          </Segmented>

          <Segmented
            size="sm"
            value={backdrop}
            onValueChange={(next) => setBackdrop(next as ReceiptBackdrop)}
            aria-label={zh ? '画布背景' : 'Stage backdrop'}
          >
            <SegmentedItem value="mist">{zh ? '山雾' : 'Mist'}</SegmentedItem>
            <SegmentedItem value="sea">{zh ? '海汐' : 'Tide'}</SegmentedItem>
            <SegmentedItem value="stone">{zh ? '洞石' : 'Stone'}</SegmentedItem>
            <SegmentedItem value="ink">{zh ? '夜墨' : 'Ink'}</SegmentedItem>
            <SegmentedItem value="paper">{zh ? '透明' : 'Clean'}</SegmentedItem>
          </Segmented>
        </div>
      </div>

      <div className={styles.stageFrame} data-backdrop={backdrop}>
        <div className={styles.stageScroll}>
          <div className={styles.paperWrap}>
            <article data-theme="light" className={styles.paper} aria-busy={loading} aria-label={receipt?.title ?? (zh ? '用量小票预览' : 'Usage receipt preview')}>
              {fetchError ? (
                <div className={styles.emptyPaper}>
                  <strong>{zh ? '读取失败' : 'Could not load usage'}</strong>
                  <p>{fetchError}</p>
                </div>
              ) : loading && !activeData ? (
                <div className={styles.emptyPaper}>
                  <strong>{zh ? '正在读取…' : 'Loading…'}</strong>
                </div>
              ) : !receipt ? (
                <div className={styles.emptyPaper}>
                  <strong>{zh ? '这个范围内没有用量' : 'No usage in this range'}</strong>
                  <p>{zh ? '换一个时间范围看看。' : 'Try another range.'}</p>
                </div>
              ) : (
                <>
                  <header className={styles.receiptHeader}>
                    <h3 className={styles.receiptTitle}>{receipt.title}</h3>
                    <p
                      className={styles.receiptSubtitle}
                      title={receipt.subtitle.length > 36 ? receipt.subtitle : undefined}
                    >
                      {receipt.subtitle}
                    </p>
                  </header>

                  <dl className={styles.kvList}>
                    {receipt.metaRows.map(row => (
                      <div key={row.label} className={styles.kvRow}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                  </dl>

                  <hr className={styles.divider} />

                  <div className={styles.hero}>
                    {receipt.heroEyebrow ? <span className={styles.heroEyebrow}>{receipt.heroEyebrow}</span> : null}
                    {receipt.heroFigures.length === 1 ? (
                      <strong className={styles.heroSingle}>{receipt.heroFigures[0]!.value}</strong>
                    ) : (
                      <div className={styles.heroDual}>
                        {receipt.heroFigures.map(fig => (
                          <div key={fig.label} className={styles.heroDualItem}>
                            <span className={styles.heroDualLabel}>{fig.label}</span>
                            <strong className={styles.heroDualValue}>{fig.value}</strong>
                          </div>
                        ))}
                      </div>
                    )}
                    {receipt.heroSubnote ? <p className={styles.heroSubnote}>{receipt.heroSubnote}</p> : null}
                  </div>

                  <hr className={styles.divider} />

                  <dl className={styles.kvList}>
                    {receipt.summaryRows.map(row => (
                      <div key={row.label} className={styles.kvRow}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                  </dl>

                  <hr className={styles.divider} />

                  {receipt.groups.length > 0 ? (
                    <>
                      <div className={styles.breakdownHead}>
                        <span>{receipt.breakdownHeader.left}</span>
                        <span>{receipt.breakdownHeader.right}</span>
                      </div>

                      <div className={styles.groupList}>
                        {receipt.groups.map(group => (
                          <div key={group.provider} className={styles.group}>
                            <div className={styles.groupRow}>
                              <span className={styles.groupLead}>
                                <span className={styles.agentMark} aria-hidden="true">
                                  <AgentIcon id={group.iconId} size={15} />
                                </span>
                                <span
                                  className={styles.groupName}
                                  title={group.label.length > 24 ? group.label : undefined}
                                >
                                  {group.label}
                                </span>
                              </span>
                              <span className={styles.groupValue}>{group.valueText}</span>
                            </div>

                            <ul className={styles.modelList}>
                              {group.models.map(item => (
                                <li key={`${group.provider}:${item.model}`} className={styles.modelRow}>
                                  <span className={styles.modelLead}>
                                    {item.brandIcon ? (
                                      <span
                                        className={styles.modelMask}
                                        style={{
                                          maskImage: `url("${item.brandIcon.src}")`,
                                          WebkitMaskImage: `url("${item.brandIcon.src}")`,
                                        } as CSSProperties}
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <span className={styles.modelDot} aria-hidden="true" />
                                    )}
                                    <span
                                      className={styles.modelName}
                                      title={
                                        item.displayName !== item.model.trim().toUpperCase() || item.displayName.length > 26
                                          ? item.model
                                          : undefined
                                      }
                                    >
                                      {item.displayName}
                                    </span>
                                  </span>
                                  <span className={styles.modelValue}>{item.valueText}</span>
                                </li>
                              ))}
                              {group.foldedCount > 0 && group.foldedValueText ? (
                                <li className={`${styles.modelRow} ${styles.foldedRow}`}>
                                  <span className={styles.modelLead}>
                                    <span className={styles.modelDot} aria-hidden="true" />
                                    <span className={styles.modelName}>
                                      {zh ? `其他 ${group.foldedCount} 个模型` : `${group.foldedCount} MORE MODELS`}
                                    </span>
                                  </span>
                                  <span className={styles.modelValue}>{group.foldedValueText}</span>
                                </li>
                              ) : null}
                            </ul>
                          </div>
                        ))}
                      </div>

                      <hr className={styles.divider} />
                    </>
                  ) : null}

                  <dl className={styles.kvList}>
                    {receipt.tokenRows.map(row => (
                      <div key={row.label} className={styles.kvRow}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                  </dl>

                  {receipt.footnotes.length > 0 ? (
                    <div className={styles.footnotes}>
                      {receipt.footnotes.map(note => (
                        <p key={note} className={styles.footnote}>{note}</p>
                      ))}
                    </div>
                  ) : null}

                  <hr className={styles.divider} />

                  <footer className={styles.receiptFooter}>
                    {receipt.footerLines.map(line => (
                      <p key={line} className={styles.footerLine}>{renderFooterLineWithLink(line)}</p>
                    ))}
                  </footer>
                </>
              )}
            </article>
            <svg className={styles.teeth} viewBox="0 0 384 7" preserveAspectRatio="none" aria-hidden="true">
              <path d={TEETH_PATH} />
            </svg>
          </div>
        </div>
      </div>

      <div className={styles.actionsRow}>
        <span
          role="status"
          aria-live="polite"
          className={styles.liveStatus}
          data-visible={feedback.visible ? 'true' : undefined}
          data-failed={feedback.failed ? 'true' : undefined}
        >
          {feedback.text}
        </span>

        <div className={styles.actionButtons}>
          <Button
            size="sm"
            variant="ghost"
            disabled={!receipt}
            data-copied={copiedTarget === 'text' ? '' : undefined}
            onClick={() => void handleCopyText()}
          >
            <Icon icon={copiedTarget === 'text' ? Check : FileText} size="sm" />
            {zh ? '复制文本' : 'Copy Text'}
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={!receipt}
            loading={savingPng}
            onClick={() => void handleSavePng()}
          >
            <Icon icon={Download} size="sm" />
            {zh ? '保存图片' : 'Save PNG'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!receipt}
            data-copied={copiedTarget === 'image' ? '' : undefined}
            onClick={() => void handleCopyImage()}
          >
            <Icon icon={copiedTarget === 'image' ? Check : Copy} size="sm" />
            {zh ? '复制图片' : 'Copy Image'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function renderFooterLineWithLink(line: string): ReactNode {
  const index = line.indexOf(RECEIPT_FOOTER_DOMAIN);
  if (index === -1) return line;
  const before = line.slice(0, index);
  const after = line.slice(index + RECEIPT_FOOTER_DOMAIN.length);
  return (
    <>
      {before}
      <a
        href={RECEIPT_FOOTER_URL}
        target="_blank"
        rel="noreferrer"
        className={styles.footerLink}
      >
        {RECEIPT_FOOTER_DOMAIN}
      </a>
      {after}
    </>
  );
}
