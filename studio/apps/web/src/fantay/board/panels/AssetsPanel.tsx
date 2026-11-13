// fx-governance-allow-raw: the create tiles are dashed cards and 使用 sits on a hover row, which no Button variant models
'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// 我的素材: the user's own things across projects. 品牌套件 are the existing brands (a brand is a design system, so using
// one switches this project's design system); 角色 / 产品 / 自定义 are user assets the board copies into the project
// when they are placed. The brand extraction opens its own project, exactly like the Brands page.
import { Plus, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { BrandSummary, UserAsset, UserAssetKind } from '@open-design/contracts';

import { BrandLogo, hostnameOf } from '../../../components/BrandPreviewCard';
import { NewBrandModal } from '../../../components/NewBrandModal';
import { useT } from '../../../i18n';
import { fetchUserAssets } from '../../../providers/user-assets';
import { navigate } from '../../../router';
import { fetchBrands } from '../../../runtime/brands';
import { runProjectCommand, useActiveProjectSession } from '../../shell/project-bridge';
import { IconButton } from '../../ui/icon-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs';
import { useBoardHost } from '../context';
import type { DictKey } from '../model/types';
import { AssetEditorDialog, CREATE_LABEL } from './AssetEditorDialog';
import { writePanelDrag } from './panel-drag';
import { usePanelActions } from './use-panel-actions';
import styles from './panels.module.css';

const TABS: ReadonlyArray<{ id: 'brand' | UserAssetKind; key: DictKey }> = [
  { id: 'brand', key: 'board.assets.tabBrand' },
  { id: 'character', key: 'board.assets.tabCharacter' },
  { id: 'product', key: 'board.assets.tabProduct' },
  { id: 'custom', key: 'board.assets.tabCustom' },
];

function BrandList({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const { env } = useBoardHost();
  const session = useActiveProjectSession(env.projectId);
  const [brands, setBrands] = useState<readonly BrandSummary[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchBrands().then((next) => {
      if (live) setBrands(next);
    });
    return () => {
      live = false;
    };
  }, [creating]);

  return (
    <>
      <button type="button" className={styles.create} disabled={readOnly} data-testid="board-assets-create-brand" onClick={() => setCreating(true)}>
        <Plus strokeWidth={1.5} />
        {t('board.assets.createBrand')}
      </button>
      <ul className={styles.brandList}>
        {brands.map((summary) => {
          const designSystemId = summary.meta.designSystemId ?? null;
          const inUse = designSystemId !== null && session?.designSystemId === designSystemId;
          const name = summary.brand?.name || hostnameOf(summary.meta.sourceUrl);
          return (
            <li key={summary.meta.id} className={styles.brand} data-testid="board-assets-brand">
              <BrandLogo brandId={summary.meta.id} host={hostnameOf(summary.meta.sourceUrl)} name={name} faviconSize={32} className={styles.brandLogo} />
              <div className={styles.brandBody}>
                <p className={styles.cardTitle} title={name}>{name}</p>
                <div className={styles.swatches} aria-hidden>
                  {summary.brand?.colors.slice(0, 6).map((color) => <span key={color.role} style={{ background: color.hex }} />)}
                </div>
              </div>
              {designSystemId ? (
                inUse ? <span className={styles.brandState}>{t('board.assets.brandInUse')}</span> : (
                  <button
                    type="button"
                    className={styles.brandUse}
                    disabled={readOnly}
                    onClick={() => runProjectCommand(env.projectId, { kind: 'changeDesignSystem', designSystemId })}
                  >
                    {t('board.assets.useBrand')}
                  </button>
                )
              ) : <span className={styles.brandState}>{t('board.assets.brandPending')}</span>}
            </li>
          );
        })}
      </ul>
      <NewBrandModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(_brandId, projectId, conversationId) => {
          setCreating(false);
          navigate({ kind: 'project', projectId, fileName: null, conversationId });
        }}
      />
    </>
  );
}

function AssetList({ kind, readOnly }: { kind: UserAssetKind; readOnly: boolean }) {
  const t = useT();
  const actions = usePanelActions();
  const [assets, setAssets] = useState<readonly UserAsset[]>([]);
  const [editing, setEditing] = useState<{ kind: UserAssetKind; asset: UserAsset | null } | null>(null);

  const load = useCallback(() => {
    void fetchUserAssets(kind).then(setAssets, () => setAssets([]));
  }, [kind]);
  useEffect(load, [load]);

  return (
    <>
      <button
        type="button"
        className={styles.create}
        data-testid={`board-assets-create-${kind}`}
        onClick={() => setEditing({ kind, asset: null })}
      >
        <Plus strokeWidth={1.5} />
        {t(CREATE_LABEL[kind])}
      </button>
      <ul className={styles.grid}>
        {assets.map((asset) => {
          const cover = asset.files.find((file) => file.mime.startsWith('image/'));
          return (
            <li key={asset.id} className={styles.card} data-testid="board-assets-card">
              <div
                className={styles.thumb}
                draggable={!readOnly}
                onDragStart={(event) => writePanelDrag(event.dataTransfer, { kind: 'asset', id: asset.id }, asset.name)}
                onClick={() => setEditing({ kind, asset })}
              >
                {cover ? <img className={styles.cover} src={cover.url} alt="" loading="lazy" draggable={false} /> : <div className={styles.glyph}>{asset.name.slice(0, 1)}</div>}
                {readOnly ? null : (
                  <div className={styles.overlay} onClick={(event) => event.stopPropagation()}>
                    <IconButton size="sm" variant="frosted" aria-label={t('board.refs.place')} onClick={() => void actions.placeAsset(asset.id)}>
                      <Plus strokeWidth={1.5} />
                    </IconButton>
                    {actions.generatorId ? (
                      <IconButton
                        size="sm"
                        variant="frosted"
                        aria-label={t('board.refs.useReference')}
                        onClick={() => void actions.placeAsset(asset.id).then(actions.connectToGenerator)}
                      >
                        <Sparkles strokeWidth={1.5} />
                      </IconButton>
                    ) : null}
                  </div>
                )}
              </div>
              <p className={styles.cardTitle} title={asset.name}>{asset.name}</p>
              <p className={styles.cardMeta}>{t('board.assets.fileCount', { count: asset.files.length })}</p>
            </li>
          );
        })}
      </ul>
      <AssetEditorDialog target={editing} onClose={() => setEditing(null)} onChanged={load} />
    </>
  );
}

export function AssetsPanel({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  return (
    <>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('board.panel.assets')}</h2>
      </header>
      <Tabs defaultValue="brand" className={styles.tabs}>
        <TabsList variant="line" size="sm">
          {TABS.map((tab) => <TabsTrigger key={tab.id} value={tab.id} data-testid={`board-assets-tab-${tab.id}`}>{t(tab.key)}</TabsTrigger>)}
        </TabsList>
        {TABS.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className={styles.tabBody}>
            {tab.id === 'brand' ? <BrandList readOnly={readOnly} /> : <AssetList kind={tab.id} readOnly={readOnly} />}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
