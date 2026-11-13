import {
  MOVIE_VISUALS,
  MOVIE_STYLES,
  type MovieDocument,
  type MovieVisual,
  type MovieGradient,
} from "../api/movie.js";
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const n = (value: number | undefined, fallback = 0) =>
  Number.isFinite(value) ? value! : fallback;
function color(doc: MovieDocument, value: string) {
  return ["background", "foreground", "accent"].includes(value)
    ? doc.style[value as "background" | "foreground" | "accent"]
    : /^#[\da-f]{6}$/i.test(value)
      ? value
      : doc.style.accent;
}
function gradientSvg(doc: MovieDocument, g: MovieGradient, id: string) {
  const stops = g.stops
    .map(
      (s) =>
        `<stop offset="${s.offset * 100}%" stop-color="${color(doc, s.color)}" stop-opacity="${s.opacity ?? 1}"/>`,
    )
    .join("");
  if (g.kind === "radial")
    return `<radialGradient id="${id}" cx="${g.cx ?? 35}%" cy="${g.cy ?? 25}%" r="${g.radius ?? 75}%">${stops}</radialGradient>`;
  const a = ((g.angle ?? 90) * Math.PI) / 180,
    x = Math.cos(a) * 50,
    y = Math.sin(a) * 50;
  return `<linearGradient id="${id}" x1="${50 - x}%" y1="${50 - y}%" x2="${50 + x}%" y2="${50 + y}%">${stops}</linearGradient>`;
}
function shadowColor(doc: MovieDocument, value: string, opacity: number) {
  const hex = color(doc, value).slice(1);
  return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${opacity})`;
}
function gearPath(teeth = 12, hole = 0.3): string {
  const points = Array.from({ length: teeth * 4 }, (_, i) => {
    const angle = ((i / 4 + 0.1) * Math.PI * 2) / teeth,
      r = i % 4 === 1 || i % 4 === 2 ? 490 : 395;
    return `${(500 + Math.cos(angle) * r).toFixed(2)} ${(500 + Math.sin(angle) * r).toFixed(2)}`;
  });
  const r = hole * 490;
  return `M${points.join("L")}Z${r ? `M${500 - r} 500a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z` : ""}`;
}
function textureSvg(id: string, paper: boolean): string {
  let seed = 9173;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const marks = Array.from({ length: paper ? 24 : 36 }, (_, i) => {
    const x = (random() * 64).toFixed(2),
      y = (random() * 64).toFixed(2),
      ink = i % 2 ? "#ffffff" : "#000000";
    return paper
      ? `<path d="M${x} ${y}l${(1 + random() * 5).toFixed(2)} ${(random() - 0.5).toFixed(2)}" fill="none" stroke="${ink}" stroke-width=".6"/>`
      : `<circle cx="${x}" cy="${y}" r="${(0.3 + random() * 0.6).toFixed(2)}" fill="${ink}"/>`;
  }).join("");
  return `<pattern id="${id}" width="64" height="64" patternUnits="userSpaceOnUse">${marks}</pattern>`;
}
export function movieVisual(
  doc: MovieDocument,
  shot?: MovieDocument["shots"][number],
): MovieVisual {
  return (
    shot?.visual ??
    doc.style.visual ??
    MOVIE_VISUALS[doc.style.id] ??
    MOVIE_STYLES.find((s) => s.name === doc.style.name)?.visual ??
    MOVIE_VISUALS.fantay!
  );
}
export function movieLayerHtml(
  doc: MovieDocument,
  start: number,
  width: number,
  height: number,
  assetBase = "",
  assetQuery = "",
  duration = 300,
  override?: MovieVisual,
  hold = 0,
): string {
  const layers = (override ?? movieVisual(doc)).layers;
  const renderLayer = (i: number, parents: Set<number>): string => {
    if (parents.has(i)) return "";
    const l = layers[i]!;
    const ink = color(doc, l.color),
      stroke = n(l.stroke),
      radius = n(l.radius),
      asset =
        doc.style.assets?.find((a) => a.id === l.assetId) ??
        (l.type === "image" ? doc.style.assets?.[0] : undefined);
    const uses3d =
      l.rotationX !== undefined ||
      l.rotationY !== undefined ||
      l.keyframes?.some(
        (f) => f.rotationX !== undefined || f.rotationY !== undefined,
      );
    const shadow = l.shadow
      ? ` drop-shadow(${(width * l.shadow.x) / 100}px ${(width * l.shadow.y) / 100}px ${(width * l.shadow.blur) / 100}px ${shadowColor(doc, l.shadow.color, l.shadow.opacity)})`
      : "";
    const filter =
      shadow || l.keyframes?.some((f) => f.blur !== undefined)
        ? `filter:blur(var(--motion-blur,0px))${shadow};`
        : "";
    const style = `left:${n(l.x)}%;top:${n(l.y)}%;width:${n(l.width, l.type === "group" ? 100 : 10)}%;height:${n(l.height, l.type === "group" ? 100 : 10)}%;opacity:${n(l.opacity, 1)};color:${ink};transform:${uses3d ? `perspective(${width}px) rotateX(${n(l.rotationX)}deg) rotateY(${n(l.rotationY)}deg) ` : ""}rotate(${n(l.rotation)}deg);transform-origin:${l.origin?.x ?? 50}% ${l.origin?.y ?? 50}%;border-radius:${radius}%;mix-blend-mode:${l.blend ?? "normal"};--motion-blur:0px;${l.shadow && l.type === "image" ? "box-shadow:none;" : ""}${filter}`;
    let inner = "";
    if (l.type === "group")
      inner = layers
        .map((child, index) =>
          child.parentId === l.id
            ? renderLayer(index, new Set([...parents, i]))
            : "",
        )
        .join("");
    else if (l.type === "text")
      inner = `<div class="art-type" style="font-size:${((height * n(l.height)) / 100) * 0.8}px">${esc(l.text ?? "")}</div>`;
    else if (["line", "path", "rect", "ellipse", "gear"].includes(l.type)) {
      const id = `paint-${Math.round(start * 1000)}-${i}`;
      const fill =
        l.type === "line"
          ? "none"
          : l.gradient
            ? `url(#${id})`
            : l.fill === undefined
              ? stroke
                ? "none"
                : ink
              : l.fill === "none"
                ? "none"
                : color(doc, l.fill);
      const edge =
        l.type === "line" || stroke
          ? color(doc, l.strokeColor ?? l.color)
          : "none";
      const attrs = `fill="${fill}" fill-rule="${l.type === "gear" ? "evenodd" : "nonzero"}" stroke="${edge}" stroke-width="${l.type === "line" ? Math.max(2, (width * stroke) / 100) : (width * stroke) / 100}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"`;
      const shape =
        l.type === "rect"
          ? `<rect x="0" y="0" width="1000" height="1000" rx="${radius * 10}" ${attrs}/>`
          : l.type === "ellipse"
            ? `<ellipse cx="500" cy="500" rx="500" ry="500" ${attrs}/>`
            : `<path pathLength="1" d="${esc(l.type === "line" ? "M0 0L1000 1000" : l.type === "gear" ? gearPath(l.teeth, l.hole) : (l.path ?? "M0 0"))}" ${attrs}/>`;
      const textured = l.texture && fill !== "none";
      const defs =
        (l.gradient ? gradientSvg(doc, l.gradient, id) : "") +
        (textured ? textureSvg(id + "-texture", l.texture === "paper") : "");
      const grain = textured
        ? shape.replace(
            attrs,
            `fill="url(#${id}-texture)" fill-rule="${l.type === "gear" ? "evenodd" : "nonzero"}" stroke="none" opacity="${l.textureStrength ?? 0.15}"`,
          )
        : "";
      inner = `<svg viewBox="0 0 1000 1000" preserveAspectRatio="none">${defs ? `<defs>${defs}</defs>` : ""}${shape}${grain}</svg>`;
    } else if (l.type === "grid")
      inner = `<div class="art-grid" style="--grid-ink:${ink};--grid-size:${Math.round(width / 24)}px"></div>`;
    else if (l.type === "image") {
      const src = asset
        ? `${assetBase}${asset.path.split("/").map(encodeURIComponent).join("/")}${assetQuery}`
        : "";
      inner = src
        ? /\.(mp4|webm|mov)$/i.test(asset!.path)
          ? `<video muted playsinline preload="auto" src="${esc(src)}" data-start="${start}" data-duration="${duration + hold}" data-play-duration="${duration}"></video>`
          : `<img src="${esc(src)}" style="object-fit:${l.fit ?? (/\.svg$/i.test(asset!.path) ? "contain" : "cover")}" alt="">`
        : `<div class="art-illustration"><svg viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice"><rect width="400" height="600" fill="${ink}"/><path d="M-80 520L400 60L530 150L20 660Z" fill="${doc.style.background}" opacity=".55"/><path d="M-100 50L180 270L-100 490" fill="${doc.style.foreground}" opacity=".45"/><path d="M80 460L520 120" stroke="${doc.style.foreground}" stroke-width="2" opacity=".4"/></svg></div>`;
    }
    return `<div class="art-layer art-${l.type}" data-layer="${i}" style="${style}">${inner}</div>`;
  };
  return layers
    .map((l, i) => (!l.parentId ? renderLayer(i, new Set()) : ""))
    .join("");
}
export function movieVisualCss(
  doc: MovieDocument,
  width: number,
  height: number,
): string {
  const c = movieVisual(doc).copy;
  const face =
    doc.style.typeface && /^[\p{L}\p{N}\s_,'".\-]+$/u.test(doc.style.typeface)
      ? doc.style.typeface
      : "";
  return `.art-layer{position:absolute;pointer-events:none;transform-origin:center;overflow:hidden}.art-layer svg,.art-layer img,.art-layer video,.art-illustration{width:100%;height:100%;display:block;object-fit:cover}.art-image{box-shadow:0 12px 24px #00000018}.art-type{font-weight:600;white-space:nowrap;line-height:1.05}.art-grid{width:100%;height:100%;background-image:linear-gradient(var(--grid-ink) 1px,transparent 1px),linear-gradient(90deg,var(--grid-ink) 1px,transparent 1px);background-size:var(--grid-size) var(--grid-size)}.copy,.split .copy{z-index:2;left:${n(c.x, 8)}%;right:auto;top:${n(c.y, 25)}%;width:${n(c.width, 80)}%;text-align:${c.align}}h1{font-size:${(width * n(c.titleSize, 7)) / 100}px;${face ? `font-family:${face};` : ""}}h1 .copy-line{display:block}p{font-size:${(width * n(c.bodySize, 1.8)) / 100}px;margin-top:${height * 0.035}px}.rule,.art{display:none}footer{z-index:3}.statement .copy{left:9%;width:82%;top:34%;text-align:center}.metric h1{font-size:${width * 0.12}px}.scene:has(>.media) .copy{left:8%;width:43%;right:auto}.scene:has(>.media) .art-image{display:none}${doc.aspect === "9:16" ? `.copy,.split .copy{left:9%;width:82%;top:22%}h1{font-size:${width * 0.105}px}p{font-size:${width * 0.036}px}.scene:has(>.media) .copy{left:9%;width:82%;top:10%}` : ""}`;
}
export function movieShotCss(doc: MovieDocument, width: number): string {
  return (
    ".art-layer{overflow:visible;transform-style:preserve-3d}.art-layer svg{overflow:visible}.art-image{overflow:hidden}.scene-world{position:absolute;inset:0;transform-origin:50% 45%;isolation:isolate}" +
    doc.shots
      .map((s, i) => {
        const v = movieVisual(doc, s),
          c = v.copy,
          scope = "#shot-" + i;
        return `${scope}{background:${color(doc, v.background ?? "background")};color:${color(doc, v.foreground ?? "foreground")}}${scope} .copy{left:${c.x}%;top:${c.y}%;width:${c.width}%;text-align:${c.align}}${scope} h1{font-size:${(width * c.titleSize) / 100}px}${scope} p{font-size:${(width * c.bodySize) / 100}px}${v.copyMode === "none" ? scope + " .copy, " + scope + " footer{display:none}" : ""}${v.copyMode === "caption" ? scope + " footer{display:none}" + scope + " .copy p{margin-top:8px;opacity:.65}" : ""}`;
      })
      .join("")
  );
}
export const MOVIE_LAYER_TIMELINE = `
const easeMap={linear:'none',smooth:'sine.inOut',out:'power3.out',back:'back.out(1.4)',inOut:'power2.inOut',backIn:'back.in(1.3)',elasticOut:'elastic.out(1,.5)',bounceOut:'bounce.out'};
function track(target,frames,camera=false){
  frames.forEach((f,k)=>{
    const p={};
    if(f.x!==undefined)p[camera?'xPercent':'left']=camera?f.x:f.x+'%';
    if(f.y!==undefined)p[camera?'yPercent':'top']=camera?f.y:f.y+'%';
    if(f.width!==undefined)p.width=f.width+'%';
    if(f.height!==undefined)p.height=f.height+'%';
    for(const key of ['scale','scaleX','scaleY','rotation','rotationX','rotationY','opacity'])if(f[key]!==undefined)p[key]=f[key];
    if(f.blur!==undefined)p['--motion-blur']=(f.blur*canvasWidth/100)+'px';
    const at=time+(k?frames[k-1].at:0)*s.duration;
    const opts={...p,duration:k?(f.at-frames[k-1].at)*s.duration:0,ease:easeMap[f.ease]||'none'};
    if(k)tl.to(target,opts,at);else tl.set(target,p,at);
    if(f.draw!==undefined){
      const line=target+' path';
      tl.set(line,{attr:{'stroke-dasharray':1}},time);
      const attr={'stroke-dashoffset':1-f.draw};
      if(k)tl.to(line,{attr,duration:opts.duration,ease:opts.ease},at);
      else tl.set(line,{attr},at);
    }
  });
}
visual.layers.forEach((l,j)=>{
  const target=el+' [data-layer="'+j+'"]';
  if(l.keyframes?.length){track(target,l.keyframes);return;}
  const delay=Math.min(l.delay||0,Math.max(0,s.duration-.8));
  const from={opacity:0};
  if(l.enter==='rise')from.y=70;
  if(l.enter==='slide')from.x=-90;
  if(l.enter==='scale')from.scale=.65;
  if(l.enter==='draw')from.clipPath='inset(0 100% 0 0)';
  if(l.enter)tl.fromTo(target,from,{opacity:l.opacity??1,x:0,y:0,scale:1,clipPath:'inset(0 0% 0 0)',duration:.7,ease:'power3.out'},time+delay);
  const driftAt=time+delay+(l.enter ? .7 : 0),driftDuration=Math.max(.1,s.duration-(driftAt-time));
  if(l.drift==='float')tl.to(target,{y:-25,repeat:1,yoyo:true,duration:driftDuration/2,ease:'sine.inOut'},driftAt);
  if(l.drift==='rotate')tl.to(target,{rotation:(l.rotation||0)+20,duration:driftDuration,ease:'none'},driftAt);
  if(l.drift==='pan')tl.to(target,{x:30,scale:1.04,duration:driftDuration,ease:'none'},driftAt);
});
if(visual.camera?.length)track(el+' .scene-world',visual.camera,true);
`;
