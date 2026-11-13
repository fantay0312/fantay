import { SIDECAR_DEFAULTS } from "@open-design/sidecar-proto";
import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseDisplayName,
  releaseInstallIdentity,
} from "@open-design/release";

import type { ToolPackConfig } from "../config/index.js";

export type MacInstallIdentity = {
  appId: string;
  displayName: string;
  executableName: string;
  installerTitle: string;
  productName: string;
  publicAppBundleName: string;
  runtimeProductName: string;
  systemAppBundleName: string;
};

export function sanitizeNamespace(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function resolveMacInstallIdentity(config: Pick<ToolPackConfig, "namespace" | "appVersion">): MacInstallIdentity {
  const namespaceToken = sanitizeNamespace(config.namespace);
  const channel = releaseChannelFromVersion(config.appVersion)
    ?? releaseChannelFromNamespace(config.namespace, SIDECAR_DEFAULTS.namespace);
  const channelIdentity = releaseInstallIdentity(channel ?? "stable");
  const displayName = releaseDisplayName(channel);
  const publicAppBundleName = `${displayName}.app`;
  const systemAppBundleName = channel != null
    ? publicAppBundleName
    : `${displayName}.${namespaceToken}.app`;

  return {
    appId: channelIdentity.appId,
    displayName,
    executableName: displayName,
    installerTitle: channel == null ? `${displayName}-${namespaceToken}` : displayName,
    productName: displayName,
    publicAppBundleName,
    // Electron derives its default userData path from the app manifest's productName.
    runtimeProductName: channelIdentity.productName,
    systemAppBundleName,
  };
}
