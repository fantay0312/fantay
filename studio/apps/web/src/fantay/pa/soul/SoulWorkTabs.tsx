// SPDX-License-Identifier: AGPL-3.0-only
// 工作: one line-tab strip over the tasks and activity pages (Soul UI spec §6.3). 任务 is its own place; 动态, 目标
// and 例行 are the activity place's three panes. All four tabs are inline; the needs-you count rides on 任务.
import { useT } from '../../../i18n';
import { Tabs, TabsList, TabsTrigger, VisuallyHidden, cn } from '../../ui';
import { usePa } from '../pa-context';
import type { PaActivityTab } from '../pa-types';
import styles from './SoulWorkTabs.module.css';
import shell from './SoulShell.module.css';

type WorkTab = 'tasks' | PaActivityTab;

const TABS: ReadonlyArray<{ value: WorkTab; label: 'pa.soul.shell.work.tasks' | 'pa.soul.shell.work.activity' | 'pa.soul.shell.work.goals' | 'pa.soul.shell.work.routines' }> = [
  { value: 'tasks', label: 'pa.soul.shell.work.tasks' },
  { value: 'activity', label: 'pa.soul.shell.work.activity' },
  { value: 'goals', label: 'pa.soul.shell.work.goals' },
  { value: 'routines', label: 'pa.soul.shell.work.routines' },
];

export function SoulWorkTabs() {
  const t = useT();
  const { ui, nav, index } = usePa();
  const value: WorkTab = ui.place === 'tasks' ? 'tasks' : ui.activityTab ?? 'activity';
  const needs = index.needs.length;
  const open = (next: string) => {
    if (next === 'tasks') nav.openPlace('tasks');
    else if (next === 'activity' || next === 'goals' || next === 'routines') nav.openPlace('activity', { activityTab: next });
  };
  return (
    <Tabs value={value} onValueChange={open} className={styles.tabs}>
      <TabsList variant="line" size="md" aria-label={t('pa.soul.shell.work.tabs')} className={styles.list} data-testid="pa-work-tabs">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} data-testid={`pa-work-tab-${tab.value}`} className={styles.trigger}>
            {t(tab.label)}
            {tab.value === 'tasks' && needs > 0 ? (
              <>
                <span aria-hidden className={cn(shell.needsPill, styles.pill)}>
                  {needs}
                </span>
                <VisuallyHidden>{t('pa.soul.shell.bar.needs', { count: needs })}</VisuallyHidden>
              </>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
