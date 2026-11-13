// SPDX-License-Identifier: Apache-2.0
// The receipt of the last localized edit, undo or redo (spec 07 §6.3): a Disclosure under the stage
// bar; every changed field is named through `motion.receipt.field.*`, in every locale.
import type { MovieEditReceipt as Receipt } from "@open-design/contracts";

import { useT } from "../../i18n";
import type { Dict } from "../../i18n/types";
import { Disclosure } from "../../fantay/ui";
import styles from "./MovieEditReceipt.module.css";

const FIELD_LABELS: Readonly<Record<string, keyof Dict>> = {
  "shot.title": "motion.receipt.field.shotTitle",
  "shot.body": "motion.receipt.field.shotBody",
  "shot.direction": "motion.receipt.field.shotDirection",
  "shot.duration": "motion.receipt.field.shotDuration",
  "shot.layout": "motion.receipt.field.shotLayout",
  "shot.media": "motion.receipt.field.shotMedia",
  "shot.added": "motion.receipt.field.shotAdded",
  "shot.removed": "motion.receipt.field.shotRemoved",
  "shot.order": "motion.receipt.field.shotOrder",
  "clip.in": "motion.receipt.field.clipIn",
  "clip.rate": "motion.receipt.field.clipRate",
  "clip.volume": "motion.receipt.field.clipVolume",
  "clip.fit": "motion.receipt.field.clipFit",
  "clip.assetId": "motion.receipt.field.clipAssetId",
  "caption.text": "motion.receipt.field.captionText",
  "caption.start": "motion.receipt.field.captionStart",
  "caption.end": "motion.receipt.field.captionEnd",
  "caption.added": "motion.receipt.field.captionAdded",
  "caption.removed": "motion.receipt.field.captionRemoved",
  style: "motion.receipt.field.style",
  visual: "motion.receipt.field.visual",
  title: "motion.receipt.field.title",
  brief: "motion.receipt.field.brief",
  aspect: "motion.receipt.field.aspect",
  startMode: "motion.receipt.field.startMode",
};

export function MovieEditReceipt({ receipt: r }: { receipt: Receipt }) {
  const t = useT();
  const verb = t(
    r.action === "undo"
      ? "motion.receipt.undone"
      : r.action === "redo"
        ? "motion.receipt.redone"
        : "motion.receipt.applied",
  );
  const label = (field: string) => {
    const key = FIELD_LABELS[field];
    return key ? t(key) : field;
  };
  return (
    <section className={styles.receipt} aria-label={t("motion.receipt.aria")} data-testid="movie-edit-receipt">
      <Disclosure
        label={t("motion.receipt.summary", {
          verb,
          shots: r.changedShotIds.length,
          changes: r.changes.length,
          more: r.truncated ? "+" : "",
        })}
      >
        <ul className={styles.list}>
          {r.changes.map((change, index) => (
            <li key={index} className={styles.change}>
              <strong className={styles.field}>
                {change.shotTitle ? `${change.shotTitle} · ` : ""}
                {label(change.field)}
              </strong>
              <span className={styles.values}>
                <del className={styles.before}>{String(change.before ?? "—")}</del>
                <span aria-hidden="true">→</span>
                <ins className={styles.after}>{String(change.after ?? "—")}</ins>
              </span>
            </li>
          ))}
        </ul>
        {!r.historyRecorded ? <p className={styles.note}>{t("motion.receipt.noHistory")}</p> : null}
      </Disclosure>
    </section>
  );
}
