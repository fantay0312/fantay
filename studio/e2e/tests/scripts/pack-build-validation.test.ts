import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("packaged build validation", () => {
  it("keeps test and generated-route diagnostics in independent checking, with production-only build roots", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pack-typecheck-"));
    try {
      for (const file of ["tsconfig.json", "tsconfig.build.json"]) {
        const parsed = JSON.parse(await readFile(join(root, "apps/web", file), "utf8")) as {
          include?: string[];
          exclude?: string[];
        };
        await writeFile(join(fixture, file), JSON.stringify({
          compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, target: "ES2022" },
          include: parsed.include,
          exclude: parsed.exclude,
        }));
      }
      for (const dir of ["tests", "src", "sidecar", ".next/types"]) await mkdir(join(fixture, dir), { recursive: true });
      for (const dir of ["tests", "src", "sidecar", ".next/types"]) {
        await writeFile(join(fixture, dir, "witness.ts"), "export const value: string = 123;\n");
      }
      const diagnostics = (config: string) => {
        let output = "";
        try {
          output = execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", config, "--noEmit", "--pretty", "false", "--incremental", "false"], {
            cwd: fixture,
            encoding: "utf8",
          });
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string };
          output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        }
        return [...output.matchAll(/(?:^|\n)(.+?)\(\d+,\d+\): error TS2322:/g)]
          .map((match) => match[1]!.replaceAll("\\", "/"))
          .sort();
      };
      expect(diagnostics("tsconfig.json")).toEqual([".next/types/witness.ts", "sidecar/witness.ts", "src/witness.ts", "tests/witness.ts"]);
      expect(diagnostics("tsconfig.build.json")).toEqual([".next/types/witness.ts", "src/witness.ts"]);
      const pkg = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"));
      expect(pkg.scripts.typecheck).toBe("next typegen && tsc -b --noEmit");
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  it("always skips Next's embedded checker so native TypeScript 7 remains the web type gate", () => {
    const read = (mode: string) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
      "const {default:config}=await import('./apps/web/next.config.ts'); console.log(JSON.stringify(config.typescript));"],
    { cwd: root, env: { ...process.env, NODE_ENV: "production", OD_WEB_TYPECHECK: mode, OD_WEB_TSCONFIG_PATH: "" }, encoding: "utf8" }));
    expect(read("")).toEqual({ tsconfigPath: "tsconfig.build.json", ignoreBuildErrors: true });
    expect(read("external")).toEqual({ tsconfigPath: "tsconfig.build.json", ignoreBuildErrors: true });
  });
});
