import { movieDuration, movieShotStarts, movieFps, movieFrameSize, type MovieDocument } from "../api/movie.js";
import {
  movieVisual,
  movieLayerHtml,
  movieVisualCss,
  movieShotCss,
} from "./movie-layers.js";

import {
  buildMovieTimeline,
  movieTransitionDuration,
} from "./movie-timeline.js";
export { movieTransitionDuration, movieNextShotIndex } from "./movie-timeline.js";

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
/** The same deterministic timeline powers stills, scrubbing, playback and export. */
export function buildMovieHtml(
  doc: MovieDocument,
  options: {
    gsapUrl?: string;
    assetBase?: string;
    assetQuery?: string;
    videoHref?: string;
    autoplay?: boolean;
    seek?: number;
    /** Host-only text selection bridge; never enabled by the exporter. */
    editable?: boolean;
  } = {},
): string {
  const { width, height } = movieFrameSize(doc);
  const duration = movieDuration(doc);
  const hasAudio=doc.shots.some(s=>s.clip&&s.clip.volume>0&&!s.clip.muted&&/\.(mp4|m4v|mov|webm|mp3|wav|m4a|aac|flac|ogg)$/i.test(s.media??doc.style.assets?.find(a=>a.id===s.clip!.assetId)?.path??''));
  const font =
    doc.style.font === "serif"
      ? 'Georgia, "Songti SC", serif'
      : doc.style.font === "mono"
        ? '"SFMono-Regular", Consolas, monospace'
        : '"Albert Sans", "PingFang SC", system-ui, sans-serif';
  const starts = movieShotStarts(doc);
  const scenes = doc.shots
    .map((shot, index) => {
      const at = starts[index]!;
      const mediaPath =
        shot.media ??
        (shot.clip
          ? doc.style.assets?.find((a) => a.id === shot.clip!.assetId)?.path
          : undefined);
      const media = mediaPath
        ? `${options.assetBase ?? ""}${mediaPath.split("/").map(encodeURIComponent).join("/")}${options.assetQuery ?? ""}`
        : "";
      const timing = `data-play-duration="${shot.duration}" data-start="${at}" data-duration="${shot.duration + movieTransitionDuration(doc, index)}"${shot.clip?.in ? ` data-media-start="${shot.clip.in}"` : ""}${shot.clip && shot.clip.rate !== 1 ? ` data-playback-rate="${shot.clip.rate}"` : ""}`;
      const color=shot.clip?.color;
      const mediaStyle = shot.clip ? ` style="object-fit:${shot.clip.fit};left:${shot.clip.x ?? 0}%;top:${shot.clip.y ?? 0}%;width:${shot.clip.width ?? 100}%;height:${shot.clip.height ?? shot.clip.width ?? 100}%;opacity:${shot.clip.opacity ?? 1};transform:rotate(${shot.clip.rotation ?? 0}deg)${color?`;filter:brightness(${2**color.exposure}) contrast(${color.contrast}) saturate(${color.saturation}) blur(${color.blur}px) grayscale(${color.grayscale})`:''}"` : "";
      const crop=shot.clip?.crop, cropped=Boolean(crop&&Object.values(crop).some(Boolean));
      const mediaClass='media';
      let mediaHtml = media
        ? /\.(mp4|m4v|webm|mov)$/i.test(mediaPath!) && !shot.clip?.audioOnly
          ? `<video class="${mediaClass}" muted playsinline preload="auto" src="${escape(media)}" ${timing}${cropped?'':mediaStyle}></video>`
          : /\.(svg|png|jpe?g|webp|gif)$/i.test(mediaPath!) ? `<img class="${mediaClass}" src="${escape(media)}" alt=""${cropped?'':mediaStyle}>` : ""
        : "";
      if(cropped)mediaHtml=`<div class="clip-frame clip-target" data-crop-media="${escape(JSON.stringify(crop))}" data-fit="${shot.clip!.fit}"${mediaStyle}>${mediaHtml}</div>`;
      const audioTiming=timing.replace(`data-duration="${shot.duration + movieTransitionDuration(doc,index)}"`,`data-duration="${shot.duration}"`);
      const audio =
        shot.clip && shot.clip.volume > 0 && !shot.clip.muted && /\.(mp4|m4v|mov|webm|mp3|wav|m4a|aac|flac|ogg)$/i.test(mediaPath??'')
          ? `<audio preload="auto" src="${escape(media)}" ${audioTiming} data-volume="${shot.clip.volume}" data-fade-in="${shot.clip.audioFadeIn ?? shot.clip.fadeIn ?? 0}" data-fade-out="${shot.clip.audioFadeOut ?? shot.clip.fadeOut ?? 0}"></audio>`
          : "";
      const captionStyle=shot.captionStyle;
      const captionCss=captionStyle?` style="top:${captionStyle.y}%;bottom:auto;font-size:${captionStyle.fontSize}px;text-align:${captionStyle.align}"`:"";
      const captionSpanCss=captionStyle?` style="color:${captionStyle.color};background:${captionStyle.background}${Math.round(captionStyle.backgroundOpacity*255).toString(16).padStart(2,"0")};-webkit-text-stroke:${captionStyle.outline}px #000;paint-order:stroke fill"`:"";
      const titleHtml=shot.kind==="text"&&shot.textAnimation==="typewriter"?Array.from(shot.title).map(c=>c==="\n"?"<br>":`<span class="title-char">${escape(c)}</span>`).join(""):escape(shot.title).replace(/\n/g,"<br>");
      const target = (field: string, captionId?: string) => options.editable && !shot.locked
        ? ` data-movie-shot="${escape(shot.id)}" data-movie-field="${field}"${captionId ? ` data-movie-caption="${escape(captionId)}"` : ''}` : '';
      const captions = (shot.captions ?? [])
        .map(
          (caption, i) =>
            `<div class="movie-caption caption-${i}"${captionCss} data-caption-start="${at + caption.start}" data-caption-end="${at + caption.end}"><span${captionSpanCss}${caption.id ? target('caption', caption.id) : ''}>${escape(caption.text).replace(/\n/g, "<br>")}</span></div>`,
        )
        .join("");
      return `<section class="scene ${shot.layout}${shot.clip ? " footage" : ""}${shot.clip?.audioOnly ? " audio-only" : ""}" style="z-index:${((shot.placement?.track ?? 0) + 1)*10000+doc.shots.filter((s,i)=>(s.placement?.track??0)===(shot.placement?.track??0)&&(starts[i]!<at||starts[i]===at&&i<=index)).length}${shot.clip || shot.kind === "text" ? ";background:transparent" : ""}" id="shot-${index}" data-start="${at}" data-duration="${shot.duration + movieTransitionDuration(doc, index)}" data-hold="${movieTransitionDuration(doc, index)}"><div class="scene-world">${shot.clip ? mediaHtml : ""}${movieLayerHtml(doc, at, width, height, options.assetBase, options.assetQuery, shot.duration, movieVisual(doc, shot), movieTransitionDuration(doc, index))}</div>${shot.clip ? "" : mediaHtml}${audio}<div class="copy"><h1>${titleHtml}</h1><p>${escape(shot.body).replace(/\n/g, "<br>")}</p></div>${captions}<footer><span>${escape(doc.title)}</span><span>${String(index + 1).padStart(2, "0")} / ${String(doc.shots.length).padStart(2, "0")}</span></footer></section>`;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=${width},height=${height}"><meta name="od-motion-output" content="video"><meta name="od-motion-audio" content="${hasAudio ? "required" : "silent"}">${options.videoHref ? `<link rel="alternate" type="video/mp4" href="${escape(options.videoHref)}">` : ""}<title>${escape(doc.title)}</title><script src="${escape(options.gsapUrl ?? "./gsap.min.js")}"></script><style>
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${doc.style.background};color:${doc.style.foreground};font-family:${font}}#root{position:relative;width:100%;height:100%;overflow:hidden}.scene{position:absolute;inset:0;padding:7.5%;visibility:hidden;overflow:hidden}.copy{position:absolute;left:7.5%;right:7.5%;top:25%}h1{font-size:${doc.aspect === "9:16" ? 116 : 142}px;line-height:1.1;letter-spacing:-.035em;font-weight:600;margin:0;white-space:normal;overflow-wrap:anywhere}p{font-size:34px;line-height:1.6;margin:42px 0 0;max-width:85%}.rule{width:100%;height:2px;background:currentColor;opacity:.3}.art{position:absolute;right:8%;bottom:19%;width:390px;height:390px}.art i{position:absolute;border:3px solid currentColor;border-radius:50%;inset:0}.art i:nth-child(2){inset:20%;background:${doc.style.accent};border:0}.art i:nth-child(3){inset:40%;background:${doc.style.foreground};border:0}.title .art{opacity:.35;right:-7%;bottom:-22%;width:800px;height:800px}.statement .copy{top:36%;text-align:center}.statement .art{display:none}.metric h1{font-size:230px;color:${doc.style.accent}}.split .copy{right:40%}.split .art{bottom:27%}footer{position:absolute;left:7.5%;right:7.5%;bottom:6%;display:flex;justify-content:space-between;font-size:23px;opacity:.65}.media{position:absolute;right:5%;top:20%;width:40%;height:60%;object-fit:cover}.scene:has(.media) .copy{right:49%}.scene:has(.media) .art{display:none} ${doc.aspect === "9:16" ? ".copy,.split .copy{top:25%;right:9%}.art{bottom:14%}.split .art{bottom:12%}.scene:has(.media) .copy{right:8%;top:10%}.media{top:50%;width:84%;right:8%;height:34%}p{font-size:40px}" : ""}
${movieVisualCss(doc, width, height)}${movieShotCss(doc, width)}
.footage .scene-world>.media{inset:0;width:100%;height:100%;border-radius:0}.footage footer{display:none}.movie-caption{position:absolute;z-index:5;left:8%;right:8%;bottom:7%;text-align:center;visibility:hidden;font-size:${width * 0.023}px;line-height:1.4;font-weight:600;pointer-events:none;color:#fff}.movie-caption span{display:inline-block;max-width:100%;padding:.2em .55em;background:#000c;border-radius:.15em;white-space:pre-wrap}.footage .copy{pointer-events:none}
.clip-frame{position:absolute;inset:0;overflow:hidden}.clip-frame>.media{max-width:none;max-height:none;object-fit:fill}.audio-only .scene-world,.audio-only .copy,.audio-only .movie-caption{display:none}
\n</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${Math.max(duration, 0.1)}" data-width="${width}" data-height="${height}" data-fps="${movieFps(doc)}">${scenes}</div><script>
${buildMovieTimeline(doc, width, options.seek ?? 0.8, options.autoplay ?? false)}
${options.editable ? `
document.querySelectorAll('.scene').forEach(function(scene, i) {
  var shotIds = ${JSON.stringify(doc.shots.map(s => s.locked ? null : s.id)).replace(/</g, '\\u003c')};
  if (!shotIds[i]) return;
  ['title', 'body'].forEach(function(field, index) {
    var node = scene.querySelector(index === 0 ? '.copy h1' : '.copy p');
    if (node) { node.dataset.movieShot = shotIds[i]; node.dataset.movieField = field; }
  });
  var layers = ${JSON.stringify(doc.shots.map(s => movieVisual(doc, s).layers.map(l => l.id))).replace(/</g, '\\u003c')};
  scene.querySelectorAll('.art-type').forEach(function(node) {
    var layer = node.closest('[data-layer]');
    if (!layer) return;
    node.dataset.movieShot = shotIds[i]; node.dataset.movieField = 'layer'; node.dataset.movieLayer = layers[i][Number(layer.dataset.layer)];
  });
});
document.addEventListener('dblclick', function(event) {
  var node = event.target.closest('[data-movie-field]');
  if (!node) return;
  event.preventDefault();
  parent.postMessage({ type: 'fantay-movie-text', shotId: node.dataset.movieShot, field: node.dataset.movieField, captionId: node.dataset.movieCaption, layerId: node.dataset.movieLayer }, '*');
});
var editStyle = document.createElement('style');
editStyle.textContent = '[data-movie-field]{pointer-events:auto!important;cursor:text}[data-movie-field]:hover{outline:1px dashed currentColor;outline-offset:4px}';
document.head.appendChild(editStyle);` : ''}
</script></body></html>`;
}
