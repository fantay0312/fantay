// SPDX-License-Identifier: Apache-2.0
// Localized shot edits (spec 07 §6.3): title, timing, the source cut and caption cues of one shot,
// applied as a single undoable edit. Only changed fields become operations.
import { useEffect, useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { MovieDocument, MovieEditOperation, MovieShot } from "@open-design/contracts";

import { useT } from "../../i18n";
import {
  Button,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "../../fantay/ui";
import styles from "./MovieSelectionEditor.module.css";

export function selectionEditOperations(before: MovieShot, after: MovieShot): MovieEditOperation[] {
  const ops: MovieEditOperation[] = [];
  const changes: Record<string, unknown> = {};
  for (const key of ["title", "body", "direction", "duration", "layout", "captionStyle", "textAnimation"] as const)
    if (before[key] !== after[key]) changes[key] = after[key];
  if (JSON.stringify(before.visual) !== JSON.stringify(after.visual)) changes.visual = after.visual;
  if (Object.keys(changes).length) ops.push({ op: "update-shot", shotId: before.id, changes });
  if (before.clip && after.clip) {
    const clip: Record<string, unknown> = {};
    for (const key of ["in", "rate", "volume", "fit", "x", "y", "width", "height", "opacity", "audioOnly", "muted", "fadeIn", "fadeOut", "audioFadeIn", "audioFadeOut", "rotation", "crop", "color", "keyframes"] as const)
      if (before.clip[key] !== after.clip[key]) clip[key] = after.clip[key];
    if (Object.keys(clip).length) ops.push({ op: "update-clip", shotId: before.id, changes: clip });
  }
  const a = before.captions ?? [];
  const b = after.captions ?? [];
  for (const caption of a) {
    const next = b.find((c) => c.id === caption.id);
    if (!next) {
      ops.push({ op: "remove-caption", shotId: before.id, captionId: caption.id! });
      continue;
    }
    const change: Record<string, unknown> = {};
    for (const key of ["text", "start", "end"] as const) if (caption[key] !== next[key]) change[key] = next[key];
    if (Object.keys(change).length)
      ops.push({ op: "update-caption", shotId: before.id, captionId: caption.id!, changes: change });
  }
  for (const caption of b) if (!a.some((c) => c.id === caption.id)) ops.push({ op: "add-caption", shotId: before.id, caption });
  return ops;
}

const CLIP_FIELDS = [
  { key: "in", label: "motion.common.sourceIn", min: 0, max: 3600 },
  { key: "rate", label: "motion.selection.speed", min: 0.25, max: 4 },
  { key: "volume", label: "motion.selection.volume", min: 0, max: 1 },
] as const;

export function MovieSelectionEditor({
  document: d,
  selectedShotId,
  onSelect,
  busy,
  busyReason,
  readOnly = false,
  onApply,
  onDirtyChange,
}: {
  document: MovieDocument;
  selectedShotId?: string;
  onSelect: (id: string) => void;
  /** The editor is held: an edit is being applied, or `busyReason` says what else holds it. */
  busy: boolean;
  /** Why it is held when it is not applying (an unsaved draft, an AI run, a render). */
  busyReason?: string;
  readOnly?: boolean;
  onApply: (label: string, operations: MovieEditOperation[]) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const id = useId();
  const source = d.shots.find((s) => s.id === selectedShotId) ?? d.shots[0];
  const [draft, setDraft] = useState<MovieShot | undefined>(() => (source ? structuredClone(source) : undefined));
  useEffect(() => {
    setDraft(source ? structuredClone(source) : undefined);
    // The draft restarts when the shot or its saved content changes, not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id, d.contentRevision]);
  const operations = source && draft && source.id === draft.id ? selectionEditOperations(source, draft) : [];
  useEffect(() => {
    onDirtyChange(operations.length > 0);
  }, [operations.length, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  if (!source || !draft) return <p className={styles.empty}>{t("motion.selection.empty")}</p>;
  const locked = busy || readOnly;
  // Why the caption actions wait; a request in flight (busy without a reason) is momentary (07 §6.1 rule 2).
  const lockedReason = readOnly ? t("motion.editor.readOnly") : busy ? busyReason : undefined;
  const update = (patch: Partial<MovieShot>) => setDraft({ ...draft, ...patch });
  const captions = draft.captions ?? [];
  const lastEnd = captions.at(-1)?.end ?? 0;
  const captionsFull = lastEnd >= draft.duration;
  return (
    <section className={styles.editor} aria-label={t("motion.selection.aria")} data-testid="movie-selection-editor">
      <div className={styles.heading}>
        <h3 className={styles.title}>{t("motion.selection.title")}</h3>
        <span className={styles.state}>
          {operations.length ? t("motion.selection.pending", { count: operations.length }) : t("motion.common.saved")}
        </span>
      </div>
      <div className={styles.fields}>
        <Field label={t("motion.selection.shot")} htmlFor={`${id}-shot`} labelVariant="form">
          <Select value={source.id} disabled={locked || operations.length > 0} onValueChange={onSelect}>
            <SelectTrigger id={`${id}-shot`} size="sm" className={styles.select}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {d.shots.map((s, i) => (
                <SelectItem key={s.id} value={s.id}>
                  {i + 1}. {s.title || s.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("motion.selection.shotTitle")} htmlFor={`${id}-title`} labelVariant="form">
          <Input
            id={`${id}-title`}
            inputSize="sm"
            value={draft.title}
            disabled={locked}
            onChange={(e) => update({ title: e.target.value })}
          />
        </Field>
        <Field label={t("motion.selection.duration")} htmlFor={`${id}-duration`} labelVariant="form">
          <Input
            id={`${id}-duration`}
            type="number"
            variant="mono"
            inputSize="sm"
            min={1 / 60}
            max={30}
            step={0.01}
            value={draft.duration}
            disabled={locked}
            onChange={(e) => update({ duration: Number(e.target.value) })}
          />
        </Field>
        {draft.clip ? (
          <div className={styles.section}>
            <h4 className={styles.subheading}>{t("motion.selection.sourceClip")}</h4>
            <div className={styles.numbers}>
              {CLIP_FIELDS.map(({ key, label, min, max }) => (
                <Field key={key} label={t(label)} htmlFor={`${id}-clip-${key}`} labelVariant="form">
                  <Input
                    id={`${id}-clip-${key}`}
                    type="number"
                    variant="mono"
                    inputSize="sm"
                    min={min}
                    max={max}
                    step={0.01}
                    value={draft.clip![key]}
                    disabled={locked}
                    onChange={(e) => update({ clip: { ...draft.clip!, [key]: Number(e.target.value) } })}
                  />
                </Field>
              ))}
            </div>
            <Field label={t("motion.selection.fit")} htmlFor={`${id}-fit`} labelVariant="form">
              <Select
                value={draft.clip.fit}
                disabled={locked}
                onValueChange={(fit) => update({ clip: { ...draft.clip!, fit: fit as "cover" | "contain" } })}
              >
                <SelectTrigger id={`${id}-fit`} size="sm" className={styles.select}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cover">{t("motion.selection.fitCover")}</SelectItem>
                  <SelectItem value="contain">{t("motion.selection.fitContain")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        ) : null}
        <div className={styles.section}>
          <div className={styles.heading}>
            <h4 className={styles.subheading}>{t("motion.selection.captions")}</h4>
            <Button
              variant="ghost"
              size="sm"
              disabled={locked || captionsFull}
              // i18n-extra motion.selection.captionsFull (placeholder: the field that makes room).
              disabledReason={lockedReason ?? (captionsFull ? t("motion.selection.captionsFull") : undefined)}
              onClick={() => {
                if (captionsFull) return;
                update({
                  captions: [...captions, { id: crypto.randomUUID(), start: lastEnd, end: draft.duration, text: "" }],
                });
              }}
            >
              <Icon icon={Plus} size="sm" />
              {t("motion.selection.addCaption")}
            </Button>
          </div>
          {captions.map((caption, index) => (
            <div className={styles.caption} key={caption.id}>
              <div className={styles.heading}>
                <strong className={styles.captionLabel}>{t("motion.selection.captionN", { n: index + 1 })}</strong>
                <IconButton
                  variant="danger"
                  size="sm"
                  aria-label={t("motion.selection.deleteCaption", { n: index + 1 })}
                  disabled={locked}
                  disabledReason={lockedReason}
                  onClick={() => update({ captions: captions.filter((c) => c.id !== caption.id) })}
                >
                  <Icon icon={Trash2} size="sm" />
                </IconButton>
              </div>
              <div className={styles.numbers}>
                {(
                  [
                    ["start", t("motion.selection.captionStart")],
                    ["end", t("motion.selection.captionEnd")],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label} htmlFor={`${id}-caption-${index}-${key}`} labelVariant="form">
                    <Input
                      id={`${id}-caption-${index}-${key}`}
                      aria-label={`${label} ${index + 1}`}
                      type="number"
                      variant="mono"
                      inputSize="sm"
                      min={0}
                      max={draft.duration}
                      step={0.01}
                      value={caption[key]}
                      disabled={locked}
                      onChange={(e) =>
                        update({
                          captions: captions.map((c) => (c.id === caption.id ? { ...c, [key]: Number(e.target.value) } : c)),
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
              <Textarea
                aria-label={t("motion.selection.captionText", { n: index + 1 })}
                rows={2}
                value={caption.text}
                disabled={locked}
                onChange={(e) =>
                  update({ captions: captions.map((c) => (c.id === caption.id ? { ...c, text: e.target.value } : c)) })
                }
              />
            </div>
          ))}
          {!captions.length ? <p className={styles.empty}>{t("motion.selection.noCaptions")}</p> : null}
        </div>
        {/* Nothing to apply → no actions (07 §6.1 rule 2: zero-count actions are hidden, not disabled). */}
        {operations.length ? (
          <div className={styles.actions}>
            <Button
              variant="ghost"
              disabled={busy}
              disabledReason={busyReason}
              onClick={() => setDraft(structuredClone(source))}
            >
              {t("motion.selection.discard")}
            </Button>
            <Button
              variant="primary"
              disabled={locked}
              disabledReason={readOnly ? t("motion.editor.readOnly") : busyReason}
              onClick={() =>
                void onApply(t("motion.selection.editLabel", { title: source.title || source.id }), operations)
              }
            >
              {t(busy && !busyReason ? "motion.selection.applying" : "motion.selection.apply")}
            </Button>
          </div>
        ) : null}
      </div>
      <p className={styles.help}>{t("motion.selection.help")}</p>
    </section>
  );
}
