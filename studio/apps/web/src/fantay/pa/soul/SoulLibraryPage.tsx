// SPDX-License-Identifier: AGPL-3.0-only
// 角色库 (place `library`, Soul UI spec §6.2): a head with search, 导入 and the tab's create button, four inline line tabs
// with counts (角色 · 世界书 · 我的人设 · 文风), then the tab's content. 角色 adds the tag filter, the 入门 shelf (W3-1's
// SoulStarterShelf) and the character tiles. Every create and edit opens a modal; tab, query and tag live in `ui`.
import { useRef, useState, type ChangeEvent } from 'react';
import { Plus } from 'lucide-react';

import { useI18n } from '../../../i18n';
import { Button, Chip, Icon, SearchField, Tabs, TabsContent, TabsList, TabsTrigger, cn, toast } from '../../ui';
import { usePa } from '../pa-context';
import type { PaLibraryTab, TFn } from '../pa-types';
import { paPendingKey } from '../usePaWorkspace';
import { readFileText } from './soul-files';
import { SoulStarterShelf } from './SoulStarterShelf';
import { SoulCharacterGrid, SoulLorebookRows, SoulPersonaRows, SoulPresetRows, libraryTags, useSoulWorldImport } from './SoulLibraryTiles';
import pages from '../PaPages.module.css';
import styles from './SoulLibraryPage.module.css';

const TABS: readonly PaLibraryTab[] = ['characters', 'lorebooks', 'personas', 'presets'];
const SHELF_KEY = 'fantay.pa.library.shelf.v1';
/** Below this workspace width the search moves under the title (spec §6.2 "Widths"). */
const NARROW = 900;

const NEW_KEY: Record<PaLibraryTab, Parameters<TFn>[0]> = {
  characters: 'pa.soul.library.new.character',
  lorebooks: 'pa.soul.library.new.lorebook',
  personas: 'pa.soul.library.new.persona',
  presets: 'pa.soul.library.new.preset',
};

function readShelf(): boolean {
  try {
    return window.localStorage.getItem(SHELF_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeShelf(open: boolean): void {
  try {
    window.localStorage.setItem(SHELF_KEY, open ? '1' : '0');
  } catch {
    /* per-viewer convenience only */
  }
}

export function SoulLibraryPage() {
  const { index, ui, nav, layout, data } = usePa();
  const { t } = useI18n();
  const [shelfOpen, setShelfOpen] = useState(readShelf);
  const worldInput = useRef<HTMLInputElement>(null);
  const importWorld = useSoulWorldImport();

  const tab = ui.libraryTab;
  const query = ui.libraryQuery;
  const tag = ui.libraryTag;
  const narrow = layout.width < NARROW;
  // Enterprise mode: only administrators change characters, world books and styles; personas stay the member's own.
  const manage = index.canManageLibrary;
  // Following an organization server: the library is changed there, and this page says when it was last taken.
  const org = data.snapshot?.org ?? null;
  const orgLine = !org ? '' : org.library.error
    ? t('pa.enterprise.org.failed', { reason: org.library.error })
    : org.library.syncedAt
      ? t('pa.enterprise.org.synced', { time: new Date(org.library.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
      : t('pa.enterprise.org.never');
  const tags = libraryTags(index);
  const activeTag = tag && tags.includes(tag) ? tag : null;
  const filtering = query.trim() !== '' || activeTag !== null;
  const counts: Record<PaLibraryTab, number> = {
    characters: index.agents.size,
    lorebooks: index.lorebooks.size,
    personas: index.personas.size,
    presets: index.presets.size,
  };

  const create = () => {
    if (tab === 'characters') nav.openModal({ kind: 'agent', agentId: null });
    else if (tab === 'lorebooks') nav.openModal({ kind: 'lorebook', lorebookId: null });
    else if (tab === 'personas') nav.openModal({ kind: 'persona', personaId: null });
    else nav.openModal({ kind: 'preset', presetId: null });
  };
  const startImport = () => {
    if (tab === 'lorebooks') worldInput.current?.click();
    else nav.openModal({ kind: 'cardImport' });
  };
  const onWorldFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let world: unknown;
    try {
      const text = await readFileText(file);
      world = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      toast({ tone: 'danger', title: t('pa.soul.library.lore.importFailed') });
      return;
    }
    await importWorld(world, file.name);
  };
  const toggleShelf = () => {
    const next = !shelfOpen;
    setShelfOpen(next);
    writeShelf(next);
  };

  const search = (
    <SearchField
      variant="ring"
      className={styles.search}
      value={query}
      placeholder={t(`pa.soul.library.search.${tab}`)}
      aria-label={t(`pa.soul.library.search.${tab}`)}
      data-testid="pa-library-search"
      onChange={(event) => nav.setLibrary({ query: event.target.value })}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && query) {
          event.stopPropagation();
          nav.setLibrary({ query: '' });
        }
      }}
    />
  );

  return (
    <div className={pages.page} data-testid="pa-library-page" data-narrow={narrow ? '' : undefined}>
      <div className={cn(pages.inner, styles.inner)}>
        <header className={cn(pages.head, styles.head)}>
          <div className={pages.headText}>
            <h1 className={pages.title}>{t('pa.soul.library.title')}</h1>
            {manage ? null : (
              <p className={pages.hint} data-testid="pa-library-managed">
                {org ? t('pa.enterprise.org.managed') : t('pa.enterprise.libraryManaged.hint')}
                {org ? ` ${orgLine}` : null}
              </p>
            )}
          </div>
          <div className={styles.headActions}>
            {narrow ? null : search}
            {org && data.snapshot?.member?.role === 'admin' ? (
              <Button
                variant="secondary"
                loading={data.pending.has(paPendingKey.orgSync())}
                onClick={() =>
                  void data.actions.syncOrg().catch((error: unknown) =>
                    toast({ tone: 'danger', title: error instanceof Error && error.message ? error.message : t('pa.enterprise.org.failed', { reason: '' }) }),
                  )
                }
                data-testid="pa-library-org-sync"
              >
                {t('pa.enterprise.org.sync')}
              </Button>
            ) : null}
            {manage && (tab === 'characters' || tab === 'lorebooks') ? (
              <Button variant="secondary" onClick={startImport} data-testid="pa-library-import">
                {t('pa.soul.library.import')}
              </Button>
            ) : null}
            {manage || tab === 'personas' ? (
              <Button variant="primary" onClick={create} data-testid="pa-library-create">
                <Icon icon={Plus} size="sm" className={styles.buttonIcon} />
                {t(NEW_KEY[tab])}
              </Button>
            ) : null}
          </div>
        </header>
        {narrow ? <div className={styles.searchRow}>{search}</div> : null}

        <Tabs value={tab} onValueChange={(next) => nav.setLibrary({ tab: next as PaLibraryTab })} className={styles.tabs}>
          <TabsList variant="line" size="md" aria-label={t('pa.soul.library.tabs.label')} className={styles.tabList}>
            {TABS.map((id) => (
              <TabsTrigger key={id} value={id} data-testid={`pa-library-tab-${id}`}>
                {t(`pa.soul.library.tabs.${id}`)}
                <span className={styles.tabCount}>{counts[id]}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="characters" className={pages.content}>
            {tags.length > 0 ? (
              <div className={styles.tags} data-testid="pa-library-tags">
                <Chip size="sm" variant="solid" className={styles.tagChip} on={activeTag === null} onClick={() => nav.setLibrary({ tag: null })}>
                  {t('pa.soul.library.tags.all')}
                </Chip>
                {tags.map((value) => (
                  <Chip
                    key={value}
                    size="sm"
                    variant="solid"
                    className={styles.tagChip}
                    on={activeTag === value}
                    aria-pressed={activeTag === value}
                    onClick={() => nav.setLibrary({ tag: activeTag === value ? null : value })}
                  >
                    {value}
                  </Chip>
                ))}
              </div>
            ) : null}
            {filtering || !manage ? null : (
              <section className={styles.section} aria-labelledby="pa-library-shelf">
                <div className={styles.sectionHead}>
                  <h2 id="pa-library-shelf" className={pages.groupTitle}>
                    {t('pa.soul.library.shelf.title')}
                  </h2>
                  <Button variant="link" size="sm" className={styles.shelfToggle} aria-expanded={shelfOpen} onClick={toggleShelf}>
                    {shelfOpen ? t('pa.soul.library.shelf.collapse') : t('pa.soul.library.shelf.expand')}
                  </Button>
                </div>
                {shelfOpen ? <SoulStarterShelf /> : null}
              </section>
            )}
            <section className={styles.section} aria-labelledby="pa-library-mine">
              <div className={styles.sectionHead}>
                <h2 id="pa-library-mine" className={pages.groupTitle}>
                  {t('pa.soul.library.mine')}
                </h2>
              </div>
              <SoulCharacterGrid query={query} tag={activeTag} />
            </section>
          </TabsContent>
          <TabsContent value="lorebooks" className={pages.content}>
            <SoulLorebookRows query={query} onCreate={create} />
          </TabsContent>
          <TabsContent value="personas" className={pages.content}>
            <SoulPersonaRows query={query} onCreate={create} />
          </TabsContent>
          <TabsContent value="presets" className={pages.content}>
            <SoulPresetRows query={query} />
          </TabsContent>
        </Tabs>

        <input
          ref={worldInput}
          type="file"
          accept=".json,application/json"
          className={styles.fileInput}
          tabIndex={-1}
          aria-hidden
          onChange={(event) => void onWorldFile(event)}
        />
      </div>
    </div>
  );
}
