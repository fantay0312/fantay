/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — 一键成稿 actions and the live view of a running production: start, poll
 * (`GET /api/workbench/production`, ~800 ms), cancel, redraw one asset, save to a folder, reveal.
 * The run itself lives in the daemon; the browser only starts it and watches.
 * Derived from dsh-media-desk client/desk.js (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useState } from 'react';
import type {
  WorkbenchAsset,
  WorkbenchAssetTarget,
  WorkbenchProduction,
  WorkbenchProductionLive,
  WorkbenchStatus,
} from '@open-design/contracts';

import { toast } from '../../ui/toast';
import { workbenchApi } from '../api';
import { getWorkbenchSnapshot, reportError, workbench } from '../store';
import { coverDataUrl } from './cover';

type Copy = (zh: string, en: string) => string;

const POLL_MS = 800;

export const isBusy = (asset: Pick<WorkbenchAsset, 'status'> | null | undefined): boolean =>
  asset?.status === 'pending' || asset?.status === 'running';

/** Everything a production draws: cover, figures, shots. */
export function productionAssets(production: WorkbenchProduction | null | undefined): WorkbenchAsset[] {
  if (!production) return [];
  return [...(production.cover ? [production.cover] : []), ...production.images, ...production.shots];
}

/** The streaming plan carries JSON-escaped strings; show them unescaped. */
export function unescapeJson(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

/** Start 一键成稿. Resolves true when the daemon accepted the run. */
export async function startProduction(id: string, withImages: boolean | undefined, L: Copy): Promise<boolean> {
  try {
    const response = await workbenchApi.produce(id, withImages);
    workbench.setState(response.state);
    if (!response.started) toast({ title: L('这条正在成稿，等它做完', 'This one is already being produced') });
    return response.started;
  } catch (error) {
    reportError(error, L('没能开始成稿', 'Could not start production'));
    return false;
  }
}

export async function cancelProduction(id: string, L: Copy): Promise<void> {
  try {
    await workbenchApi.cancelProduce(id);
    toast({ title: L('已取消成稿', 'Production cancelled') });
  } catch (error) {
    reportError(error, L('取消失败', 'Could not cancel'));
  }
}

export async function regenAsset(id: string, target: WorkbenchAssetTarget, L: Copy): Promise<void> {
  try {
    const response = await workbenchApi.regen(id, target);
    workbench.setState(response.state);
  } catch (error) {
    reportError(error, L('没能开始重画', 'Could not redraw'));
  }
}

export async function revealProduction(id: string, L: Copy): Promise<void> {
  try {
    await workbenchApi.reveal(id);
  } catch (error) {
    reportError(error, L('没能打开文件夹', 'Could not open the folder'));
  }
}

/** Save the production as a folder; the video cover is composited here and sent along as a JPEG. */
export async function saveProduction(id: string, production: WorkbenchProduction, L: Copy): Promise<boolean> {
  try {
    const videoCover = await coverDataUrl({ src: production.cover?.src, text: production.coverText || production.title }).catch(() => undefined);
    const response = await workbenchApi.save(id, videoCover);
    workbench.setState(response.state);
    toast({
      title: L('已保存到文件夹', 'Saved to a folder'),
      description: response.path,
      tone: 'success',
      action: { label: L('在访达中显示', 'Show in Finder'), onClick: () => { void revealProduction(id, L); } },
    });
    return true;
  } catch (error) {
    reportError(error, L('保存失败', 'Could not save'));
    return false;
  }
}

/** Replace one item's production in the shared snapshot (polling results). */
function mergeProduction(id: string, production: WorkbenchProduction, status?: WorkbenchStatus): void {
  const state = getWorkbenchSnapshot().state;
  if (!state) return;
  const current = state.items.find(item => item.id === id);
  if (!current) return;
  if (current.production === production && (!status || current.status === status)) return;
  workbench.setState({
    ...state,
    items: state.items.map(item => (item.id === id ? { ...item, production, ...(status ? { status } : {}) } : item)),
  });
}

/**
 * Poll a production while it runs or while any asset is being drawn. Returns the streaming view
 * (text written so far, plan title and shot visuals). When the run ends the full state is reloaded
 * once so undo and derived data catch up.
 */
export function useProductionWatch(id: string | null, watching: boolean): WorkbenchProductionLive | null {
  const [live, setLive] = useState<WorkbenchProductionLive | null>(null);

  useEffect(() => {
    setLive(null);
  }, [id]);

  useEffect(() => {
    if (!id || !watching) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const response = await workbenchApi.production(id, controller.signal);
        if (stopped) return;
        setLive(response.live);
        if (response.production) mergeProduction(id, response.production, response.status);
      } catch {
        // A dropped poll is retried on the next tick.
      }
      if (!stopped) timer = window.setTimeout(() => { void tick(); }, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      void workbench.refresh();
    };
  }, [id, watching]);

  return watching ? live : null;
}
