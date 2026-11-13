// The composer's design-system picker shows a system the way the 设计体系 page does: the hover pane is
// the studio's own cover (drawn from the system's tokens), and "open" brings up the full studio, the
// same continuous reader the page uses, in a dialog over the composer.
import { useEffect, useState } from 'react';
import { parseStudioTokens, type StudioDocument, type StudioToken, type WorkspaceCollabContext } from '@open-design/contracts';
import { useI18n } from '../i18n';
import type { Locale } from '../i18n/types';
import { localizeDesignSystemCategory, localizeDesignSystemSummary } from '../i18n/content';
import { fetchDesignSystem } from '../providers/registry';
import { overviewFromMarkdown, readStudioFile, studioFileUrl, studioTokenFile } from '../runtime/design-system-studio';
import { useDesignKit } from '../runtime/design-kit';
import { studioThemeScopes } from '../runtime/studio-palette';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import {
  resolveWorkspaceResourceReadIdentity,
  workspaceResourceReadIdentityFromContext,
  workspaceResourceReadIdentityKey,
  type WorkspaceResourceReadIdentity,
} from '../collab/workspace-identity';
import type { DesignSystemDetail, DesignSystemSummary } from '../types';
import { Button, Modal, ModalTitle, Skeleton } from '../fantay/ui';
import { DesignSystemStudio } from './DesignSystemStudio';
import { StudioCover } from './StudioCover';
import { studioDisplayName } from './StudioOverview';
import { designSystemLogoHost, isUserSystem } from './design-system-metadata';
import { Icon } from './Icon';
import styles from './DesignSystemQuickLook.module.css';

const EMPTY_NOTES: StudioDocument['tokenNotes'] = {};

/** The exact project scope wins over the shell's ambient one, as in every other design-system read. */
function useReadIdentity(workspaceContext?: WorkspaceCollabContext | null): WorkspaceResourceReadIdentity | null {
  const state = useWorkspaceContext();
  return workspaceContext !== undefined ? workspaceResourceReadIdentityFromContext(workspaceContext) : resolveWorkspaceResourceReadIdentity(state);
}

/** What the page's list says under a name: a user system's scenario or source, a preset's category. */
export function designSystemSubtitle(system: DesignSystemSummary, locale: Locale, fallback: string): string {
  return isUserSystem(system)
    ? system.summary?.trim() || designSystemLogoHost(system) || fallback
    : localizeDesignSystemCategory(locale, system.category || 'Uncategorized');
}

type Look = { tokens: StudioToken[]; intro: string; faces: string };
const looks = new Map<string, Promise<Look | null>>();

/** One read per system and identity while the app runs: hovering back and forth must not refetch. */
function loadLook(id: string, context: WorkspaceCollabContext | null, identity: string): Promise<Look | null> {
  const key = id + '|' + identity;
  let pending = looks.get(key);
  if (!pending) {
    pending = (async () => {
      const detail = await fetchDesignSystem(id, context);
      const css = await readStudioFile(studioFileUrl(id, studioTokenFile(detail?.packageInfo), undefined, context)).catch(() => null);
      // Package fonts only, as the studio loads them; anything else would point outside the package.
      const faces = (css?.match(/@font-face\s*\{[^{}]*\}/gi) ?? []).map((face) => face.replace(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi, (_match, asset: string) => {
        const path = asset.replace(/^\.\//, '');
        return /^fonts\/[\w.\/-]+$/.test(path) && !path.includes('..') ? 'url("' + studioFileUrl(id, path, undefined, context) + '")' : 'url("")';
      })).join('\n');
      return { tokens: parseStudioTokens(css ?? ''), intro: overviewFromMarkdown(detail?.body ?? '').intro, faces };
    })().catch(() => null);
    if (looks.size > 80) looks.clear();
    looks.set(key, pending);
    pending.then((value) => { if (value === null) looks.delete(key); });
  }
  return pending;
}

export function DesignSystemCoverPreview({
  system,
  workspaceContext,
  selected,
  onUse,
  onOpen,
}: {
  system: DesignSystemSummary;
  workspaceContext?: WorkspaceCollabContext | null;
  selected: boolean;
  onUse: () => void;
  onOpen: () => void;
}) {
  const { locale, t } = useI18n();
  const zh = locale.startsWith('zh');
  const identity = useReadIdentity(workspaceContext);
  const identityKey = workspaceResourceReadIdentityKey(identity);
  const [look, setLook] = useState<{ id: string; value: Look | null } | null>(null);
  useEffect(() => {
    let live = true;
    void loadLook(system.id, identity?.context ?? null, identityKey).then((value) => { if (live) setLook({ id: system.id, value }); });
    return () => { live = false; };
  }, [system.id, identityKey]);
  const current = look?.id === system.id ? look.value : undefined;
  const summary = localizeDesignSystemSummary(locale, system).trim();
  const swatches = system.swatches?.slice(0, 6) ?? [];

  return <div className={styles.look} data-testid="project-ds-picker-preview-cover">
    <div className={styles.coverFrame}>
      {current === undefined
        ? <Skeleton className={styles.coverSkeleton} />
        : current && current.tokens.length > 0
          ? <>
            {current.faces ? <style>{current.faces}</style> : null}
            <StudioCover name={studioDisplayName(system.title)} intro={current.intro || summary} tokens={current.tokens} scope={studioThemeScopes(current.tokens, [])[0] ?? ':root'} notes={EMPTY_NOTES} chinese={zh} />
          </>
          : <div className={styles.bands} aria-hidden>{swatches.length ? swatches.map((color, index) => <span key={color + index} style={{ background: color }} />) : <span className={styles.monogram}>{studioDisplayName(system.title).slice(0, 1).toUpperCase()}</span>}</div>}
    </div>
    <div className={styles.meta}>
      <div className={styles.titleRow}>
        <strong className={styles.title} title={system.title}>{studioDisplayName(system.title)}</strong>
        {selected ? <span className={styles.badge}>{zh ? '已选用' : 'In use'}</span> : null}
      </div>
      <span className={styles.subtitle}>{designSystemSubtitle(system, locale, t('brandDetail.designSystem'))}</span>
      {summary ? <p className={styles.summary}>{summary}</p> : null}
      {swatches.length > 0 && current && current.tokens.length > 0 ? <div className={styles.swatches} aria-hidden>{swatches.map((color, index) => <span key={color + index} style={{ background: color }} />)}</div> : null}
    </div>
    <div className={styles.actions}>
      <Button variant="secondary" size="sm" onClick={onOpen} data-testid="project-ds-picker-preview-expand"><Icon name="maximize" size={13} />{zh ? '打开' : 'Open'}</Button>
      {selected ? null : <Button variant="primary" size="sm" onClick={onUse} data-testid="project-ds-picker-preview-use"><Icon name="check" size={13} />{zh ? '使用此体系' : 'Use this system'}</Button>}
    </div>
  </div>;
}

/**
 * The full studio for one system, read-only, the same reader the 设计体系 page shows: every chapter on
 * one scrolling page with the section menu following along.
 */
export function DesignSystemStudioDialog({
  system,
  workspaceContext,
  selected,
  onUse,
  onClose,
}: {
  system: DesignSystemSummary;
  workspaceContext?: WorkspaceCollabContext | null;
  selected: boolean;
  onUse: () => void;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const zh = locale.startsWith('zh');
  const identity = useReadIdentity(workspaceContext);
  const identityKey = workspaceResourceReadIdentityKey(identity);
  const readContext = identity?.context ?? null;
  const [detail, setDetail] = useState<{ id: string; value: DesignSystemDetail | null } | null>(null);
  useEffect(() => {
    let live = true;
    void fetchDesignSystem(system.id, readContext).then((value) => { if (live) setDetail({ id: system.id, value }); }).catch(() => { if (live) setDetail({ id: system.id, value: null }); });
    return () => { live = false; };
  }, [system.id, identityKey]);
  const resolved = detail?.id === system.id ? detail.value : undefined;
  const { kit } = useDesignKit({
    publishedAssets: Boolean(system.teamSynced),
    designSystemId: system.id,
    title: system.title,
    projectId: resolved?.projectId ?? system.projectId,
    body: resolved?.body,
    packageInfo: resolved?.packageInfo,
    swatches: system.swatches,
    showcaseHtml: null,
    // As on the page: a user system renders live from its project; read-only comes from the studio below.
    editable: isUserSystem(system),
    host: designSystemLogoHost(system) || undefined,
    workspaceContext: readContext,
    workspaceReadGeneration: identityKey,
  });

  return <Modal open onClose={onClose} showClose={false} size="2xl" className={styles.dialog} aria-describedby={undefined} data-testid="design-system-studio-dialog">
    <ModalTitle className={styles.srOnly}>{system.title}</ModalTitle>
    {kit && resolved !== undefined
      ? <DesignSystemStudio
          kit={kit}
          body={resolved?.body}
          packageInfo={resolved?.packageInfo}
          editable={false}
          readContext={readContext}
          workspaceReadGeneration={identityKey}
          expandable={false}
          dataTestId={`design-system-studio-dialog-${system.id}`}
          actionsSlot={selected
            ? <span className={styles.inUse}><Icon name="check" size={13} />{zh ? '已选用' : 'In use'}</span>
            : <Button variant="primary" size="sm" onClick={onUse}><Icon name="check" size={13} />{zh ? '使用此体系' : 'Use this system'}</Button>}
          trailingSlot={<Button variant="bare" size="icon-sm" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><Icon name="close" size={15} /></Button>}
        />
      : <div className={styles.loading} role="status" aria-label={t('designSystemPicker.loadingPreview')}><Skeleton className={styles.loadingCover} /><Skeleton className={styles.loadingLine} index={1} /><Skeleton className={styles.loadingLineShort} index={2} /></div>}
  </Modal>;
}
