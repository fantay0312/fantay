/** Display identity only; provider credentials are never included in this value. */
export interface TokenToSeaUser {
  id: string;
  name: string;
  email?: string;
  picture?: string;
}

export interface TokenToSeaStatus {
  configured: boolean;
  clientId: string | null;
  redirectUri: string;
  signedIn: boolean;
  pending: boolean;
  user: TokenToSeaUser | null;
  error?: string;
}

export interface TokenToSeaMovieImportRequest {
  projectId: string;
  runId: string;
  assetId: string;
  expectedRevision: number;
}

/** Only archived output assets are importable; never treat arbitrary provider URLs as project files. */
export function tokenToSeaMediaAssets(output: unknown, kinds: string[] = ['video/','image/','audio/']): string[] {
  const assets = new Set<string>();
  function visit(value: unknown, depth: number) {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.slice(0, 100).forEach(item => visit(item, depth + 1)); return; }
    const item = value as Record<string, unknown>;
    if (typeof item.asset_id === 'string' && /^asset_[a-f0-9]{64}$/.test(item.asset_id)
      && (typeof item.mime_type !== 'string' || kinds.some(kind=>String(item.mime_type).startsWith(kind)))) assets.add(item.asset_id);
    for (const key of ['output', 'data', 'assets', 'result', 'content']) visit(item[key], depth + 1);
  }
  visit(output, 0);
  return [...assets];
}
export function tokenToSeaVideoAssets(output: unknown): string[] { return tokenToSeaMediaAssets(output,['video/']); }
