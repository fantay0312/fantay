// fx-governance-allow-raw: a gallery tile is a whole card, which no button primitive models
// SPDX-License-Identifier: AGPL-3.0-only
// The template gallery under the Home composer. Twelve real templates from the installed catalogue, a few of each
// kind, opening the same preview modal as Home's template chips; 查看全部 leads to the community page.
import { useMemo, type CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import type { InstalledPluginRecord } from '@open-design/contracts';

import { useWorkspaceContext } from '../../collab/useWorkspaceContext';
import { buildCommunityTemplates } from '../../components/CommunityTemplatePreview';
import { TemplateThumb } from '../../components/CommunityView';
import { useI18n } from '../../i18n';
import { navigate } from '../../router';
import styles from './FantayHomeShowcase.module.css';

/** Divides evenly into the 2, 3 and 4 columns the grid wraps to, so no width leaves an orphan row. */
const SHOWCASE_SIZE = 12;

/** Catalogue entries that read badly as a front-page tile: a real person's likeness, an all-black first frame. */
const SHOWCASE_SKIPPED: ReadonlySet<string> = new Set([
  'image-template-e-commerce-live-stream-ui-mockup',
  'video-template-character-intro-motion-graphics-sequence',
]);

type Template = ReturnType<typeof buildCommunityTemplates>[number];

/** Takes templates with artwork round-robin across their kinds: the grid shows the range, not twelve of one kind. */
function pickShowcase(templates: readonly Template[]): Template[] {
  const byType = new Map<string, Template[]>();
  for (const template of templates) {
    if (!template.cardMedia?.poster || SHOWCASE_SKIPPED.has(template.id)) continue;
    const bucket = byType.get(template.type);
    if (bucket) bucket.push(template);
    else byType.set(template.type, [template]);
  }
  const buckets = [...byType.values()];
  const picked: Template[] = [];
  for (let round = 0; picked.length < SHOWCASE_SIZE && buckets.some((bucket) => round < bucket.length); round += 1) {
    for (const bucket of buckets) {
      const template = bucket[round];
      if (template && picked.length < SHOWCASE_SIZE) picked.push(template);
    }
  }
  return picked;
}

export interface FantayHomeShowcaseProps {
  plugins: InstalledPluginRecord[];
  onOpen(record: InstalledPluginRecord): void;
}

export function FantayHomeShowcase({ plugins, onOpen }: FantayHomeShowcaseProps) {
  const { locale, t } = useI18n();
  const { context: workspaceContext } = useWorkspaceContext();
  const templates = useMemo(
    () => pickShowcase(buildCommunityTemplates(plugins, locale, t, workspaceContext)),
    [plugins, locale, t, workspaceContext],
  );
  if (templates.length === 0) return null;
  return (
    <section className={styles.root} aria-labelledby="fantay-home-showcase-title" data-testid="fantay-home-showcase">
      <header className={styles.head}>
        <h2 id="fantay-home-showcase-title" className={styles.title}>
          {t('fantayHome.showcase.title')}
        </h2>
        <button type="button" className={styles.all} onClick={() => navigate({ kind: 'home', view: 'community' })}>
          {t('recentProjects.viewAll')}
          <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </header>
      <div className={styles.grid}>
        {templates.map((template) => {
          const record = plugins.find((entry) => entry.id === template.id);
          return (
            <button
              key={template.id}
              type="button"
              className={styles.tile}
              data-testid={`fantay-home-showcase-${template.id}`}
              onClick={() => (record ? onOpen(record) : undefined)}
            >
              <span
                className={`community-template-card__preview${template.type === 'Slides' ? ' is-deck' : ''} ${styles.plate}`}
                style={{ '--template-accent': template.accent } as CSSProperties}
                aria-hidden
              >
                <TemplateThumb template={template} />
              </span>
              <span className={styles.name}>{template.title}</span>
              <span className={styles.meta}>{template.meta}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
