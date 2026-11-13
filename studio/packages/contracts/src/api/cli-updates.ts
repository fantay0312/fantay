/** Local CLI maintenance is independent of model selection and app updates. */
export type CliUpdateState = 'unchecked' | 'current' | 'available' | 'queued' | 'updating' | 'updated' | 'error';
export type CliUpdateMethod = 'npm' | 'homebrew' | 'native' | 'manual';
export type CliUpdateReason = 'app-managed' | 'unknown-install' | 'unsupported' | 'check-failed' | 'busy' | 'install-failed' | 'verification-failed' | 'installation-changed';

export interface CliUpdateInfo {
  agentId: string;
  installedVersion: string | null;
  latestVersion: string | null;
  state: CliUpdateState;
  method: CliUpdateMethod;
  canUpdate: boolean;
  sourceUrl?: string;
  reason?: CliUpdateReason;
  phase?: 'installing' | 'verifying';
}

export interface CliUpdatesSnapshot {
  checking: boolean;
  lastCheckedAt: string | null;
  items: CliUpdateInfo[];
  error?: 'check-failed';
}
