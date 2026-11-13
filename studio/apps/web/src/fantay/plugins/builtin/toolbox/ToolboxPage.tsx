// SPDX-License-Identifier: AGPL-3.0-only
// The 工具台 page. Its tools are the entries of the `fantay.toolbox.tool` slot, which the page's sidebar entry
// declares: the built-in tools and any plugin's tools are listed the same way. Each entry gives `id`, `order`,
// `label` (string or thunk), optional `description` and `icon` (a component taking `{ size }`), and its
// component is the tool's panel, drawn with `ToolboxToolProps` inside its own error boundary.
//
// The tools are tabs. In a wide column they are a tray of rows beside the open tool; in a narrow one the same
// tabs become one full-width row of equal segments above it, wrapping instead of hiding any. The page measures
// its column and flips the tabs' orientation, so the arrow keys follow what is on screen. A tool once opened
// stays mounted (hidden) while you look at another, so its input survives the switch.
import { useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Toolbox, Wrench } from 'lucide-react';

import { Button, EmptyState, Icon, Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui';
import { PluginBoundary, usePluginUiVersion, useSlotEntries } from '../../react';
import type { SlotEntry } from '../../slots';
import type { ToolPluginPageProps } from '../../types';
import type { Translate } from './dictionary';
import styles from './ToolboxPage.module.css';

/** The extension point: a `list` slot that exists while the 工具台 page does. */
export const TOOLBOX_TOOL_SLOT = 'fantay.toolbox.tool';

/** What a tool panel registered into `fantay.toolbox.tool` receives. */
export interface ToolboxToolProps {
  /** The entry's `id`. */
  toolId: string;
}

type GlyphProps = { size?: number };
type Glyph = ComponentType<GlyphProps>;

interface ToolItem {
  /** Stable across a plugin reload: the owner and the entry id. Also the tab value. */
  key: string;
  uid: number;
  toolId: string;
  label: string;
  description?: string;
  icon?: Glyph;
  panel: ComponentType<ToolboxToolProps>;
}

/** Below this column width the tools stand in a row above the open tool instead of beside it. */
const NARROW_BELOW = 680;

function text(value: unknown): string | undefined {
  try {
    const resolved: unknown = typeof value === 'function' ? (value as () => unknown)() : value;
    return typeof resolved === 'string' && resolved ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isComponent(value: unknown): value is Glyph {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value);
}

function toolItems(entries: readonly SlotEntry[]): ToolItem[] {
  const seen = new Set<string>();
  const tools: ToolItem[] = [];
  for (const entry of entries) {
    const toolId = entry.options.id;
    if (typeof toolId !== 'string' || !toolId) continue;
    const key = `${encodeURIComponent(entry.owner ?? 'fantay')}.${encodeURIComponent(toolId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push({
      key,
      uid: entry.uid,
      toolId,
      label: text(entry.options.label) ?? toolId,
      description: text(entry.options.description),
      icon: isComponent(entry.options.icon) ? entry.options.icon : undefined,
      panel: entry.component,
    });
  }
  return tools;
}

/**
 * The sidebar glyph. FeatureIcon rows draw about 17px of ink in their 15px slot; a Lucide glyph reaches the same
 * weight at 4/3 of the slot, and negative margins keep it to the slot so the label stays in its column.
 */
export function ToolboxNavIcon({ size = 15 }: GlyphProps) {
  const drawn = Math.round((size * 4) / 3);
  return <Icon icon={Toolbox} size={drawn} style={{ margin: (size - drawn) / 2 }} />;
}

function ToolGlyph({ icon: Custom, size, resetKey }: { icon?: Glyph; size: number; resetKey: string }) {
  const fallback = <Icon icon={Wrench} size={size} />;
  if (!Custom) return fallback;
  return (
    <PluginBoundary resetKey={resetKey} fallback={fallback}>
      <Custom size={size} />
    </PluginBoundary>
  );
}

function ToolPanel({ tool, t }: { tool: ToolItem; t: Translate }) {
  const [attempt, setAttempt] = useState(0);
  const Panel = tool.panel;
  return (
    <PluginBoundary
      resetKey={`${tool.key}#${attempt}`}
      fallback={(
        <EmptyState
          variant="dashed"
          title={t('toolFailed')}
          description={t('toolFailedHint')}
          action={(
            <Button variant="secondary" onClick={() => setAttempt((count) => count + 1)}>
              {t('retry')}
            </Button>
          )}
        />
      )}
    >
      <Panel toolId={tool.toolId} />
    </PluginBoundary>
  );
}

export function createToolboxPage(t: Translate): ComponentType<ToolPluginPageProps> {
  // The tool last opened, kept while the plugin is on, so the page reopens on it.
  let remembered: string | null = null;

  function ToolboxPage(_props: ToolPluginPageProps) {
    // Labels are thunks that read the plugin language: re-resolve them whenever plugin UI changes.
    const version = usePluginUiVersion();
    const entries = useSlotEntries(TOOLBOX_TOOL_SLOT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const tools = useMemo(() => toolItems(entries), [entries, version]);
    const [chosen, setChosen] = useState<string | null>(remembered);
    const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
    const [narrow, setNarrow] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);

    const active = tools.find((tool) => tool.key === chosen) ?? tools[0];
    const activeKey = active?.key ?? '';
    const hasTools = tools.length > 0;

    // Measured before paint, so a narrow window never shows the wide layout for a frame.
    useLayoutEffect(() => {
      const element = bodyRef.current;
      if (!element) return undefined;
      const measure = (width: number) => setNarrow(width < NARROW_BELOW);
      measure(element.getBoundingClientRect().width);
      if (typeof ResizeObserver === 'undefined') return undefined;
      const observer = new ResizeObserver(([entry]) => {
        if (entry) measure(entry.contentRect.width);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }, [hasTools]);

    const choose = (key: string) => {
      remembered = key;
      setChosen(key);
      setOpened((previous) => {
        const next = new Set(previous).add(key);
        if (activeKey) next.add(activeKey);
        return next;
      });
    };

    return (
      <div className={styles.page} data-testid="toolbox-page">
        <div className={styles.inner}>
          <header className={styles.head}>
            <h1 className={styles.title}>{t('title')}</h1>
            <p className={styles.hint}>{t('subtitle')}</p>
          </header>

          {hasTools ? (
            <Tabs
              ref={bodyRef}
              className={styles.body}
              data-layout={narrow ? 'row' : 'column'}
              orientation={narrow ? 'horizontal' : 'vertical'}
              value={activeKey}
              onValueChange={choose}
            >
              <TabsList className={styles.picker} aria-label={t('tools')} data-testid="toolbox-tools">
                {tools.map((tool) => (
                  <TabsTrigger
                    key={tool.uid}
                    value={tool.key}
                    className={styles.pick}
                    data-testid={`toolbox-tool-${tool.toolId}`}
                  >
                    <span className={styles.pickIcon}>
                      <ToolGlyph icon={tool.icon} size={narrow ? 14 : 16} resetKey={tool.key} />
                    </span>
                    <span className={styles.pickText}>
                      <span className={styles.pickLabel}>{tool.label}</span>
                      {tool.description ? <span className={styles.pickHint}>{tool.description}</span> : null}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>

              <div className={styles.panels}>
                {tools.map((tool) =>
                  tool.key === activeKey || opened.has(tool.key) ? (
                    <TabsContent
                      key={tool.uid}
                      value={tool.key}
                      forceMount
                      hidden={tool.key !== activeKey}
                      className={styles.panel}
                    >
                      <header className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>{tool.label}</h2>
                        {tool.description ? <p className={styles.panelHint}>{tool.description}</p> : null}
                      </header>
                      <ToolPanel tool={tool} t={t} />
                    </TabsContent>
                  ) : null,
                )}
              </div>
            </Tabs>
          ) : (
            <EmptyState variant="dashed" title={t('emptyTitle')} description={t('emptyHint')} />
          )}
        </div>
      </div>
    );
  }

  return ToolboxPage;
}
