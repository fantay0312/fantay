import type { MouseEvent, ReactNode } from 'react';
import { useT } from '../i18n';
import { usePageNavigationReady } from '../observability/navigation-timing';
import { buildPath, navigate, type ResourceModule, type Route } from '../router';
import { MaterialsView } from './materials/MaterialsView';
import { McpClientSection } from './McpClientSection';
import { UseEverywhereGuidePanel } from './UseEverywhereModal';
import styles from './ResourceLibraryView.module.css';

interface Props {
  isActive: boolean;
  module: ResourceModule;
  renderSkills: () => ReactNode;
}

function moduleRoute(module: ResourceModule): Route {
  return module === 'materials'
    ? { kind: 'home', view: 'materials' }
    : { kind: 'home', view: 'materials', resourceModule: module };
}

function followModule(event: MouseEvent<HTMLAnchorElement>, module: ResourceModule) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
    || event.altKey || event.shiftKey) return;
  event.preventDefault();
  navigate(moduleRoute(module));
}

export function ResourceLibraryView({ isActive, module, renderSkills }: Props) {
  const t = useT();
  const modules = [
    { id: 'materials', label: t('materials.title') },
    { id: 'skills', label: 'Skill' },
    { id: 'mcp', label: 'MCP' },
    { id: 'tutorials', label: t('resources.tutorials') },
  ] as const;
  const materialActive = isActive && module === 'materials';
  const hasImmediateContent = isActive && (module === 'skills' || module === 'tutorials');
  usePageNavigationReady({
    page: 'materials',
    visible: hasImmediateContent,
    ready: hasImmediateContent,
  });

  const navigation = (
    <nav className={styles.modules} aria-labelledby="resource-library-title">
      {modules.map(({ id, label }) => (
        <a
          key={id}
          className={styles.module}
          href={buildPath(moduleRoute(id))}
          aria-current={module === id ? 'page' : undefined}
          data-testid={`resource-module-${id}`}
          onClick={(event) => followModule(event, id)}
        >
          {label}
        </a>
      ))}
    </nav>
  );

  let moduleContent: ReactNode = null;
  if (isActive && module === 'skills') {
    moduleContent = renderSkills();
  } else if (isActive && module === 'mcp') {
    moduleContent = (
      <div className="integrations-view__panel">
        <McpClientSection navigationPage="materials" />
      </div>
    );
  } else if (isActive && module === 'tutorials') {
    moduleContent = (
      <section className={styles.guide} aria-labelledby="resource-guide-title">
        <h2 id="resource-guide-title">{t('entry.useEverywhereTitle')}</h2>
        <div className="integrations-view__use-everywhere">
          <UseEverywhereGuidePanel
            onOpenSettings={() => navigate(moduleRoute('mcp'))}
            daemonUrl={typeof window === 'undefined' ? undefined : window.location.origin}
          />
        </div>
      </section>
    );
  }

  return (
    <MaterialsView
      isActive={materialActive}
      renderLayout={({ inventory, controls, gallery }) => (
        <section className={styles.root} aria-labelledby="resource-library-title" data-testid="resource-library">
          <header className={styles.header}>
            <div>
              <h1 id="resource-library-title" className="entry-section__title">{t('entry.navMaterials')}</h1>
              {materialActive ? inventory : null}
            </div>
            {controls}
          </header>
          {navigation}
          {gallery}
          {moduleContent}
        </section>
      )}
    />
  );
}
