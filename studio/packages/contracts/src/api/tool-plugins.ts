// Tool plugin gateway contract. A tool plugin's host half runs in the desktop shell and may serve HTTP
// routes there (the DeepSeek Harness `webServer` service). The workspace reaches those routes with
// same-origin relative URLs, so the daemon forwards every request under a registered prefix to the
// shell's loopback server. The workspace registers the forwarding target with
// `PUT /api/tool-plugin-gateway` whenever it changes.

export const TOOL_PLUGIN_GATEWAY_PATH = '/api/tool-plugin-gateway';

/** Header that carries the gateway token on the forwarded request. */
export const TOOL_PLUGIN_GATEWAY_HEADER = 'x-fantay-plugin-gateway';

export interface ToolPluginGatewayRequest {
  /** Loopback port of the desktop shell's plugin server. */
  port: number;
  /** Secret the plugin server requires on every request. */
  token: string;
  /** Path prefixes to forward; each must satisfy `isToolPluginGatewayPrefix`. */
  prefixes: string[];
}

export interface ToolPluginGatewayResponse {
  /** The prefixes now being forwarded. */
  prefixes: string[];
}

const GATEWAY_PREFIX = /^\/api\/plugins\/(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;
/** First segments under `/api/plugins/` that belong to the daemon's own plugin routes. */
const RESERVED_SEGMENTS = new Set(['events', 'stats', 'upload-zip', 'upload-folder', 'install', 'share-tasks']);

/**
 * True for a prefix the gateway may forward: `/api/plugins/<name>` or `/api/plugins/@scope/<name>`,
 * the namespace DeepSeek Harness plugins use for their routes, minus the daemon's own route names.
 */
export function isToolPluginGatewayPrefix(path: string): boolean {
  if (!GATEWAY_PREFIX.test(path)) return false;
  const first = path.slice('/api/plugins/'.length).split('/')[0] ?? '';
  return !RESERVED_SEGMENTS.has(first);
}
