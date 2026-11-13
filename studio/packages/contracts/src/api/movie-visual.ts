/** Percent-based, code-native art direction. No arbitrary HTML, CSS or scripts. */
export interface MovieLayer {
  id: string;
  type:
    | "rect"
    | "ellipse"
    | "line"
    | "grid"
    | "text"
    | "path"
    | "image"
    | "group"
    | "gear";
  teeth?: number;
  hole?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity?: number;
  rotation?: number;
  radius?: number;
  stroke?: number;
  fill?: string;
  strokeColor?: string;
  gradient?: MovieGradient;
  texture?: "paper" | "grain";
  textureStrength?: number;
  shadow?: {
    color: string;
    opacity: number;
    x: number;
    y: number;
    blur: number;
  };
  origin?: { x: number; y: number };
  parentId?: string;
  rotationX?: number;
  rotationY?: number;
  blend?: "normal" | "multiply" | "screen";
  text?: string;
  path?: string;
  assetId?: string;
  fit?: "contain" | "cover";
  enter?: "fade" | "rise" | "slide" | "scale" | "draw";
  delay?: number;
  drift?: "none" | "float" | "rotate" | "pan";
  keyframes?: MovieKeyframe[];
}
export interface MovieGradient {
  kind: "linear" | "radial";
  angle?: number;
  cx?: number;
  cy?: number;
  radius?: number;
  stops: Array<{ offset: number; color: string; opacity?: number }>;
}
export interface MovieKeyframe {
  /** Normalized time in this shot, 0..1. Positions remain percentages. */
  at: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  rotationX?: number;
  rotationY?: number;
  blur?: number;
  opacity?: number;
  draw?: number;
  ease?:
    | "linear"
    | "smooth"
    | "out"
    | "back"
    | "inOut"
    | "backIn"
    | "elasticOut"
    | "bounceOut";
}
export interface MovieVisual {
  composition:
    | "poster"
    | "editorial"
    | "blueprint"
    | "collage"
    | "gallery"
    | "kinetic"
    | "organic"
    | "minimal"
    | "custom";
  copy: {
    x: number;
    y: number;
    width: number;
    align: "left" | "center" | "right";
    titleSize: number;
    bodySize: number;
  };
  layers: MovieLayer[];
  transition: "fade" | "wipe" | "slide" | "cut" | "crossfade" | "iris";
  transitionDuration?: number;
  background?: string;
  foreground?: string;
  copyMode?: "title" | "caption" | "none";
  camera?: MovieKeyframe[];
}
export interface MovieStyleAsset {
  id: string;
  path: string;
  materialId?: string;
  label?: string;
}
export interface MovieStyleReference {
  materialId: string;
  title: string;
  license: string;
  source?: string;
  receipt?: string;
  licenseText?: string;
}

const layer = (
  id: string,
  type: MovieLayer["type"],
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  extra: Partial<MovieLayer> = {},
): MovieLayer => ({ id, type, x, y, width, height, color, ...extra });
const copy = (
  x = 8,
  y = 27,
  width = 70,
  align: MovieVisual["copy"]["align"] = "left",
  titleSize = 7.4,
  bodySize = 1.8,
) => ({ x, y, width, align, titleSize, bodySize });

export const MOVIE_VISUALS: Record<string, MovieVisual> = {
  fantay: {
    composition: "poster",
    copy: copy(8, 25, 76),
    transition: "slide",
    layers: [
      layer("frame", "rect", 3, 5, 94, 90, "foreground", {
        stroke: 0.12,
        opacity: 0.22,
      }),
      layer("ribbon", "rect", 69, -16, 20, 132, "accent", {
        rotation: 24,
        enter: "slide",
        drift: "pan",
      }),
      layer("cut", "rect", 79, 63, 30, 26, "foreground", {
        rotation: 24,
        enter: "rise",
        delay: 0.18,
      }),
      layer("edition", "text", 8, 10, 48, 7, "foreground", {
        text: "FANTAY / MOTION STUDIES",
        opacity: 0.62,
      }),
      layer("serial", "text", 8, 79, 50, 11, "foreground", {
        text: "FORM → FEELING",
        opacity: 0.42,
        enter: "rise",
      }),
    ],
  },
  editorial: {
    composition: "editorial",
    copy: copy(9, 32, 60, "left", 7, 1.75),
    transition: "wipe",
    layers: [
      layer("column", "rect", 77, 0, 23, 100, "accent", {
        opacity: 0.16,
        enter: "slide",
      }),
      layer("top-rule", "line", 8, 20, 84, 0.3, "foreground", {
        opacity: 0.7,
        enter: "draw",
      }),
      layer("vertical-rule", "line", 72, 20, 0.12, 70, "foreground", {
        opacity: 0.4,
        enter: "draw",
      }),
      layer("masthead", "text", 8, 7, 80, 10, "foreground", {
        text: "THE MOVING EDITION",
        opacity: 0.75,
      }),
      layer("issue", "text", 76, 35, 16, 23, "accent", {
        text: "A",
        enter: "scale",
        drift: "float",
      }),
      layer("foot-rule", "line", 8, 81, 59, 0.15, "foreground", {
        opacity: 0.5,
        enter: "draw",
        delay: 0.2,
      }),
    ],
  },
  signal: {
    composition: "kinetic",
    copy: copy(7, 26, 85, "left", 8.5, 2.1),
    transition: "slide",
    layers: [
      layer("stripe-top", "rect", 0, 0, 100, 9, "accent", { enter: "slide" }),
      layer("signal-tag", "text", 5, 1.5, 88, 6, "background", {
        text: "SIGNAL / ON AIR / SIGNAL / ON AIR",
      }),
      layer("stripe-bottom", "rect", 0, 84, 100, 16, "accent", {
        enter: "rise",
        delay: 0.12,
      }),
      layer("index", "text", 6, 86, 85, 11, "background", {
        text: "MAKE IT LOUD.",
        enter: "slide",
      }),
      layer("slash-one", "rect", 84, 12, 3, 18, "accent", {
        rotation: 30,
        enter: "scale",
      }),
      layer("slash-two", "rect", 90, 12, 3, 18, "accent", {
        rotation: 30,
        enter: "scale",
        delay: 0.12,
      }),
    ],
  },
  blueprint: {
    composition: "blueprint",
    copy: copy(8, 25, 54, "left", 6.4, 1.7),
    transition: "fade",
    layers: [
      layer("grid", "grid", 0, 0, 100, 100, "accent", { opacity: 0.13 }),
      layer("diagram", "path", 64, 19, 28, 60, "accent", {
        path: "M 100 50 L 820 50 L 820 310 L 460 310 L 460 650 L 900 650 M 100 50 L 100 880 L 900 880",
        stroke: 0.6,
        enter: "draw",
        delay: 0.12,
      }),
      layer("node-a", "rect", 64, 20, 13, 15, "accent", {
        stroke: 0.22,
        enter: "scale",
      }),
      layer("node-b", "rect", 77, 43, 13, 15, "accent", {
        stroke: 0.22,
        enter: "scale",
        delay: 0.2,
      }),
      layer("node-c", "rect", 64, 67, 13, 15, "accent", {
        stroke: 0.22,
        enter: "scale",
        delay: 0.4,
      }),
      layer("measure", "text", 8, 11, 80, 7, "accent", {
        text: "SYSTEM / 001    —    SCALE 1:1",
        opacity: 0.7,
      }),
      layer("baseline", "line", 8, 79, 45, 0.16, "accent", { enter: "draw" }),
    ],
  },
  soft: {
    composition: "organic",
    copy: copy(12, 30, 74, "center", 6.6, 1.8),
    transition: "fade",
    layers: [
      layer("wave-a", "path", -15, 38, 120, 74, "accent", {
        path: "M 0 450 C 200 50 400 900 620 300 C 760 -60 890 450 1000 50 L 1000 1000 L 0 1000 Z",
        opacity: 0.75,
        enter: "rise",
        drift: "float",
      }),
      layer("wave-b", "path", -8, 63, 120, 57, "foreground", {
        path: "M 0 380 C 250 100 440 850 700 290 C 860 0 930 400 1000 210 L 1000 1000 L 0 1000 Z",
        opacity: 0.12,
        enter: "rise",
        delay: 0.15,
      }),
      layer("petal", "path", 70, -14, 43, 58, "accent", {
        path: "M 500 20 C 600 330 930 150 800 500 C 1050 760 630 720 500 970 C 370 720 -50 760 200 500 C 70 150 400 330 500 20 Z",
        opacity: 0.5,
        drift: "rotate",
        enter: "scale",
      }),
      layer("note", "text", 18, 12, 64, 6, "foreground", {
        text: "SMALL MOMENTS, SLOWLY.",
        opacity: 0.6,
      }),
    ],
  },
  minimal: {
    composition: "minimal",
    copy: copy(12, 30, 74, "left", 7.8, 1.8),
    transition: "wipe",
    layers: [
      layer("accent-line", "rect", 8, 28, 0.55, 43, "accent", {
        enter: "draw",
      }),
      layer("small-rule", "line", 12, 77, 30, 0.18, "foreground", {
        opacity: 0.6,
        enter: "draw",
      }),
      layer("label", "text", 12, 13, 70, 5, "foreground", {
        text: "A THOUGHT, IN MOTION.",
        opacity: 0.45,
      }),
    ],
  },
  collage: {
    composition: "collage",
    copy: copy(8, 30, 45, "left", 6.4, 1.9),
    transition: "slide",
    layers: [
      layer("paper", "rect", 58, 15, 31, 65, "foreground", {
        rotation: 8,
        enter: "rise",
        opacity: 0.12,
      }),
      layer("cover", "image", 57, 12, 29, 65, "accent", {
        rotation: -7,
        assetId: "cover",
        enter: "rise",
        drift: "float",
      }),
      layer("detail", "image", 74, 47, 20, 39, "foreground", {
        rotation: 11,
        assetId: "detail",
        enter: "scale",
        delay: 0.18,
      }),
      layer("tape", "rect", 61, 9, 18, 7, "foreground", {
        rotation: -7,
        opacity: 0.15,
      }),
      layer("stamp", "text", 8, 13, 63, 5, "foreground", {
        text: "CUT / COLLECT / CREATE",
        opacity: 0.55,
      }),
    ],
  },
  gallery: {
    composition: "gallery",
    copy: copy(9, 59, 73, "left", 6, 1.5),
    transition: "wipe",
    layers: [
      layer("cover", "image", 0, 0, 100, 100, "accent", {
        assetId: "cover",
        enter: "scale",
        drift: "pan",
      }),
      layer("caption-panel", "rect", 5, 52, 90, 40, "background", {
        opacity: 0.94,
        enter: "rise",
      }),
      layer("caption-rule", "line", 9, 55, 80, 0.14, "foreground", {
        opacity: 0.5,
        enter: "draw",
        delay: 0.2,
      }),
      layer("tag", "text", 6, 7, 86, 5, "background", {
        text: "FANTAY / VISUAL JOURNAL",
        enter: "fade",
      }),
    ],
  },
};
