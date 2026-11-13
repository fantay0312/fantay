import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createMovieDocument,
  movieCurrentRender,
  movieDuration,
  MOVIE_MAX_CLIPS,
  MOVIE_MAX_DURATION,
  type MovieAction,
  type MovieDocument,
  type MovieSaveRequest,
  type MovieStyle,
  type MovieVisual,
  type MovieLayer,
  type MovieKeyframe,
  type MovieGradient,
} from "@open-design/contracts";
import {
  carryMovieHistory,
  hydrateMovieHistory,
  movieContentKey,
  recordMovieHistory,
  storedMovie,
  sameMovieShot,
} from "./edit-history.js";

const FILE = "movie-studio.json";
const locks = new Map<string, Promise<unknown>>();
export class MovieError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
function number(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label = "Visual parameter",
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new MovieError(
      `${label} (${String(value)}) must be a finite number between ${min} and ${max}`,
    );
  return value;
}
function relativePath(value: unknown, field: string): string {
  const result = text(value, field, 500, false);
  if (
    result.startsWith("/") ||
    result.includes("\\") ||
    /[:?#]/.test(result) ||
    result.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new MovieError("Asset path must stay inside the project");
  return result;
}
export function parseMovieKeyframes(value: unknown): MovieKeyframe[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    throw new MovieError("A motion track supports 1–16 keyframes");
  let previous = -1;
  return value.map((raw) => {
    const f = object(raw),
      at = number(f.at, 0, 0, 1);
    if (at <= previous)
      throw new MovieError("Keyframe times must be increasing");
    previous = at;
    const result: MovieKeyframe = { at };
    for (const key of ["x", "y"] as const)
      if (f[key] !== undefined) result[key] = number(f[key], 0, -150, 250);
    for (const key of ["width", "height"] as const)
      if (f[key] !== undefined) result[key] = number(f[key], 1, 0.01, 400);
    for (const key of ["scale", "scaleX", "scaleY"] as const)
      if (f[key] !== undefined) result[key] = number(f[key], 1, 0, 5);
    if (f.rotation !== undefined)
      result.rotation = number(f.rotation, 0, -720, 720);
    for (const key of ["rotationX", "rotationY"] as const)
      if (f[key] !== undefined) result[key] = number(f[key], 0, -180, 180);
    if (f.blur !== undefined) result.blur = number(f.blur, 0, 0, 5);
    if (f.opacity !== undefined) result.opacity = number(f.opacity, 1, 0, 1);
    if (f.draw !== undefined) result.draw = number(f.draw, 1, 0, 1);
    if (f.ease !== undefined) {
      if (
        ![
          "linear",
          "smooth",
          "out",
          "back",
          "inOut",
          "backIn",
          "elasticOut",
          "bounceOut",
        ].includes(String(f.ease))
      )
        throw new MovieError("Invalid keyframe ease");
      result.ease = f.ease as NonNullable<MovieKeyframe["ease"]>;
    }
    return result;
  });
}
function paintColor(value: unknown, none = false): string {
  if (
    typeof value !== "string" ||
    !(
      /^(background|foreground|accent)$/.test(value) ||
      /^#[\da-f]{6}$/i.test(value) ||
      (none && value === "none")
    )
  )
    throw new MovieError("Invalid material color");
  return value;
}
function parseGradient(value: unknown): MovieGradient {
  const g = object(value);
  if (
    !["linear", "radial"].includes(String(g.kind)) ||
    !Array.isArray(g.stops) ||
    g.stops.length < 2 ||
    g.stops.length > 8
  )
    throw new MovieError("A gradient needs 2–8 color stops");
  let last = -1;
  const stops = g.stops.map((raw) => {
    const s = object(raw),
      offset = number(s.offset, 0, 0, 1);
    if (offset < last) throw new MovieError("Gradient stops must be sorted");
    last = offset;
    return {
      offset,
      color: paintColor(s.color),
      ...(s.opacity === undefined
        ? {}
        : { opacity: number(s.opacity, 1, 0, 1) }),
    };
  });
  return {
    kind: g.kind as MovieGradient["kind"],
    stops,
    ...(g.angle === undefined ? {} : { angle: number(g.angle, 0, -360, 360) }),
    ...(g.cx === undefined ? {} : { cx: number(g.cx, 50, 0, 100) }),
    ...(g.cy === undefined ? {} : { cy: number(g.cy, 50, 0, 100) }),
    ...(g.radius === undefined ? {} : { radius: number(g.radius, 70, 1, 200) }),
  };
}
export function parseMovieVisual(value: unknown): MovieVisual {
  const v = object(value),
    c = object(v.copy);
  if (
    ![
      "poster",
      "editorial",
      "blueprint",
      "collage",
      "gallery",
      "kinetic",
      "organic",
      "minimal",
      "custom",
    ].includes(String(v.composition)) ||
    !["fade", "wipe", "slide", "cut", "crossfade", "iris"].includes(
      String(v.transition),
    )
  )
    throw new MovieError("Invalid visual composition");
  if (
    !["left", "center", "right"].includes(String(c.align)) ||
    !Array.isArray(v.layers) ||
    v.layers.length > 32
  )
    throw new MovieError("Invalid visual layers");
  const ids = new Set<string>();
  const layers = v.layers.map((raw) => {
    const l = object(raw),
      id = text(l.id, "layer id", 80, false);
    const unknown = Object.keys(l).filter(
      (key) =>
        ![
          "id",
          "type",
          "x",
          "y",
          "width",
          "height",
          "color",
          "opacity",
          "rotation",
          "radius",
          "stroke",
          "fill",
          "strokeColor",
          "gradient",
          "texture",
          "textureStrength",
          "shadow",
          "origin",
          "parentId",
          "rotationX",
          "rotationY",
          "blend",
          "teeth",
          "hole",
          "delay",
          "enter",
          "drift",
          "text",
          "assetId",
          "fit",
          "path",
          "keyframes",
        ].includes(key),
    );
    if (unknown.length)
      throw new MovieError(
        `Layer ${id} has unsupported fields: ${unknown.join(", ")}`,
      );
    if (ids.has(id)) throw new MovieError("Layer ids must be unique");
    ids.add(id);
    if (
      ![
        "rect",
        "ellipse",
        "line",
        "grid",
        "text",
        "path",
        "image",
        "group",
        "gear",
      ].includes(String(l.type))
    )
      throw new MovieError("Invalid layer type");
    if (
      typeof l.color !== "string" ||
      !(
        /^(background|foreground|accent)$/.test(l.color) ||
        /^#[\da-f]{6}$/i.test(l.color)
      )
    )
      throw new MovieError("Invalid layer color");
    const layer: MovieLayer = {
      id,
      type: l.type as MovieLayer["type"],
      x: number(l.x, 0, -100, 200),
      y: number(l.y, 0, -100, 200),
      width: number(
        l.width,
        l.type === "group" ? 100 : 10,
        0.01,
        300,
        `Layer ${id} width`,
      ),
      height: number(
        l.height,
        l.type === "group" ? 100 : 10,
        0.01,
        300,
        `Layer ${id} height`,
      ),
      color: l.color,
    };
    if (l.opacity !== undefined) layer.opacity = number(l.opacity, 1, 0, 1);
    if (l.rotation !== undefined)
      layer.rotation = number(l.rotation, 0, -360, 360);
    if (l.radius !== undefined) layer.radius = number(l.radius, 0, 0, 50);
    if (l.stroke !== undefined)
      layer.stroke = number(l.stroke, 0, 0, 5, `Layer ${id} stroke`);
    if (l.fill !== undefined) layer.fill = paintColor(l.fill, true);
    if (l.strokeColor !== undefined)
      layer.strokeColor = paintColor(l.strokeColor);
    if (l.gradient !== undefined) layer.gradient = parseGradient(l.gradient);
    if (l.texture !== undefined) {
      if (!["paper", "grain"].includes(String(l.texture)))
        throw new MovieError("Invalid surface texture");
      layer.texture = l.texture as "paper" | "grain";
    }
    if (l.textureStrength !== undefined)
      layer.textureStrength = number(l.textureStrength, 0.15, 0, 0.35);
    if (l.teeth !== undefined) {
      const teeth = number(l.teeth, 12, 4, 32);
      if (!Number.isInteger(teeth))
        throw new MovieError("Gear teeth must be an integer");
      layer.teeth = teeth;
    }
    if (l.hole !== undefined) layer.hole = number(l.hole, 0.3, 0, 0.8);
    if (l.shadow !== undefined) {
      const s = object(l.shadow);
      layer.shadow = {
        color: paintColor(s.color),
        opacity: number(s.opacity, 0.2, 0, 1),
        x: number(s.x, 0, -20, 20),
        y: number(s.y, 1, -20, 20),
        blur: number(s.blur, 1, 0, 5),
      };
    }
    if (l.origin !== undefined) {
      const o = object(l.origin);
      layer.origin = { x: number(o.x, 50, 0, 100), y: number(o.y, 50, 0, 100) };
    }
    if (l.parentId !== undefined)
      layer.parentId = text(l.parentId, "parent group", 80, false);
    for (const key of ["rotationX", "rotationY"] as const)
      if (l[key] !== undefined) layer[key] = number(l[key], 0, -180, 180);
    if (l.blend !== undefined) {
      if (!["normal", "multiply", "screen"].includes(String(l.blend)))
        throw new MovieError("Invalid material blend");
      layer.blend = l.blend as NonNullable<MovieLayer["blend"]>;
    }
    if (l.delay !== undefined) layer.delay = number(l.delay, 0, 0, 4);
    if (l.enter !== undefined) {
      if (!["fade", "rise", "slide", "scale", "draw"].includes(String(l.enter)))
        throw new MovieError("Invalid layer entrance");
      layer.enter = l.enter as NonNullable<MovieLayer["enter"]>;
    }
    if (l.drift !== undefined) {
      if (!["none", "float", "rotate", "pan"].includes(String(l.drift)))
        throw new MovieError("Invalid layer motion");
      layer.drift = l.drift as NonNullable<MovieLayer["drift"]>;
    }
    if (l.text !== undefined) layer.text = text(l.text, "layer text", 160);
    if (l.assetId !== undefined)
      layer.assetId = text(l.assetId, "layer asset", 120, false);
    if (l.fit !== undefined) {
      if (!["cover", "contain"].includes(String(l.fit)))
        throw new MovieError("Invalid image fit");
      layer.fit = l.fit as "cover" | "contain";
    }
    if (l.path !== undefined) {
      const p = text(l.path, "SVG path", 5000, false);
      if (!/^[MmLlHhVvCcSsQqTtAaZz\d\s,.+\-]+$/.test(p))
        throw new MovieError("Invalid SVG path");
      layer.path = p;
    }
    if (l.keyframes !== undefined)
      layer.keyframes = parseMovieKeyframes(l.keyframes);
    return layer;
  });
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (const layer of layers) {
    const seen = new Set([layer.id]);
    let parent = layer.parentId;
    while (parent) {
      if (seen.has(parent) || seen.size > 4)
        throw new MovieError(
          "Layer groups must be acyclic and at most four levels deep",
        );
      const found = byId.get(parent);
      if (!found || found.type !== "group")
        throw new MovieError(
          "parentId must reference a group in the same scene",
        );
      seen.add(parent);
      parent = found.parentId;
    }
  }
  return {
    composition: v.composition as MovieVisual["composition"],
    transition: v.transition as MovieVisual["transition"],
    copy: {
      x: number(c.x, 8, -20, 100),
      y: number(c.y, 25, -20, 100),
      width: number(c.width, 80, 5, 120),
      align: c.align as "left" | "center" | "right",
      titleSize: number(c.titleSize, 7, 1, 20),
      bodySize: number(c.bodySize, 1.8, 0.5, 6),
    },
    layers,
    ...(v.background === undefined
      ? {}
      : { background: paintColor(v.background) }),
    ...(v.foreground === undefined
      ? {}
      : { foreground: paintColor(v.foreground) }),
    ...(v.transitionDuration === undefined
      ? {}
      : { transitionDuration: number(v.transitionDuration, 0.45, 0.05, 1.5) }),
    ...(v.copyMode && ["title", "caption", "none"].includes(String(v.copyMode))
      ? { copyMode: v.copyMode as "title" | "caption" | "none" }
      : {}),
    ...(v.camera !== undefined
      ? { camera: parseMovieKeyframes(v.camera) }
      : {}),
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MovieError("Expected an object");
  return value as Record<string, unknown>;
}
function text(
  value: unknown,
  field: string,
  max: number,
  empty = true,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim())
  )
    throw new MovieError(`${field} is invalid`);
  return value;
}
export function parseMovieStyle(value: unknown): MovieStyle {
  const v = object(value);
  for (const key of ["background", "foreground", "accent"])
    if (typeof v[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(v[key] as string))
      throw new MovieError(`${key} must be a six-digit hex color`);
  if (
    !["sans", "serif", "mono"].includes(String(v.font)) ||
    !["rise", "slide", "scale"].includes(String(v.motion))
  )
    throw new MovieError("Invalid typography or motion");
  return {
    id: text(v.id, "style id", 120, false),
    name: text(v.name, "style name", 100, false),
    description: text(v.description, "description", 2000),
    background: v.background as string,
    foreground: v.foreground as string,
    accent: v.accent as string,
    font: v.font as MovieStyle["font"],
    motion: v.motion as MovieStyle["motion"],
    ...(v.aspect && ["16:9", "9:16", "1:1"].includes(String(v.aspect))
      ? { aspect: v.aspect as NonNullable<MovieStyle["aspect"]> }
      : {}),
    ...(v.source ? { source: text(v.source, "source", 2000) } : {}),
    ...(v.demoShots ? { demoShots: parseMovieShots(v.demoShots) } : {}),
    ...(v.visual ? { visual: parseMovieVisual(v.visual) } : {}),
    ...(v.typeface
      ? {
          typeface: (() => {
            const f = text(v.typeface, "typeface", 250, false);
            if (!/^[\p{L}\p{N}\s_,'".\-]+$/u.test(f))
              throw new MovieError("Invalid typeface");
            return f;
          })(),
        }
      : {}),
    ...(v.designSystem
      ? {
          designSystem: (() => {
            const d = object(v.designSystem);
            return {
              id: text(d.id, "design system", 120, false),
              tokenFile: relativePath(d.tokenFile, "token file"),
              digest: text(d.digest, "digest", 100, false),
            };
          })(),
        }
      : {}),
    ...(v.assets
      ? {
          assets: (() => {
            if (!Array.isArray(v.assets) || v.assets.length > MOVIE_MAX_CLIPS)
              throw new MovieError(`At most ${MOVIE_MAX_CLIPS} project assets`);
            const ids = new Set<string>();
            return v.assets.map((raw) => {
              const a = object(raw),
                id = text(a.id, "asset id", 120, false),
                p = relativePath(a.path, "asset path");
              if (
                ids.has(id) ||
                !/\.(svg|png|jpe?g|webp|gif|mp4|m4v|webm|mov|mp3|wav|m4a|aac|flac|ogg)$/i.test(p)
              )
                throw new MovieError("Invalid style asset");
              ids.add(id);
              return {
                id,
                path: p,
                ...(a.materialId
                  ? {
                      materialId: text(a.materialId, "material id", 200, false),
                    }
                  : {}),
                ...(a.label
                  ? { label: text(a.label, "asset label", 200) }
                  : {}),
              };
            });
          })(),
        }
      : {}),
    ...(v.references
      ? {
          references: (() => {
            if (!Array.isArray(v.references) || v.references.length > 20)
              throw new MovieError("At most 20 material references");
            return v.references.map((raw) => {
              const r = object(raw);
              return {
                materialId: text(r.materialId, "material id", 200, false),
                title: text(r.title, "material title", 300, false),
                license: text(r.license, "license", 4000),
                ...(r.source ? { source: text(r.source, "source", 2000) } : {}),
                ...(r.receipt
                  ? {
                      receipt: (() => {
                        const p = relativePath(r.receipt, "receipt");
                        if (
                          !/^(?:[0-9]+-)?fantasy-design-receipt\.json$/i.test(
                            path.basename(p),
                          )
                        )
                          throw new MovieError("Invalid material receipt");
                        return p;
                      })(),
                    }
                  : {}),
                ...(r.licenseText
                  ? { licenseText: text(r.licenseText, "license text", 20000) }
                  : {}),
              };
            });
          })(),
        }
      : {}),
  };
}
export function parseMovieShots(value: unknown): MovieDocument["shots"] {
  if (!Array.isArray(value) || value.length > MOVIE_MAX_CLIPS)
    throw new MovieError(`A movie supports up to ${MOVIE_MAX_CLIPS} clips`);
  const seen = new Set<string>();
  const shots = value.map((value) => {
    const shot = object(value);
    const id = text(shot.id, "shot id", 100, false);
    if (seen.has(id)) throw new MovieError("Shot ids must be unique");
    seen.add(id);
    if (
      typeof shot.duration !== "number" ||
      !Number.isFinite(shot.duration) ||
      shot.duration < 1 / 60 ||
      shot.duration > MOVIE_MAX_DURATION
    )
      throw new MovieError("Clip duration must be at least 1/60 second and at most four hours");
    if (
      !["title", "statement", "metric", "split"].includes(String(shot.layout))
    )
      throw new MovieError("Invalid shot layout");
    const media = shot.media
      ? text(shot.media, "media", 500, false)
      : undefined;
    if (
      media &&
      (media.startsWith("/") ||
        media.includes("\\") ||
        media.split("/").some((p) => !p || p === ".." || p === ".") ||
        !/\.(svg|png|jpe?g|webp|gif|mp4|m4v|webm|mov|mp3|wav|m4a|aac|flac|ogg)$/i.test(media) ||
        /[:?#]/.test(media))
    )
      throw new MovieError("Media must be a project-relative image, audio or video");
    return {
      id,
      ...(shot.kind === "text" ? { kind: "text" as const } : {}),
      ...(shot.locked!==undefined?{locked:(()=>{if(typeof shot.locked!=='boolean')throw new MovieError('locked must be boolean');return shot.locked;})()}:{}),
      ...(shot.textAnimation!==undefined?{textAnimation:(()=>{if(!['none','fade','rise','slide','typewriter'].includes(String(shot.textAnimation)))throw new MovieError('Invalid text animation');return shot.textAnimation as 'none'|'fade'|'rise'|'slide'|'typewriter';})()}:{}),
      ...(shot.captionStyle!==undefined?{captionStyle:(()=>{const s=object(shot.captionStyle);for(const key of ['color','background'])if(!/^#[0-9a-f]{6}$/i.test(String(s[key])))throw new MovieError('Caption colors must be six-digit hex');if(!['left','center','right'].includes(String(s.align)))throw new MovieError('Invalid caption alignment');return{fontSize:number(s.fontSize,42,12,160),color:String(s.color),background:String(s.background),backgroundOpacity:number(s.backgroundOpacity,.65,0,1),y:number(s.y,85,0,95),outline:number(s.outline,0,0,6),align:s.align as 'left'|'center'|'right'};})()}:{}),
      title: text(shot.title, "shot title", 300),
      body: text(shot.body, "shot body", 1200),
      ...(shot.direction !== undefined
        ? { direction: text(shot.direction, "shot direction", 2000) }
        : {}),
      duration: shot.duration,
      layout: shot.layout as MovieDocument["shots"][number]["layout"],
      ...(shot.placement ? { placement: (() => {
        const p = object(shot.placement);
        const track = number(p.track, 0, 0, 7);
        if (!Number.isInteger(track)) throw new MovieError("Track must be an integer from 0 to 7");
        return { start: number(p.start, 0, 0, MOVIE_MAX_DURATION), track };
      })() } : {}),
      ...(media ? { media } : {}),
      ...(shot.clip
        ? {
            clip: (() => {
              const c = object(shot.clip);
              for (const flag of ["audioOnly", "muted"])
                if (c[flag] !== undefined && typeof c[flag] !== "boolean") throw new MovieError(`Invalid clip ${flag}`);
              if (!["cover", "contain"].includes(String(c.fit)))
                throw new MovieError("Invalid video fit");
              return {
                assetId: text(c.assetId, "video asset", 120, false),
                in: number(c.in, 0, 0, 86400),
                rate: number(c.rate, 1, 0.25, 4),
                volume: number(c.volume, 0, 0, 1),
                fit: c.fit as "cover" | "contain",
                ...(c.x !== undefined ? { x: number(c.x, 0, -150, 250) } : {}),
                ...(c.y !== undefined ? { y: number(c.y, 0, -150, 250) } : {}),
                ...(c.width !== undefined ? { width: number(c.width, 100, 1, 400) } : {}),
                ...(c.height !== undefined ? { height: number(c.height, 100, 1, 400) } : {}),
                ...(c.opacity !== undefined ? { opacity: number(c.opacity, 1, 0, 1) } : {}),
                ...(c.audioOnly !== undefined ? { audioOnly: c.audioOnly === true } : {}),
                ...(c.muted !== undefined ? { muted: c.muted === true } : {}),
                ...(c.fadeIn !== undefined ? { fadeIn: number(c.fadeIn, 0, 0, Number(shot.duration)) } : {}),
                ...(c.fadeOut !== undefined ? { fadeOut: number(c.fadeOut, 0, 0, Number(shot.duration)) } : {}),
                ...(c.audioFadeIn !== undefined ? { audioFadeIn: number(c.audioFadeIn, 0, 0, Number(shot.duration)) } : {}),
                ...(c.audioFadeOut !== undefined ? { audioFadeOut: number(c.audioFadeOut, 0, 0, Number(shot.duration)) } : {}),
                ...(c.rotation !== undefined ? { rotation: number(c.rotation, 0, -360, 360) } : {}),
                ...(c.crop !== undefined ? { crop: (() => {
                  const crop=object(c.crop);return {top:number(crop.top,0,0,.45),right:number(crop.right,0,0,.45),bottom:number(crop.bottom,0,0,.45),left:number(crop.left,0,0,.45)};
                })() } : {}),
                ...(c.color !== undefined ? { color: (() => {
                  const color=object(c.color);return {exposure:number(color.exposure,0,-3,3),contrast:number(color.contrast,1,0,3),saturation:number(color.saturation,1,0,3),blur:number(color.blur,0,0,30),grayscale:number(color.grayscale,0,0,1)};
                })() } : {}),
                ...(c.keyframes !== undefined ? { keyframes: (() => {
                  if(!Array.isArray(c.keyframes)||c.keyframes.length>64)throw new MovieError('A clip supports up to 64 linear keyframes');
                  let previous=-1;
                  return c.keyframes.map(raw=>{const f=object(raw),at=number(f.at,0,0,1);if(at<=previous)throw new MovieError('Clip keyframes must be ordered');previous=at;
                    if(Object.keys(f).some(k=>!['at','x','y','width','height','rotation','opacity'].includes(k)))throw new MovieError('Clip keyframes support position, size, rotation and opacity');
                    return {at,...(f.x!==undefined?{x:number(f.x,0,-150,250)}:{}),...(f.y!==undefined?{y:number(f.y,0,-150,250)}:{}),...(f.width!==undefined?{width:number(f.width,100,1,400)}:{}),...(f.height!==undefined?{height:number(f.height,100,1,400)}:{}),...(f.rotation!==undefined?{rotation:number(f.rotation,0,-360,360)}:{}),...(f.opacity!==undefined?{opacity:number(f.opacity,1,0,1)}:{})};
                  });
                })() } : {}),
              };
            })(),
          }
        : {}),
      ...(shot.captions
        ? {
            captions: (() => {
              if (!Array.isArray(shot.captions) || shot.captions.length > 2000)
                throw new MovieError("At most 2000 captions per clip");
              let end = 0;
              const captionIds = new Set<string>();
              return shot.captions.map((raw, index) => {
                const c = object(raw),
                  start = number(c.start, 0, 0, shot.duration as number),
                  finish = number(c.end, 0, 0, shot.duration as number);
                if (start < end || finish <= start)
                  throw new MovieError(
                    "Captions must be ordered, non-overlapping and inside the shot",
                  );
                end = finish;
                const captionId =
                  c.id === undefined
                    ? `${id}-caption-${index + 1}`
                    : text(c.id, "caption id", 160, false);
                if (captionIds.has(captionId))
                  throw new MovieError(
                    "Caption ids must be unique within a shot",
                  );
                captionIds.add(captionId);
                return {
                  id: captionId,
                  start,
                  end: finish,
                  text: text(c.text, "caption", 300, false),
                };
              });
            })(),
          }
        : {}),
      ...(shot.visual ? { visual: parseMovieVisual(shot.visual) } : {}),
    };
  });
  if (movieDuration({ shots }) > MOVIE_MAX_DURATION)
    throw new MovieError("Movie duration cannot exceed four hours");
  return shots;
}
export function parseMovieInput(value: unknown): MovieSaveRequest["document"] {
  const v = object(value);
  if (!["library", "remix", "personal", "blank"].includes(String(v.startMode)))
    throw new MovieError("Invalid start mode");
  if (!["16:9", "9:16", "1:1"].includes(String(v.aspect)))
    throw new MovieError("Invalid aspect ratio");
  const shots = parseMovieShots(v.shots);
  return {
    title: text(v.title, "title", 200, false),
    brief: text(v.brief, "brief", 12000),
    startMode: v.startMode as MovieDocument["startMode"],
    aspect: v.aspect as MovieDocument["aspect"],
    style: parseMovieStyle(v.style),
    shots,
    ...(v.settings ? { settings: (() => {
      const s = object(v.settings), rate = object(s.frameRate);
      const width = number(s.width, 1920, 64, 7680), height = number(s.height, 1080, 64, 7680);
      const numerator = number(rate.numerator, 30, 1, 240000), denominator = number(rate.denominator, 1, 1, 10000);
      if (![width, height, numerator, denominator].every(Number.isInteger) || numerator / denominator < 1 || numerator / denominator > 120)
        throw new MovieError("Choose an integer resolution and a frame rate from 1 to 120 fps");
      return { width, height, frameRate: { numerator, denominator } };
    })() } : {}),
  };
}
async function assertRegular(file: string, missing = true): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)
      throw new MovieError("Movie files must be regular files");
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
export async function safeMovieAsset(
  projectDir: string,
  relative: string,
): Promise<string> {
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep))
    throw new MovieError("Asset is outside the project");
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep)) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink())
      throw new MovieError("Symbolic link assets are not supported");
  }
  await assertRegular(resolved, false);
  return resolved;
}
export async function readMovie(
  projectDir: string,
): Promise<MovieDocument | null> {
  const file = path.join(projectDir, FILE);
  await assertRegular(file);
  try {
    const doc = JSON.parse(await readFile(file, "utf8")) as MovieDocument;
    for (const shots of [
      doc.shots,
      doc.style?.demoShots,
      ...(doc.savedStyles ?? []).map((s) => s.demoShots),
    ])
      for (const shot of shots ?? [])
        if (shot.captions)
          shot.captions = shot.captions.map((c, i) => ({
            ...c,
            id: c.id ?? `${shot.id}-caption-${i + 1}`,
          }));
    return hydrateMovieHistory(doc);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function writeMovie(
  projectDir: string,
  doc: MovieDocument,
): Promise<MovieDocument> {
  const file = path.join(projectDir, FILE);
  await mkdir(projectDir, { recursive: true });
  await assertRegular(file);
  const temp = path.join(projectDir, `.movie-${randomUUID()}.tmp`);
  doc.updatedAt = new Date().toISOString();
  doc.revision++;
  await writeFile(temp, `${JSON.stringify(storedMovie(doc), null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temp, file);
  return doc;
}
export async function mutateMovie(
  projectDir: string,
  expected: number | undefined,
  mutate: (doc: MovieDocument | null) => Promise<MovieDocument> | MovieDocument,
): Promise<MovieDocument> {
  const previous = locks.get(projectDir) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const doc = await readMovie(projectDir);
      if (expected !== undefined && expected !== (doc?.revision ?? 0))
        throw new MovieError(
          "The movie changed in another window. Reload before saving.",
          409,
        );
      const next = await mutate(doc);
      carryMovieHistory(doc, next);
      return writeMovie(projectDir, next);
    });
  locks.set(projectDir, pending);
  try {
    return await pending;
  } finally {
    if (locks.get(projectDir) === pending) locks.delete(projectDir);
  }
}
export async function saveMovie(
  projectDir: string,
  body: unknown,
): Promise<MovieDocument> {
  const v = object(body);
  if (!Number.isInteger(v.expectedRevision) || Number(v.expectedRevision) < 0)
    throw new MovieError("expectedRevision is required");
  const input = parseMovieInput(v.document);
  return mutateMovie(projectDir, Number(v.expectedRevision), (doc) => {
    if (!doc)
      return {
        ...createMovieDocument(input.title, input.startMode, input.style),
        ...input,
      };
    return applyMovieEdit(doc, input);
  });
}
export function applyMovieEdit(
  doc: MovieDocument,
  input: MovieSaveRequest["document"],
  options: { history?: boolean; label?: string } = {},
): MovieDocument {
  if(options.history!==false)for(const before of doc.shots.filter(s=>s.locked)){
    const after=input.shots.find(s=>s.id===before.id);
    if(after?.locked!==false&&!sameMovieShot(before,after))throw new MovieError('This clip is locked. Unlock it before changing its content or timing.');
  }
  const changed = movieContentKey(doc) !== movieContentKey(input);
  const next: MovieDocument = {
    ...doc,
    ...input,
    ...(doc.authored || doc.startMode === "blank" || input.startMode === "blank"
      ? { authored: true }
      : {}),
    contentRevision: doc.contentRevision + (changed ? 1 : 0),
    ...(changed
      ? {
          storyboardApproved: null,
          samplesApproved: null,
          approvedRenderId: null,
          delivery: null,
          stylePreview: null,
        }
      : {}),
  };
  return options.history === false
    ? next
    : recordMovieHistory(doc, next, options.label);
}
export async function applyMovieAction(
  projectDir: string,
  expected: number,
  action: MovieAction,
): Promise<MovieDocument> {
  return mutateMovie(projectDir, expected, async (doc) => {
    if (!doc) throw new MovieError("Create a movie first", 404);
    switch (action.action) {
      case "approve-storyboard":
        if (!doc.shots.length || doc.shots.some((s) => !s.title.trim()))
          throw new MovieError("Add a title to every shot first");
        doc.storyboardApproved = doc.contentRevision;
        break;
      case "approve-samples":
        if (doc.storyboardApproved !== doc.contentRevision)
          throw new MovieError("Confirm the current storyboard first");
        doc.samplesApproved = doc.contentRevision;
        break;
      case "save-style": {
        if (!doc.shots.length)
          throw new MovieError(
            "Design at least one scene before saving a style",
          );
        if (
          doc.authored ||
          doc.startMode === "blank" ||
          doc.style.id.startsWith("ai-")
        ) {
          const preview = doc.stylePreview;
          if (
            !preview ||
            preview.contentRevision !== doc.contentRevision ||
            !preview.frames.length ||
            !doc.shots.every((s) => preview.shotIds?.includes(s.id))
          )
            throw new MovieError(
              "Preview the current scenes before saving this new style",
            );
          const { movieAssetDigest } = await import("./assets.js");
          if (preview.assetDigest !== (await movieAssetDigest(projectDir, doc)))
            throw new MovieError(
              "The assets changed. Preview this style again.",
              409,
            );
        }
        const key = (style: MovieStyle) =>
          JSON.stringify({
            ...style,
            id: undefined,
            sourceProjectId: undefined,
            snapshotKey: undefined,
          });
        const candidate = {
          ...doc.style,
          demoShots: structuredClone(doc.shots),
          aspect: doc.aspect,
        };
        const { movieAssetDigest } = await import("./assets.js");
        const assetDigest = await movieAssetDigest(projectDir, doc);
        const snapshotKey = createHash("sha256")
          .update(JSON.stringify([key(candidate), assetDigest]))
          .digest("hex");
        if (
          doc.savedStyles.some(
            (style) =>
              style.snapshotKey === snapshotKey ||
              key(style) === key(candidate),
          )
        )
          break;
        const id = `personal-${randomUUID()}`;
        const { snapshotMovieStyle } = await import("./style-snapshot.js");
        const style = {
          ...(await snapshotMovieStyle(projectDir, doc, id, assetDigest)),
          id,
          snapshotKey,
        };
        doc.savedStyles = [...doc.savedStyles.slice(-49), style];
        break;
      }
      case "add-note":
        await (
          await import("./review.js")
        ).appendReviewNote(projectDir, doc, action);
        break;
      case "resolve-note": {
        const note = doc.notes.find((n) => n.id === action.noteId);
        if (!note) throw new MovieError("Review note not found", 404);
        const target = action.renderId ?? note.addressedRenderId;
        if (target) {
          if (!doc.renders.some((r) => r.id === target && r.status === "done"))
            throw new MovieError("Choose a completed revision");
          if (note.addressedRenderId && target !== note.addressedRenderId)
            throw new MovieError("Confirm the version produced for this note");
          note.resolvedInRenderId = target;
        }
        note.resolved = true;
        break;
      }
      case "approve-review": {
        const current = movieCurrentRender(doc);
        if (!current)
          throw new MovieError("Render the current edit before approving");
        if (doc.notes.some((n) => !n.resolved))
          throw new MovieError("Resolve outstanding review notes first");
        doc.approvedRenderId = current.id;
        break;
      }
      default:
        throw new MovieError("Unknown movie action");
    }
    return doc;
  });
}
