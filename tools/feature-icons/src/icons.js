// Copyright (c) 2026 Kubai087. Licensed under the Kubai Icons License; see LICENSE.
// The icon set. Each entry: svg(u) builds the layers, target(hover, state) returns the
// numbers for rest or hover, draw(p, E) writes the interpolated numbers back.
// Fantay: the 31 feature icons of Fantay Studio (sidebar, settings sections, home creation
// chips, Personal Agent sections). Examples kept from Kubai Icons are unchanged but for
// data-line hints (闹钟, 剪贴板), which only a line palette reads, and 闹钟's hover, which runs
// its hands on instead of ringing; 拼图, 芯片, 调节, 烧瓶, 信息, 网页, 胶片, 幻灯片 and 台灯 are drawn
// for Fantay, and so are the Personal Agent icons 服务铃, 机器人, 机器人组, 清单 and 插头.

// ---------- Icons ----------
// Fills: u.lo(h) / u.up(h) carry the thin bottom band. Use them only on a flat-bottomed
// rectangle of height h whose bottom is clear: nothing within about 3 units of the edge
// and the piece itself not short. Everything else, and curved shapes, use u.loS / u.upS.
// Marks: on a mid-tone (back) body they are white; on a light (front) body or white
// content they take the deep tint; a supporting object laid over the subject (the
// lens) is deep so it reads as separate. Weights: content lines 1.6, glyphs 2.2.
const OL = 'class="ol" data-t="stroke:#5393FF"';
const LINE = 'class="ln" data-t="stroke:#D3E2FC"';
const ACC = 'class="ln" data-t="stroke:#5393FF"';
const DEEP = 'data-t="fill:#2F6FE0"';
const DEEPS = 'data-t="stroke:#2F6FE0"';
const FOLDER_BACK_R = [KR, 1.4, 1.4, KR, KR, KR];
// Keylines (fills; outside strokes add 1 all round), all centred on (15.5, 12.5) and scaled from the folder's 23-wide body
// (Material's 20 / 18 / 20×16 grid × 1.15): circle Ø23, square 20.6, landscape 23×18.4,
// portrait 18.4×23. Outlines sit 1 unit outside a shape; a coloured band around white
// content keeps 2+ units or is dropped so the content meets the edge.
const GEAR = gear(6, 11.4, 9);
const SHORTCUT_TILES = [[7.2, 4.2], [16.5, 4.2], [7.2, 13.5], [16.5, 13.5]];

// A jigsaw piece: a rounded square body of side s at (x, y) with a round knob centred on
// its top edge and another on its right edge. Clockwise, like R().
const KNOB_R = 2.8, KNOB_C = 2.3, KNOB_N = Math.sqrt(KNOB_R ** 2 - KNOB_C ** 2);
function jigsaw(x, y, s) {
  const r = KR, cx = x + s / 2, cy = y + s / 2, n = KNOB_N, k = `${KNOB_R} ${KNOB_R} 0 1 1`;
  return `M${f(x + r)} ${f(y)}H${f(cx - n)}A${k} ${f(cx + n)} ${f(y)}H${f(x + s - r)}Q${f(x + s)} ${f(y)} ${f(x + s)} ${f(y + r)}`
    + `V${f(cy - n)}A${k} ${f(x + s)} ${f(cy + n)}V${f(y + s - r)}Q${f(x + s)} ${f(y + s)} ${f(x + s - r)} ${f(y + s)}`
    + `H${f(x + r)}Q${f(x)} ${f(y + s)} ${f(x)} ${f(y + s - r)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Z`;
}
// The piece's lower half, cut level with the right knob's centre and taking the knob's
// lower half with it; its top corners are rounded by rc, so the back shows at them.
function jigsawFront(x, y, s, rc) {
  const c = y + s / 2, n = KNOB_N, kx = x + s + KNOB_C, xr = kx + KNOB_R, a = rc / KNOB_R;
  return `M${f(x + rc)} ${f(c)}H${f(xr - rc)}Q${f(xr)} ${f(c)} ${f(kx + KNOB_R * Math.cos(a))} ${f(c + KNOB_R * Math.sin(a))}`
    + `A${KNOB_R} ${KNOB_R} 0 0 1 ${f(x + s)} ${f(c + n)}V${f(y + s - KR)}Q${f(x + s)} ${f(y + s)} ${f(x + s - KR)} ${f(y + s)}`
    + `H${f(x + KR)}Q${f(x)} ${f(y + s)} ${f(x)} ${f(y + s - KR)}V${f(c + rc)}Q${f(x)} ${f(c)} ${f(x + rc)} ${f(c)}Z`;
}
// With its knobs the piece fills the square keyline, centred on (15.5, 12.5).
const PIECE = jigsaw(5.45, 7.55, 15), PIECE_FRONT = jigsawFront(5.45, 7.55, 15, 1.8);
// A four-point spark centred on the origin.
const SPARK = rp(Array.from({ length: 8 }, (_, i) => {
  const a = -Math.PI / 2 + i * Math.PI / 4, r = i % 2 ? 0.9 : 2.5;
  return [Math.cos(a) * r, Math.sin(a) * r];
}), 0.25);
// A round-bottomed flask: the bulb is FLASK_DISC, the neck 6.6 wide meets it through a
// small fillet, and a lip (drawn separately) covers the neck's mouth.
const FLASK_DISC = [15.5, 15.2, 8.6];
const FLASK = 'M12.8 2.2H18.2Q18.8 2.2 18.8 2.8V6Q18.8 7.26 20 7.87A8.6 8.6 0 1 1 11 7.87Q12.2 7.26 12.2 6V2.8Q12.2 2.2 12.8 2.2Z';
// A robot's eye centred on (x, y): an upright bar 2h tall at rest (o = 0) that curves into a
// smiling arc (^) w either side and k above and below at o = 1. One quadratic, so the two
// shapes interpolate number by number.
function robotEye(x, y, h, w, k, o) {
  const l = (a, b) => a + (b - a) * o;
  return `M${f(l(x, x - w))} ${f(l(y - h, y + k))}Q${f(x)} ${f(l(y, y - 3 * k))} ${f(l(x, x + w))} ${f(l(y + h, y + k))}`;
}
const ROBOT_EYE = 'fill="none" stroke-width="2.2" stroke-linecap="round"';
// The plug and its socket lie on the diagonal: drawn along a level axis through the centre,
// then turned 45° (plug lower left, socket upper right) point by point, so the shadow and the
// top glow, which stay outside, still fall from above.
const PLUG_PT = ([x, y]) => {
  const dx = x - 15.5, dy = y - 12.5, c = Math.SQRT1_2;
  return [15.5 + (dx + dy) * c, 12.5 + (dy - dx) * c];
};
const plugBox = (x, y, w, h, r) => rp(R(x, y, w, h).map(PLUG_PT), r);
const plugCord = (x1, x2) => poly([[x1, 12.5], [x2, 12.5]].map(PLUG_PT));
// A desk lamp: the lower arm stands from the base to the elbow LAMP_E, the upper arm runs on to
// the head, and the shade hangs there. The shade and its rays are drawn about the head along an
// upright axis pointing down, then turned point by point (SVG's rotate: positive is clockwise), so
// the shadow and the top glow still fall from above. The base stops short of the light, so at the
// end the rays keep about 2 clear of it, of the shade and of the arm.
const LAMP_E = [6.4, 9.4], LAMP_ARM = [9.6, -5.8];
const lampTurn = ([x, y], a) => {
  const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
};
const LAMP_SHADE = [[-2.5, -1.4], [2.5, -1.4], [7.2, 6.8], [-7.2, 6.8]];

const ICONS = [
  {
    name: '聊天',
    // Two speech bubbles; the reply in front starts typing on hover.
    svg: (u) => {
      const back = rr(4, 3.3, 16, 11.6, KR);
      const front = rp([[10.2, 8.8], [27, 8.8], [27, 19], [17.4, 19], [13.8, 22.6], [13.8, 19], [10.2, 19]], [KR, KR, KR, 0.5, 0.6, 0.5, KR]);
      return `<g data-n="b"><g filter="${u.sh}"><g filter="${u.hi}"><path d="${back}" fill="${u.loS}"/></g></g><path d="${back}" ${OL}/>
          <path d="${lines(7, 6.8, [6.4])}" class="ln" stroke="#fff" data-w="stroke"/></g>
        <g filter="${u.sh}"><g filter="${u.hi}"><path d="${front}" fill="${u.upS}"/></g></g><path d="${front}" ${OL}/>
        <circle data-n="d1" cx="14.6" r="1.4" ${DEEP}/><circle data-n="d2" cx="18.6" r="1.4" ${DEEP}/><circle data-n="d3" cx="22.6" r="1.4" ${DEEP}/>`;
    },
    target: (h) => ({ d: h ? [-0.6, -1.5, -0.6] : [0, 0, 0], b: h ? -0.8 : 0 }),
    draw(p, E) {
      at(E.d1, { cy: f(13.9 + p.d[0]) }); at(E.d2, { cy: f(13.9 + p.d[1]) }); at(E.d3, { cy: f(13.9 + p.d[2]) });
      at(E.b, { transform: `translate(${f(p.b)} ${f(p.b)})` });
    }
  },
  {
    name: '主页',
    // The new-tab home: a house whose door swings open on hover.
    svg: (u) => {
      const roof = rp([[3.6, 12.6], [15.5, 2.4], [27.4, 12.6]], [1.4, 2.2, 1.4]);
      const door = rp(R(13.2, 15.6, 4.6, 7.4), [1.2, 1.2, 0, 0]);
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${rr(7.4, 10.6, 16.2, 12.4, KR)}" fill="${u.loS}"/></g></g>
      <path d="${rr(7.4, 10.6, 16.2, 12.4, KR)}" ${OL}/>
      <path d="${door}" fill="${u.pure('#2F6FE0')}"/>
      <g data-n="door"><path d="${door}" fill="#fff"/></g>
      <g filter="${u.hi}"><path d="${roof}" fill="${u.upS}"/></g>
      <path d="${roof}" ${OL}/>`;
    },
    target: (h) => ({ door: h ? 0.3 : 1 }),
    draw(p, E) {
      at(E.door, { transform: `translate(13.2 0) scale(${f(Math.max(0.001, p.door))} 1) translate(-13.2 0)` });
    }
  },
  {
    name: '快捷方式',
    // A grid of sites; on hover one tile lifts out, ready to open.
    svg: (u) => `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${rr(5.2, 2.2, 20.6, 20.6, KR)}" fill="${u.loS}"/></g></g>
      <path d="${rr(5.2, 2.2, 20.6, 20.6, KR)}" ${OL}/>
      ${SHORTCUT_TILES.filter((t, i) => i !== 1).map(([x, y]) => `<path d="${rr(x, y, 7.3, 7.3, CR)}" fill="#fff"/>`).join('')}
      <g data-n="lift"><g filter="${u.sh}"><path d="${rr(0, 0, 7.3, 7.3, CR)}" fill="#fff"/></g><circle cx="3.65" cy="3.65" r="1.7" data-t="fill:#5393FF"/></g>`,
    target: (h) => ({ lift: h ? [16.9, 2.6, 1.14] : [16.5, 4.2, 1] }),
    draw(p, E) {
      const [x, y, s] = p.lift;
      at(E.lift, { transform: `translate(${f(x)} ${f(y)}) translate(3.65 3.65) scale(${f(s)}) translate(-3.65 -3.65)` });
    }
  },
  {
    name: '文件夹',
    svg: (u) => `
      <g filter="${u.sh}"><path data-n="back" fill="${u.lo(21)}"/></g>
      <path data-n="backO" ${OL}/>
      <g data-n="file"><path d="${rr(0, 0, 17, 9, 1)}" fill="#fff"/><path d="M5.5 2.3H11.5" ${LINE} stroke-width="1"/></g>
      <g filter="${u.hi}"><path data-n="front" fill="${u.up(18)}"/></g>
      <path data-n="frontO" ${OL}/>`,
    target: (h) => ({
      back: h ? [[4, 3], [11.2, 3], [14.2, 6], [27, 6], [27.6, 23], [4.6, 23]] : [[4, 2], [11.2, 2], [14.2, 5], [27, 5], [27, 23], [4, 23]],
      fx: h ? 7.9 : 7,
      front: h ? [[6.8, 13], [29.3, 13], [27.6, 23], [5.4, 23]] : [[4, 5], [27, 5], [27, 23], [4, 23]],
      fr: h ? 1.8 : KR
    }),
    draw(p, E) {
      const b = rp(p.back, FOLDER_BACK_R), fr = rp(p.front, p.fr);
      at(E.back, { d: b }); at(E.backO, { d: b });
      at(E.file, { transform: `translate(${f(p.fx)} 9)` });
      at(E.front, { d: fr }); at(E.frontO, { d: fr });
    }
  },
  {
    name: '闹钟',
    // An alarm clock with twin bells on two feet. Fantay: on hover its time runs on, without
    // the upstream ringing: the minute hand sweeps once round in one smooth move while the hour
    // hand steps on an hour, and both stay there (11:08, the same open V) until the pointer leaves.
    svg: (u) => {
      const body = circ(15.5, 13.4, 9.8), bells = circ(8.7, 6.6, 4.2) + circ(22.3, 6.6, 4.2);
      return `
      <path d="M11.2 20.4L8.4 23.4M19.8 20.4L22.6 23.4" fill="none" stroke-width="2.2" stroke-linecap="round" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${bells}" fill="${u.upS}"/></g></g>
      <path d="${bells}" ${OL}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g>
      <path d="${body}" ${OL}/>
      <path d="${circ(15.5, 13.4, 7.4)}" fill="#fff" data-line="bare"/>
      <path data-n="hh" d="M15.5 13.4V9.6" stroke-width="2.6" stroke-linecap="round" data-t="stroke:#89B5FF"/>
      <path data-n="mh" d="M15.5 13.4V7.8" stroke-width="2" stroke-linecap="round" ${DEEPS}/>
      <circle cx="15.5" cy="13.4" r="1.7" ${DEEP}/>`;
    },
    target: (h) => ({ m: CLOCK_MINUTES + (h ? 60 : 0) }),
    draw(p, E) {
      // Minutes since twelve: the hour hand turns half a degree a minute, the minute hand six.
      at(E.hh, { transform: `rotate(${f(p.m / 2)} 15.5 13.4)` });
      at(E.mh, { transform: `rotate(${f(p.m * 6)} 15.5 13.4)` });
    }
  },
  {
    name: '地球',
    // A globe whose meridian swings round as if it turns.
    svg: (u) => {
      const disc = circ(15.5, 12.5, 11.5);
      return `<clipPath id="${u.id('gl')}"><path d="${disc}"/></clipPath>
        <g filter="${u.sh}"><g filter="${u.hi}"><path d="${disc}" fill="${u.loS}"/></g></g>
        <g clip-path="url(#${u.id('gl')})" fill="none" stroke-width="1.6" stroke="#fff" data-w="stroke">
          <path d="M3 12.5H28"/><path data-n="mer"/>
        </g>
        <path d="${disc}" ${OL}/>`;
    },
    target: (h) => ({ rx: h ? 8.6 : 4.6 }),
    draw(p, E) {
      const rx = p.rx;
      at(E.mer, { d: `M${f(15.5 - rx)} 12.5A${f(rx)} 11.5 0 1 0 ${f(15.5 + rx)} 12.5A${f(rx)} 11.5 0 1 0 ${f(15.5 - rx)} 12.5Z` });
    }
  },
  {
    name: '包裹',
    // A parcel whose two top flaps fold open on hover.
    svg: (u) => {
      const box = rr(5.2, 8.6, 20.6, 14.2, KR);
      return `<g filter="${u.sh}"><g filter="${u.hi}"><path d="${box}" fill="${u.lo(14.2)}"/></g></g><path d="${box}" ${OL}/>
        <path d="${rr(14.2, 8.6, 2.6, 4.6, 0.6)}" fill="#fff"/>
        <g filter="${u.hi}"><path data-n="fl" fill="${u.upS}"/></g><path data-n="flO" ${OL}/>
        <g filter="${u.hi}"><path data-n="fr" fill="${u.upS}"/></g><path data-n="frO" ${OL}/>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o));
      const l = rp([[5.2, 8.6], [15.4, 8.6], [15.4 - 2.6 * o, 6.2 - 2.8 * o], [5.2 - 2.8 * o, 6.2 - 1.6 * o]], [0.6, 0.6, 1, 1]);
      const r = rp([[15.6, 8.6], [25.8, 8.6], [25.8 + 2.8 * o, 6.2 - 1.6 * o], [15.6 + 2.6 * o, 6.2 - 2.8 * o]], [0.6, 0.6, 1, 1]);
      at(E.fl, { d: l }); at(E.flO, { d: l }); at(E.fr, { d: r }); at(E.frO, { d: r });
    }
  },
  {
    name: '设置',
    svg: (u) => `
      <g filter="${u.sh}"><g filter="${u.hi}"><g data-n="gear"><path d="${GEAR}" fill="${u.loS}"/></g></g></g><g data-n="gearO"><path d="${GEAR}" ${OL}/></g>
      <path d="${circ(15.5, 12.5, 5.8)}" fill="#fff"/>
      <g filter="${u.hi}"><path data-n="hub" fill="${u.upS}"/></g>
      <path data-n="hubO" ${OL}/>`,
    target: (h) => ({ rot: h ? 60 : 0, hub: h ? 2.9 : 3.5 }),
    draw(p, E) {
      at(E.gear, { transform: `rotate(${f(p.rot)} 15.5 12.5)` }); at(E.gearO, { transform: `rotate(${f(p.rot)} 15.5 12.5)` });
      const d = circ(15.5, 12.5, p.hub);
      at(E.hub, { d }); at(E.hubO, { d });
    }
  },
  {
    name: '用户',
    // An avatar in a round frame; on hover the person looks up.
    svg: (u) => {
      const disc = circ(15.5, 12.5, 11.5);
      return `<clipPath id="${u.id('av')}"><path d="${disc}"/></clipPath>
        <g filter="${u.sh}"><g filter="${u.hi}"><path d="${disc}" fill="${u.loS}"/></g></g>
        <g clip-path="url(#${u.id('av')})">
          <path data-n="body" d="${rp([[5, 27], [5, 22], [10.4, 17.4], [20.6, 17.4], [26, 22], [26, 27]], [0, 0, 4, 4, 0, 0])}" fill="#fff"/>
        </g>
        <circle data-n="head" cx="15.5" cy="10.4" r="4.4" fill="#fff"/>
        <path d="${disc}" ${OL}/>`;
    },
    target: (h) => ({ lift: h ? -1.2 : 0 }),
    draw(p, E) {
      at(E.head, { cy: f(10.4 + p.lift) });
      at(E.body, { transform: `translate(0 ${f(p.lift * 0.4)})` });
    }
  },
  {
    name: '剪贴板',
    // A clipboard; a check gets ticked on its sheet on hover.
    svg: (u) => {
      const board = rr(6.3, 2.6, 18.4, 21.2, KR), clip = rp(R(11, 0.8, 9, 4.6), [1.6, 1.6, 1.2, 1.2]);
      return `<g filter="${u.sh}"><g filter="${u.hi}"><path d="${board}" fill="${u.loS}"/></g></g><path d="${board}" ${OL}/>
        <path d="${rr(8.6, 6.6, 13.8, 15, CR)}" fill="#fff" data-line="bare"/>
        <path d="${lines(11, 10.2, [9])}" ${LINE}/>
        <path data-n="chk" d="M12.2 16.2L14.6 18.6L19 14" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${DEEPS}/>
        <g filter="${u.hi}"><path d="${clip}" fill="${u.upS}"/></g><path d="${clip}" ${OL}/>`;
    },
    target: (h) => ({ chk: h ? 1 : 0 }),
    draw(p, E) {
      const L = 9.8;
      at(E.chk, { 'stroke-dasharray': L, 'stroke-dashoffset': f(L * (1 - Math.max(0, Math.min(1, p.chk)))) });
    }
  },
  {
    name: '笔记本',
    // A spiral notebook. On hover the cover turns over on its rings and folds away behind,
    // leaving the lined first page.
    svg: (u) => {
      const back = rr(6.3, 1, 18.4, 23, KR);
      const rings = [5.5, 10.2, 14.8, 19.5].map((y) => rr(3.8, y - 1.2, 7.4, 2.4, 1.2)).join('');
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${back}" fill="${u.loS}"/></g></g>
      <path d="${back}" ${OL}/>
      <path d="${rr(9.4, 3, 13.3, 19, CR)}" fill="#fff"/>
      <path d="${lines(13.4, 8.4, [7.4, 5])}" ${ACC}/>
      <g data-n="cvG"><g filter="${u.hi}"><path data-n="cv" fill="${u.upS}"/></g>
        <path data-n="shade" ${DEEP} opacity="0"/>
        <path data-n="cvO" ${OL}/>
        <g data-n="label"><path d="${lines(13.4, 7.4, [7])}" class="ln" ${DEEPS} stroke-opacity=".55"/></g></g>
      <path d="${rings}" ${DEEP}/>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      // The cover's width shrinks to its hinge on the rings, darkening as it faces away; at
      // the end it has gone round behind the back.
      const o = Math.max(0, Math.min(1, p.o));
      const s = Math.cos(o * Math.PI / 2), w = 15.3 * s;
      const d = rp(R(9.4, 1, w, 23), [1.6, KR, KR, 1.6]);
      at(E.cv, { d }); at(E.cvO, { d }); at(E.shade, { d, opacity: f(0.4 * Math.sin(o * Math.PI / 2)) });
      at(E.label, { transform: `translate(9.4 0) scale(${f(Math.max(0.001, s))} 1) translate(-9.4 0)` });
      at(E.cvG, { opacity: o > 0.985 ? 0 : 1 });
    }
  },
  {
    name: '图表',
    // A bar chart whose bars rise and fall to new values on hover.
    svg: (u) => `<g filter="${u.sh}"><g filter="${u.hi}"><path d="${rr(5.2, 2.2, 20.6, 20.6, KR)}" fill="${u.loS}"/></g></g>
      <path d="${rr(5.2, 2.2, 20.6, 20.6, KR)}" ${OL}/>
      <path data-n="b1" fill="#fff"/><path data-n="b2" fill="#fff"/><path data-n="b3" fill="#fff"/>`,
    target: (h) => ({ hgt: h ? [10, 5.4, 13.4] : [5.4, 10.6, 7.6] }),
    draw(p, E) {
      [8.4, 13.7, 19].forEach((x, i) => {
        const hh = p.hgt[i];
        at(E['b' + (i + 1)], { d: rp(R(x, 20 - hh, 3.6, hh), [1, 1, 0.4, 0.4]) });
      });
    }
  },
  {
    name: '盾牌',
    // A shield with a lit half; it steps forward on hover.
    svg: (u) => {
      const sh = 'M15.5 1.4L24.2 4.8V11.4C24.2 17.2 20.6 21.6 15.5 23.8C10.4 21.6 6.8 17.2 6.8 11.4V4.8Z';
      return `<g data-n="g">
        <clipPath id="${u.id('half')}"><rect x="15.5" y="-2" width="16" height="30"/></clipPath>
        <g filter="${u.sh}"><g filter="${u.hi}"><path d="${sh}" fill="${u.loS}"/></g></g>
        <g clip-path="url(#${u.id('half')})"><g filter="${u.hi}"><path d="${sh}" fill="${u.upS}"/></g></g>
        <path d="${sh}" ${OL}/>
        <path d="M11.4 12.2L14.4 15.2L19.8 9.6" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${DEEPS}/>
      </g>`;
    },
    target: (h) => ({ y: h ? -1 : 0, s: h ? 1.06 : 1 }),
    draw(p, E) { at(E.g, { transform: `translate(15.5 ${f(12.6 + p.y)}) scale(${f(p.s)}) translate(-15.5 -12.6)` }); }
  },
  {
    name: '照片',
    // Two prints, one behind the other: on hover the back one fans out to the left and
    // the front one tilts, like leafing through an album.
    svg: (u) => {
      const frame = rr(4, 5.6, 23, 16.1, KR), back = rr(6, 3.3, 19, 15, KR);
      return `
      <g data-n="back"><g filter="${u.sh}"><g filter="${u.hi}"><path d="${back}" fill="${u.lo(15)}"/></g></g><path d="${back}" ${OL}/></g>
      <g data-n="front">
        <clipPath id="${u.id('sky')}"><path d="${frame}"/></clipPath>
        <g filter="${u.sh}"><g filter="${u.hi}"><path d="${frame}" fill="${u.upS}"/></g></g>
        <g clip-path="url(#${u.id('sky')})">
          <circle cx="20.4" cy="9.8" r="2.5" fill="#fff"/>
          <path d="${rp([[-1, 23], [-1, 20.2], [10.6, 10.8], [23, 20.8], [23, 23]], [0, 0, 1.8, 0, 0])}" fill="${u.loS}"/>
          <path d="${rp([[8, 23], [8, 21.4], [19.8, 13.2], [32, 20.8], [32, 23]], [0, 0, 1.8, 0, 0])}" fill="${u.pure('#5393FF')}"/>
        </g>
        <path d="${frame}" ${OL}/>
      </g>`;
    },
    target: (h) => ({ back: h ? [-1.4, -1.2, -9] : [0, 0, 0], front: h ? [0.6, 0.2, 4] : [0, 0, 0] }),
    draw(p, E) {
      at(E.back, { transform: `translate(${f(p.back[0])} ${f(p.back[1])}) rotate(${f(p.back[2])} 15.5 21.7)` });
      at(E.front, { transform: `translate(${f(p.front[0])} ${f(p.front[1])}) rotate(${f(p.front[2])} 15.5 21.7)` });
    }
  },
  {
    name: '视频',
    // A video camera; its lens opens wider and the record light grows on hover.
    svg: (u) => {
      const body = rr(4, 6, 15.8, 13, KR);
      return `<g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g><path d="${body}" ${OL}/>
        <g filter="${u.hi}"><path data-n="lens" fill="${u.upS}"/></g><path data-n="lensO" ${OL}/>
        <circle data-n="dot" cx="8.8" cy="10.4" fill="#fff" data-w="fill"/>`;
    },
    target: (h) => ({ w: h ? [8.6, 6.2] : [7.6, 4.8], dot: h ? 2.3 : 1.8 }),
    draw(p, E) {
      const [wx, wy] = p.w;
      const d = rp([[18.6, 9.6], [18.6 + wx, 12.5 - wy], [18.6 + wx, 12.5 + wy], [18.6, 15.4]], [0.6, 1.4, 1.4, 0.6]);
      at(E.lens, { d }); at(E.lensO, { d });
      at(E.dot, { r: f(p.dot) });
    }
  },
  {
    name: '手机',
    // A phone whose notification card slides in on hover.
    svg: (u) => {
      const body = rr(7.3, 1, 16.4, 23, 3.4), card = rr(0, 0, 10.4, 4.4, 1.4);
      return `<g data-n="ph">
        <g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g><path d="${body}" ${OL}/>
        <path d="${rr(9.4, 3.4, 12.2, 16.6, CR)}" fill="#fff"/>
        <g data-n="card"><g filter="${u.hi}"><path d="${card}" fill="${u.upS}"/></g><path d="${card}" ${OL}/><path d="${lines(1.8, 2, [4.4])}" class="ln" ${DEEPS}/></g>
      </g>`;
    },
    target: (h) => ({ card: h ? [10.3, 6.2, 1] : [10.3, 3.4, 0], tilt: h ? -5 : 0 }),
    draw(p, E) {
      at(E.card, { transform: `translate(${f(p.card[0])} ${f(p.card[1])})`, opacity: f(p.card[2]) });
      at(E.ph, { transform: `rotate(${f(p.tilt)} 15.5 12.5)` });
    }
  },
  {
    name: '文档',
    // A page whose folded corner opens a little more on hover.
    svg: (u) => `<g filter="${u.sh}"><g filter="${u.hi}"><path data-n="pg" fill="${u.loS}"/></g></g><path data-n="pgO" ${OL}/>
      <path d="${lines(9.6, 13.4, [11.8, 8.2])}" class="ln" stroke="#fff" data-w="stroke"/>
      <g filter="${u.hi}"><path data-n="fold" fill="${u.upS}"/></g><path data-n="foldO" ${OL}/>`,
    target: (h) => ({ fold: h ? 8 : 6 }),
    draw(p, E) {
      const c = p.fold;
      const pg = rp([[6.3, 1.5], [24.7 - c, 1.5], [24.7, 1.5 + c], [24.7, 23.5], [6.3, 23.5]], [KR, 0.5, 0.5, KR, KR]);
      const fold = rp([[24.7 - c, 1.5], [24.7, 1.5 + c], [24.7 - c, 1.5 + c]], [0.4, 0.4, 1.2]);
      at(E.pg, { d: pg }); at(E.pgO, { d: pg }); at(E.fold, { d: fold }); at(E.foldO, { d: fold });
    }
  },
  {
    name: '拼图',
    // A jigsaw piece. On hover it is picked up: it lifts a little and tilts, in one smooth
    // move, and stays so until the pointer leaves.
    svg: (u) => `
      <g filter="${u.sh}"><g filter="${u.hi}"><g data-n="r0"><path d="${PIECE}" fill="${u.loS}"/></g></g></g>
      <g data-n="r1"><path d="${PIECE}" ${OL}/></g>
      <g filter="${u.hi}"><g data-n="r2"><path d="${PIECE_FRONT}" fill="${u.upS}"/></g></g>
      <g data-n="r3"><path d="${PIECE_FRONT}" ${OL} data-line="none"/></g>`,
    target: (h) => ({ a: h ? -10 : 0, y: h ? -1.2 : 0 }),
    draw(p, E) {
      const t = `translate(0 ${f(p.y)}) rotate(${f(p.a)} 15.5 15)`;
      ['r0', 'r1', 'r2', 'r3'].forEach((n) => at(E[n], { transform: t }));
    }
  },
  {
    name: '芯片',
    // A chip on its pins. On hover it powers up: the core lights and its spark spins a
    // quarter turn. The spark keeps 2 clear of the core's edge at rest and at the end.
    svg: (u) => {
      const body = rr(7.7, 4.7, 15.6, 15.6, KR), core = rr(11, 8, 9, 9, 1.6);
      const pins = 'M12.6 2.1V4.7M18.4 2.1V4.7M12.6 20.3V22.9M18.4 20.3V22.9M5.1 9.6H7.7M5.1 15.4H7.7M23.3 9.6H25.9M23.3 15.4H25.9';
      return `
      <path d="${pins}" fill="none" stroke-width="2.2" stroke-linecap="round" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g>
      <path d="${body}" ${OL}/>
      <g filter="${u.hi}"><path d="${core}" fill="${u.upS}"/></g>
      <path data-n="glow" d="${core}" fill="#fff" opacity="0"/>
      <path d="${core}" ${OL}/>
      <path data-n="spark" d="${SPARK}" ${DEEP}/>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o));
      at(E.glow, { opacity: f(0.85 * o) });
      at(E.spark, { transform: `translate(15.5 12.5) rotate(${f(90 * o)})` });
    }
  },
  {
    name: '调节',
    // A panel of two sliders; on hover both knobs slide across to new settings.
    svg: (u) => {
      const body = rr(5.2, 2.2, 20.6, 20.6, KR), knob = circ(0, 0, 2.2);
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g>
      <path d="${body}" ${OL}/>
      <path d="M8.8 8.6H22.2M8.8 16.4H22.2" class="ln" stroke="#fff" data-w="stroke"/>
      <g data-n="k1"><g filter="${u.sh}"><g filter="${u.hi}"><path d="${knob}" fill="${u.upS}"/></g></g><path d="${knob}" ${OL}/></g>
      <g data-n="k2"><g filter="${u.sh}"><g filter="${u.hi}"><path d="${knob}" fill="${u.upS}"/></g></g><path d="${knob}" ${OL}/></g>`;
    },
    target: (h) => ({ k: h ? [18.2, 12.8] : [12.8, 18.2] }),
    draw(p, E) {
      at(E.k1, { transform: `translate(${f(p.k[0])} 8.6)` });
      at(E.k2, { transform: `translate(${f(p.k[1])} 16.4)` });
    }
  },
  {
    name: '烧瓶',
    // A round flask with liquid in its lower half. On hover the liquid rises as it starts
    // to bubble: the bubble already there floats up and a second one forms.
    svg: (u) => {
      const lip = rr(11.2, 1, 8.6, 2.6, 1.3);
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${FLASK}" fill="${u.loS}"/></g></g>
      <path d="${FLASK}" ${OL}/>
      <circle data-n="b1" r="1.3" fill="#fff" data-w="fill"/>
      <circle data-n="b2" r="1.2" fill="#fff" data-w="fill"/>
      <g filter="${u.hi}"><path data-n="liq" fill="${u.upS}"/></g>
      <path data-n="liqO" ${OL}/>
      <g filter="${u.hi}"><path d="${lip}" fill="${u.upS}"/></g>
      <path d="${lip}" ${OL}/>`;
    },
    target: (h) => ({ lvl: h ? 16.8 : 17.6, b1: h ? [14.2, 10.2] : [13.4, 13.2], b2: h ? 1 : 0 }),
    draw(p, E) {
      const d = frontPiece(FLASK_DISC, FLASK_DISC, p.lvl, 2);
      at(E.liq, { d }); at(E.liqO, { d });
      at(E.b1, { cx: f(p.b1[0]), cy: f(p.b1[1]) });
      at(E.b2, { cx: 18.4, cy: 12.4, transform: `translate(18.4 12.4) scale(${f(Math.max(0.001, p.b2))}) translate(-18.4 -12.4)` });
    }
  },
  {
    name: '信息',
    // An info badge. On hover its face turns over once, like a coin, and lands face up.
    svg: (u) => `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${circ(15.5, 12.5, 11.5)}" fill="${u.loS}"/></g></g>
      <path d="${circ(15.5, 12.5, 11.5)}" ${OL}/>
      <g filter="${u.hi}"><g data-n="face"><path d="${circ(15.5, 12.5, 8)}" fill="${u.upS}"/></g></g>
      <g data-n="faceO"><path d="${circ(15.5, 12.5, 8)}" ${OL} data-line="none"/>
        <circle cx="15.5" cy="8.5" r="1.6" ${DEEP}/><path d="${rr(14.4, 11.7, 2.2, 6.2, 1.1)}" ${DEEP}/></g>`,
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const s = Math.cos(Math.max(0, Math.min(1, p.o)) * Math.PI);
      const t = `translate(15.5 0) scale(${f(Math.abs(s) < 0.001 ? 0.001 : s)} 1) translate(-15.5 0)`;
      at(E.face, { transform: t }); at(E.faceO, { transform: t });
    }
  },
  {
    name: '网页',
    // A browser window on a page that runs below the fold; on hover the page scrolls on by
    // one section, so the cards move up under the bar and the next block comes in.
    svg: (u) => {
      const body = rr(4, 3.3, 23, 18.4, KR), head = rp(R(4, 3.3, 23, 4.6), [KR, KR, 0, 0]);
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g>
      <path d="${body}" ${OL}/>
      <clipPath id="${u.id('view')}"><rect x="6" y="9.9" width="19" height="9.8"/></clipPath>
      <g clip-path="url(#${u.id('view')})"><g data-n="page">
        <path d="${rr(6, 0, 19, 4.4, CR)}" fill="#fff"/>
        <path d="${lines(8.4, 2.2, [7.6])}" ${ACC}/>
        <path d="${rr(6, 6.4, 8.5, 4.4, CR) + rr(16.5, 6.4, 8.5, 4.4, CR)}" fill="#fff"/>
        <path d="${rr(6, 12.8, 19, 4.4, CR)}" fill="#fff"/>
      </g></g>
      <g filter="${u.hi}"><path d="${head}" fill="${u.upS}"/></g>
      <path d="${head}" ${OL}/>`;
    },
    target: (h) => ({ y: h ? 3.5 : 9.9 }),
    draw(p, E) { at(E.page, { transform: `translate(0 ${f(p.y)})` }); }
  },
  {
    name: '胶片',
    // A strip of film in its gate; on hover it advances one frame, and comes to rest with
    // the next frame in the gate.
    svg: (u) => {
      const body = rr(4, 3.3, 23, 18.4, KR);
      const holes = [0, 1, 2, 3, 4, 5].map((j) => rr(6 + j * 5.25, 5.3, 2.4, 2.4, 0.6) + rr(6 + j * 5.25, 17.3, 2.4, 2.4, 0.6)).join('');
      const frames = [0, 1, 2].map((k) => rr(6 + k * 10.5, 9.7, 8.5, 5.6, CR)).join('');
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g>
      <path d="${body}" ${OL}/>
      <clipPath id="${u.id('gate')}"><path d="${body}"/></clipPath>
      <g clip-path="url(#${u.id('gate')})"><g data-n="strip"><path d="${holes}" fill="#fff" data-line="ink"/><path d="${frames}" fill="#fff"/></g></g>`;
    },
    target: (h) => ({ x: h ? -10.5 : 0 }),
    draw(p, E) { at(E.strip, { transform: `translate(${f(p.x)} 0)` }); }
  },
  {
    name: '幻灯片',
    // A flip chart on its stand. On hover the slide flips up over the top edge,
    // foreshortening and darkening as it turns away, and the next slide shows: a chart.
    svg: (u) => {
      const board = rr(4, 1.6, 23, 15, KR), slide = rr(6, 3.6, 19, 11, CR);
      const bars = [[9, 3.4], [14.2, 6.2], [19.4, 4.6]].map(([x, hh]) => rp(R(x, 12.4 - hh, 2.6, hh), [0.8, 0.8, 0.4, 0.4])).join('');
      return `
      <path d="M15.5 17.6V19.8M10.6 23.4L15.5 19.8L20.4 23.4" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${board}" fill="${u.loS}"/></g></g>
      <path d="${board}" ${OL}/>
      <path d="${slide}" fill="#fff" data-line="bare"/>
      <path d="${bars}" ${DEEP}/>
      <g data-n="sheet"><path d="${slide}" fill="#fff" data-line="bare"/>
        <path d="${lines(8.8, 7, [7.2])}" ${ACC}/><path d="${lines(8.8, 10, [13.4])}" ${LINE}/>
        <path data-n="shade" d="${slide}" ${DEEP} opacity="0"/></g>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o));
      const sy = Math.cos(o * Math.PI / 2);
      at(E.sheet, { transform: `translate(0 3.6) scale(1 ${f(Math.max(0.001, sy))}) translate(0 -3.6)`, opacity: o > 0.985 ? 0 : 1 });
      at(E.shade, { opacity: f(0.45 * Math.sin(o * Math.PI / 2)) });
    }
  },
  {
    name: '服务铃',
    // A concierge bell, the assistant you ring for. On hover its button is pressed home onto
    // the dome and it rings: two short sound lines spring out, and all stays so until the
    // pointer leaves. The dome's foot runs 1 under the base, so the two outlines meet in one.
    svg: (u) => {
      const dome = 'M6.3 19.4A9.2 9.2 0 0 1 24.7 19.4Z', base = rr(4, 18.4, 23, 3.4, 1.6);
      return `
      <path data-n="stem" stroke-width="2.2" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${dome}" fill="${u.loS}"/></g></g>
      <path d="${dome}" ${OL}/>
      <path d="M10.6 15.29A6.4 6.4 0 0 1 13.84 13.22" class="ln" stroke="#fff" data-w="stroke"/>
      <g filter="${u.hi}"><path data-n="knob" fill="${u.upS}"/></g><path data-n="knobO" ${OL}/>
      <path data-n="d1" d="M11.2 5.2L9.2 3.8" class="ln" ${DEEPS}/><path data-n="d2" d="M19.8 5.2L21.8 3.8" class="ln" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${base}" fill="${u.upS}"/></g></g>
      <path d="${base}" ${OL}/>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o)), y = 4.4 + 3 * o, knob = circ(15.5, y, 1.8);
      at(E.knob, { d: knob }); at(E.knobO, { d: knob });
      at(E.stem, { d: `M15.5 ${f(y)}V10.6` });
      // The sound lines draw outward from their inner ends once the button is nearly down.
      const s = Math.max(0, Math.min(1, (o - 0.35) / 0.65)), L = 2.45;
      [E.d1, E.d2].forEach((el) => at(el, { 'stroke-dasharray': L, 'stroke-dashoffset': f(L * (1 - s)), opacity: s > 0.001 ? 1 : 0 }));
    }
  },
  {
    name: '机器人',
    // A robot's head: antenna, two ears, a face screen. On hover it greets you: its eyes curve
    // into a smile and the antenna perks up. The line palettes leave the screen bare, so the
    // eyes sit straight in the head's outline.
    svg: (u) => {
      const head = rr(6.4, 8.8, 18.2, 14.8, KR), ears = rr(4.2, 13.4, 3.8, 5.6, 1.2) + rr(23, 13.4, 3.8, 5.6, 1.2);
      return `
      <path data-n="stem" stroke-width="2.2" ${DEEPS}/>
      <g filter="${u.hi}"><path d="${ears}" fill="${u.upS}"/></g><path d="${ears}" ${OL}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${head}" fill="${u.loS}"/></g></g>
      <path d="${head}" ${OL}/>
      <path d="${rr(8.6, 11, 13.8, 10.4, 2.4)}" fill="#fff" data-line="bare"/>
      <path data-n="e1" ${ROBOT_EYE} ${DEEPS}/><path data-n="e2" ${ROBOT_EYE} ${DEEPS}/>
      <g filter="${u.hi}"><path data-n="ball" fill="${u.upS}"/></g><path data-n="ballO" ${OL}/>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o)), y = 2.8 - 0.8 * o, ball = circ(15.5, y, 1.7);
      at(E.ball, { d: ball }); at(E.ballO, { d: ball });
      at(E.stem, { d: `M15.5 ${f(y)}V9.4` });
      at(E.e1, { d: robotEye(12.3, 16, 1.2, 1.5, 0.8, o) });
      at(E.e2, { d: robotEye(18.7, 16, 1.2, 1.5, 0.8, o) });
    }
  },
  {
    name: '机器人组',
    // Two robots, one behind the other: a group of agents. On hover both smile, like the robot.
    // The one behind stands higher, so its eyes stay clear of the one in front.
    svg: (u) => {
      const back = rr(4, 2.6, 10.6, 10.6, KR), front = rr(13.4, 12.8, 13.6, 10, KR);
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${back}" fill="${u.loS}"/></g></g>
      <path d="${back}" ${OL}/>
      <path data-n="b1" ${ROBOT_EYE} stroke="#fff" data-w="stroke"/><path data-n="b2" ${ROBOT_EYE} stroke="#fff" data-w="stroke"/>
      <path d="M20.2 7V13.4" stroke-width="2.2" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${front}" fill="${u.upS}"/></g></g>
      <path d="${front}" ${OL}/>
      <path data-n="f1" ${ROBOT_EYE} ${DEEPS}/><path data-n="f2" ${ROBOT_EYE} ${DEEPS}/>
      <g filter="${u.hi}"><path d="${circ(20.2, 7, 1.4)}" fill="${u.upS}"/></g><path d="${circ(20.2, 7, 1.4)}" ${OL}/>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o));
      at(E.b1, { d: robotEye(6.8, 7.9, 0.8, 1, 0.6, o) }); at(E.b2, { d: robotEye(11.8, 7.9, 0.8, 1, 0.6, o) });
      at(E.f1, { d: robotEye(17.4, 17.8, 0.8, 1.1, 0.6, o) }); at(E.f2, { d: robotEye(23, 17.8, 0.8, 1.1, 0.6, o) });
    }
  },
  {
    name: '清单',
    // A to-do list: the first task is ticked, the second still an open circle. On hover the
    // second is done too: its circle closes up as a tick is drawn in its place.
    svg: (u) => {
      const body = rr(5.2, 2.2, 20.6, 20.6, KR);
      const tick = (y) => `M8.6 ${f(y - 0.2)}L10.6 ${f(y + 1.8)}L14 ${f(y - 1.8)}`;
      const glyph = 'fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" stroke="#fff" data-w="stroke"';
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${body}" fill="${u.loS}"/></g></g>
      <path d="${body}" ${OL}/>
      <path d="${tick(8.6)}" ${glyph}/>
      <path d="M17 8.6H22.4M17 16.4H22.4" class="ln" stroke="#fff" data-w="stroke"/>
      <circle data-n="dot" cx="11.3" cy="16.4" r="2.3" fill="#fff"/>
      <path data-n="chk" d="${tick(16.4)}" ${glyph}/>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o)), L = 7.79;
      at(E.chk, { 'stroke-dasharray': L, 'stroke-dashoffset': f(L * (1 - o)), opacity: o > 0.001 ? 1 : 0 });
      at(E.dot, { r: f(Math.max(0.001, 2.3 * (1 - o))) });
    }
  },
  {
    name: '插头',
    // A plug and its socket on a diagonal, cords trailing out. On hover the two are pushed
    // together: the prongs go in and the bodies meet, the plug's end tucked 1 under the
    // socket so their outlines join in one line. At rest the prongs keep 2+ clear of it.
    svg: (u) => `
      <path data-n="pc" fill="none" stroke-width="2.2" stroke-linecap="round" ${DEEPS}/>
      <path data-n="pr" ${DEEP}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path data-n="pb" fill="${u.loS}"/></g></g><path data-n="pbO" ${OL}/>
      <path data-n="sc" fill="none" stroke-width="2.2" stroke-linecap="round" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path data-n="sb" fill="${u.upS}"/></g></g><path data-n="sbO" ${OL}/>`,
    target: (h) => ({ d: h ? 3.7 : 0 }),
    draw(p, E) {
      const d = p.d, pb = plugBox(5.9 + d, 7.3, 6.6, 10.4, 2), sb = plugBox(18.9 - d, 7.3, 6.6, 10.4, 2);
      at(E.pc, { d: plugCord(1.6 + d, 6.6 + d) });
      at(E.pr, { d: plugBox(11.6 + d, 9.2, 3.7, 2.4, 0.6) + plugBox(11.6 + d, 13.4, 3.7, 2.4, 0.6) });
      at(E.pb, { d: pb }); at(E.pbO, { d: pb });
      at(E.sc, { d: plugCord(25 - d, 29.4 - d) });
      at(E.sb, { d: sb }); at(E.sbO, { d: sb });
    }
  },
  {
    name: '台灯',
    // A desk lamp, the creator's desk (工作台). On hover it bends to the work and switches on: the
    // upper arm swings down about the elbow while the shade tips over toward the desk, and once
    // the head has nearly settled three short rays of light fan out from its mouth. All stays so
    // until the pointer leaves.
    svg: (u) => {
      const base = rr(4.2, 20, 10.8, 3.6, 1.8);
      return `
      <path data-n="arm" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${base}" fill="${u.loS}"/></g></g>
      <path d="${base}" ${OL}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><path data-n="shade" fill="${u.upS}"/></g></g>
      <path data-n="shadeO" ${OL}/>
      <path data-n="r1" class="ln" ${DEEPS}/><path data-n="r2" class="ln" ${DEEPS}/><path data-n="r3" class="ln" ${DEEPS}/>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o));
      const [ex, ey] = LAMP_E, v = lampTurn(LAMP_ARM, 11 * o), hx = ex + v[0], hy = ey + v[1], a = -36 + 12 * o;
      const pt = (q) => { const [x, y] = lampTurn(q, a); return [hx + x, hy + y]; };
      at(E.arm, { d: poly([[9.6, 21], LAMP_E, [hx, hy]]) });
      const shade = rp(LAMP_SHADE.map(pt), [2.2, 2.2, 1.2, 1.2]);
      at(E.shade, { d: shade }); at(E.shadeO, { d: shade });
      // The rays fan out from the middle of the mouth, each drawn outward from its inner end,
      // once the head has nearly come down.
      const s = Math.max(0, Math.min(1, (o - 0.35) / 0.65)), r0 = 4.8, L = 2.4;
      [-28, 0, 28].forEach((phi, i) => {
        const ray = (r) => pt([r * Math.sin(phi * Math.PI / 180), 6.8 + r * Math.cos(phi * Math.PI / 180)]);
        at(E['r' + (i + 1)], { d: poly([ray(r0), ray(r0 + L * s)]), opacity: s > 0.001 ? 1 : 0 });
      });
    }
  }
];
