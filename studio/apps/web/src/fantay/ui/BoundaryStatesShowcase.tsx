'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Boundary States Showcase: curated specimens for Empty, Error, Loading, and Long-Text states
// to eliminate rough internal-tool edges and maintain gallery-grade visual craft.
import { useState } from 'react';
import {
  AlertTriangle,
  Copy,
  FileCode2,
  FolderPlus,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

import { Button } from './button';
import { Callout } from './callout';
import { Chip } from './chip';
import { cn } from './cn';
import { EmptyState } from './empty-state';
import { FX } from './fx';
import { Icon } from './icons';
import { Progress } from './progress';
import { Segmented, SegmentedItem } from './segmented';
import { Skeleton } from './skeleton';
import { Spinner } from './spinner';
import { StatusLabel } from './status-label';
import { toast } from './toast';

export type BoundaryStateKind = 'all' | 'empty' | 'error' | 'loading' | 'long-text';

export function BoundaryStatesShowcase({ className }: { className?: string }) {
  const [filter, setFilter] = useState<BoundaryStateKind>('all');
  const [retrying, setRetrying] = useState(false);

  const handleRetry = () => {
    setRetrying(true);
    window.setTimeout(() => {
      setRetrying(false);
      toast({ title: '已重新连接渲染节点', tone: 'success' });
    }, 600);
  };

  const show = (kind: Exclude<BoundaryStateKind, 'all'>) => filter === 'all' || filter === kind;

  return (
    <section
      className={cn(FX, 'flex flex-col gap-3 rounded-card border border-solid border-line-soft bg-surface p-4', className)}
      data-testid="fantay-boundary-states-showcase"
      aria-label="边界状态视觉规范样例"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-0 border-b border-solid border-line-soft pb-3">
        <div className="flex items-center gap-2">
          <span className="text-body font-medium text-ink">边界状态规范样例</span>
          <Chip size="sm">Empty · Error · Loading · Overflow</Chip>
        </div>
        <Segmented
          size="sm"
          aria-label="切换边界状态样例"
          value={filter}
          onValueChange={(value) => setFilter(value as BoundaryStateKind)}
          data-testid="boundary-states-filter"
        >
          <SegmentedItem value="all">全部</SegmentedItem>
          <SegmentedItem value="empty">空状态</SegmentedItem>
          <SegmentedItem value="error">报错</SegmentedItem>
          <SegmentedItem value="loading">加载中</SegmentedItem>
          <SegmentedItem value="long-text">长文本</SegmentedItem>
        </Segmented>
      </div>

      <div className={cn('grid gap-3', filter === 'all' ? 'md:grid-cols-2' : 'grid-cols-1')}>
        {show('empty') ? (
          <div
            data-testid="boundary-specimen-empty"
            className="flex flex-col justify-between gap-3 rounded-card border border-solid border-line-soft bg-paper p-3.5"
          >
            <div className="flex items-center justify-between">
              <span className="text-caption font-medium text-ink-soft">01 · 空状态 (Empty State)</span>
              <StatusLabel>零数据占位</StatusLabel>
            </div>
            <EmptyState
              variant="dashed"
              illustration={<Icon icon={FolderPlus} size="lg" className="text-ink-faint" />}
              title="尚无画板或分镜产物"
              description="从一句创作指令开始，或直接拖入参考图、视频与设计规范文件。"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => toast({ title: '已打开新建画板向导' })}
                >
                  <Icon icon={Sparkles} size="sm" />
                  新建首个画板
                </Button>
              }
            />
          </div>
        ) : null}

        {show('error') ? (
          <div
            data-testid="boundary-specimen-error"
            className="flex flex-col justify-between gap-3 rounded-card border border-solid border-line-soft bg-paper p-3.5"
          >
            <div className="flex items-center justify-between">
              <span className="text-caption font-medium text-ink-soft">02 · 报错状态 (Error State)</span>
              <Chip size="sm" tone="danger">可恢复异常</Chip>
            </div>
            <div className="flex flex-col gap-2.5 rounded-card border border-solid border-line bg-surface p-3">
              <Callout tone="error">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-body font-medium text-ink">生成通道连接超时 (ERR_UPSTREAM_504)</span>
                    <span className="text-caption text-ink-soft">
                      TokenToSea 媒体网关在 15s 内未返回首帧，您的额度未被扣除。
                    </span>
                  </div>
                  <Icon icon={AlertTriangle} size="sm" className="mt-0.5 flex-none text-danger" />
                </div>
              </Callout>
              <div className="flex items-center justify-between gap-2 rounded-row bg-sub px-2.5 py-1.5 font-mono text-micro text-ink-faint">
                <span className="truncate">trace_id: tts-req-9f82a4c1 · region: ap-east-1</span>
                <Button
                  variant="bare"
                  size="sm"
                  className="h-6 px-1.5 text-micro"
                  onClick={() => toast({ title: '已复制诊断追踪号' })}
                >
                  <Icon icon={Copy} size={12} />
                  复制
                </Button>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => toast({ title: '已切换至备用模型节点' })}>
                  切换节点
                </Button>
                <Button variant="primary" size="sm" loading={retrying} onClick={handleRetry}>
                  <Icon icon={RefreshCw} size="sm" />
                  立即重试
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {show('loading') ? (
          <div
            data-testid="boundary-specimen-loading"
            className="flex flex-col justify-between gap-3 rounded-card border border-solid border-line-soft bg-paper p-3.5"
          >
            <div className="flex items-center justify-between">
              <span className="text-caption font-medium text-ink-soft">03 · 加载中状态 (Loading & Skeleton)</span>
              <Chip size="sm" tone="warning">尺寸锁定防抖</Chip>
            </div>
            <div className="flex flex-col gap-3 rounded-card border border-solid border-line-soft bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Spinner size="sm" />
                  <span className="text-body font-medium text-ink">正在合成多机位分镜与字幕轨…</span>
                </div>
                <span className="font-mono text-caption tabular-nums text-ink-faint">68%</span>
              </div>
              <Progress aria-label="分镜合成进度" value={68} />
              <div className="grid grid-cols-3 gap-2 pt-1">
                <Skeleton shape="tile" index={0} className="h-14 w-full" />
                <Skeleton shape="tile" index={1} className="h-14 w-full" />
                <Skeleton shape="tile" index={2} className="h-14 w-full" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Skeleton shape="line" className="w-2/3" />
                <Skeleton shape="line" className="w-16" />
              </div>
            </div>
          </div>
        ) : null}

        {show('long-text') ? (
          <div
            data-testid="boundary-specimen-long-text"
            className="flex flex-col justify-between gap-3 rounded-card border border-solid border-line-soft bg-paper p-3.5"
          >
            <div className="flex items-center justify-between">
              <span className="text-caption font-medium text-ink-soft">04 · 长文本与极端溢出 (Long Text & Overflow)</span>
              <StatusLabel tone="done">自适应截断</StatusLabel>
            </div>
            <div className="flex min-w-0 flex-col gap-2.5 rounded-card border border-solid border-line-soft bg-surface p-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon icon={FileCode2} size="sm" className="flex-none text-ink-soft" />
                  <span
                    className="truncate text-body font-medium text-ink"
                    title="2026_Q4_Brand_Campaign_Ultra_Wide_Key_Visual_Master_Sequence_Final_v12_Revised.mov"
                  >
                    2026_Q4_Brand_Campaign_Ultra_Wide_Key_Visual_Master_Sequence_Final_v12_Revised.mov
                  </span>
                </div>
                <Chip size="sm" className="flex-none font-mono tabular-nums">
                  3840×2160 · 59.94fps
                </Chip>
              </div>
              <p className="m-0 line-clamp-2 break-words text-caption leading-relaxed text-ink-soft">
                长段落双行收敛示例：当提示词或审阅批注包含超长中英混排描述与无空格标识符（如
                https://tokentosea.example.com/ workspace/artifacts/sha256-8f9d2a7e4b1c0e3f6a5d9c8b7a6e5f4d3c2b1a09
                ）时，容器自动断词并锁定两行高度，绝不撑破右侧栅格或遮挡操作区。
              </p>
              <div className="flex min-w-0 items-center justify-between gap-2 border-0 border-t border-solid border-line-soft pt-2 font-mono text-micro text-ink-faint">
                <span className="truncate" title="/Users/fantasy/Library/Application Support/Fantaydesign/namespaces/fantay/projects/movie-studio.json">
                  ~/Library/Application Support/…/projects/movie-studio.json
                </span>
                <span className="flex-none tabular-nums">12,480 tokens</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
