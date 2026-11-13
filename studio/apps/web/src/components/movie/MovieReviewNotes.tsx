// SPDX-License-Identifier: Apache-2.0
// Review feedback (spec 07 §6.3): scope (this frame / this range / whole film / the selected shot), the
// note composer, the version-aware note list with its fix confirmation, and the one primary of the
// inspector — "发给 AI 改并出片（N）", shown only when there is something to send.
import { useEffect, useId, useRef, useState } from "react";
import { Check, FileVideo, Plus, Send } from "lucide-react";
import type { MovieDocument, MovieNoteTarget, MovieReviewNote, WorkspaceCollabContext } from "@open-design/contracts";
import { movieDuration } from '@open-design/contracts';

import { workspaceResourceUrl } from "../../collab/workspace-identity";
import { useT, useI18n } from "../../i18n";
import {
  Button,
  Checkbox,
  CheckboxField,
  Disclosure,
  Field,
  Icon,
  Input,
  Segmented,
  SegmentedItem,
  Spinner,
  Textarea,
} from "../../fantay/ui";
import styles from "./MovieReview.module.css";

type Translate = ReturnType<typeof useT>;

const timestamp = (n: number) => `${Math.floor(n / 60)}:${(n % 60).toFixed(2).padStart(5, "0")}`;

export function movieNoteLabel(n: MovieNoteTarget | MovieReviewNote, t: Translate): string {
  if (n.scope === "film") return t("motion.notes.scopeFilm");
  if (n.scope === "shot")
    return "shotTitle" in n && n.shotTitle ? t("motion.notes.shotLabel", { title: n.shotTitle }) : t("motion.notes.selectedShot");
  return n.scope === "range"
    ? `${timestamp(n.time)} – ${timestamp(n.endTime ?? n.time)}`
    : t("motion.notes.timeLabel", { time: timestamp(n.time) });
}

export function MovieReviewNotes({
  document: d,
  target,
  onTarget,
  onFreeze,
  onAdd,
  onSubmit,
  onResolve,
  onLocate,
  busy,
  aiRunning,
  readOnly = false,
  projectId,
  context,
  onAddMaterial,
  focusRequested = 0,
  live = false,
}: {
  document: MovieDocument;
  target: MovieNoteTarget;
  onTarget: (target: MovieNoteTarget) => void;
  onFreeze: () => void;
  onAdd: (text: string) => Promise<void>;
  onSubmit: (ids: string[]) => void;
  onResolve: (note: MovieReviewNote) => void;
  onLocate: (note: MovieReviewNote) => void;
  busy: boolean;
  /** An AI task is running (main chat or the embedded side chat). */
  aiRunning: boolean;
  readOnly?: boolean;
  projectId: string;
  context?: WorkspaceCollabContext | null;
  onAddMaterial: () => void;
  focusRequested?: number;
  /** Comments on the editable timeline, before any MP4 is exported. */
  live?: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const id = useId();
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusRequested) input.current?.focus();
  }, [focusRequested]);
  const locked = busy || readOnly;
  // A request in flight is momentary and needs no reason; read-only access does (07 §6.1 rule 2).
  const lockedReason = readOnly ? t("motion.editor.readOnly") : undefined;
  const visible = d.notes.filter(
    (n) =>
      all ||
      (target.renderId
        ? n.renderId === target.renderId || n.addressedRenderId === target.renderId || n.resolvedInRenderId === target.renderId
        : !n.renderId),
  );
  const eligible = visible.filter(
    (n) => !n.resolved && !n.addressedRenderId && (target.renderId ? n.renderId === target.renderId : !n.renderId),
  );
  const chosen = eligible.filter((n) => !excluded.includes(n.id)).map((n) => n.id);
  const shotTitle = d.shots.find((s) => s.id === target.shotId)?.title;
  const targetTitle =
    target.scope === "shot"
      ? shotTitle
        ? t("motion.notes.shotLabel", { title: shotTitle })
        : t("motion.notes.selectedShot")
      : movieNoteLabel(target, t);
  const version = (renderId?: string, revision?: number) =>
    renderId
      ? `v${d.renders.findIndex((r) => r.id === renderId) + 1}`
      : t("motion.notes.planVersion", { revision: revision ?? d.contentRevision });
  const materials = [
    ...new Map(
      [
        ...(d.style.assets ?? []).map((a) => ({ path: a.path, label: a.label ?? a.path })),
        ...d.shots.filter((s) => s.media).map((s) => ({ path: s.media!, label: s.media! })),
      ].map((a) => [a.path, a]),
    ).values(),
  ];
  const changeScope = (scope: string) => {
    if (scope === "shot") {
      onFreeze();
      return;
    }
    if (scope === "time") {
      onTarget({ ...target, scope: "time" });
      onFreeze();
      return;
    }
    if (scope === "range") {
      onTarget({
        ...target,
        scope: "range",
        endTime: target.endTime ?? Math.min(target.time + 1, live ? movieDuration(d) : d.renders.find((r) => r.id === target.renderId)?.duration ?? 300),
      });
      return;
    }
    onTarget({ ...target, scope: "film", time: 0 });
  };

  return (
    <section className={styles.notePanel} aria-label={t("motion.notes.title")} data-testid="movie-review-notes">
      <header className={styles.panelHeader}>
        <strong className={styles.panelTitle}>
          {t("motion.notes.title")}
          <span className={styles.countBadge}>{visible.filter((n) => !n.resolved).length}</span>
        </strong>
        <span className={styles.version}>{version(target.renderId)}</span>
      </header>
      <div className={styles.noteComposer}>
        <Segmented size="sm" className={styles.scopes} aria-label={t("motion.notes.scopeAria")} value={target.scope} onValueChange={changeScope}>
          {target.scope === "shot" ? <SegmentedItem value="shot">{targetTitle}</SegmentedItem> : null}
          {target.renderId || live ? (
            <>
              <SegmentedItem value="time">{t("motion.notes.scopeTime")}</SegmentedItem>
              <SegmentedItem value="range">{t("motion.notes.scopeRange")}</SegmentedItem>
            </>
          ) : null}
          <SegmentedItem value="film">{t("motion.notes.scopeFilm")}</SegmentedItem>
        </Segmented>
        {target.scope !== "film" ? <p className={styles.targetLabel}>{targetTitle}</p> : null}
        {target.scope === "range" ? (
          <div className={styles.rangeFields}>
            <Field label={t("motion.notes.rangeStart")} htmlFor={`${id}-start`} labelVariant="form">
              <Input
                id={`${id}-start`}
                type="number"
                variant="mono"
                inputSize="sm"
                min={0}
                step={0.01}
                value={Number(target.time.toFixed(2))}
                onChange={(e) => onTarget({ ...target, time: Number(e.target.value) })}
              />
            </Field>
            <Field label={t("motion.notes.rangeEnd")} htmlFor={`${id}-end`} labelVariant="form">
              <Input
                id={`${id}-end`}
                type="number"
                variant="mono"
                inputSize="sm"
                min={0}
                step={0.01}
                value={Number((target.endTime ?? target.time).toFixed(2))}
                onChange={(e) => onTarget({ ...target, endTime: Number(e.target.value) })}
              />
            </Field>
          </div>
        ) : null}
        <Textarea
          ref={input}
          variant="bare"
          className={styles.noteInput}
          aria-label={t("motion.notes.textLabel")}
          value={text}
          rows={4}
          disabled={readOnly}
          onFocus={onFreeze}
          onChange={(e) => setText(e.target.value)}
          placeholder={t(target.scope === "shot" ? "motion.notes.placeholderShot" : "motion.notes.placeholder")}
        />
        <div className={styles.composerFooter}>
          <span className={styles.hint}>{live ? (zh ? '批注记录当前时间和版本；选择后才发给主聊天。' : 'Comments keep their time and version. Only selected comments are sent to the project chat.') : t("motion.notes.sourceHint")}</span>
          <Button
            variant="default"
            size="sm"
            disabled={locked || !text.trim()}
            // i18n-extra motion.notes.writeFirst (placeholder: the composer's own prompt).
            disabledReason={
              lockedReason ??
              (text.trim() ? undefined : t("motion.notes.writeFirst"))
            }
            onClick={async () => {
              try {
                await onAdd(text.trim());
                setText("");
              } catch {
                /* The editor shows the actionable error. */
              }
            }}
          >
            {t("motion.notes.add")}
          </Button>
        </div>
      </div>
      <div className={styles.notesHeading}>
        <span>{t("motion.notes.listTitle", { count: visible.length })}</span>
        <CheckboxField
          className={styles.allVersions}
          label={t("motion.notes.allVersions")}
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
      </div>
      <div className={styles.notesList}>
        {!visible.length ? <p className={styles.emptyNotes}>{t("motion.notes.empty")}</p> : null}
        {visible.map((n) => (
          <article key={n.id} className={styles.noteRow} data-testid="movie-review-note">
            <div className={styles.noteMeta}>
              {eligible.some((e) => e.id === n.id) ? (
                <label className={styles.noteCheck}>
                  <Checkbox
                    aria-label={t("motion.notes.includeNote", { text: n.text })}
                    checked={!excluded.includes(n.id)}
                    disabled={readOnly}
                    onChange={(e) =>
                      setExcluded((ids) => (e.target.checked ? ids.filter((id) => id !== n.id) : [...ids, n.id]))
                    }
                  />
                </label>
              ) : null}
              <Button variant="link" size="sm" className={styles.noteLocate} onClick={() => onLocate(n)}>
                {movieNoteLabel(n, t)}
              </Button>
              <span className={styles.version}>{version(n.renderId, n.contentRevision)}</span>
            </div>
            <p className={styles.noteBody}>{n.text}</p>
            {n.resolved ? (
              <span className={styles.resolvedText}>
                <Icon icon={Check} size="sm" />
                {n.resolvedInRenderId
                  ? t("motion.notes.confirmedIn", { version: version(n.resolvedInRenderId) })
                  : t("motion.notes.closed")}
              </span>
            ) : n.addressedRenderId ? (
              <div className={styles.noteResolution}>
                <Button variant="link" size="sm" onClick={() => onLocate({ ...n, renderId: n.addressedRenderId! })}>
                  {t("motion.notes.readyForReview", { version: version(n.addressedRenderId) })}
                </Button>
                <Button variant="default" size="sm" disabled={locked} disabledReason={lockedReason} onClick={() => onResolve(n)}>
                  {t("motion.notes.confirmFix")}
                </Button>
              </div>
            ) : (
              <div className={styles.noteResolution}>
                <span className={styles.pendingText}>
                  {t(n.submittedBatchId && d.reviewBatch?.status !== "failed" ? "motion.notes.submitted" : "motion.notes.pending")}
                </span>
                <Button variant="bare" size="sm" disabled={locked} disabledReason={lockedReason} onClick={() => onResolve(n)}>
                  {t("motion.notes.closeNote")}
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>
      {chosen.length > 0 ? (
        <Button
          variant="primary"
          block
          disabled={locked || aiRunning}
          disabledReason={readOnly ? t("motion.editor.readOnly") : aiRunning ? t("motion.editor.aiBusy") : undefined}
          onClick={() => onSubmit(chosen)}
        >
          {aiRunning ? <Spinner size="sm" /> : <Icon icon={Send} size="sm" />}
          {aiRunning ? t("motion.notes.revising") : live ? (zh ? `发给主聊天修改（${chosen.length}）` : `Send to project chat (${chosen.length})`) : t("motion.notes.submit", { count: chosen.length })}
        </Button>
      ) : (
        <p className={styles.caption}>{t("motion.editor.notesNone")}</p>
      )}
      {!live ? <Disclosure className={styles.materials} label={t("motion.notes.materials", { count: materials.length })}>
        <div className={styles.materialList}>
          {materials.map((a) => (
            <a
              key={a.path}
              className={styles.materialRow}
              href={workspaceResourceUrl(`/api/projects/${projectId}/raw/${a.path}`, context)}
              target="_blank"
              rel="noreferrer"
            >
              <Icon icon={FileVideo} size="sm" />
              <span className={styles.materialName}>{a.label.split("/").at(-1)}</span>
            </a>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className={styles.addMaterial}
            disabled={readOnly}
            disabledReason={lockedReason}
            onClick={onAddMaterial}
          >
            <Icon icon={Plus} size="sm" />
            {t("motion.notes.addMaterial")}
          </Button>
        </div>
      </Disclosure> : null}
    </section>
  );
}
