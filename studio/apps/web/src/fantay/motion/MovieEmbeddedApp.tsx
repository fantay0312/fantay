// SPDX-License-Identifier: AGPL-3.0-only
// The chrome-free MCP Apps surface `/movie-app[/:id]` (spec 07 §4.4). Without an id: 片库 / 新建影片
// tabs — the static-cover film library and the create panel. With an id: the film editor with its own
// side chat (external hosts have no chat column). Route-driven; every link stays in the current route
// family, so before W3 the legacy pages (/movies, /create/animation) that still mount it keep working.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { getOpenDesignHost } from '@open-design/host';
import { createMovieDocument, type LibraryAsset, type MovieDocument, type MovieStyle, type WorkspaceCollabContext } from '@open-design/contracts';

import { workspaceIdentityCacheKey } from '../../collab/workspace-identity';
import { MovieLibrary } from '../../components/movie/MovieLibrary';
import { MovieStudio, type MovieStudioChat } from '../../components/movie/MovieStudio';
import { MovieVideoPicker } from '../../components/movie/MovieVideoPicker';
import { clearMovieDraft, readMovieDraft, saveMovieDraft } from '../../components/movie/movie-draft';
import { useI18n } from '../../i18n';
import { fetchMoviePreviewCapability, movieRequest } from '../../providers/movie';
import { fetchDesignSystems } from '../../providers/registry';
import { linkNativeMovieProject, listNativeMovieProjects, pickNativeMovieProject, type NativeMovieProject } from '../../providers/native-movie';
import { createProject } from '../../state/projects';
import { buildPath, navigate, useRoute, type Route } from '../../router';
import type { AgentInfo, AppConfig, Project } from '../../types';
import { autoSendFirstMessageKey, autoSendPromptKey } from '../chat/auto-send';
import { Button, FX, FxLegacy, Icon, Tabs, TabsContent, TabsList, TabsTrigger, cn } from '../ui';
import {
  MotionCreateCancelled,
  MotionCreateError,
  createMotionProject,
  initialMotionCreateDraft,
  loadPersonalStyles,
  motionCreationDraftToSave,
  type MotionCreateDraft,
  type MotionCreateTask,
} from './motion-create';
import type { MotionCreateTarget } from './motion-create-store';
import { MotionCreatePanel } from './MotionCreatePanel';
import { filterMotionProjects, motionEditorRoute } from './motion-projects';
import styles from './MovieEmbeddedApp.module.css';

export interface MovieEmbeddedAppProps {
  config: AppConfig;
  agents: AgentInfo[];
  projects: Project[];
  workspaceContext: WorkspaceCollabContext | null;
  executionSwitcher: ReactNode;
  onRefresh: () => void;
}

/** Which page renders the app: the MCP surface, or (until W3) a legacy page that still mounts it. */
type FilmsRouteFamily = 'embedded' | 'movies' | 'create';

const NEW_FILM: MotionCreateTarget = { kind: 'new-project' };

/** The first AI task of a film created here, consumed once by its editor's side chat (07 §4.4). */
const pendingFirstPrompts = new Map<string, { id: string; prompt: string }>();

export function resetMovieEmbeddedAppForTests(): void {
  pendingFirstPrompts.clear();
}

function routeFamily(route: Route): FilmsRouteFamily {
  if (route.kind !== 'home' || route.embeddedMovie) return 'embedded';
  return route.creationMode === 'movie' ? 'create' : 'movies';
}

/** The film list (no id) or one film, in the same family as the page the app is on. */
function filmsRoute(family: FilmsRouteFamily, projectId?: string): Route {
  const film = projectId ? { movieProjectId: projectId } : {};
  if (family === 'create') return { kind: 'home', view: 'home', creationMode: 'movie', ...film };
  if (family === 'movies') return { kind: 'home', view: 'movies', ...film };
  return { kind: 'home', view: 'movies', embeddedMovie: true, ...film };
}

/** `/movies?project=<id>` (the old CLI link) still names a film on the legacy page. */
function legacyProjectQuery(family: FilmsRouteFamily): string | null {
  if (family !== 'movies' || typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('project');
}

/** The film is created here and its first task goes through the side chat: the workspace chat must not send it again. */
function dropStagedAutoSend(projectId: string): void {
  try {
    window.sessionStorage.removeItem(autoSendFirstMessageKey(projectId));
    window.sessionStorage.removeItem(autoSendPromptKey(projectId));
  } catch {
    // Storage unavailable: nothing was staged either.
  }
}

export function MovieEmbeddedApp(props: MovieEmbeddedAppProps) {
  const route = useRoute();
  const family = routeFamily(route);
  const filmId = route.kind === 'home' ? (route.movieProjectId ?? legacyProjectQuery(family)) : null;
  const scope = workspaceIdentityCacheKey(props.workspaceContext);
  return (
    <div className={cn(FX, styles.app)} data-testid="movie-embedded-app" data-family={family}>
      {filmId ? (
        <EmbeddedFilm key={`${filmId}\u0000${scope}`} {...props} projectId={filmId} onExit={() => navigate(filmsRoute(family))} />
      ) : (
        <FilmsHome key={scope} {...props} family={family} />
      )}
    </div>
  );
}

function EmbeddedFilm({
  projectId,
  config,
  agents,
  projects,
  workspaceContext,
  executionSwitcher,
  onExit,
}: MovieEmbeddedAppProps & { projectId: string; onExit: () => void }) {
  // Read without consuming during render (a double render must see it too); dropped once mounted.
  const [initialAiPrompt] = useState(() => pendingFirstPrompts.get(projectId) ?? null);
  useEffect(() => {
    pendingFirstPrompts.delete(projectId);
  }, [projectId]);
  const chat = useMemo<MovieStudioChat>(
    () => ({ mode: 'side', config, agents, projects, executionSwitcher }),
    [config, agents, projects, executionSwitcher],
  );
  return (
    <MovieStudio
      presentation="embedded"
      projectId={projectId}
      isActive
      workspaceContext={workspaceContext}
      chat={chat}
      onExit={onExit}
      initialAiPrompt={initialAiPrompt}
    />
  );
}

function mergeFootage(current: readonly LibraryAsset[], added: readonly LibraryAsset[]): LibraryAsset[] {
  const merged = [...current];
  for (const asset of added) if (!merged.some((item) => item.id === asset.id)) merged.push(asset);
  return merged;
}

function FilmsHome({ projects, workspaceContext, onRefresh, family }: MovieEmbeddedAppProps & { family: FilmsRouteFamily }) {
  const { t, locale } = useI18n();
  const scope = workspaceIdentityCacheKey(workspaceContext);
  const [saved] = useState(() => readMovieDraft(scope));
  const [tab, setTab] = useState<'films' | 'new'>(() => family === 'create' ? 'new' : 'films');
  const [draft, setDraft] = useState<MotionCreateDraft>(() =>
    initialMotionCreateDraft({ target: NEW_FILM, source: 'legacy-route' }, saved),
  );
  const [documents, setDocuments] = useState<Record<string, MovieDocument>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [designSystems, setDesignSystems] = useState<Array<{ id: string; title: string }>>([]);
  const [personalStyles, setPersonalStyles] = useState<MovieStyle[]>([]);
  const [generateUnavailable, setGenerateUnavailable] = useState(false);
  const [nativeProjects, setNativeProjects] = useState<NativeMovieProject[]>([]);
  const [nativeBusy, setNativeBusy] = useState(false);
  const desktop = getOpenDesignHost()?.client;
  const desktopNative = desktop?.type === 'desktop' && desktop.platform === 'darwin';
  const [nativeSupported, setNativeSupported] = useState(desktopNative);
  const run = useRef<AbortController | null>(null);
  // The instance is keyed by the workspace identity: the context's ids never change inside it.
  const env = useRef({ workspaceContext, projects, t });
  env.current = { workspaceContext, projects, t };
  const motionProjects = useMemo(() => filterMotionProjects(projects), [projects]);

  useEffect(() => {
    if (tab !== 'films') return;
    let active = true;
    const refresh = () => { void listNativeMovieProjects().then(items => { if (active) { setNativeProjects(items); setNativeSupported(desktopNative || items.length > 0); } }).catch(error => { if (active && desktopNative) setError(String(error.message ?? error)); }); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, [desktopNative, tab, projects]);

  const openNativeProject = async (selected?: NativeMovieProject) => {
    if (nativeBusy) return;
    setNativeBusy(true); setError(null);
    try {
      const entry = selected ?? await pickNativeMovieProject();
      if (!entry) return;
      let projectId = entry.projectId;
      if (!projectId) {
        const created = await createProject({ name: entry.name, skillId: 'fantay-movie', designSystemId: null,
          metadata: { kind: 'video', intent: 'motion-design', videoModel: 'hyperframes-html' }, workspaceContext });
        projectId = created.project.id;
        await movieRequest(projectId, workspaceContext, { document: createMovieDocument(entry.name, 'blank'), expectedRevision: 0 });
        await linkNativeMovieProject(projectId, entry.id, workspaceContext);
        onRefresh();
      }
      navigate(family === 'embedded' ? filmsRoute(family, projectId) : motionEditorRoute(projectId));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setNativeBusy(false); }
  };

  // The library: one GET /movie per motion project while the films tab shows (07 §4.4, MovieStudio :475-512).
  useEffect(() => {
    if (tab !== 'films') return undefined;
    let active = true;
    setLoading(true);
    const context = env.current.workspaceContext;
    void Promise.all(
      motionProjects.map(async (project) => [project.id, await movieRequest(project.id, context).catch(() => null)] as const),
    )
      .then((entries) => {
        if (!active) return;
        setDocuments(
          Object.fromEntries(entries.filter((entry): entry is readonly [string, MovieDocument] => entry[1] !== null)),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tab, motionProjects]);

  // Design systems and the C6 renderer capability, once.
  useEffect(() => {
    let active = true;
    void fetchDesignSystems(env.current.workspaceContext).then((items) => {
      if (active) setDesignSystems(items.map(({ id, title }) => ({ id, title })));
    });
    void fetchMoviePreviewCapability().then((capability) => {
      if (active) setGenerateUnavailable(capability?.available === false);
    });
    return () => {
      active = false;
    };
  }, []);

  // "用我的风格" needs the saved styles of every motion project.
  const wantsPersonal = draft.kind === 'code' && draft.startMode === 'personal';
  useEffect(() => {
    if (!wantsPersonal) return undefined;
    let active = true;
    void loadPersonalStyles(env.current.projects, env.current.workspaceContext).then((found) => {
      if (!active) return;
      setPersonalStyles(found);
      if (found.length) setDraft((current) => ({ ...current, style: found.find((style) => style.id === current.style.id) ?? found[0]! }));
    });
    return () => {
      active = false;
    };
  }, [wantsPersonal, projects]);

  // The new-film draft stays on this device until a film is created (movie-draft.ts).
  useEffect(() => {
    saveMovieDraft(scope, motionCreationDraftToSave(draft));
  }, [draft, scope]);

  // Leaving the screen retires a create in flight (it must not navigate later).
  useEffect(
    () => () => {
      run.current?.abort();
      run.current = null;
    },
    [],
  );

  const messageFor = useCallback(
    (cause: unknown) =>
      cause instanceof MotionCreateError ? env.current.t(cause.key) : cause instanceof Error ? cause.message : String(cause),
    [],
  );

  const submit = async (task: MotionCreateTask) => {
    if (busy) return;
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await createMotionProject({
        draft,
        task,
        target: NEW_FILM,
        defaultDesignSystemId: 'fantay',
        personalStyles,
        locale,
        workspaceContext,
        defaultTitles: { film: t('motion.create.defaultFilmTitle'), style: t('motion.create.defaultStyleTitle') },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      run.current = null;
      clearMovieDraft(scope);
      if (result.prompt) {
        dropStagedAutoSend(result.projectId);
        pendingFirstPrompts.set(result.projectId, { id: crypto.randomUUID(), prompt: result.prompt });
      }
      onRefresh();
      navigate(family === 'embedded' ? filmsRoute(family, result.projectId) : motionEditorRoute(result.projectId));
    } catch (cause) {
      if (controller.signal.aborted || cause instanceof MotionCreateCancelled) return;
      setError(messageFor(cause));
    } finally {
      if (run.current === controller) run.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next === 'new' ? 'new' : 'films')} className={styles.home}>
      <div className={styles.header}>
        <TabsList variant="line" size="md" aria-label={t('motion.embedded.tabsAria')} className={styles.tabsList}>
          <TabsTrigger value="films">{t('motion.embedded.tabFilms')}</TabsTrigger>
          <TabsTrigger value="new">{t('motion.library.newFilm')}</TabsTrigger>
        </TabsList>
        {family === 'embedded' ? (
          <Button variant="ghost" size="sm" className={styles.headerAction} asChild>
            <a
              href={buildPath({ kind: 'home', view: 'home' })}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (getOpenDesignHost()?.client?.type === 'desktop') {
                  event.preventDefault();
                  navigate({ kind: 'home', view: 'home' });
                }
              }}
            >
              <Icon icon={ExternalLink} size="sm" />
              {t('motion.embedded.fullWorkspace')}
            </a>
          </Button>
        ) : null}
      </div>
      <TabsContent value="films" className={styles.filmsPanel}>
        {error ? <p role="alert">{error}</p> : null}
        <MovieLibrary
          projects={motionProjects}
          documents={documents}
          loading={loading}
          onOpen={(id) => navigate(family === 'embedded' ? filmsRoute(family, id) : motionEditorRoute(id))}
          onNew={() => setTab('new')}
          workspaceContext={workspaceContext}
          nativeProjects={nativeProjects}
          nativeBusy={nativeBusy}
          onOpenNative={entry => { void openNativeProject(entry); }}
          onImportNative={nativeSupported ? () => { void openNativeProject(); } : undefined}
        />
      </TabsContent>
      <TabsContent value="new" className={styles.newPanel}>
        <MotionCreatePanel
          variant="embedded"
          target={NEW_FILM}
          draft={draft}
          onDraftChange={setDraft}
          personalStyles={personalStyles}
          designSystems={designSystems}
          busy={busy}
          error={error}
          onSubmit={(task) => void submit(task)}
          onChooseVideos={() => setPicking(true)}
          generateUnavailable={generateUnavailable}
          workspaceContext={workspaceContext}
        />
      </TabsContent>
      {picking ? (
        <FxLegacy>
          <MovieVideoPicker
            onClose={() => setPicking(false)}
            onConfirm={(assets) => {
              setDraft((current) => ({
                ...current,
                footage: mergeFootage(current.footage, assets),
                kind: 'footage',
                startMode: 'blank',
              }));
              setPicking(false);
            }}
          />
        </FxLegacy>
      ) : null}
    </Tabs>
  );
}
