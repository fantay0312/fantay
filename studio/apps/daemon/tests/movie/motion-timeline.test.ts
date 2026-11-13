import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  buildMovieHtml,
  createMovieDocument,
  MOVIE_SAMPLES,
} from "@open-design/contracts";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

it("shows exactly the timed caption when seeking forward and backward", () => {
  const doc=createMovieDocument("Captions","blank");
  doc.shots=[{id:"s",duration:2.5,title:"",body:"",layout:"title",captions:[{start:.1,end:.9,text:"First"},{start:1,end:2.4,text:"Second"}]}];
  const dom=new JSDOM(buildMovieHtml(doc),{runScripts:"outside-only",pretendToBeVisual:true});
  try {
    dom.window.eval(readFileSync(require.resolve("gsap/dist/gsap.min.js"),"utf8"));
    dom.window.eval([...dom.window.document.scripts].find(s=>!s.src)!.textContent!);
    const captions=[...dom.window.document.querySelectorAll(".movie-caption")];
    for(const [time,visible] of [[0,-1],[.4,0],[1.4,1],[0,-1],[.4,0],[2.45,-1]]) {
      dom.window.__timelines.main.pause(time);
      expect(captions.map(c=>c.style.visibility)).toEqual(captions.map((_,i)=>i===visible?"visible":"hidden"));
    }
  } finally {dom.window.__timelines.main.kill();dom.window.gsap.ticker.sleep();dom.window.close();}
});

it("holds a delayed track's first state from shot start instead of exposing the base end state", () => {
  const doc = createMovieDocument();
  doc.shots = [
    {
      id: "delay",
      title: "",
      body: "",
      duration: 4,
      layout: "title",
      visual: {
        composition: "custom",
        transition: "fade",
        copyMode: "none",
        copy: {
          x: 8,
          y: 80,
          width: 80,
          align: "left",
          titleSize: 3,
          bodySize: 1,
        },
        layers: [
          {
            id: "moving",
            type: "rect",
            x: 75,
            y: 30,
            width: 10,
            height: 10,
            color: "accent",
            keyframes: [
              { at: 0.4, x: 10, opacity: 0 },
              { at: 1, x: 80, opacity: 1 },
            ],
          },
        ],
      },
    },
  ];
  const dom = new JSDOM(buildMovieHtml(doc), {
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
    dom.window.__timelines.main.pause(0.2);
    const layer = dom.window.document.querySelector('[data-layer="0"]');
    expect(layer.style.left).toBe("10%");
    expect(Number(layer.style.opacity)).toBe(0);
    dom.window.__timelines.main.pause(3);
    expect(Number(layer.style.opacity)).toBeGreaterThan(0);
  } finally {
    dom.window.__timelines?.main?.kill();
    dom.window.gsap?.ticker.sleep();
    dom.window.close();
  }
});

it("draws a growing stem through fractional progress instead of snapping between hidden and full", () => {
  const doc = createMovieDocument(
    "Growth",
    "library",
    MOVIE_SAMPLES.find((s) => s.id === "paper-garden")!,
  );
  const dom = new JSDOM(buildMovieHtml(doc), {
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
    const stem = [...dom.window.document.querySelectorAll("#shot-1 path")].find(
      (p) => p.getAttribute("d")?.startsWith("M500 1000C200"),
    )!;
    dom.window.__timelines.main.pause(5.4);
    const halfway = Number(stem.getAttribute("stroke-dashoffset"));
    expect(halfway).toBeGreaterThan(0.1);
    expect(halfway).toBeLessThan(0.9);
    dom.window.__timelines.main.pause(6.9);
    expect(Number(stem.getAttribute("stroke-dashoffset"))).toBeCloseTo(0);
  } finally {
    dom.window.__timelines?.main?.kill();
    dom.window.gsap?.ticker.sleep();
    dom.window.close();
  }
});

it('keeps two independently timed tracks visible during their overlap',()=>{
 const doc=createMovieDocument('Layers','blank');
 doc.shots=[{id:'base',title:'Base',body:'',layout:'title',duration:4,placement:{start:0,track:0}},
 {id:'overlay',title:'Overlay',body:'',layout:'title',duration:2,placement:{start:1,track:1}}];
 const dom=new JSDOM(buildMovieHtml(doc),{runScripts:'outside-only',pretendToBeVisual:true});
 try {
  dom.window.eval(readFileSync(require.resolve('gsap/dist/gsap.min.js'),'utf8'));
  dom.window.eval([...dom.window.document.scripts].find(s=>!s.src)!.textContent!);
  const a=dom.window.document.querySelector('#shot-0'),b=dom.window.document.querySelector('#shot-1');
  dom.window.__timelines.main.pause(1.5);
  expect([a.style.visibility,b.style.visibility]).toEqual(['inherit','inherit']);
  dom.window.__timelines.main.pause(3.5);
  expect(a.style.visibility).toBe('inherit');expect(b.style.visibility).toBe('hidden');
  dom.window.__timelines.main.pause(0.5);
  expect(a.style.visibility).toBe('inherit');expect(b.style.visibility).toBe('hidden');
 }finally{dom.window.__timelines.main.kill();dom.window.gsap.ticker.sleep();dom.window.close();}
});
