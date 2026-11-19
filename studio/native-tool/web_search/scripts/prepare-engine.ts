import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const vendor = path.join(root, "vendor", "smart-search");
const interpreter = path.join(
  vendor,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const target = path.join(
  root,
  "runtime",
  `${process.platform}-${process.arch}`,
);
const scratch = path.join(root, ".tmp", "engine-build");

async function run(
  command: string,
  args: string[],
  capture = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: vendor,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(`Engine preparation failed (${command}, exit ${code}).`),
          ),
    );
  });
}

async function hashSource(
  directory: string,
  hash = createHash("sha256"),
): Promise<string> {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if ([".venv", "__pycache__", ".tmp", ".pytest_cache", ".DS_Store"].includes(entry.name) || entry.name.endsWith('.egg-info'))
      continue;
    const full = path.join(directory, entry.name);
    hash.update(path.relative(vendor, full));
    if (entry.isDirectory()) await hashSource(full, hash);
    else hash.update(await readFile(full));
  }
  return hash.copy().digest("hex");
}

const fingerprint = createHash('sha256')
  .update(await hashSource(path.join(vendor, 'src')))
  .update(await readFile(path.join(vendor, 'pyproject.toml')))
  .update(await readFile(path.join(vendor, 'package.json')))
  .update(await readFile(path.join(vendor, 'desktop/scripts/build_backend.py')))
  .update(await readFile(path.join(root, 'runtime-requirements.txt')))
  .update(`${process.platform}-${process.arch}`)
  .digest('hex');
let previous = "";
try {
  previous = JSON.parse(await readFile(path.join(target, "build.json"), "utf8"))
    .fingerprint as string;
} catch {
  /* First build. */
}
if (
  previous === fingerprint &&
  existsSync(
    path.join(
      target,
      process.platform === "win32" ? "smart-search.exe" : "smart-search",
    ),
  )
) {
  console.log("Bundled search engine is current.");
} else {
  if (!existsSync(interpreter))
    await run("uv", [
      "venv",
      "--python",
      process.env.FANTAY_SEARCH_BUILD_PYTHON || "3.13.14",
      path.join(vendor, ".venv"),
    ]);
  await run('uv', ['pip', 'install', '--python', interpreter, '--no-deps', '-r', path.join(root, 'runtime-requirements.txt')]);
  await run('uv', ['pip', 'install', '--python', interpreter, '--no-deps', '-e', '.']);
  await mkdir(scratch, { recursive: true });
  const manifest = path.join(scratch, "result.json");
  await run(interpreter, [
    "desktop/scripts/build_backend.py",
    "--output-root",
    scratch,
    "--result-file",
    manifest,
    "--smoke",
  ]);
  const result = JSON.parse(await readFile(manifest, "utf8")) as {
    bundle_directory: string;
  };
  const staging = `${target}.staging`;
  await rm(staging, { recursive: true, force: true });
  await cp(result.bundle_directory, staging, { recursive: true });
  await writeFile(
    path.join(staging, "build.json"),
    JSON.stringify({
      fingerprint,
      version: "0.1.34",
      platform: process.platform,
      arch: process.arch,
    }),
  );
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

const catalog = await run(
  interpreter,
  [
    "-c",
    [
      "import json",
      "from smart_search.desktop_catalog import command_catalog",
      "from smart_search.ui_metadata import metadata_payload",
      "from smart_search.i18n import use_language",
      'with use_language("zh"):',
      ' print(json.dumps({"commands": command_catalog(), "fields": metadata_payload()["fields"]}, ensure_ascii=False))',
    ].join("\n"),
  ],
  true,
);
const data = JSON.parse(catalog) as { commands: unknown; fields: unknown };
await writeFile(
  path.join(root, "commands.json"),
  JSON.stringify(data.commands, null, 2) + "\n",
);
await writeFile(
  path.join(root, "configuration.json"),
  JSON.stringify(data.fields, null, 2) + "\n",
);
console.log(
  `Prepared complete Smart Search engine for ${process.platform}-${process.arch}.`,
);
