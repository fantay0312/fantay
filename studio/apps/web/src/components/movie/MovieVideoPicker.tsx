// SPDX-License-Identifier: Apache-2.0
// Library video picker for footage films (spec 07 §6.3): the upstream LibraryPicker filtered to videos,
// plus an upload button that adds a file (≤ 256 MiB) to the library and refreshes the list. Callers
// render it inside <FxLegacy> on Fantay surfaces (amendment B3).
import { useRef, useState } from "react";
import type { LibraryAsset } from "@open-design/contracts";

import { useT } from "../../i18n";
import { Button, Callout } from "../../fantay/ui";
import { LibraryPicker } from "../LibraryPicker";

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export function MovieVideoPicker({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (assets: LibraryAsset[]) => Promise<void> | void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  async function upload(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t("motion.videoPicker.tooLarge"));
      return;
    }
    setUploading(true);
    setError("");
    try {
      const response = await fetch(`/api/library/videos?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const result = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message || t("ds.uploadFailed"));
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  }

  return (
    <LibraryPicker
      onlyKind="video"
      refreshKey={refresh}
      title={t("motion.videoPicker.title")}
      confirmLabel={t("motion.videoPicker.confirm")}
      onClose={onClose}
      onConfirm={onConfirm}
      footerAddon={
        <>
          <input
            ref={input}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mov"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <Button variant="default" disabled={uploading} onClick={() => input.current?.click()}>
            {t(uploading ? "motion.videoPicker.uploading" : "motion.videoPicker.upload")}
          </Button>
          {error ? (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          ) : null}
        </>
      }
    />
  );
}
