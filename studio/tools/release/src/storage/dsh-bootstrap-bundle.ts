import { createHash } from "node:crypto";

import { publicUrl } from "./common.ts";

// Publish the PowerShell dependency before the CMD wrapper that invokes it.
export const DSH_BOOTSTRAP_FILES = ["install-dsh.ps1", "install-dsh.sh", "install-dsh.cmd"] as const;

export type DshBootstrapObject = {
  body: Buffer;
  name: (typeof DSH_BOOTSTRAP_FILES)[number];
};

const INSTALLER_URL_MARKER = "__FANTAY_DSH_INSTALLER_URL__";

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Make the versioned CMD snapshot invoke the PS1 published beside it. The
 * canonical CMD carries a publication placeholder. Materialization supplies
 * the immutable URL from the configured Fantay storage origin.
 */
export function materializeDshBootstrapInstallers(
  sources: readonly DshBootstrapObject[],
  version: string,
  publicOrigin: string,
): DshBootstrapObject[] {
  return sources.map((source) => {
    if (source.name !== "install-dsh.cmd") return { ...source, body: Buffer.from(source.body) };

    const cmd = source.body.toString("utf8");
    const markerCount = cmd.split(INSTALLER_URL_MARKER).length - 1;
    if (markerCount !== 1) {
      throw new Error(
        `install-dsh.cmd must contain exactly one installer URL marker for immutable materialization; found ${markerCount}`,
      );
    }
    const immutablePs1Url = publicUrl(
      publicOrigin,
      `bootstrap/dsh/${version}`,
      "install-dsh.ps1",
    );
    return {
      ...source,
      body: Buffer.from(cmd.replace(INSTALLER_URL_MARKER, immutablePs1Url), "utf8"),
    };
  });
}

export function dshBootstrapChecksums(installers: readonly DshBootstrapObject[]): Buffer {
  return Buffer.from(
    installers.map(({ body, name }) => `${sha256(body)}  ${name}`).join("\n") + "\n",
    "utf8",
  );
}

export function dshBootstrapFileHashes(
  installers: readonly DshBootstrapObject[],
): Record<string, string> {
  return Object.fromEntries(installers.map(({ body, name }) => [name, sha256(body)]));
}
