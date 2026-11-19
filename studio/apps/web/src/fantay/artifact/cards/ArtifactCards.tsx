// fx-governance-allow-raw: a card's open target is the whole card laid over its preview, which no button primitive models
// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/components/chat/GeneratedFilesCard.tsx @ 88941ba7 (Apache-2.0): the shape of the group (one product on a cover with a caption row, several as rows with a type tile and two lines, six rows then a "more" control) and the rule that what can be pressed must exist. Changed here: rewritten for this chat, no code copied: previews come from the existing live page frame and turn snapshots, share and export are quiet actions that open the workspace's anchored menus, existence is read from the project file list instead of a stat call, and the card adds a selected state, a pending row, a context menu, product tokens and the chat's motion grammar.
//
// The products of a turn, in the chat: one group at the end of the turn. Which files are listed is
// decided upstream (from tool calls, reconciled with the daemon's list); this file only draws them.
// A click opens the file as a tab in the side workspace, always the workspace's latest version,
// whichever turn's snapshot the card shows.
'use client';

import { ChevronDown, ChevronRight, Copy, Download, Forward, PanelRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { useProjectCollabContext } from '../../../collab/collab-context';
import { appendResourceQuery } from '../../../collab/workspace-identity';
import { ARTIFACT_ANCHOR_ATTR, artifactAnchorId } from '../../../components/chat/AnchoredMenuShell';
import { useT } from '../../../i18n';
import { projectFileUrl } from '../../../providers/registry';
import { artifactExportNeedsFormatChoice } from '../../../runtime/chat/artifact-export';
import type { ProjectFile } from '../../../types';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  IconButton,
  VisuallyHidden,
} from '../../ui';
import { formatBytes } from '../use-artifact-source';
import { useArtifactViewState } from '../use-view-state';
import { useActiveArtifact } from './active-artifact';
import styles from './ArtifactCards.module.css';
import { ProductFaceView, Sheen, TypeGlyph } from './CardFaces';
import {
  MAX_VISIBLE_PRODUCTS,
  cardsLayout,
  coverReadsText,
  productFace,
  productFacts,
  productLabel,
  productName,
  visibleProducts,
  type ArtifactProduct,
  type ProductMeasure,
} from './card-model';

export interface ArtifactCardsProps {
  items: readonly ArtifactProduct[];
  projectId: string;
  /**
   * The project's current files. A card reads its size from here, a text cover its first lines, and
   * a finished turn's file that is not in a non-empty list is shown as not in the project.
   */
  files?: readonly ProjectFile[] | undefined;
  /** Opens a product as a tab. Only the name is handed over: the tab always shows the latest version. */
  onOpen?: ((name: string) => void) | undefined;
  /** Share, pages only. The workspace opens its own share menu beside the element carrying `anchorId`. */
  onPublish?: ((name: string, anchorId: string) => void) | undefined;
  /** Export for files with several formats: the workspace opens its export menu beside `anchorId`. */
  onExport?: ((name: string, anchorId: string) => void) | undefined;
}

/** How long "path copied" stays in the card's second line. */
const NOTICE_MS = 1600;
/** The project's file list can trail a write by a moment; a file counts as gone only after this long. */
const MISSING_GRACE_MS = 1200;

export function ArtifactCards({ items, projectId, files, onOpen, onPublish, onExport }: ArtifactCardsProps): JSX.Element | null {
  const t = useT();
  const anchorScope = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const activeName = useActiveArtifact(projectId);
  // Kept with the turn's first product, so a list the reader opened is still open after the chat
  // remounts the message.
  const [expanded, setExpanded] = useArtifactViewState<boolean>(projectId, items[0]?.name ?? '', 'cards-expanded', false);
  const fileByName = useMemo(() => new Map((files ?? []).map((file) => [file.name, file] as const)), [files]);
  // An absent or empty list says nothing about any one file (it may simply not have loaded yet).
  const listKnown = fileByName.size > 0;
  // Rows present when the group first appears arrive with the shell; a row that joins later gets its own entrance.
  const settled = useRef(false);
  useEffect(() => {
    settled.current = true;
  }, []);

  if (items.length === 0) return null;

  const layout = cardsLayout(items);
  const { visible, hidden } = visibleProducts(items, expanded);
  const card = (item: ArtifactProduct, variant: 'cover' | 'row'): JSX.Element => (
    <ProductCard
      key={item.name}
      item={item}
      variant={variant}
      projectId={projectId}
      file={fileByName.get(item.name)}
      listed={!listKnown || fileByName.has(item.name)}
      selected={activeName === item.name}
      anchorScope={anchorScope}
      settled={settled}
      onOpen={onOpen}
      onPublish={onPublish}
      onExport={onExport}
    />
  );
  const only = items[0];

  return (
    <div className={styles.group} role="group" aria-label={t('artifact.cards.group')} data-layout={layout} data-testid="artifact-cards">
      {layout === 'cover' && only ? (
        card(only, 'cover')
      ) : (
        <div className={styles.shell}>
          <div className={styles.rows} role="list">
            {visible.map((item) => (
              <div key={item.name} className={styles.rowItem} role="listitem">
                {card(item, 'row')}
              </div>
            ))}
          </div>
          {items.length > MAX_VISIBLE_PRODUCTS ? (
            <Button
              variant="bare"
              size="sm"
              className={styles.more}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              data-testid="artifact-cards-more"
            >
              <span className={styles.moreMark}>
                <ChevronDown aria-hidden="true" size={16} strokeWidth={1.75} />
              </span>
              {expanded ? t('artifact.cards.showLess') : t('assistant.unfinishedMore', { n: hidden })}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface ProductCardProps {
  item: ArtifactProduct;
  variant: 'cover' | 'row';
  projectId: string;
  file: ProjectFile | undefined;
  /** False when the project's file list is known and does not have this file. */
  listed: boolean;
  /** This file's tab is the one in front in the side workspace. */
  selected: boolean;
  anchorScope: string;
  settled: { readonly current: boolean };
  onOpen?: ((name: string) => void) | undefined;
  onPublish?: ((name: string, anchorId: string) => void) | undefined;
  onExport?: ((name: string, anchorId: string) => void) | undefined;
}

function ProductCard({ item, variant, projectId, file, listed, selected, anchorScope, settled, onOpen, onPublish, onExport }: ProductCardProps): JSX.Element {
  const t = useT();
  const { workspaceContext, viewerOnly } = useProjectCollabContext();
  const [late] = useState(() => settled.current);
  const [measure, setMeasure] = useState<ProductMeasure>({});
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const pending = item.pending === true;
  // What can be pressed must exist. A finished turn's file that the project does not list (deleted
  // since, or never written) keeps its card and says so; it offers nothing to open or export.
  const missing = useLasting(!listed && !pending && item.sharePending !== true, MISSING_GRACE_MS);
  const ready = !pending && !missing;
  const face = productFace(item.name, item.kind);
  const label = productLabel(item.name, item.kind);
  const { base } = productName(item.name);

  const src = projectFileUrl(projectId, item.name, workspaceContext);
  const liveUrl = item.revision === undefined || item.revision === null ? src : appendResourceQuery(src, `v=${encodeURIComponent(String(item.revision))}`);
  // An image's frozen copy is the card's subject: the face and the download both read it. Without
  // one (an older conversation) the current file stands in, and nothing is said about it.
  const mediaUrl = item.snapshotUrl ?? liveUrl;

  const openable = !!onOpen && ready;
  // Share is a page's action; export belongs to every finished product.
  const sharable = item.kind === 'html' && !!onPublish && ready;
  const shareBlocked = viewerOnly
    ? t('fileViewer.readonlySharedNoExport')
    : item.sharePending
      ? t('fileViewer.shareAfterGenerationComplete')
      : undefined;
  const choosesFormat = !!onExport && artifactExportNeedsFormatChoice(item.name);
  const publishAnchor = artifactAnchorId('publish', item.name, anchorScope);
  const exportAnchor = artifactAnchorId('export', item.name, anchorScope);
  const [pinned, releasePin, pin] = usePinnedActions([publishAnchor, exportAnchor]);

  const share = (): void => {
    if (!onPublish || shareBlocked) return;
    pin();
    onPublish(item.name, publishAnchor);
  };
  const exportProduct = (): void => {
    if (choosesFormat && onExport) {
      pin();
      onExport(item.name, exportAnchor);
      return;
    }
    // One format: the original file (for an image, the copy the card shows), straight to disk.
    releasePin();
    downloadFile(item.snapshotUrl ?? src, base);
  };
  const copyPath = (): void => {
    void navigator.clipboard?.writeText(item.name).then(
      () => {
        setNotice(t('workspace.code.pathCopied'));
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
      },
      () => undefined,
    );
  };

  const facts = productFacts({
    face,
    measure,
    size: file ? formatBytes(file.size) : '',
    snapshot: item.snapshotUrl !== undefined,
  });
  const exportLabel = choosesFormat ? t('chat.artifact.export') : t('fileViewer.download');

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={pending}>
        <div
          className={styles.card}
          /* Each card's test id carries its file name, so counting cards needs this stable hook. */
          data-artifact-card=""
          data-variant={variant}
          data-kind={item.kind}
          data-openable={openable ? '' : undefined}
          data-pending={pending ? '' : undefined}
          data-missing={missing ? '' : undefined}
          data-selected={selected && ready ? '' : undefined}
          data-late={late ? '' : undefined}
          data-actions={pinned ? 'pinned' : undefined}
          data-testid={`artifact-card-${item.name}`}
        >
          {openable && onOpen ? (
            <button
              type="button"
              className={styles.open}
              title={item.name}
              aria-label={t('tool.openInTab', { name: base })}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onOpen(item.name)}
              data-testid={`artifact-card-open-${item.name}`}
            />
          ) : null}
          {variant === 'cover' ? (
            <span
              className={styles.preview}
              data-face={face}
              data-text={face === 'document' && coverReadsText(item.name, file?.size) ? '' : undefined}
              aria-hidden="true"
            >
              <ProductFaceView
                item={item}
                /* A file that is gone has no picture to fetch: its place is kept by the document cover. */
                face={missing ? 'document' : face}
                size="cover"
                projectId={projectId}
                liveUrl={liveUrl}
                mediaUrl={mediaUrl}
                file={file}
                measure={measure}
                onMeasure={setMeasure}
              />
            </span>
          ) : null}
          <div className={styles.caption}>
            {variant === 'row' ? (
              <span className={styles.tile} data-face={ready ? face : 'document'} aria-hidden="true">
                {!ready ? (
                  <>
                    <TypeGlyph name={item.name} size={18} />
                    {pending ? <Sheen /> : null}
                  </>
                ) : (
                  <ProductFaceView
                    item={item}
                    face={face}
                    size="tile"
                    projectId={projectId}
                    liveUrl={liveUrl}
                    mediaUrl={mediaUrl}
                    file={file}
                    onMeasure={setMeasure}
                  />
                )}
              </span>
            ) : null}
            <div className={styles.text}>
              <span className={styles.name}>{base}</span>
              {pending ? (
                <span className={styles.meta} role="status">
                  <span className={styles.pulse} aria-hidden="true" />
                  <span className={styles.metaText}>{t('artifact.cards.writing')}</span>
                </span>
              ) : (
                <span className={styles.meta}>
                  <span className={styles.metaText}>
                    {notice ?? (missing ? t('artifact.cards.missing') : [t(`artifact.cards.kind.${label}`), ...facts].join(' · '))}
                  </span>
                  {/* Only the notice is announced: facts that settle as a picture loads are not news. */}
                  <VisuallyHidden role="status">{notice}</VisuallyHidden>
                </span>
              )}
            </div>
            {!ready ? null : (
              <div className={styles.actions}>
                {sharable ? (
                  <IconButton
                    size="sm"
                    aria-label={t('chat.artifact.publish')}
                    aria-haspopup="menu"
                    disabled={shareBlocked !== undefined}
                    disabledReason={shareBlocked}
                    onClick={share}
                    data-testid={`artifact-card-publish-${item.name}`}
                    {...{ [ARTIFACT_ANCHOR_ATTR]: publishAnchor }}
                  >
                    <Forward aria-hidden="true" strokeWidth={1.75} />
                  </IconButton>
                ) : null}
                <IconButton
                  size="sm"
                  aria-label={exportLabel}
                  aria-haspopup={choosesFormat ? 'menu' : undefined}
                  onClick={exportProduct}
                  data-testid={`artifact-card-export-${item.name}`}
                  {...{ [ARTIFACT_ANCHOR_ATTR]: exportAnchor }}
                >
                  <Download aria-hidden="true" strokeWidth={1.75} />
                </IconButton>
              </div>
            )}
            {openable ? <ChevronRight className={styles.go} aria-hidden="true" size={16} strokeWidth={1.75} /> : null}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid={`artifact-card-menu-${item.name}`}>
        {openable && onOpen ? (
          <ContextMenuItem icon={<PanelRight size={14} strokeWidth={1.75} />} onSelect={() => onOpen(item.name)}>
            {t('fileViewer.open')}
          </ContextMenuItem>
        ) : null}
        {sharable ? (
          <ContextMenuItem icon={<Forward size={14} strokeWidth={1.75} />} disabled={shareBlocked !== undefined} onSelect={share}>
            {t('chat.artifact.publish')}
          </ContextMenuItem>
        ) : null}
        {ready ? (
          <>
            <ContextMenuItem icon={<Download size={14} strokeWidth={1.75} />} onSelect={exportProduct}>
              {exportLabel}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem icon={<Copy size={14} strokeWidth={1.75} />} onSelect={copyPath}>
          {t('workspace.code.copyPath')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** True once `condition` has held without a break for `ms`; false the moment it stops holding. */
function useLasting(condition: boolean, ms: number): boolean {
  const [lasting, setLasting] = useState(false);
  useEffect(() => {
    if (!condition) {
      setLasting(false);
      return;
    }
    const timer = window.setTimeout(() => setLasting(true), ms);
    return () => window.clearTimeout(timer);
  }, [condition, ms]);
  return condition && lasting;
}

/**
 * Share and export open a menu that the workspace anchors to the card's own button, a moment after
 * the click. The buttons are quiet until hovered, so while such a menu is open they are pinned
 * visible: a menu must not hang beside nothing. The pin is let go once no menu is anchored to this
 * card any more, checked after each press, key or scroll that could have closed it.
 */
function usePinnedActions(anchorIds: readonly string[]): [pinned: boolean, release: () => void, pin: () => void] {
  const [pinned, setPinned] = useState(false);
  const anchors = anchorIds.join('\n');

  useEffect(() => {
    if (!pinned) return;
    let timer: number | undefined;
    const check = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const open = anchors.split('\n').some((id) => document.querySelector(`[data-anchored-menu="${CSS.escape(id)}"]`) !== null);
        if (!open) setPinned(false);
      }, 240);
    };
    document.addEventListener('pointerdown', check, true);
    document.addEventListener('keydown', check, true);
    document.addEventListener('scroll', check, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', check, true);
      document.removeEventListener('keydown', check, true);
      document.removeEventListener('scroll', check, true);
    };
  }, [pinned, anchors]);

  return [pinned, () => setPinned(false), () => setPinned(true)];
}

/** Saves a project file to disk under its own name. */
function downloadFile(href: string, name: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
