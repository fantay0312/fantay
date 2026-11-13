'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// /fantay-ui/pa-lab: a bench for the Fantay workspace. It renders the production PersonalAgentWorkspace over an
// in-memory fixture transport, so every scenario, theme, locale, frame width and inspector tab can be judged in place.
// URL params ?scenario=&theme=&locale=&width=&tab= drive the controls (for Playwright). Two state knobs have no
// control: &latency=<ms> holds the first-load state, &stale=1 fails every read after 1.5 s (the stale callout).
// Linked from nowhere.
import { useEffect, useMemo, useState } from 'react';

import { useI18n, type Locale } from '../../../i18n';
import { ThemeSegmented } from '../../theme/ThemeSegmented';
import { useTheme } from '../../theme/theme';
import { FxRoot, Segmented, SegmentedItem, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '../../ui';
import type { PaInspectorTab } from '../pa-types';
import { PaTransportProvider } from '../pa-transport';
import { PersonalAgentWorkspace } from '../PersonalAgentWorkspace';
import { createFixtureTransport } from './fixture-transport';
import { PA_SCENARIO_IDS, buildFixture, isPaScenario, type PaScenarioId } from './fixtures';
import styles from './PaLab.module.css';

const WIDTHS = ['1192', '1032', '860', '700'] as const;
const TABS: readonly PaInspectorTab[] = ['activity', 'approvals', 'profile'];
const LOCALES: readonly Locale[] = ['zh-CN', 'en'];
const TAB_LABEL: Record<PaInspectorTab, string> = { activity: 'activity', approvals: 'approvals', profile: 'profile' };

function params(): URLSearchParams {
  return new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
}

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

export function PaLab() {
  const { locale, setLocale } = useI18n();
  const { preference, setPreference } = useTheme();
  const [scenario, setScenario] = useState<PaScenarioId>(() => {
    const value = params().get('scenario');
    return isPaScenario(value) ? value : 'fantay-chat';
  });
  const [width, setWidth] = useState<(typeof WIDTHS)[number]>(() => pick(params().get('width'), WIDTHS, '1192'));
  const [tab, setTab] = useState<PaInspectorTab>(() => pick(params().get('tab'), TABS, 'activity'));

  // Apply theme and locale from the URL once. The query is captured at first render: the URL-sync effect
  // below rewrites it, and a development double-run of this effect must not read the rewritten values.
  const [initialQuery] = useState(params);
  useEffect(() => {
    const query = initialQuery;
    const theme = query.get('theme');
    if (theme === 'light' || theme === 'dark') setPreference(theme);
    else if (theme === 'system') setPreference('light');
    const wanted = query.get('locale');
    if (wanted && (LOCALES as readonly string[]).includes(wanted)) setLocale(wanted as Locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL in step with the controls.
  useEffect(() => {
    const query = params();
    query.set('scenario', scenario);
    query.set('width', width);
    query.set('tab', tab);
    query.set('theme', preference);
    query.set('locale', locale);
    window.history.replaceState(null, '', `${window.location.pathname}?${query.toString()}`);
  }, [scenario, width, tab, preference, locale]);

  // A fresh fixture and transport per scenario, so state from one never leaks into the next.
  const { fixture, transport } = useMemo(() => {
    const built = buildFixture(scenario);
    const latency = Number(initialQuery.get('latency'));
    return {
      fixture: built,
      transport: createFixtureTransport(built, {
        ...(Number.isFinite(latency) && latency > 0 ? { latency } : {}),
        ...(initialQuery.get('stale') === '1' ? { failAfterMs: 1500 } : {}),
      }),
    };
  }, [initialQuery, scenario]);
  const initialState = useMemo(() => ({ ...fixture.ui, inspectorTab: tab }), [fixture, tab]);

  return (
    <FxRoot className={`${styles.page} min-h-screen bg-paper`} data-testid="pa-lab">
      <header className={styles.toolbar}>
        <Select value={scenario} onValueChange={(next) => isPaScenario(next) && setScenario(next)}>
          <SelectTrigger size="sm" aria-label="Scenario" className={styles.scenario} data-testid="pa-lab-scenario">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PA_SCENARIO_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ThemeSegmented size="sm" />
        <Segmented size="sm" aria-label="Locale" value={locale} onValueChange={(next) => setLocale(next as Locale)}>
          {LOCALES.map((value) => (
            <SegmentedItem key={value} value={value}>
              {value === 'zh-CN' ? '中文' : 'English'}
            </SegmentedItem>
          ))}
        </Segmented>
        <Segmented size="sm" aria-label="Frame width" value={width} onValueChange={(next) => setWidth(next as (typeof WIDTHS)[number])}>
          {WIDTHS.map((value) => (
            <SegmentedItem key={value} value={value}>
              {value}
            </SegmentedItem>
          ))}
        </Segmented>
        <Segmented size="sm" aria-label="Inspector tab" value={tab} onValueChange={(next) => setTab(next as PaInspectorTab)}>
          {TABS.map((value) => (
            <SegmentedItem key={value} value={value}>
              {TAB_LABEL[value]}
            </SegmentedItem>
          ))}
        </Segmented>
      </header>
      <div className={styles.stage}>
        <div className={styles.frame} style={{ width: Number(width) }} data-testid="pa-lab-frame">
          <PaTransportProvider transport={transport}>
            <PersonalAgentWorkspace
              key={`${scenario}:${tab}`}
              active
              onOpenProject={(id, file) => toast({ title: `open ${id} ${file ?? ''}`.trim() })}
              projects={fixture.projects}
              initialState={initialState}
            />
          </PaTransportProvider>
        </div>
      </div>
    </FxRoot>
  );
}
