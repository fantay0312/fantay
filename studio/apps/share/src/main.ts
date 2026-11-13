import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShareServer } from './server.js';
const app = createShareServer({ dataDir: process.env.SHARE_DATA_DIR ?? '/var/lib/fantay-share', origin: process.env.SHARE_ORIGIN ?? 'https://design.tokentosea.com', secret: process.env.SHARE_SESSION_SECRET ?? '', publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public') });
app.server.listen(Number(process.env.PORT ?? 47800), '127.0.0.1', () => console.log('Fantay share service ready'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => app.close());
