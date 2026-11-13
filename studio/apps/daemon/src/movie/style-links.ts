import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MOVIE_VISUALS,
  parseStudioTokens,
  resolveStudioToken,
  type MovieStyle,
  type MaterialDetail,
  type MaterialApplyResponse,
} from "@open-design/contracts";
import { MovieError, safeMovieAsset } from "./store.js";

function hex(value: string | undefined): string | undefined {
  if (!value) return;
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  if (/^#[\da-f]{3}$/i.test(value))
    return (
      "#" +
      value
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
    );
  if (value === "white") return "#ffffff";
  if (value === "black") return "#000000";
  const rgb = value.match(
    /^rgb\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*\)$/i,
  );
  if (rgb)
    return (
      "#" +
      rgb
        .slice(1)
        .map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0"))
        .join("")
    );
}
export function styleFromDesignTokens(
  style: MovieStyle,
  id: string,
  css: string,
  tokenFile = "tokens.css",
): MovieStyle {
  const tokens = parseStudioTokens(css);
  const value = (names: string[]) =>
    names.map((name) => resolveStudioToken(name, tokens)).find(Boolean) ??
    undefined;
  const background = hex(value(["--bg", "--background", "--color-bg"])),
    foreground = hex(value(["--fg", "--foreground", "--text-primary"])),
    accent = hex(value(["--accent", "--color-accent", "--brand"]));
  if (!background || !foreground || !accent)
    throw new MovieError(
      "This design system needs resolvable background, foreground and accent colors.",
    );
  const typeface = value(["--font-display", "--font-body", "--font-sans"]);
  return {
    ...style,
    background,
    foreground,
    accent,
    ...(typeface && /^[\p{L}\p{N}\s_,'".\-]+$/u.test(typeface)
      ? { typeface }
      : {}),
    designSystem: {
      id,
      tokenFile,
      digest: createHash("sha256").update(css).digest("hex"),
    },
  };
}
export function styleWithMaterial(
  style: MovieStyle,
  detail: MaterialDetail,
  applied?: MaterialApplyResponse,
): MovieStyle {
  const previous=style.references?.find(r=>r.materialId===detail.id);
  const references = [
    ...(style.references ?? []).filter((r) => r.materialId !== detail.id),
    {
      ...previous,
      materialId: detail.id,
      title: detail.title,
      license: detail.license,
      ...(detail.source ? { source: detail.source } : {}),
      ...(applied ? { receipt: applied.receiptRelPath } : {}),
    },
  ];
  if (references.length > 20)
    throw new MovieError("A style supports up to 20 material references.");
  const media =
    applied?.attachments.find((p) =>
      /\.(svg|png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(p),
    ) ??
    applied?.files.find((f) =>
      /\.(svg|png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(f.relPath),
    )?.relPath;
  if (!media) return { ...style, references };
  const id =
    "material-" +
    createHash("sha256").update(detail.id).digest("hex").slice(0, 12);
  const assets = [
    ...(style.assets ?? []).filter((a) => a.id !== id),
    { id, path: media, materialId: detail.id, label: detail.title },
  ];
  if (assets.length > 12)
    throw new MovieError("A style supports up to 12 image or video assets.");
  const visual = structuredClone(
    style.visual ?? MOVIE_VISUALS[style.id] ?? MOVIE_VISUALS.collage!,
  );
  const empty = visual.layers.find(
    (l) => l.type === "image" && !assets.some((a) => a.id === l.assetId),
  );
  if (empty) empty.assetId = id;
  else if (!visual.layers.some((l) => l.assetId === id)) {
    visual.layers.push({
      id,
      type: "image",
      assetId: id,
      x: 61,
      y: 18,
      width: 31,
      height: 61,
      color: "accent",
      rotation: -4,
      enter: "scale",
      drift: "float",
    });
    visual.copy.width = Math.min(visual.copy.width, 46);
  }
  return { ...style, references, assets, visual };
}
export async function copyReusableStyle(
  style: MovieStyle,
  sourceDir: string,
  targetDir: string,
): Promise<MovieStyle> {
  const next = structuredClone(style);
  delete next.sourceProjectId;
  const sources = [
    ...new Set([
      ...(style.assets ?? []).map((a) => a.path),
      ...(style.demoShots??[]).flatMap(s=>s.media?[s.media]:[]),
      ...(style.references ?? []).flatMap((r) =>
        r.receipt ? [r.receipt] : [],
      ),
    ]),
  ];
  if (!sources.length) return next;
  const assetDir = path.join(targetDir, "assets");
  await mkdir(assetDir, { recursive: true });
  if ((await lstat(assetDir)).isSymbolicLink())
    throw new MovieError("Style asset folder cannot be a symlink");
  const relative = `assets/style-${randomUUID()}`,
    folder = path.join(targetDir, relative);
  await mkdir(folder);
  const paths = new Map<string, string>();
  let total = 0;
  for (const [i, source] of sources.entries()) {
    const file = await safeMovieAsset(sourceDir, source),
      info = await lstat(file);
    total += info.size;
    if (info.size > 20 * 1024 * 1024 || total > 64 * 1024 * 1024)
      throw new MovieError("Style assets exceed the copy limit");
    const name = `${i}-${path.basename(source)}`;
    await writeFile(path.join(folder, name), await readFile(file), {
      flag: "wx",
    });
    paths.set(source, `${relative}/${name}`);
  }
  if (next.assets)
    next.assets = next.assets.map((a) => ({ ...a, path: paths.get(a.path)! }));
  if(next.demoShots)next.demoShots=next.demoShots.map(s=>s.media?{...s,media:paths.get(s.media)!}:s);
  if (next.references)
    next.references = next.references.map((r) => ({
      ...r,
      ...(r.receipt ? { receipt: paths.get(r.receipt)! } : {}),
    }));
  return next;
}
