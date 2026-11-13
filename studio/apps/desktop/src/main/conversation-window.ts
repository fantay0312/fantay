export function conversationWindowUrl(base: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const { projectId, conversationId } = input as Record<string, unknown>;
  const validId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,200}$/.test(value);
  if (!validId(projectId) || !validId(conversationId)) return null;
  const url = new URL(base);
  if (!['od:', 'http:', 'https:'].includes(url.protocol)) return null;
  url.pathname = `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
