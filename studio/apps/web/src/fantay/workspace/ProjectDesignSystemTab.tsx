// SPDX-License-Identifier: AGPL-3.0-only
// 设计系统 root for projects that are not design systems themselves (spec 02 §7.8, tab id
// `__project_design_system__`). Reads the live project session (ProjectView bridge) for the chosen design
// system, the catalogue and read-only state; switching runs ProjectView's own handler through
// `runProjectCommand`. The loaded system renders the upstream DesignSystemStudio read-only (FxLegacy).
import { ChevronDown, ExternalLink, Palette, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DesignSystemDetail, DesignSystemSummary, WorkspaceCollabContext } from '@open-design/contracts';

import { useProjectCollabContext } from '../../collab/collab-context';
import { workspaceIdentityCacheKey } from '../../collab/workspace-identity';
import { DesignSystemStudio } from '../../components/DesignSystemStudio';
import { useT } from '../../i18n';
import { fetchDesignSystem, fetchDesignSystemsResult } from '../../providers/registry';
import { navigate } from '../../router';
import { setDesignSystemFocus } from '../../runtime/brands';
import { useDesignKit } from '../../runtime/design-kit';
import { runProjectCommand, useActiveProjectSession } from '../shell/project-bridge';
import {
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  EmptyState,
  Icon,
  cn,
} from '../ui';
import { SystemEmptyDemo } from '../stageshow';
import { WorkspaceLoader } from './WorkspaceLoader';

const SWATCH_LIMIT = 4;

/** Up to four colour dots. `backgroundColor` only: a catalogue value is never a url(). */
function Swatches({ colors, className }: { colors: readonly string[] | undefined; className?: string }) {
  const list = (colors ?? []).filter((color) => typeof color === 'string' && color.trim() !== '').slice(0, SWATCH_LIMIT);
  if (list.length === 0) return null;
  return (
    <span aria-hidden data-slot="ds-swatches" className={cn('flex flex-none items-center gap-0.5', className)}>
      {list.map((color, index) => (
        <span key={`${index}-${color}`} className="size-3 rounded-full shadow-ring" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

interface DesignSystemChooserProps {
  projectId: string;
  designSystems: readonly DesignSystemSummary[];
  workspaceContext: WorkspaceCollabContext | null;
  currentId: string | null;
  readOnly: boolean;
  label: string;
  variant: 'primary' | 'default';
  'data-testid': string;
}

/** The catalogue as a radio menu (title + swatches); choosing runs ProjectView's design-system change. */
function DesignSystemChooser({
  projectId,
  designSystems,
  workspaceContext,
  currentId,
  readOnly,
  label,
  variant,
  'data-testid': testId,
}: DesignSystemChooserProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fallbackState, setFallbackState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    items: readonly DesignSystemSummary[];
  }>({ status: 'idle', items: [] });

  const items = designSystems.length > 0 ? designSystems : fallbackState.items;

  useEffect(() => {
    if (!open || designSystems.length > 0) return undefined;
    let cancelled = false;
    setFallbackState((prev) => ({ status: 'loading', items: prev.items }));
    void fetchDesignSystemsResult(workspaceContext).then((result) => {
      if (cancelled) return;
      if (result.ok && result.designSystems.length > 0) {
        setFallbackState({ status: 'ready', items: result.designSystems });
      } else {
        setFallbackState({ status: 'error', items: [] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, designSystems.length, workspaceContext, attempt]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={readOnly}>
        <Button
          variant={variant}
          size="sm"
          data-testid={testId}
          disabled={readOnly}
          disabledReason={readOnly ? t('fantayShell.ds.readOnly') : undefined}
        >
          {label}
          <Icon icon={ChevronDown} size="xs" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width="lg" data-testid="fantay-project-ds-menu">
        {items.length === 0 ? (
          fallbackState.status === 'error' ? (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-label text-ink-soft" role="alert" data-testid="fantay-project-ds-menu-error">
              <span>{t('fantayShell.ds.loadFailed')}</span>
              <Button
                size="sm"
                variant="ghost"
                data-testid="fantay-project-ds-menu-retry"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setAttempt((value) => value + 1);
                }}
              >
                <Icon icon={RefreshCw} size="xs" />
                {t('fantayShell.sidebar.retry')}
              </Button>
            </div>
          ) : (
            <DropdownMenuItem disabled>{t('fantayShell.ds.loading')}</DropdownMenuItem>
          )
        ) : (
          <DropdownMenuRadioGroup
            value={currentId ?? ''}
            onValueChange={(designSystemId) => {
              if (!designSystemId || designSystemId === currentId) return;
              runProjectCommand(projectId, { kind: 'changeDesignSystem', designSystemId });
            }}
          >
            {items.map((system) => (
              <DropdownMenuRadioItem key={system.id} value={system.id} data-testid={`fantay-project-ds-option-${system.id}`}>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{system.title}</span>
                  <Swatches colors={system.swatches} />
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type DetailStatus = 'loading' | 'ready' | 'error';

interface DetailState {
  key: string;
  status: DetailStatus;
  detail: DesignSystemDetail | null;
}

/** Loads `/api/design-systems/:id` for the chosen system; keyed by id + workspace identity + retries. */
function useDesignSystemDetail(designSystemId: string | null, workspaceContext: WorkspaceCollabContext | null) {
  const [attempt, setAttempt] = useState(0);
  const key = designSystemId ? `${designSystemId}\u0000${workspaceIdentityCacheKey(workspaceContext)}\u0000${attempt}` : '';
  const contextRef = useRef(workspaceContext);
  contextRef.current = workspaceContext;
  const [state, setState] = useState<DetailState>({ key: '', status: 'loading', detail: null });

  useEffect(() => {
    if (!designSystemId) return undefined;
    let cancelled = false;
    void fetchDesignSystem(designSystemId, contextRef.current).then((detail) => {
      if (cancelled) return;
      setState({ key, status: detail ? 'ready' : 'error', detail });
    });
    return () => {
      cancelled = true;
    };
  }, [designSystemId, key]);

  const current: DetailState = state.key === key ? state : { key, status: 'loading', detail: null };
  return { ...current, retry: () => setAttempt((value) => value + 1) };
}

interface LoadedDesignSystemProps {
  detail: DesignSystemDetail;
  workspaceContext: WorkspaceCollabContext | null;
  badgeSlot: ReactNode;
  actionsSlot: ReactNode;
}

/** The project's title and controls ride in the studio's own identity bar: a second bar above it would
 *  stack two headers on a tab that is already inside the workspace chrome. */
function LoadedDesignSystem({ detail, workspaceContext, badgeSlot, actionsSlot }: LoadedDesignSystemProps) {
  const t = useT();
  const { kit } = useDesignKit({
    designSystemId: detail.id,
    title: detail.title,
    swatches: detail.swatches,
    body: detail.body,
    packageInfo: detail.packageInfo,
    editable: false,
    workspaceContext,
  });
  if (!kit) return <WorkspaceLoader label={t('fantayShell.ds.loading')} data-testid="fantay-project-ds-loading" />;
  return (
    <div data-fx-legacy="" className="fx-legacy flex min-h-0 min-w-0 flex-1 flex-col">
      <DesignSystemStudio
        kit={kit}
        body={detail.body}
        packageInfo={detail.packageInfo}
        editable={false}
        embedded
        loadPackageInfo
        workspaceContext={workspaceContext}
        badgeSlot={badgeSlot}
        actionsSlot={actionsSlot}
        dataTestId="fantay-project-design-system"
      />
    </div>
  );
}

export interface ProjectDesignSystemTabProps {
  projectId: string;
}

export function ProjectDesignSystemTab({ projectId }: ProjectDesignSystemTabProps) {
  const t = useT();
  const session = useActiveProjectSession(projectId);
  const { workspaceContext } = useProjectCollabContext();
  const designSystemId = session?.designSystemId ?? null;
  const detailState = useDesignSystemDetail(designSystemId, workspaceContext);

  let content: ReactNode;
  if (!session) {
    content = <WorkspaceLoader label={t('fantayShell.ds.loading')} data-testid="fantay-project-ds-loading" />;
  } else if (!designSystemId) {
    content = (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState
          variant="dashed"
          className="w-full max-w-[600px]"
          data-testid="fantay-project-ds-none"
          illustration={<SystemEmptyDemo fallback={<Icon icon={Palette} size="xl" className="text-ink-faint" />} />}
          title={t('fantayShell.ds.none')}
          action={
            <DesignSystemChooser
              projectId={projectId}
              designSystems={session.designSystems}
              workspaceContext={workspaceContext}
              currentId={null}
              readOnly={session.readOnly}
              label={t('fantayShell.ds.choose')}
              variant="primary"
              data-testid="fantay-project-ds-choose"
            />
          }
        />
      </div>
    );
  } else if (detailState.status === 'loading') {
    content = <WorkspaceLoader label={t('fantayShell.ds.loading')} data-testid="fantay-project-ds-loading" />;
  } else if (detailState.status === 'error' || !detailState.detail) {
    content = (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Callout tone="error" role="alert" data-testid="fantay-project-ds-error" className="flex items-center gap-3">
          <span>{t('fantayShell.ds.loadFailed')}</span>
          <Button size="sm" data-testid="fantay-project-ds-retry" onClick={detailState.retry}>
            <Icon icon={RefreshCw} size="sm" />
            {t('fantayShell.sidebar.retry')}
          </Button>
        </Callout>
      </div>
    );
  } else {
    const detail = detailState.detail;
    content = (
      <LoadedDesignSystem
        key={detail.id}
        detail={detail}
        workspaceContext={workspaceContext}
        badgeSlot={
          <>
            {/* Expanded, the studio portals out of this tab and prints the name itself. */}
            <span
              className="hidden max-w-[32cqw] truncate text-lead leading-5 font-semibold text-ink in-data-[project-ds-tab]:block"
              data-testid="fantay-project-ds-title"
            >
              {detail.title}
            </span>
            <Swatches colors={detail.swatches} />
          </>
        }
        actionsSlot={
          <>
            <DesignSystemChooser
              projectId={projectId}
              designSystems={session.designSystems}
              workspaceContext={workspaceContext}
              currentId={designSystemId}
              readOnly={session.readOnly}
              label={t('fantayShell.ds.change')}
              variant="default"
              data-testid="fantay-project-ds-change"
            />
            <Button
              size="sm"
              variant="ghost"
              data-testid="fantay-project-ds-open"
              onClick={() => {
                // The detail route resolves only user systems; a preset opens in the manager's preset list.
                if (designSystemId.startsWith('user:')) {
                  navigate({ kind: 'design-system-detail', designSystemId });
                  return;
                }
                setDesignSystemFocus(designSystemId);
                navigate({ kind: 'home', view: 'design-systems' });
              }}
            >
              <Icon icon={ExternalLink} size="sm" />
              {t('fantayShell.ds.open')}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <div
      className="fx flex min-h-0 min-w-0 flex-1 flex-col bg-paper"
      data-project-ds-tab=""
      data-testid="fantay-project-design-system-tab"
      data-design-system-id={designSystemId ?? ''}
    >
      {content}
    </div>
  );
}
