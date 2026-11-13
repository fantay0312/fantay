import type { Request } from 'express';
import { isLocalSameOrigin } from '../origin-validation.js';

/** Desktop net.fetch carries its cookie jar but omits Origin on od:// requests.
 * Validate that local transport and Host instead of treating cookie presence
 * as evidence of a cross-site browser request. Opaque/external origins still
 * go through the daemon's standard origin validator.
 */
export function isTokenToSeaWriteOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'od://app') {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false;
    return isLocalSameOrigin({ headers: { ...req.headers, origin: undefined } }, req.socket.localPort);
  }
  return isLocalSameOrigin(req, req.socket.localPort);
}
