// SPDX-License-Identifier: AGPL-3.0-only
// Web side of the desktop chrome (spec 02 §10.6): native menu commands reach the web command registry,
// the native menu is relabelled in the current locale, and on Windows the title-bar overlay is recoloured
// from the live tokens. Every host call goes through the feature-detecting wrappers of `@open-design/host`,
// so a browser or an older desktop build is a no-op.
import { useEffect, useRef, type RefObject } from 'react';
import {
  setHostMenuLabels,
  setHostTitleBarOverlay,
  subscribeHostMenuCommands,
  type OpenDesignHostMenuCommand,
  type OpenDesignHostMenuLabels,
} from '@open-design/host';

import type { Dict } from '../../i18n/types';
import { toast } from '../ui/toast';
import { runFantayCommand } from './commands';
import { SHELL_TOP_ROW_HEIGHT, type FantayClientType } from './geometry';

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

/** The native menu labels from the `fantayMenu.*` keys. */
export function buildFantayMenuLabels(t: Translate): OpenDesignHostMenuLabels {
  return {
    file: t('fantayMenu.file'),
    newProject: t('fantayMenu.newProject'),
    newChat: t('fantayMenu.newChat'),
    importDesign: t('fantayMenu.importDesign'),
    settings: t('fantayMenu.settings'),
    toggleSidebar: t('fantayMenu.toggleSidebar'),
    zoomIn: t('fantayMenu.zoomIn'),
    zoomOut: t('fantayMenu.zoomOut'),
    zoomFit: t('fantayMenu.zoomFit'),
    zoom100: t('fantayMenu.zoom100'),
  };
}

export type MappedHostMenuCommand =
  | readonly ['fantay.board.zoomTo', { zoom: number }]
  | readonly [Exclude<OpenDesignHostMenuCommand, 'fantay.board.zoom100'>];

/** `fantay.board.zoom100` → `['fantay.board.zoomTo', { zoom: 1 }]`; every other command maps to itself. */
export function mapHostMenuCommand(command: OpenDesignHostMenuCommand): MappedHostMenuCommand {
  if (command === 'fantay.board.zoom100') return ['fantay.board.zoomTo', { zoom: 1 }] as const;
  return [command] as const;
}

/** Dispatches a native menu command; true when a web handler ran. Unhandled `fantay.board.*` stay silent. */
export function runHostMenuCommand(command: OpenDesignHostMenuCommand): boolean {
  const mapped = mapHostMenuCommand(command);
  if (mapped[0] === 'fantay.board.zoomTo') return runFantayCommand('fantay.board.zoomTo', mapped[1]);
  return runFantayCommand(mapped[0]);
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function hexByte(value: number): string {
  return clampChannel(value).toString(16).padStart(2, '0');
}

function parseRgbChannel(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.endsWith('%')) {
    const percent = Number.parseFloat(text.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * 255 : null;
  }
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

function parseUnitChannel(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.endsWith('%')) {
    const percent = Number.parseFloat(text.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * 255 : null;
  }
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value * 255 : null;
}

function channelsToHex(channels: ReadonlyArray<number | null>): string | null {
  if (channels.length < 3) return null;
  const [r, g, b] = channels;
  if (r == null || g == null || b == null) return null;
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

/**
 * `#rgb`, `#rrggbb`, `rgb()` / `rgba()` (comma or space syntax, alpha dropped) and `color(srgb r g b[ / a])`
 * → `#rrggbb` (lowercase), else null. The Windows title-bar overlay only takes opaque `#rrggbb`.
 */
export function resolveCssColorToHex(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase();
  if (!text) return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = /^rgba?\(([^)]*)\)$/.exec(text);
  if (rgb) {
    const body = (rgb[1] ?? '').split('/')[0] ?? '';
    const parts = body.includes(',') ? body.split(',') : body.trim().split(/\s+/);
    return channelsToHex(parts.slice(0, 3).map(parseRgbChannel));
  }
  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/.exec(text);
  if (srgb) {
    const body = (srgb[1] ?? '').split('/')[0] ?? '';
    return channelsToHex(body.trim().split(/\s+/).slice(0, 3).map(parseUnitChannel));
  }
  return null;
}

/** Resolves a custom property to its computed colour by painting a hidden probe inside `container`. */
export function probeCssColor(container: HTMLElement, variable: string): string {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.setAttribute('data-fx-probe', variable);
  probe.style.cssText = `position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;color:var(${variable})`;
  container.appendChild(probe);
  try {
    return window.getComputedStyle(probe).color;
  } finally {
    probe.remove();
  }
}

export interface DesktopShellChromeInput {
  clientType: FantayClientType;
  hostPlatform: string | undefined;
  rootRef: RefObject<HTMLElement | null>;
  locale: string;
  t: Translate;
}

export function useDesktopShellChrome({ clientType, hostPlatform, rootRef, locale, t }: DesktopShellChromeInput): void {
  const tRef = useRef(t);
  tRef.current = t;

  // Native menu → web command registry.
  useEffect(() => {
    if (clientType !== 'desktop') return undefined;
    return subscribeHostMenuCommands((command) => {
      const handled = runHostMenuCommand(command);
      if (!handled && command === 'fantay.design.import') {
        toast({ title: tRef.current('fantayShell.command.unavailable') });
      }
    });
  }, [clientType]);

  // Native menu labels follow the UI locale.
  useEffect(() => {
    if (clientType !== 'desktop') return;
    void setHostMenuLabels(buildFantayMenuLabels(tRef.current));
  }, [clientType, locale]);

  // Windows: recolour the caption-button overlay from --paper / --ink-soft whenever the theme repaints.
  useEffect(() => {
    if (clientType !== 'desktop' || hostPlatform !== 'win32') return undefined;
    const root = rootRef.current;
    if (!root || typeof MutationObserver === 'undefined') return undefined;
    let lastPayload = '';
    const sync = () => {
      const color = resolveCssColorToHex(probeCssColor(root, '--paper'));
      const symbolColor = resolveCssColorToHex(probeCssColor(root, '--ink-soft'));
      if (!color || !symbolColor) return;
      const payload = `${color}|${symbolColor}`;
      if (payload === lastPayload) return;
      lastPayload = payload;
      void setHostTitleBarOverlay({ color, symbolColor, height: SHELL_TOP_ROW_HEIGHT });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => observer.disconnect();
  }, [clientType, hostPlatform, rootRef]);
}
