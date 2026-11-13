import type { MovieStyle, MovieShot } from "./movie.js";
import type { MovieLayer, MovieVisual, MovieKeyframe } from "./movie-visual.js";

const l = (
  id: string,
  type: MovieLayer["type"],
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  more: Partial<MovieLayer> = {},
): MovieLayer => ({ id, type, x, y, width, height, color, ...more });
const visual = (
  layers: MovieLayer[],
  camera?: MovieKeyframe[],
): MovieVisual => ({
  composition: "custom",
  copyMode: "caption",
  copy: {
    x: 8,
    y: 85,
    width: 84,
    align: "left",
    titleSize: 2.5,
    bodySize: 1.25,
  },
  transition: "fade",
  layers,
  ...(camera ? { camera } : {}),
});
const stroke = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  path: string,
  color = "accent",
  start = 0,
  end = 0.7,
) =>
  l(id, "path", x, y, w, h, color, {
    path,
    stroke: 0.22,
    keyframes: (
      [
        { at: 0, draw: 0 },
        { at: start, draw: 0 },
        { at: end, draw: 1, ease: "smooth" },
      ] as MovieKeyframe[]
    ).filter((f, i, a) => i === 0 || f.at !== a[i - 1]!.at),
  });
const shot = (
  id: string,
  title: string,
  body: string,
  art: MovieVisual,
): MovieShot => ({
  id,
  title,
  body,
  duration: 4,
  layout: "title",
  visual: art,
});
const pulse = (
  id: string,
  x: number,
  y: number,
  frames: MovieKeyframe[],
  size = 2.2,
) => l(id, "ellipse", x, y, size, size * 1.77, "accent", { keyframes: frames });

function signal(stage: number): MovieLayer[] {
  const layers: MovieLayer[] = [
    l("grid", "grid", 0, 0, 100, 82, "accent", { opacity: 0.08 }),
    l("hub-plate", "rect", 43, 31, 14, 24, "foreground", {
      opacity: 0.12,
      radius: 12,
    }),
    l("hub", "rect", 44, 33, 12, 20, "accent", { stroke: 0.25, radius: 9 }),
    l("hub-label", "text", 46, 40, 9, 7, "foreground", {
      text: stage === 0 ? "IN" : stage === 1 ? "AI" : "✓",
    }),
  ];
  const branches = [
    "M0 0L350 0Q500 0 500 500L1000 500",
    "M0 500L1000 500",
    "M0 1000L350 1000Q500 1000 500 500L1000 500",
  ];
  if (stage < 2) {
    for (let i = 0; i < 3; i++) {
      layers.push(
        l("source-" + i, "rect", 10, 16 + i * 22, 10, 13, "foreground", {
          stroke: 0.14,
          radius: 5,
        }),
      );
      const y = 22 + i * 22;
      layers.push(
        stroke(
          "input-" + i,
          20,
          Math.min(y, 43),
          24,
          Math.max(1, Math.abs(43 - y)),
          y > 43 ? "M0 1000L350 1000Q500 1000 500 500L1000 0" : branches[i]!,
          "accent",
          0.02 + i * 0.07,
          0.35 + i * 0.08,
        ),
      );
      layers.push(
        pulse("packet-" + i, 14, 20 + i * 22, [
          { at: 0, x: 14, y: 20 + i * 22, opacity: 0 },
          { at: 0.12 + i * 0.08, x: 14, y: 20 + i * 22, opacity: 1 },
          { at: 0.65 + i * 0.08, x: 48, y: 42, scale: 0.55, ease: "smooth" },
          { at: 1, x: 48, y: 42, opacity: 0 },
        ]),
      );
    }
  }
  if (stage > 0) {
    for (let i = 0; i < 3; i++) {
      const y = 23 + i * 20;
      layers.push(
        stroke(
          "output-" + i,
          56,
          Math.min(42, y),
          22,
          Math.max(1, Math.abs(y - 42)),
          y < 42
            ? "M0 1000C400 1000 400 0 1000 0"
            : "M0 0C400 0 400 1000 1000 1000",
          "accent",
          0.1,
          0.5,
        ),
      );
      layers.push(
        l("result-" + i, "rect", 77, 17 + i * 20, 14, 13, "foreground", {
          stroke: 0.13,
          radius: 4,
          keyframes: [
            { at: 0, opacity: 0, scale: 0.7 },
            { at: 0.35 + i * 0.14, opacity: 1, scale: 1, ease: "out" },
          ],
        }),
      );
      for (let bar = 0; bar < 3; bar++)
        layers.push(
          l(
            `bar-${i}-${bar}`,
            "rect",
            79,
            20 + i * 20 + bar * 2.3,
            9 - bar * 2,
            0.8,
            "accent",
            {
              keyframes: [
                { at: 0, width: 0.1, opacity: 0 },
                {
                  at: 0.55 + i * 0.12,
                  width: 9 - bar * 2,
                  opacity: 1,
                  ease: "out",
                },
              ],
            },
          ),
        );
      layers.push(
        pulse("out-packet-" + i, 49, 42, [
          { at: 0, opacity: 0 },
          { at: 0.2 + i * 0.1, x: 49, y: 42, opacity: 1 },
          {
            at: 0.75 + i * 0.08,
            x: 83,
            y: 21 + i * 20,
            opacity: 1,
            ease: "smooth",
          },
          { at: 1, opacity: 0 },
        ]),
      );
    }
  }
  if (stage === 2) {
    layers.push(
      stroke(
        "check",
        45,
        38,
        10,
        13,
        "M50 500L350 820L950 100",
        "accent",
        0.1,
        0.45,
      ),
    );
    layers.push(
      l("answer-ring", "rect", 41, 27, 18, 32, "accent", {
        stroke: 0.13,
        radius: 8,
        keyframes: [
          { at: 0, scale: 0.8, opacity: 0 },
          { at: 0.55, scale: 1, opacity: 0.7 },
          { at: 1, scale: 1.05, opacity: 0.2 },
        ],
      }),
    );
  }
  return layers;
}

function garden(stage: number): MovieLayer[] {
  const layers: MovieLayer[] = [
    l("sky-wash", "path", 0, 0, 100, 82, "#e2e9d4", {
      path: "M0 150Q500 500 1000 120L1000 1000L0 1000Z",
    }),
    l("soil", "path", -5, 64, 110, 18, "#8e6d50", {
      path: "M0 250Q250 0 500 250T1000 200L1000 1000L0 1000Z",
    }),
    l("soil-line", "path", 0, 73, 100, 8, "#ba9976", {
      path: "M0 100Q300 600 600 100T1000 500",
      stroke: 0.3,
    }),
    l("sun", "ellipse", 79, 10, 7, 12.4, "#e3b55a", {
      keyframes: [
        { at: 0, y: 12, scale: 0.95 },
        { at: 1, y: 7, scale: 1.05, ease: "smooth" },
      ],
    }),
  ];
  for (let i = 0; i < 2; i++)
    layers.push(
      l("cloud-" + i, "path", 10 + i * 47, 13 + i * 4, 17, 9, "#fffdf5", {
        path: "M0 800Q30 450 200 470Q300 -100 600 300Q900 180 1000 800Z",
        opacity: 0.7,
        keyframes: [
          { at: 0, x: 10 + i * 47 },
          { at: 1, x: 13 + i * 47, ease: "linear" },
        ],
      }),
    );
  if (stage === 0)
    layers.push(
      l("seed", "ellipse", 48, 12, 3, 6, "#6d4531", {
        rotation: 25,
        keyframes: [
          { at: 0, y: 9, rotation: 0 },
          { at: 0.64, y: 66, rotation: 160, ease: "smooth" },
          { at: 0.8, y: 60, rotation: 180 },
          { at: 1, y: 67, rotation: 190 },
        ],
      }),
    );
  else {
    layers.push({
      ...stroke(
        "stem",
        49,
        29,
        3,
        43,
        "M500 1000C200 780 800 350 500 0",
        "#496d3e",
        0,
        stage === 1 ? 0.7 : 0.01,
      ),
      stroke: 0.85,
    });
    layers.push(
      stroke(
        "roots",
        39,
        69,
        24,
        10,
        "M500 0L500 350L250 900M500 350L850 950M500 350L600 980",
        "#d7c9a6",
        0,
        0.75,
      ),
    );
    layers.push(
      l("leaf-left", "path", 34, 46, 18, 18, "#739250", {
        path: "M1000 900Q0 1000 0 0Q1000 -30 1000 900Z",
        rotation: -15,
        keyframes: [
          { at: 0, scale: stage === 1 ? 0 : 1, opacity: stage === 1 ? 0 : 1 },
          { at: 0.32, scale: stage === 1 ? 0 : 1, opacity: stage === 1 ? 0 : 1 },
          { at: 0.55, scale: 1, opacity: 1, ease: "out" },
          { at: 1, rotation: -21 },
        ],
      }),
    );
    layers.push(
      l("leaf-right", "path", 49, 39, 20, 18, "#94ab63", {
        path: "M0 1000Q0 0 1000 0Q1100 1000 0 1000Z",
        keyframes: [
          { at: 0, scale: stage === 1 ? 0 : 1, opacity: stage === 1 ? 0 : 1 },
          { at: 0.48, scale: stage === 1 ? 0 : 1, opacity: stage === 1 ? 0 : 1 },
          { at: 0.75, scale: 1, opacity: 1, ease: "out" },
          { at: 1, rotation: 7 },
        ],
      }),
    );
    layers.push(
      l("leaf-veins", "path", 36, 45, 29, 17, "#c6d6a1", {
        path: "M0 100L430 850M500 600L1000 0",
        stroke: 0.12,
        keyframes: [
          { at: 0, opacity: stage === 1 ? 0 : 1 },
          { at: 0.68, opacity: stage === 1 ? 0 : 1 },
          { at: 0.8, opacity: 1 },
        ],
      }),
    );
    if (stage === 2) {
      for (let i = 0; i < 8; i++)
        layers.push(
          l(
            "petal-" + i,
            "ellipse",
            46 + Math.sin((i * Math.PI) / 4) * 5.8,
            21 - Math.cos((i * Math.PI) / 4) * 10.3,
            8,
            16,
            i % 2 ? "#bd6f63" : "#d48e7e",
            {
              rotation: i * 45,
              keyframes: [
                { at: 0, scale: 0.05, opacity: 0, rotation: i * 45 - 30 },
                {
                  at: 0.36 + i * 0.06,
                  scale: 1,
                  opacity: 1,
                  rotation: i * 45,
                  ease: "back",
                },
                { at: 1, rotation: i * 45 + 3 },
              ],
            },
          ),
        );
      layers.push(
        l("flower-core", "ellipse", 46, 22, 8, 14.2, "#e5be65", {
          keyframes: [
            { at: 0, scale: 0 },
            { at: 0.7, scale: 1, ease: "out" },
          ],
        }),
      );
      const bee = l("bee", "rect", 18, 20, 2.5, 3, "#b58a37", {
        radius: 40,
        keyframes: [
          { at: 0, x: 18, y: 20, opacity: 0 },
          { at: 0.15, x: 20, y: 22, opacity: 1 },
          { at: 0.5, x: 63, y: 15, ease: "smooth" },
          { at: 1, x: 82, y: 26, opacity: 0, ease: "smooth" },
        ],
      });
      layers.push(bee);
      layers.push(
        l("bee-wing", "ellipse", 18, 18, 2, 3, "#fffdf5", {
          keyframes: bee.keyframes!.map((f) => ({
            ...f,
            ...(f.y === undefined ? {} : { y: f.y - 2 }),
          })),
        }),
      );
    }
  }
  return layers;
}

function building(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  delay: number,
): MovieLayer[] {
  const k: MovieKeyframe[] = [
    { at: 0, y: y + h, height: 0.1, opacity: 0 },
    { at: delay, y: y + h, height: 0.1, opacity: 1 },
    { at: Math.min(0.95, delay + 0.34), y, height: h, ease: "out" },
  ];
  return [
    l(id + "-front", "path", x, y, w, h, "#6687aa", {
      path: "M0 180L500 360L500 1000L0 820Z",
      keyframes: k,
    }),
    l(id + "-side", "path", x, y, w, h, "#416583", {
      path: "M500 360L1000 180L1000 820L500 1000Z",
      keyframes: k,
    }),
    l(id + "-roof", "path", x, y, w, h, "#bdd1df", {
      path: "M0 180L500 0L1000 180L500 360Z",
      keyframes: k,
    }),
    l(
      id + "-windows",
      "path",
      x + w * 0.1,
      y + h * 0.4,
      w * 0.32,
      h * 0.38,
      "#c5e4e8",
      {
        path: "M0 0L1000 290M0 320L1000 610M0 640L1000 930M300 90L300 740M680 195L680 850",
        stroke: 0.1,
        opacity: 0.7,
        keyframes: [
          { at: 0, opacity: 0 },
          { at: Math.min(0.98, delay + 0.42), opacity: 0.7 },
        ],
      },
    ),
  ];
}
function city(stage: number): MovieLayer[] {
  const layers: MovieLayer[] = [
    l("paper", "grid", 0, 0, 100, 82, "#7ca0b4", { opacity: 0.1 }),
    l("island", "path", 13, 32, 74, 48, "#d0dedc", {
      path: "M0 500L500 0L1000 500L500 1000Z",
      keyframes: [
        { at: 0, scale: stage === 0 ? 0.65 : 1, opacity: stage === 0 ? 0 : 1 },
        { at: 0.35, scale: 1, opacity: 1, ease: "out" },
      ],
    }),
    stroke(
      "avenue",
      20,
      39,
      58,
      35,
      "M0 500L1000 500M500 0L500 1000",
      "#8fa8ab",
      0,
      0.65,
    ),
  ];
  if (stage > 0) {
    layers.push(
      ...building("tower", 38, 11, 20, 52, 0.1),
      ...building("studio", 22, 30, 19, 33, 0.25),
      ...building("home", 59, 32, 16, 29, 0.4),
    );
    if (stage === 2) {
      for (const layer of layers) {
        if (
          layer.id.startsWith("tower") ||
          layer.id.startsWith("studio") ||
          layer.id.startsWith("home")
        )
          delete layer.keyframes;
      }
      layers.push(
        l("tram", "path", 18, 57, 9, 9, "#d88d57", {
          path: "M0 200L650 0L1000 500L300 1000L0 800Z",
          keyframes: [
            { at: 0, x: 18, y: 57 },
            { at: 0.45, x: 46, y: 72, ease: "linear" },
            { at: 1, x: 79, y: 54, ease: "linear" },
          ],
        }),
      );
      const tram = layers.find((item) => item.id === "tram")!;
      layers.push(
        l("tram-windows", "path", 18, 57, 9, 9, "#f1d6ae", {
          path: "M120 260L590 110L800 420L310 740Z",
          keyframes: tram.keyframes!,
        }),
      );
      for (let i = 0; i < 3; i++) {
        layers.push(
          l(
            "tree-stem-" + i,
            "rect",
            29 + i * 17,
            58 + (i % 2) * 5,
            0.6,
            6,
            "#8e795e",
          ),
        );
        layers.push(
          l(
            "tree-" + i,
            "ellipse",
            27 + i * 17,
            53 + (i % 2) * 5,
            4.6,
            9,
            "#87a68b",
            {
              keyframes: [
                { at: 0, scale: 0.1, opacity: 0 },
                { at: 0.3 + i * 0.1, scale: 1, opacity: 1, ease: "back" },
              ],
            },
          ),
        );
      }
      layers.push(
        l("pedestrian", "ellipse", 72, 54, 1, 1.8, "#344e67", {
          keyframes: [
            { at: 0, x: 72, y: 54 },
            { at: 1, x: 54, y: 68, ease: "linear" },
          ],
        }),
      );
    }
  } else
    layers.push(
      stroke(
        "blueprint",
        27,
        23,
        45,
        42,
        "M0 300L350 100L350 700L0 900ZM350 100L700 300L700 900L350 700M150 100L500 0L850 200",
        "#6687aa",
        0.2,
        0.9,
      ),
    );
  return layers;
}

export const MOVIE_SAMPLES: readonly MovieStyle[] = [
  {
    id: "signal-journey",
    name: "信号成形",
    description:
      "脉冲进入、网络分流、结果聚合。用连续运动解释一个系统如何形成答案。",
    background: "#101c30",
    foreground: "#d6e9ee",
    accent: "#69d6c6",
    font: "mono",
    motion: "rise",
    visual: visual(signal(1)),
    demoShots: [
      shot(
        "arrive",
        "每个答案，都从一个信号开始。",
        "脉冲进入系统，信息向中心汇聚。",
        visual(signal(0)),
      ),
      shot(
        "process",
        "让复杂，各归其位。",
        "节点分流、处理，再把线索重新连接。",
        visual(signal(1), [
          { at: 0, scale: 1 },
          { at: 1, scale: 1.06, x: -2, ease: "smooth" },
        ]),
      ),
      shot(
        "answer",
        "从信息，到清晰的答案。",
        "处理完成，结果在同一个系统中交付。",
        visual(signal(2)),
      ),
    ],
  },
  {
    id: "paper-garden",
    name: "纸上花园",
    description: "一粒种子落下，根茎沿路径生长，叶片与花瓣依次展开。",
    background: "#f4efe0",
    foreground: "#3d4d34",
    accent: "#bf796a",
    font: "serif",
    motion: "rise",
    visual: visual(garden(2)),
    demoShots: [
      shot(
        "seed",
        "给一个想法，落地的机会。",
        "种子穿过光，落入纸上的土壤。",
        visual(garden(0)),
      ),
      shot(
        "grow",
        "耐心，长出自己的形状。",
        "根系向下，枝叶向上。每一步都有方向。",
        visual(garden(1)),
      ),
      shot(
        "bloom",
        "让生长，被看见。",
        "花瓣舒展，新的故事开始。",
        visual(garden(2), [
          { at: 0, scale: 1 },
          { at: 1, scale: 1.07, y: -2, ease: "smooth" },
        ]),
      ),
    ],
  },
  {
    id: "paper-city",
    name: "城市醒来",
    description: "从平面蓝图到立体街区，建筑升起、交通穿行，镜头拉远看到整体。",
    background: "#eef2ee",
    foreground: "#30475a",
    accent: "#d38b58",
    font: "sans",
    motion: "scale",
    visual: visual(city(2)),
    demoShots: [
      shot(
        "plan",
        "先把未来，画在纸上。",
        "线条找到位置，街区有了轮廓。",
        visual(city(0)),
      ),
      shot(
        "build",
        "让构想，一层层站起来。",
        "建筑逐一升起，平面的计划成为空间。",
        visual(city(1)),
      ),
      shot(
        "live",
        "当连接发生，城市就醒了。",
        "交通开始流动，局部组成完整的生活。",
        visual(city(2), [
          { at: 0, scale: 1.12, x: -3, y: -3 },
          { at: 1, scale: 0.96, x: 0, y: 0, ease: "smooth" },
        ]),
      ),
    ],
  },
];

export const MOVIE_SAMPLE_MEDIA: Record<
  string,
  { video: string; poster: string }
> = Object.fromEntries(
  MOVIE_SAMPLES.map((s) => [
    s.id,
    {
      video: `/movie-samples/${s.id}.mp4`,
      poster: `/movie-samples/${s.id}.jpg`,
    },
  ]),
);
