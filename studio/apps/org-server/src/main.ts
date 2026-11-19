// SPDX-License-Identifier: AGPL-3.0-only
// Entry of the Fantay organization server.
//   node dist/server.mjs init --id <org-id> --name <名称> --owner-name <姓名> --owner-email <邮箱> [--plan team|enterprise]
//   node dist/server.mjs            (serve)
// Environment: ORG_DATA_DIR (required), ORG_HOST (default 127.0.0.1), PORT (default 47810),
// ORG_PUBLIC_URL (the https address members use; needed for single sign-on and SCIM).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgServer } from './server.js';
import { OrgService } from './service.js';
import { OrgError } from './store.js';

function flags(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`参数无效：${key ?? ''}`);
    out[key.slice(2)] = value;
  }
  return out;
}

const dataDir = process.env.ORG_DATA_DIR;
if (!dataDir) {
  console.error('请设置 ORG_DATA_DIR：组织数据的存放目录（仅运行服务的账户可读写）');
  process.exit(2);
}
const [command, ...rest] = process.argv.slice(2);

if (command === 'init') {
  const service = new OrgService(dataDir);
  try {
    const input = flags(rest);
    const created = service.init({
      id: input.id, name: input.name, ...(input.plan ? { plan: input.plan } : {}),
      owner: { name: input['owner-name'], email: input['owner-email'] },
    });
    // The token is shown once and never stored in the clear: the owner keeps it, the server keeps its digest.
    console.log(JSON.stringify({
      org: { id: created.org.id, name: created.org.name, plan: created.org.plan },
      owner: { id: created.owner.id, email: created.owner.email },
      token: created.token.token, tokenExpiresAt: new Date(created.token.expiresAt).toISOString(),
    }, null, 2));
  } catch (error) {
    console.error(error instanceof OrgError ? error.message : error instanceof Error && error.name === 'ZodError'
      ? '初始化参数不完整：需要 --id --name --owner-name --owner-email' : String(error));
    process.exitCode = 1;
  } finally {
    service.close();
  }
} else if (command === undefined || command === 'serve') {
  const publicUrl = process.env.ORG_PUBLIC_URL;
  const app = createOrgServer({
    dataDir, consoleDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'),
    ...(publicUrl ? { publicUrl } : {}),
  });
  const port = Number(process.env.PORT ?? 47810);
  const host = process.env.ORG_HOST ?? '127.0.0.1';
  app.server.listen(port, host, () => {
    console.log(`Fantay organization server ready on ${host}:${port}${app.service.initialized() ? '' : ' (not initialized: run init first)'}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => app.close());
} else {
  console.error(`未知命令：${command}。可用：init、serve`);
  process.exit(2);
}
