import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseDisplayName,
} from "@open-design/release";

export function resolvePackagedWindowTitle(config: { appVersion: string | null; namespace: string }): string {
  const channel =
    releaseChannelFromVersion(config.appVersion) ??
    releaseChannelFromNamespace(config.namespace);
  return releaseDisplayName(channel);
}
