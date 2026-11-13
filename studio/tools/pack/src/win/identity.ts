import {
  SIDECAR_DEFAULTS,
  resolveWindowsReleaseNamespaceToken,
  resolveWindowsUninstallRegistryKey,
} from "@open-design/sidecar-proto";
import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseDisplayName,
  releaseInstallIdentity,
} from "@open-design/release";

import type { ToolPackConfig } from "../config/index.js";
import { PRODUCT_NAME } from "./constants.js";

export type WinInstallIdentity = {
  appPathsKey: string;
  displayName: string;
  exeName: string;
  installName: string;
  registryKey: string;
  shortcutName: string;
  uninstallerName: string;
};

export function resolveWinInstallIdentity(config: Pick<ToolPackConfig, "namespace" | "appVersion">): WinInstallIdentity {
  const namespaceToken = resolveWindowsReleaseNamespaceToken(config.namespace);
  const channel = releaseChannelFromVersion(config.appVersion)
    ?? releaseChannelFromNamespace(config.namespace, SIDECAR_DEFAULTS.namespace);
  const installName = channel == null ? `${PRODUCT_NAME} ${namespaceToken}` : releaseInstallIdentity(channel).productName;
  const displayName = channel == null ? `${releaseDisplayName()} ${namespaceToken}` : releaseDisplayName(channel);

  return {
    appPathsKey: `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${installName}.exe`,
    displayName,
    exeName: `${PRODUCT_NAME}.exe`,
    installName,
    // Shared with the packaged runtime, which updates DisplayVersion under this key.
    registryKey: resolveWindowsUninstallRegistryKey(config.namespace),
    shortcutName: `${installName}.lnk`,
    uninstallerName: `Uninstall ${installName}.exe`,
  };
}
