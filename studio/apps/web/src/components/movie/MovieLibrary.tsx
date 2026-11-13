// SPDX-License-Identifier: Apache-2.0
// The film library of the embedded MCP Apps surface (spec 07 §4.4, §6.3). Cards are static covers
// (review filmstrip, sample frame or poster) — never live iframes — with a full-cover open button.
import { useState } from "react";
import { Film, FolderOpen, Plus, Play } from "lucide-react";
import {
  movieCurrentRender,
  movieDuration,
  type MovieDocument,
  type WorkspaceCollabContext,
} from "@open-design/contracts";

import { useI18n } from "../../i18n";
import { workspaceResourceUrl } from '../../collab/workspace-identity';
import type { NativeMovieProject } from '../../providers/native-movie';
import type { Dict } from "../../i18n/types";
import type { Project } from "../../types";
import { MotionCover } from "../../fantay/motion/MotionCover";
import { latestDoneRender, resolveMotionCover } from "../../fantay/motion/motion-model";
import { useMovieStrip } from "../../fantay/motion/useMovieStrip";
import {
  Button,
  EmptyState,
  Icon,
  MetaLine,
  SearchField,
  Segmented,
  SegmentedItem,
  Spinner,
  Tile,
  TileBody,
  TileCover,
} from "../../fantay/ui";
import styles from "./MovieLibrary.module.css";
import { MovieEmptyDemo } from "../../fantay/stageshow";

type LibraryFilter = "all" | "active" | "delivered";

function libraryStatus(doc: MovieDocument | undefined): keyof Dict {
  if (doc?.delivery) return "motion.library.delivered";
  if (doc?.approvedRenderId) return "motion.library.approved";
  if (doc?.renders.at(-1)?.status === "running") return "motion.library.rendering";
  if (doc && movieCurrentRender(doc)) return "motion.library.inReview";
  if (doc?.renders.length) return "motion.library.needsRender";
  return "motion.library.inProgress";
}

export function MovieLibrary({
  projects,
  documents,
  loading,
  onOpen,
  onNew,
  workspaceContext,
  nativeProjects = [],
  onOpenNative,
  onImportNative,
  nativeBusy = false,
}: {
  projects: Project[];
  documents: Record<string, MovieDocument>;
  loading: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  workspaceContext?: WorkspaceCollabContext | null;
  nativeProjects?: NativeMovieProject[];
  onOpenNative?: (project: NativeMovieProject) => void;
  onImportNative?: () => void;
  nativeBusy?: boolean;
}) {
  const { t, locale } = useI18n();
  const zh = locale.startsWith('zh');
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const visible = projects.filter(
    (project) =>
      project.name.toLowerCase().includes(query.trim().toLowerCase()) &&
      (filter === "all" || (filter === "delivered" ? !!documents[project.id]?.delivery : !documents[project.id]?.delivery)),
  );
  const nativeOnly = nativeProjects.filter(item => !projects.some(project => project.id === item.projectId));
  const visibleNative = nativeOnly.filter(item => filter !== 'delivered' && item.name.toLowerCase().includes(query.trim().toLowerCase()));
  const importButton = onImportNative ? <Button variant="default" onClick={onImportNative} disabled={nativeBusy}>
    <Icon icon={FolderOpen} size="md" />{zh ? '打开视频项目' : 'Open video project'}
  </Button> : null;
  if (!projects.length && !nativeOnly.length)
    return (
      <div className={styles.empty} data-testid="movie-library">
        <EmptyState
          illustration={<MovieEmptyDemo />}
          title={t("motion.library.emptyTitle")}
          description={t("motion.library.emptyBody")}
          action={
            <div className={styles.actions}>{importButton}<Button variant="primary" onClick={onNew}>
              <Icon icon={Plus} size="md" />
              {t("motion.library.emptyCta")}
            </Button></div>
          }
        />
      </div>
    );
  return (
    <section className={styles.library} aria-label={t("motion.library.title")} data-testid="movie-library">
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 className={styles.title}>{t("motion.library.title")}</h2>
          <span className={styles.count}>{t("motion.library.count", { count: projects.length + nativeOnly.length })}</span>
        </div>
        <div className={styles.actions}>{importButton}<Button variant="primary" onClick={onNew}>
          <Icon icon={Plus} size="md" />
          {t("motion.library.newFilm")}
        </Button></div>
      </header>
      <div className={styles.filters}>
        <SearchField
          className={styles.search}
          aria-label={t("motion.library.searchLabel")}
          placeholder={t("motion.library.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented
          size="sm"
          aria-label={t("motion.library.statusFilter")}
          value={filter}
          onValueChange={(next) => setFilter(next as LibraryFilter)}
        >
          <SegmentedItem value="all">{t("motion.library.filterAll")}</SegmentedItem>
          <SegmentedItem value="active">{t("motion.library.inProgress")}</SegmentedItem>
          <SegmentedItem value="delivered">{t("motion.library.delivered")}</SegmentedItem>
        </Segmented>
      </div>
      {loading ? <Spinner size="sm" label={t("motion.library.loading")} /> : null}
      <div className={styles.grid}>
        {visible.map((project) => (
          <LibraryCard
            key={project.id}
            project={project}
            doc={documents[project.id]}
            workspaceContext={workspaceContext}
            nativeId={nativeProjects.find(item => item.projectId === project.id)?.id}
            onOpen={() => onOpen(project.id)}
          />
        ))}
        {visibleNative.map(project => <Tile tone="solid" className={styles.card} key={`native:${project.id}`} data-testid="native-movie-library-card">
          <TileCover aspect="16/10" className={styles.cover}><NativeMovieCover nativeId={project.id} /></TileCover>
          <TileBody className={styles.body}><strong className={styles.cardTitle}>{project.name}</strong><MetaLine>{zh ? '视频剪辑' : 'Video editing'}</MetaLine></TileBody>
          <Button variant="bare" className={`${styles.cardHit} ${styles.fullCardHit}`} aria-label={project.name} disabled={nativeBusy} onClick={() => onOpenNative?.(project)} />
        </Tile>)}
      </div>
      {!visible.length && !visibleNative.length ? <p className={styles.help}>{t("motion.library.noMatch")}</p> : null}
    </section>
  );
}

function NativeMovieCover({ nativeId }: { nativeId: string }) {
  const { locale } = useI18n();
  const [missing, setMissing] = useState(false);
  if (missing) return <div className={styles.emptyCover} data-testid="native-movie-empty-cover">
    <Icon icon={Film} size="xl" />
    <span>{locale.startsWith('zh') ? '还没有预览画面' : 'No preview yet'}</span>
  </div>;
  return <img className={styles.nativeCover} src={`/api/movie/native/projects/${nativeId}/thumbnail`} alt="" onError={() => setMissing(true)} />;
}

function LibraryCard({
  project,
  doc,
  workspaceContext,
  onOpen,
  nativeId,
}: {
  project: Project;
  doc: MovieDocument | undefined;
  workspaceContext?: WorkspaceCollabContext | null;
  onOpen: () => void;
  nativeId?: string;
}) {
  const { t } = useI18n();
  const { locale } = useI18n();
  const [playing, setPlaying] = useState(false);
  // The native timeline is authoritative after linking; a host render may be stale.
  const latest = doc && !nativeId ? latestDoneRender(doc) : null;
  const videoUrl = latest?.render.file ? workspaceResourceUrl(`/api/projects/${project.id}/raw/${latest.render.file}`, workspaceContext) : null;
  const strip = useMovieStrip(project.id, latest?.render.id ?? null, {
    enabled: Boolean(latest),
    workspaceContext,
  });
  const cover = resolveMotionCover({ projectId: project.id, doc: doc ?? null, strip, workspaceContext });
  return (
    <Tile tone="solid" className={styles.card} data-testid="movie-library-card">
      <TileCover aspect="16/10" className={styles.cover}>
        {playing && videoUrl ? <video className={styles.preview} src={videoUrl} controls autoPlay playsInline aria-label={project.name} /> : <>
          {nativeId ? <NativeMovieCover key={nativeId} nativeId={nativeId} /> : <MotionCover cover={cover} aspect={doc?.aspect ?? "16:9"} />}
          {videoUrl ? <Button variant="bare" className={styles.previewButton} aria-label={`${locale.startsWith('zh') ? '预览' : 'Preview'} ${project.name}`} onClick={() => setPlaying(true)}><Icon icon={Play} size="lg" /></Button> : null}
        </>}
      </TileCover>
      <TileBody className={styles.body}>
        <strong className={styles.cardTitle}>{project.name}</strong>
        <MetaLine trailing={nativeId ? undefined : <span className={styles.status}>{t(libraryStatus(doc))}</span>}>
          {nativeId ? (locale.startsWith('zh') ? '视频剪辑' : 'Video editing') : doc ? `${doc.style.name} · ${movieDuration(doc)}s` : t("motion.library.untitledKind")}
        </MetaLine>
      </TileBody>
      <Button variant="bare" className={`${styles.cardHit} ${videoUrl ? '' : styles.fullCardHit}`} aria-label={project.name} onClick={onOpen} />
    </Tile>
  );
}
