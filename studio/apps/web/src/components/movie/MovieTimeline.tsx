import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Scissors, Trash2, Plus, Sparkles } from "lucide-react";
import type { MovieDocument, MovieEditOperation, MovieVideoSource, WorkspaceCollabContext } from "@open-design/contracts";
import { useT } from "../../i18n";
import { getMovieVideoSources } from "../../providers/movie";
import { Button, Icon, Input, Callout } from "../../fantay/ui";
import styles from "./MovieTimeline.module.css";

export function MovieTimeline({ document: doc, projectId, context, time, selectedShotId, disabled, reason, onSeek, onSelect, onEdit, onAi, onImport, onGenerate }: {
  document: MovieDocument; projectId: string; context?: WorkspaceCollabContext | null;
  time: number; selectedShotId?: string; disabled: boolean; reason?: string;
  onSeek(time: number): void; onSelect(id: string): void;
  onEdit(label: string, operations: MovieEditOperation[]): Promise<boolean>;
  onAi(prompt: string): Promise<boolean>; onImport(): void; onGenerate(): void;
}) {
  const t = useT();
  const [sources, setSources] = useState<MovieVideoSource[]>([]);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const sourceKey = (doc.style.assets ?? []).map((a) => a.id + a.path).join("|");
  useEffect(() => {
    let active = true;
    getMovieVideoSources(projectId, context).then((items) => { if (active) { setSources(items); setError(""); } })
      .catch((cause: unknown) => { if (active) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => { active = false; };
  }, [projectId, context, sourceKey]);
  const duration = doc.shots.reduce((sum, s) => sum + s.duration, 0);
  const index = doc.shots.findIndex((s) => s.id === selectedShotId);
  const shot = doc.shots[index];
  const start = doc.shots.slice(0, Math.max(0, index)).reduce((sum, s) => sum + s.duration, 0);
  const localTime = time - start;
  const canCut = Boolean(shot?.clip && localTime >= 1 / 60 && localTime <= shot.duration - 1 / 60);
  const apply = async (label: string, operations: MovieEditOperation[]) => {
    if (disabled) return;
    const ok = await onEdit(label, operations);
    if (ok) setError("");
  };
  const addSource = async (source: MovieVideoSource) => {
    // Preserve the whole source. Long footage becomes consecutive cuts; never silently use only its first seconds.
    const count = Math.ceil(source.duration / 30);
    if (doc.shots.length + count > 60 || duration + source.duration > 300) {
      setError(t("motion.timeline.limit"));
      return;
    }
    const span = source.duration / count;
    const operations: MovieEditOperation[] = Array.from({ length: count }, (_, n) => ({
      op: "insert-clip", assetId: source.assetId, index: doc.shots.length + n, in: span * n, duration: span,
    }));
    await apply(t("motion.timeline.addSource"), operations);
  };
  let cursor = 0;
  return <section className={styles.timeline} aria-label={t("motion.timeline.title")} data-testid="movie-timeline">
    <div className={styles.toolbar}>
      <strong>{t("motion.timeline.title")}</strong>
      <Button size="sm" disabled={disabled} disabledReason={reason} onClick={onImport}><Icon icon={Plus} size="sm" />{t("motion.timeline.import")}</Button>
      <Button size="sm" disabled={disabled} disabledReason={reason} onClick={onGenerate}><Icon icon={Sparkles} size="sm" />{t("motion.timeline.generate")}</Button>
    </div>
    {error ? <Callout tone="error" role="alert">{error}</Callout> : null}
    <div className={styles.sources} aria-label={t("motion.sources.title")}>
      {sources.map((source) => <Button key={source.assetId} size="sm" disabled={disabled} disabledReason={reason} onClick={() => void addSource(source)}>
        <Icon icon={Plus} size="sm" />{source.label} · {source.duration.toFixed(1)}s
      </Button>)}
      {!sources.length ? <span className={styles.hint}>{t("motion.timeline.empty")}</span> : null}
    </div>
    <div className={styles.toolbar} aria-label={t("motion.timeline.tools")}>
      <Button size="sm" disabled={disabled || !canCut} disabledReason={reason ?? (!canCut ? t("motion.timeline.chooseCut") : undefined)}
        onClick={() => shot && void apply(t("motion.timeline.split"), [{ op: "split-clip", shotId: shot.id, at: localTime }])}><Icon icon={Scissors} size="sm" />{t("motion.timeline.split")}</Button>
      <Button size="sm" disabled={disabled || !canCut} onClick={() => shot && void apply(t("motion.timeline.trimStart"), [{ op: "trim-clip", shotId: shot.id, start: localTime, end: shot.duration }])}>{t("motion.timeline.trimStart")}</Button>
      <Button size="sm" disabled={disabled || !canCut} onClick={() => shot && void apply(t("motion.timeline.trimEnd"), [{ op: "trim-clip", shotId: shot.id, start: 0, end: localTime }])}>{t("motion.timeline.trimEnd")}</Button>
      <Button size="sm" aria-label={t("motion.timeline.left")} disabled={disabled || index < 1} onClick={() => shot && void apply(t("motion.timeline.left"), [{ op: "move-shot", shotId: shot.id, index: index - 1 }])}><Icon icon={ArrowLeft} size="sm" /></Button>
      <Button size="sm" aria-label={t("motion.timeline.right")} disabled={disabled || index < 0 || index >= doc.shots.length - 1} onClick={() => shot && void apply(t("motion.timeline.right"), [{ op: "move-shot", shotId: shot.id, index: index + 1 }])}><Icon icon={ArrowRight} size="sm" /></Button>
      <Button size="sm" aria-label={t("motion.timeline.remove")} disabled={disabled || !shot} onClick={() => shot && void apply(t("motion.timeline.remove"), [{ op: "remove-shot", shotId: shot.id }])}><Icon icon={Trash2} size="sm" /></Button>
    </div>
    <div className={styles.scroll}>
      <div className={styles.tracks} style={{ minWidth: Math.max(480, duration * 35) }}>
        <input className={styles.ruler} type="range" min={0} max={duration || 1} step={1 / 30} value={Math.min(time, duration)}
          disabled={!duration} aria-label={t("motion.preview.position")} onChange={(e) => onSeek(Number(e.target.value))} />
        <div className={styles.clips}>
          {doc.shots.map((s, n) => {
            const at = cursor; cursor += s.duration;
            return <button type="button" className={styles.clip} key={s.id} style={{ width: `${s.duration / (duration || 1) * 100}%` }}
              aria-label={`${n + 1}. ${s.title} · ${s.duration.toFixed(2)}s`} aria-pressed={s.id === selectedShotId}
              draggable={!disabled} onDragStart={() => setDragged(s.id)} onDragEnd={() => setDragged(null)}
              onDragOver={(e) => { if (!disabled) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragged && dragged !== s.id) void apply(t("motion.timeline.move"), [{ op: "move-shot", shotId: dragged, index: n }]); setDragged(null); }}
              onClick={() => { if (!disabled) onSelect(s.id); onSeek(at); }}>
              <span>{n + 1}. {s.title}</span><small>{at.toFixed(2)}–{(at + s.duration).toFixed(2)}s</small>
              {s.clip ? <small>{s.clip.in.toFixed(2)}s · {s.clip.rate}×</small> : null}
            </button>;
          })}
        </div>
        <div className={styles.captions} aria-label={t("motion.selection.captions")}>
          {doc.shots.map((s) => <div key={s.id} style={{ width: `${s.duration / (duration || 1) * 100}%` }}>
            {(s.captions ?? []).map((c) => <span key={c.id} style={{ left: `${c.start / s.duration * 100}%`, width: `${(c.end - c.start) / s.duration * 100}%` }} title={c.text}>{c.text}</span>)}
          </div>)}
        </div>
        {duration > 0 ? <div className={styles.playhead} style={{ left: `${Math.min(time, duration) / duration * 100}%` }} /> : null}
      </div>
    </div>
    <p className={styles.hint}>{t("motion.timeline.hint")}</p>
    <form className={styles.ai} onSubmit={(e) => { e.preventDefault(); if (!disabled && prompt.trim()) void onAi(prompt.trim()).then((ok) => { if (ok) setPrompt(""); }); }}>
      <Input aria-label={t("motion.timeline.ai")} placeholder={t("motion.timeline.aiHint")} value={prompt} disabled={disabled} onChange={(e) => setPrompt(e.target.value)} />
      <Button type="submit" size="sm" disabled={disabled || !prompt.trim()} disabledReason={reason}>{t("motion.timeline.ai")}</Button>
    </form>
  </section>;
}
