import { randomUUID } from "node:crypto";
import type { MovieDocument } from "@open-design/contracts";
import {
  applyMovieEdit,
  MovieError,
  mutateMovie,
  parseMovieInput,
} from "./store.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MovieError("Expected an authoring object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new MovieError(
      `Unknown authoring field(s): ${Object.keys(value)
        .filter((key) => !allowed.includes(key))
        .join(
          ", ",
        )}. Allowed: ${allowed.join(", ")}. Production and approval fields cannot be edited.`,
    );
}

/** The same atomic operation is used by Harness, MCP and CLI. */
export async function authorMovie(
  dir: string,
  value: unknown,
): Promise<MovieDocument> {
  const input = record(value);
  keys(input, ["expectedRevision", "style", "shots"]);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 0
  )
    throw new MovieError("expectedRevision is required");
  if (!input.style && !input.shots)
    throw new MovieError("Provide a style or authored shots");
  return mutateMovie(dir, Number(input.expectedRevision), (current) => {
    if (!current) throw new MovieError("Create a film first", 404);
    const { demoShots: _, sourceProjectId: __, ...baseStyle } = current.style;
    let style = {
      ...baseStyle,
      id: current.style.id.startsWith("ai-")
        ? current.style.id
        : `ai-${randomUUID()}`,
    };
    if (input.style) {
      const patch = record(input.style);
      keys(patch, [
        "name",
        "description",
        "background",
        "foreground",
        "accent",
        "font",
        "motion",
        "visual",
      ]);
      style = { ...style, ...patch };
    }
    let shots = current.shots;
    if (input.shots) {
      const patch = record(input.shots);
      keys(patch, ["mode", "items"]);
      if (
        !["replace", "upsert"].includes(String(patch.mode)) ||
        !Array.isArray(patch.items) ||
        !patch.items.length
      )
        throw new MovieError(
          "Provide nonempty shots.items with mode replace or upsert",
        );
      const seen = new Set<string>();
      for (const raw of patch.items) {
        const shot = record(raw);
        keys(shot, [
          "id",
          "title",
          "body",
          "direction",
          "duration",
          "layout",
          "media",
          "clip",
          "captions",
          "visual",
        ]);
        if (typeof shot.id !== "string" || seen.has(shot.id))
          throw new MovieError("Authored shot IDs must be unique");
        seen.add(shot.id);
      }
      if (patch.mode === "replace")
        shots = patch.items as MovieDocument["shots"];
      else {
        const updates = new Map(
          patch.items.map((raw) => {
            const item = record(raw);
            return [item.id, raw];
          }),
        );
        shots = [
          ...current.shots.map((s) => updates.get(s.id) ?? s),
          ...patch.items.filter(
            (raw) => !current.shots.some((s) => s.id === record(raw).id),
          ),
        ] as MovieDocument["shots"];
      }
    }
    const next = parseMovieInput({ ...current, style, shots });
    const assets = new Set(next.style.assets?.map((a) => a.id));
    for (const shot of next.shots) {
      if (
        shot.clip &&
        !next.style.assets?.some(
          (a) =>
            a.id === shot.clip!.assetId && /\.(mp4|mov|webm)$/i.test(a.path),
        )
      )
        throw new MovieError("Choose an imported video asset for the clip");
    }
    for (const visual of [
      next.style.visual,
      ...next.shots.map((s) => s.visual),
    ])
      for (const layer of visual?.layers ?? [])
        if (layer.assetId && !assets.has(layer.assetId))
          throw new MovieError(
            "Import the material before referencing its asset ID",
          );
    const edited = applyMovieEdit(current, next, { label: "AI scene edit" });
    edited.authored = true;
    return edited;
  });
}

export const MOVIE_AUTHORING_GUIDE = {
  videoEditing:
    "For footage use fantay_movie_sources first and inspect its frames. Each shot can use clip:{assetId,in,rate:.25..4,volume:0..1,fit:cover|contain}; duration is output seconds, source out=in+duration*rate. Never exceed source duration. Captions are ordered [{start,end,text}] in local output seconds. Author your own explanatory copy only when requested; use fantay_movie_transcribe for original speech, then map transcript source timestamps through the clip in/rate. Full-frame footage sits below visual overlay layers. Keep text sparse, use contrast plates, arrows and deliberate transitions. Preserve clip/captions in an upsert unless intentionally editing them.",
  purpose:
    "Invent a finished short film, not a diagram. Do not select or copy a built-in film. Design the subjects, events, lighting, camera and motion, then author each scene. This is structured code animation, not arbitrary HTML or shell.",
  artDirection: [
    "Unless explicitly requested, do not use wireframes, grids, stroke-only circles or long blank introductions. The first shot must show a recognizable, substantial subject.",
    "Build solid silhouettes with filled surfaces, tonal gradients, edge highlights and directional contact shadows. Use background, middle ground and foreground; let the subject occupy the frame. Choose a coherent 3–5 color palette.",
    "Use groups for rigid multi-part objects and origin for hinges. Motion should have anticipation, a main action, follow-through and a brief settle. Keep spring/bounce subtle and intentional, not on every object.",
    "Connect shots through the same subject, direction of travel, color or shape. Use cut for an intentional match cut, crossfade for a real dissolve, wipe/iris for a reveal. Avoid fading to blank between every shot.",
    "Create the whole story before reviewing. Consolidate fixes into one inspection pass and one confirmation pass; do not keep restarting calibration or adding new concepts. Keep on-screen text sparse and subordinate to the imagery.",
  ],
  workflow: [
    "Read the film and this guide.",
    "During Build, publish a complete playable scene skeleton early, then use fantay_movie_author with shots.mode=upsert to finish scenes one at a time. The desktop previews every committed checkpoint without an MP4. Only use replace when establishing a new storyboard or explicitly replacing it; never erase existing human edits to show progress. Each upsert item is a complete shot read from the latest document. Preserve stable shot, layer and caption IDs, placement and unrelated fields. Keep using the returned revision; re-read and reconcile conflicts instead of overwriting.",
    "For live feedback, use the selected notes from feedback-prompt/movie_feedback_prompt. They contain source times and content revisions. Edit the source and preview the affected moments; do not produce an MP4, approve delivery or resolve comments unless the user explicitly asks. The user confirms the result.",
    "Every shot needs direction (what visibly happens), a unique original visual, and timed object motion. Keep captions secondary to the moving artwork.",
    "Preview all scenes with fantay_movie_preview. Inspect representative project-local PNGs with read_image; revise a scene via author upsert if necessary.",
    "After a successful current preview, save the full animation with fantay_movie_save_style. Use the returned/latest revision. Never approve review or delivery.",
  ],
  author: {
    expectedRevision: "Exact latest integer revision",
    style:
      "Optional name, description, background/foreground/accent (#rrggbb), font (sans/serif/mono), motion (rise/slide/scale), visual. Imported assets and evidence are retained automatically.",
    shots: {
      mode: "replace replaces the storyboard; upsert replaces an existing shot by id or appends a new shot",
      items:
        "Complete shots: id, title, body, direction, duration (1..30 seconds), layout (title/statement/metric/split), visual. Up to 60 shots / 300 seconds.",
    },
  },
  visual: {
    composition: "custom",
    copy: "{x,y,width,align:left|center|right,titleSize,bodySize}. Coordinates and font sizes are percentages of the canvas width. Reserve an unobstructed caption zone.",
    copyMode: "caption | none | title",
    transition:
      "cut | crossfade | wipe | iris (preferred for connected shots), or legacy fade/slide. transitionDuration is seconds, .05..1.5. Crossfade/wipe/iris hold this scene at its end and reveal the next over that interval; total film duration does not grow. Optional background and foreground = palette token or #rrggbb; keep captions readable on each scene.",
    layers:
      "Up to 32 layers per scene. Types rect, ellipse, line, grid, text, path, image, group, gear. Required: id,type,x,y,width,height,color. Percent positions; positive sizes. color = background/foreground/accent or #rrggbb. Gear uses teeth:4..32(integer), hole:0..0.8; its toothed solid silhouette is generated locally, so no coordinate calculations or Python are needed. A full-canvas group uses x:0,y:0,width:100,height:100; children use parentId and coordinates relative to that group. Groups can nest up to four levels; no cycles.",
    optionalLayerFields:
      "opacity:0..1, rotation:-360..360, rotationX/rotationY:-180..180, origin:{x,y} in0..100 (% of layer), radius:0..50, stroke:0..5 (% canvas width), strokeColor, fill (#rrggbb/palette/none), text(max160), path(SVG d,0..1000 coordinates), assetId(imported only), fit:contain|cover, blend:normal|multiply|screen. A path with stroke is hollow unless fill or gradient is explicit. No markup, raw CSS, URLs or scripts.",
    materials:
      "gradient:{kind:linear|radial,angle?:degrees (0 left-to-right,90 top-to-bottom),cx?:0..100,cy?:0..100,radius?:1..200,stops:[{offset:0..1,color,opacity?:0..1}]}. Use 2–8 sorted stops. shadow:{color,opacity:0..1,x:-20..20,y:-20..20,blur:0..5}; x,y,blur are % of canvas width. texture:paper|grain and textureStrength:0..0.35 add subtle deterministic surface marks to filled shapes. Use texture sparingly on broad surfaces. For depth, combine differently colored filled faces rather than just outlining them.",
    keyframes:
      "keyframes:[{at:0,...},{at:.5,...},{at:1,...}],1..16 strictly increasing normalized times. Properties x,y,width,height (%), scale/scaleX/scaleY:0..5, rotation:-720..720, rotationX/rotationY:-180..180, blur:0..5 (% canvas width), opacity:0..1, draw:0..1 for stroke paths. ease:linear|smooth|out|back|inOut|backIn|elasticOut|bounceOut. Set initial values at0; hold them until a delayed action. Animate actual subjects, not a shared slide entrance.",
    camera:
      "Optional keyframes with scale, x,y,rotation. Camera x/y are offsets in % from the base framing; object x/y are absolute positions. Camera affects artwork, captions stay fixed. Shape layers rotate around their own center.",
  },
};
