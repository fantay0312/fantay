import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMovieHtml,
  createMovieDocument,
  movieTransitionDuration,
  type MovieDocument,
  type MovieLayer,
  type MovieVisual,
} from "@open-design/contracts";
import { parseMovieInput } from "../../src/movie/store.js";
import { moviePreviewTimes } from "../../src/movie/style-preview.js";
const require = createRequire(import.meta.url),
  { JSDOM } = require("jsdom");
const visual = (layers: MovieLayer[] = []): MovieVisual => ({
  composition: "custom",
  copyMode: "none",
  copy: { x: 8, y: 80, width: 84, align: "left", titleSize: 3, bodySize: 1 },
  transition: "cut",
  layers,
});
const shape: MovieLayer = {
  id: "body",
  type: "rect",
  x: 30,
  y: 30,
  width: 40,
  height: 35,
  color: "foreground",
  fill: "#aa3828",
  stroke: 0.1,
  strokeColor: "#efbd83",
  gradient: {
    kind: "linear",
    angle: 90,
    stops: [
      { offset: 0, color: "#ef805b" },
      { offset: 1, color: "#6f201a" },
    ],
  },
  shadow: { color: "#24120d", opacity: 0.3, x: 1, y: 1.2, blur: 1 },
  origin: { x: 50, y: 90 },
  texture: "paper",
  textureStrength: 0.18,
};
function film(): MovieDocument {
  const d = createMovieDocument("Cinema", "blank");
  d.shots = [
    {
      id: "a",
      title: "",
      body: "",
      duration: 4,
      layout: "title",
      visual: visual(),
    },
    {
      id: "b",
      title: "",
      body: "",
      duration: 4,
      layout: "title",
      visual: visual(),
    },
  ];
  return d;
}
function withDom(d: MovieDocument, fn: (w: any) => void) {
  const dom = new JSDOM(buildMovieHtml(d), {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  try {
    dom.window.eval(
      readFileSync(require.resolve("gsap/dist/gsap.min.js"), "utf8"),
    );
    dom.window.eval(
      [...dom.window.document.scripts].find((s) => !s.src)!.textContent!,
    );
    fn(dom.window);
  } finally {
    dom.window.__timelines?.main?.kill();
    dom.window.gsap?.ticker.sleep();
    dom.window.close();
  }
}
describe("Cinematic materials and transitions", () => {
  it("keeps transition clips active for the compositor but freezes media at its original duration", () => {
    const d = film();
    d.shots[0]!.visual!.transition = "crossfade";
    d.shots[0]!.visual!.transitionDuration = 0.4;
    d.shots[0]!.media = "clip.mp4";
    const dom = new JSDOM(buildMovieHtml(d));
    try {
      expect(dom.window.document.querySelector("#root").dataset.duration).toBe(
        "8",
      );
      expect(
        dom.window.document.querySelector("#shot-0").dataset.duration,
      ).toBe("4.4");
      const video = dom.window.document.querySelector("video");
      expect(video.dataset.duration).toBe("4.4");
      expect(video.dataset.playDuration).toBe("4");
    } finally {
      dom.window.close();
    }
  });
  it("preserves filled surfaces, edge color, gradients, shadows and linked parts", () => {
    const d = film();
    d.shots[0]!.visual = visual([
      {
        id: "object",
        type: "group",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        color: "foreground",
        origin: { x: 50, y: 70 },
        keyframes: [
          { at: 0, scaleX: 0.7 },
          { at: 1, scaleX: 1, ease: "back" },
        ],
      },
      { ...shape, parentId: "object" },
      {
        ...shape,
        id: "gear",
        type: "gear",
        teeth: 12,
        hole: 0.3,
        parentId: "object",
      },
    ]);
    const parsed = parseMovieInput(d);
    expect(parsed.shots[0]!.visual).toEqual(d.shots[0]!.visual);
    withDom(d, (w) => {
      const group = w.document.querySelector('[data-layer="0"]'),
        body = group.querySelector('[data-layer="1"]');
      expect(body.parentElement).toBe(group);
      expect(body.querySelector("rect").getAttribute("fill")).toMatch(
        /^url\(#paint-/,
      );
      expect(body.querySelector("rect").getAttribute("stroke")).toBe("#efbd83");
      expect(body.style.filter).toContain("drop-shadow");
      expect(w.getComputedStyle(body).overflow).toBe("visible");
      w.__timelines.main.pause(2);
      expect(w.gsap.getProperty(group, "scaleX")).toBeGreaterThan(1);
    });
  });
  it("rejects injected paint/filter values and cyclic groups", () => {
    for (const changes of [
      { fill: "url(https://bad.test)" },
      { shadow: { ...shape.shadow!, color: "red;display:none" } },
      {
        gradient: {
          kind: "linear",
          stops: [
            { offset: 1, color: "#ffffff" },
            { offset: 0, color: "#000000" },
          ],
        },
      },
      { type: "gear", teeth: 4.5 },
      { parentId: "missing" },
    ]) {
      const d = film();
      d.shots[0]!.visual = visual([{ ...shape, ...changes } as MovieLayer]);
      expect(() => parseMovieInput(d)).toThrow();
    }
    const d = film();
    d.shots[0]!.visual = visual([
      { ...shape, id: "a", type: "group", parentId: "b" },
      { ...shape, id: "b", type: "group", parentId: "a" },
    ]);
    expect(() => parseMovieInput(d)).toThrow("acyclic");
  });
  it("crossfades over a held previous scene, is reversible and does not extend the film", () => {
    const d = film();
    d.shots[0]!.visual!.transition = "crossfade";
    d.shots[0]!.visual!.transitionDuration = 0.4;
    d.shots[0]!.visual!.background = "#ff0000";
    d.shots[1]!.visual!.background = "#0000ff";
    expect(movieTransitionDuration(d, 0)).toBe(0.4);
    expect(moviePreviewTimes(d, { motion: true })).toContain(4.2);
    withDom(d, (w) => {
      const a = w.document.querySelector("#shot-0"),
        b = w.document.querySelector("#shot-1"),
        tl = w.__timelines.main;
      expect(tl.duration()).toBe(8);
      tl.pause(3.9);
      expect(Number(a.style.opacity)).toBe(1);
      tl.pause(4.2);
      expect(Number(a.style.opacity)).toBe(1);
      expect(Number(b.style.opacity)).toBeCloseTo(0.5, 2);
      tl.pause(4.5);
      expect(a.style.visibility).toBe("hidden");
      tl.pause(1);
      tl.pause(4.2);
      expect(Number(b.style.opacity)).toBeCloseTo(0.5, 2);
    });
  });
  it.each(["cut", "wipe", "iris"] as const)(
    "%s avoids a blank boundary",
    (transition) => {
      const d = film();
      d.shots[0]!.visual!.transition = transition;
      d.shots[0]!.visual!.transitionDuration = 0.4;
      withDom(d, (w) => {
        const a = w.document.querySelector("#shot-0"),
          b = w.document.querySelector("#shot-1"),
          tl = w.__timelines.main;
        tl.pause(4.2);
        expect(Number(b.style.opacity)).toBe(1);
        if (transition === "cut") expect(a.style.visibility).toBe("hidden");
        else {
          expect(Number(a.style.opacity)).toBe(1);
          expect(b.style.clipPath).toContain(
            transition === "iris" ? "circle" : "inset",
          );
        }
        tl.pause(4.5);
        expect(a.style.visibility).toBe("hidden");
      });
    },
  );
});
