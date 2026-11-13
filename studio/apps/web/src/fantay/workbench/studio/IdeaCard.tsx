/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 studio — the card at the top of the studio conversation: the idea itself (title and the
 * full body, which the original desk lost on the way in), the form (script / article) and style, the one
 * 一键成稿 entry with its per-run 生成图片 switch, live progress with 取消, and the notices that explain
 * why images will not be drawn.
 * Derived from dsh-media-desk client/studio.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Sparkles } from 'lucide-react';
import type { WorkbenchItem, WorkbenchProduction, WorkbenchProductionLive, WorkbenchPublicSettings } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';
import { openHostExternalUrl } from '@open-design/host';

import { Button } from '../../ui/button';
import { Callout } from '../../ui/callout';
import { cn } from '../../ui/cn';
import { Icon } from '../../ui/icons';
import { Segmented, SegmentedItem } from '../../ui/segmented';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../ui/select';
import { Switch } from '../../ui/switch';
import { useL, useWorkbenchLang } from '../lang';
import { useWorkbenchShell } from '../shell/context';
import { STYLE_BOARDS, fmtDate, kindLabel, posterOf, statusLabel, textLength } from '../shared/format';
import { useWorkbench, workbench } from '../store';
import { AutoText } from './parts';
import { cancelProduction, isBusy } from './production';
import styles from './Studio.module.css';

const DEFAULT_STYLE = '__default__';

export interface IdeaCardProps {
  item: WorkbenchItem;
  live: WorkbenchProductionLive | null;
  settings: WorkbenchPublicSettings | null;
}

export function IdeaCard({ item, live, settings }: IdeaCardProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const shell = useWorkbenchShell();
  const snapshot = useWorkbench();
  const production = item.production;
  const running = production?.status === 'running';
  const [draw, setDraw] = useState<boolean | null>(null);
  useEffect(() => setDraw(null), [item.id]);
  // This run's choice first, then what this production used last time, then the settings default.
  const withImages = draw ?? production?.withImages ?? settings?.generateImages ?? true;
  const canStart = !production || production.status === 'failed' || production.status === 'cancelled';
  const format = snapshot.state?.draftFormat === 'article' ? 'article' : 'script';
  const signedIn = snapshot.signedIn;
  const poster = workbenchMediaUrl(posterOf(item));

  return (
    <section className={styles.ideaCard} aria-label={L('灵感', 'Idea')}>
      <div className={styles.ideaLabel}>
        <span>{kindLabel(item.kind, lang)} · {fmtDate(item.createdAt, lang)}</span>
        <span className={styles.ideaStatus}>{statusLabel(item.status, lang)}</span>
      </div>
      <AutoText
        className={styles.ideaTitle}
        label={L('灵感标题', 'Idea title')}
        value={item.title}
        disabled={running}
        singleLine
        onCommit={title => { void workbench.ops([{ op: 'update_item', id: item.id, title }], { label: L('修改灵感', 'Edit idea'), quiet: true }); }}
      />
      <IdeaBody item={item} disabled={running} />
      {poster && item.kind !== 'web' ? <img className={styles.ideaMedia} src={poster} alt="" draggable={false} /> : null}
      {item.url ? (
        <Button variant="bare" size="sm" className={styles.ideaSource} onClick={() => { void openHostExternalUrl(item.url!); }}>
          <Icon icon={ExternalLink} size={12} />
          <span className={styles.ideaSourceText}>{item.source || hostOf(item.url)}</span>
        </Button>
      ) : null}

      {!running ? (
        <div className={styles.ideaControls}>
          <div className={styles.controlRow}>
            <span className={styles.controlLabel}>{L('体裁', 'Form')}</span>
            <Segmented
              size="sm"
              aria-label={L('体裁', 'Form')}
              className={styles.fullSegmented}
              value={format}
              onValueChange={(next) => {
                if (next !== format) void workbench.ops([{ op: 'set_format', format: next }], { label: L('切换体裁', 'Switch form'), quiet: true });
              }}
            >
              <SegmentedItem value="script" title={L('口播脚本：一句话一行，一段一段', 'Voice-over script: one sentence per line')}>{L('脚本', 'Script')}</SegmentedItem>
              <SegmentedItem value="article" title={L('文章：一个一个自然段', 'Article: natural paragraphs')}>{L('文章', 'Article')}</SegmentedItem>
            </Segmented>
          </div>
          <StylePicker />
        </div>
      ) : null}

      {!running && production?.status === 'done' && production.format !== format ? (
        <p className={styles.ideaHint}>{L('这篇是按另一种体裁写的，重新成稿后生效。', 'This draft used the other form; it applies on the next run.')}</p>
      ) : null}

      {canStart ? (
        <div className={styles.goRow}>
          <Button
            variant="primary"
            size="lg"
            className={styles.goButton}
            disabled={!signedIn}
            disabledReason={!signedIn ? L('先登录 TokenToSea', 'Sign in to TokenToSea first') : undefined}
            onClick={() => shell.produce(item.id, withImages)}
          >
            <Icon icon={Sparkles} size={16} />
            {production?.status === 'failed' || production?.status === 'cancelled' ? L('重新成稿', 'Produce again') : L('一键成稿', 'Produce')}
          </Button>
          <label className={styles.goOption}>
            <Switch size="sm" checked={withImages} onCheckedChange={value => setDraw(value)} />
            {L('生成图片', 'Images')}
          </label>
        </div>
      ) : null}

      {running && production ? <ProgressCard itemId={item.id} production={production} live={live} /> : null}

      {!signedIn ? (
        <Callout className={styles.ideaCallout}>
          <span>{L('写作、生图都用你的 TokenToSea 账户，登录后就能一键成稿。', 'Writing and images run on your TokenToSea account. Sign in to produce.')}</span>
          <Button size="sm" variant="primary" loading={shell.signingIn} onClick={shell.signIn}>{L('登录', 'Sign in')}</Button>
        </Callout>
      ) : null}
      {production?.status === 'failed' && production.error ? <Callout tone="error" className={styles.ideaCallout}>{production.error}</Callout> : null}
      {production?.status === 'cancelled' ? <p className={styles.ideaHint}>{L('上次成稿已取消。', 'The last run was cancelled.')}</p> : null}
      {production?.needsProvider ? (
        <p className={styles.ideaHint}>
          {L('当前 TokenToSea 账户没有可用的生图模型，这次只出了文字。', 'Your TokenToSea account has no usable image model, so this run is text only.')}
          <Button variant="link" size="sm" className={styles.inlineLink} onClick={shell.openSettings}>{L('去设置', 'Settings')}</Button>
        </p>
      ) : null}
      {canStart && signedIn && withImages && settings && !settings.imageReady ? (
        <p className={styles.ideaHint}>
          {L('当前账户没有可用的生图模型，这次只出文字，之后可以单张补画。', 'No image model is available on this account; this run is text only.')}
          <Button variant="link" size="sm" className={styles.inlineLink} onClick={shell.openSettings}>{L('去设置', 'Settings')}</Button>
        </p>
      ) : null}
      {canStart && signedIn && !withImages ? <p className={styles.ideaHint}>{L('这次只出文字版，之后仍可以单张补画。', 'Text only this time; you can still draw single images later.')}</p> : null}
      {production?.notice ? <p className={styles.ideaHint}>{production.notice}</p> : null}
    </section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The idea's body, visible in the studio too. Long bodies start folded. */
function IdeaBody({ item, disabled }: { item: WorkbenchItem; disabled: boolean }) {
  const L = useL();
  const body = item.body ?? '';
  const long = body.length > 90 || body.split('\n').length > 4;
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [item.id]);
  return (
    <div className={styles.ideaBodyWrap}>
      <div className={cn(styles.ideaBodyClip, long && !open && styles.ideaBodyClipped)} onFocus={() => setOpen(true)}>
        <AutoText
          className={styles.ideaBody}
          label={L('灵感正文', 'Idea body')}
          value={body}
          disabled={disabled}
          allowEmpty
          placeholder={L('补一句想法，写进正文', 'Add a note to the body')}
          onCommit={next => { void workbench.ops([{ op: 'update_item', id: item.id, body: next }], { label: L('修改正文', 'Edit body'), quiet: true }); }}
        />
      </div>
      {long ? (
        <Button variant="link" size="sm" className={styles.linkButton} aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? L('收起', 'Collapse') : L('展开全文', 'Show all')}
        </Button>
      ) : null}
    </div>
  );
}

function StylePicker() {
  const L = useL();
  const snapshot = useWorkbench();
  const stylesList = useMemo(() => snapshot.state?.styles ?? [], [snapshot.state?.styles]);
  const active = snapshot.state?.activeStyleId ?? null;
  const own = stylesList.filter(style => !style.preset);
  const boards = STYLE_BOARDS.map(board => ({ board, list: stylesList.filter(style => style.preset && style.board === board) })).filter(group => group.list.length);
  const loose = stylesList.filter(style => style.preset && !STYLE_BOARDS.includes((style.board ?? '') as (typeof STYLE_BOARDS)[number]));
  const label = (style: { icon?: string; name: string }) => (style.icon ? `${style.icon} ${style.name}` : style.name);
  return (
    <div className={styles.controlRow}>
      <span className={styles.controlLabel}>{L('风格', 'Style')}</span>
      <Select
        value={active ?? DEFAULT_STYLE}
        onValueChange={(next) => {
          const id = next === DEFAULT_STYLE ? null : next;
          if (id !== active) void workbench.ops([{ op: 'set_style', id }], { label: L('切换风格', 'Switch style'), quiet: true });
        }}
      >
        <SelectTrigger size="sm" className={styles.styleTrigger} aria-label={L('风格', 'Style')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_STYLE}>{L('默认', 'Default')}</SelectItem>
          {own.length ? (
            <SelectGroup>
              <SelectLabel>{L('我的风格', 'My styles')}</SelectLabel>
              {own.map(style => <SelectItem key={style.id} value={style.id}>{label(style)}</SelectItem>)}
            </SelectGroup>
          ) : null}
          {boards.map(group => (
            <SelectGroup key={group.board}>
              <SelectLabel>{group.board}</SelectLabel>
              {group.list.map(style => <SelectItem key={style.id} value={style.id}>{label(style)}</SelectItem>)}
            </SelectGroup>
          ))}
          {loose.length ? (
            <SelectGroup>
              <SelectLabel>{L('预设', 'Presets')}</SelectLabel>
              {loose.map(style => <SelectItem key={style.id} value={style.id}>{label(style)}</SelectItem>)}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Progress, reported in the conversation column like the assistant giving an update. */
function ProgressCard({ itemId, production, live }: { itemId: string; production: WorkbenchProduction; live: WorkbenchProductionLive | null }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const words = textLength(production.article || live?.text || '', lang);
  const visuals = [production.cover, ...production.images].filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
  const shots = production.shots;
  const count = (list: Array<{ src?: string }>) => list.filter(asset => asset.src).length;
  const planned = (live?.stage ?? production.stage) !== 'brief';
  const drawing = production.withImages && !production.needsProvider;
  const steps = [
    { label: L('标题和封面字', 'Title and cover words'), done: planned, active: !planned },
    {
      label: production.article
        ? L(`脚本 ${words} 字`, `Script, ${words} words`)
        : words
          ? L(`正在写 · ${words} 字`, `Writing · ${words} words`)
          : L('脚本', 'Script'),
      done: Boolean(production.article),
      active: planned && !production.article,
    },
    ...(drawing
      ? [
          {
            label: L(`封面和配图 ${count(visuals)}/${visuals.length || 1}`, `Cover and figures ${count(visuals)}/${visuals.length || 1}`),
            done: planned && visuals.length > 0 && !visuals.some(isBusy),
            active: visuals.some(isBusy),
          },
          {
            label: L(`分镜 ${count(shots)}/${shots.length || '…'}`, `Storyboard ${count(shots)}/${shots.length || '…'}`),
            done: planned && shots.length > 0 && !shots.some(isBusy),
            active: shots.some(isBusy),
          },
        ]
      : []),
  ];
  return (
    <div className={styles.progress} role="status" aria-label={L('成稿进度', 'Production progress')}>
      {steps.map((step, index) => (
        <div key={index} className={styles.progressStep} data-state={step.done ? 'done' : step.active ? 'active' : 'wait'}>
          <i className={styles.progressMark}>{step.done ? <Icon icon={Check} size={10} strokeWidth={2.6} /> : null}</i>
          <span className={step.active && !step.done ? styles.shimmer : undefined}>{step.label}</span>
        </div>
      ))}
      <Button variant="link" size="sm" className={styles.linkButton} onClick={() => { void cancelProduction(itemId, L); }}>{L('取消成稿', 'Cancel')}</Button>
    </div>
  );
}
