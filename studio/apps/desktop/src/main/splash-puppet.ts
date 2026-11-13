// The Fantay sprite as a soft body.
//
// It is a ghost in a cloth hat, and neither is stiff: moved as rigid groups the
// hat reads as a shell and the ghost as a cut-out. So the splash does not turn
// or scale the artwork's groups. A small frame loop bends the drawing itself —
// every control point of the hat, its lining and the body is displaced each
// frame — and what drives the bending is the sprite's own movement:
//
//   • the hat's cone is a spine that bends; the lower half follows the head,
//     the upper half follows the lower half, and the loose curled tip follows
//     that, each on a softer spring, so a turn travels up the hat and the orb
//     arrives last;
//   • the brim's two wings are lifted by falling and pulled down by rising,
//     and a ripple runs outward along the hem all the time;
//   • the body below the face is a tail: it trails sideways movement, grows
//     long on the way up, and never stops wagging;
//   • the hands are loose and follow late.
//
// Nothing is keyframed twice. The entrance, the hover, a wave, a swish and the
// jump for a boot stage only say where the ghost is; the cloth, the tail and
// the hands answer the velocity that results, which is what makes the same
// drawing look alive at rest and in flight.
//
// The markup is the finished, resting frame. The loop only runs when motion is
// allowed (the document carries `sp-js`, set in <head>); if it cannot start it
// removes that class and the still lockup shows.

import { CHARACTER_RIG } from "./splash-character.js";

/** The rise: from below-left to the top of its arc, then the sink into place. */
export const PUPPET_FLY_MS = 700;
export const PUPPET_SETTLE_MS = 420;
/** When the tip flicks and the orb throws its sparks (the quill leaves 20ms later). */
export const PUPPET_CAST_MS = 980;

/** Extent of the two bending spines, in viewBox units. */
const HAT_TOP_Y = 27;
const TAIL_END_Y = 487;

// Vanilla ES5, like the rest of the page's script: it runs in a sandboxed
// `data:` document with no bundler.
export const PUPPET_SCRIPT = `
      (function () {
        var root = document.documentElement;
        if (!root.classList.contains("sp-js")) return;
        var svg = document.getElementById("sp-char");
        var stage = document.getElementById("sp-react");
        var hero = document.getElementById("splash-logo");
        var shadowEl = document.getElementById("sp-shadow");
        var tipEl = document.getElementById("hat-tip");
        var haloEl = document.getElementById("orb-halo");
        var glintEl = document.getElementById("hat-glint");
        var orbEl = document.getElementById("orb");
        var handL = document.getElementById("hand-left");
        var handR = document.getElementById("hand-right");
        var igniteEl = document.getElementById("sp-ignite");
        var trailEl = document.getElementById("sp-trail");
        if (!svg || !stage || !hero || !tipEl || !haloEl || !glintEl || !orbEl || !handL || !handR ||
            !window.requestAnimationFrame || !window.performance) {
          root.classList.remove("sp-js");
          return;
        }

        var TAU = Math.PI * 2;
        var DEG = 180 / Math.PI;
        var N = 16;
        var CX = ${CHARACTER_RIG.hat[0]}, HAT_Y = ${CHARACTER_RIG.hat[1]}, HAT_LEN = ${CHARACTER_RIG.hat[1] - HAT_TOP_Y};
        var TAIL_X = ${CHARACTER_RIG.tail[0]}, TAIL_Y = ${CHARACTER_RIG.tail[1]}, TAIL_LEN = ${TAIL_END_Y - CHARACTER_RIG.tail[1]};
        var TIP_X = ${CHARACTER_RIG.hatTip[0]}, TIP_Y = ${CHARACTER_RIG.hatTip[1]};
        var GLINT_X = ${CHARACTER_RIG.glint[0]}, GLINT_Y = ${CHARACTER_RIG.glint[1]};
        var FLY = ${PUPPET_FLY_MS}, SETTLE = ${PUPPET_SETTLE_MS}, CAST = ${PUPPET_CAST_MS};

        function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
        function smooth(a, b, v) { var u = clamp((v - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); }
        function bump(u, a, b) {
          if (u <= a || u >= b) return 0;
          var s = Math.sin(Math.PI * (u - a) / (b - a));
          return s * s;
        }
        function bez(a, b, c, d, u) {
          var m = 1 - u;
          return m * m * m * a + 3 * m * m * u * b + 3 * m * u * u * c + u * u * u * d;
        }
        function fix(v, n) { var k = n === 1 ? 10 : n === 2 ? 100 : 10000; return Math.round(v * k) / k; }

        // ---- The drawing, as points ----
        // Only paths made of absolute M/C/Z are bent (all of the cloth and the
        // body are); anything else stays as drawn.
        function load(selector) {
          var nodes = svg.querySelectorAll(selector), out = [];
          for (var i = 0; i < nodes.length; i += 1) {
            var d = nodes[i].getAttribute("d") || "";
            if (/[^MCZ0-9.\\s-]/.test(d)) continue;
            var cmds = [], nums = [];
            d.replace(/([MCZ])|(-?[0-9]*\\.?[0-9]+)/g, function (m, c, n) {
              if (c) cmds.push({ c: c, at: nums.length }); else nums.push(parseFloat(n));
              return m;
            });
            var pre = [], pend = "";
            for (var j = 0; j < cmds.length; j += 1) {
              if (cmds[j].c === "Z") { pend += "Z"; continue; }
              var end = j + 1 < cmds.length ? cmds[j + 1].at : nums.length;
              for (var q = cmds[j].at; q < end; q += 2) {
                pre.push(q === cmds[j].at ? pend + cmds[j].c : " ");
                pend = "";
              }
            }
            out.push({ node: nodes[i], base: nums, pre: pre, tail: pend });
          }
          return out;
        }
        var CLOTH = load("#fs-clip-hat path, #hat-body path, #hat-light path, #stars path, #capes path");
        var BODY = load("#fs-clip-body path, #body path");

        // ---- Springs ----
        function Spring(w, z) { this.x = 0; this.v = 0; this.to = 0; this.w = w; this.z = z; }
        var lean = new Spring(12, 0.6);
        var hatLo = new Spring(13, 0.42), hatHi = new Spring(10, 0.36), tip = new Spring(8.5, 0.3);
        var hatLen = new Spring(12, 0.45);
        var wingL = new Spring(11, 0.38), wingR = new Spring(10, 0.36);
        var tailLo = new Spring(11, 0.45), tailHi = new Spring(8.5, 0.38), tailLen = new Spring(10, 0.5);
        var hLX = new Spring(9, 0.45), hLY = new Spring(9, 0.45), hRX = new Spring(8, 0.42), hRY = new Spring(8, 0.42);
        var SPRINGS = [lean, hatLo, hatHi, tip, hatLen, wingL, wingR, tailLo, tailHi, tailLen, hLX, hLY, hRX, hRY];
        function settle(h) {
          for (var i = 0; i < SPRINGS.length; i += 1) {
            var s = SPRINGS[i];
            s.v += (s.w * s.w * (s.to - s.x) - 2 * s.z * s.w * s.v) * h;
            s.x += s.v * h;
          }
        }

        // ---- The two spines ----
        var hatX = [], hatYs = [], hatA = [], tailXs = [], tailYs = [], tailA = [];
        function spine(xs, ys, as, lo, hi, len) {
          var x = 0, y = 0, prev = 0, ds = len / N;
          xs[0] = 0; ys[0] = 0; as[0] = 0;
          for (var i = 1; i <= N; i += 1) {
            var h = i / N, a = lo * h + (hi - lo) * h * h, mid = (a + prev) / 2;
            x += Math.sin(mid) * ds; y += Math.cos(mid) * ds;
            xs[i] = x; ys[i] = y; as[i] = a; prev = a;
          }
        }
        var WX = 0, WY = 0, WA = 0;
        var ripT = 0, ripAmp = 1;
        // The hat and its lining. Above the brim line the cone follows its
        // spine; at the hem the wings lift and the ripple runs.
        function cloth(x, y) {
          var ox = x, oy = y;
          WA = 0;
          if (y < HAT_Y) {
            var f = (HAT_Y - y) / HAT_LEN * N;
            var i = f >= N ? N - 1 : Math.floor(f), k = f - i, w = x - CX;
            WA = hatA[i] + (hatA[i + 1] - hatA[i]) * k;
            ox = CX + hatX[i] + (hatX[i + 1] - hatX[i]) * k + w * Math.cos(WA);
            oy = HAT_Y - (hatYs[i] + (hatYs[i + 1] - hatYs[i]) * k) + w * Math.sin(WA);
          }
          var side = x < CX ? -1 : 1, far = Math.abs(x - CX);
          var wing = smooth(70, 190, far) * smooth(240, 360, y);
          var hem = smooth(272, 345, y);
          if (wing > 0 || hem > 0) {
            var lift = side < 0 ? wingL.x : wingR.x;
            var rip = Math.sin(far * 0.045 - ripT + (side < 0 ? 0.9 : 0)) * (1.5 + 4.5 * wing) * hem * ripAmp;
            ox += side * lift * 0.3 * wing + side * rip * 0.3;
            oy += -lift * wing + rip;
          }
          WX = ox; WY = oy;
        }
        // The body: everything below the face is a tail.
        function body(x, y) {
          if (y <= TAIL_Y) { WX = x; WY = y; return; }
          var f = (y - TAIL_Y) / TAIL_LEN * N;
          var i = f >= N ? N - 1 : Math.floor(f), k = f - i, w = x - TAIL_X;
          var a = tailA[i] + (tailA[i + 1] - tailA[i]) * k;
          WX = TAIL_X + tailXs[i] + (tailXs[i + 1] - tailXs[i]) * k + w * Math.cos(a);
          WY = TAIL_Y + tailYs[i] + (tailYs[i + 1] - tailYs[i]) * k - w * Math.sin(a);
        }
        function write(list, warp) {
          for (var p = 0; p < list.length; p += 1) {
            var b = list[p].base, pre = list[p].pre, s = "";
            for (var i = 0, n = 0; i < b.length; i += 2, n += 1) {
              warp(b[i], b[i + 1]);
              s += pre[n] + fix(WX, 1) + " " + fix(WY, 1);
            }
            list[p].node.setAttribute("d", s + list[p].tail);
          }
        }

        // ---- Where the ghost is ----
        // Offsets from its resting place, px. The entrance is a rise from the
        // lower left that curls over the top and sinks in; after that it rides
        // the air on two slow, unrelated sines.
        var ACTS = [
          { k: "wave", dur: 2400, dir: 0 },
          { k: "swish", dur: 1100, dir: 1 },
          { k: "wave", dur: 2400, dir: 0 },
          { k: "swish", dur: 1100, dir: -1 }
        ];
        var act = null, actAt = 0, turn = 0, nextAt = 3300, hopAt = -1;
        var BX = 0, BY = 0;
        function bodyAt(t) {
          var x = 0, y = 0, u;
          if (t < FLY) {
            u = 1 - Math.pow(1 - clamp(t / FLY, 0, 1), 1.8);
            x = bez(-150, -168, -64, 14, u);
            y = bez(172, 24, -70, -34, u);
          } else if (t < FLY + SETTLE) {
            u = (t - FLY) / SETTLE;
            u = u * u * (3 - 2 * u);
            x = 14 * (1 - u);
            y = -34 * (1 - u);
          }
          var k = smooth(1100, 2600, t);
          x += k * 6 * Math.sin(t / 5600 * TAU + 0.5);
          y += k * (-4 + 7 * Math.sin(t / 3400 * TAU));
          if (hopAt >= 0) {
            u = (t - hopAt) / 760;
            if (u > 0 && u < 1) y += 6 * bump(u, 0, 0.3) - 36 * bump(u, 0.1, 1);
          }
          if (act && act.k === "swish") {
            u = (t - actAt) / act.dur;
            if (u > 0 && u < 1) {
              x += act.dir * 42 * bump(u, 0, 1);
              y += -11 * Math.sin(TAU * u) * (1 - u);
            }
          }
          BX = x; BY = y;
        }

        // ---- Sparks the orb sheds on the way in, and throws when it casts ----
        var trail = trailEl ? trailEl.children : [];
        var trailIx = 0, trailAt = 0;
        function inHero(el) {
          var a = el.getBoundingClientRect(), b = hero.getBoundingClientRect();
          return [a.left + a.width / 2 - b.left, a.top + a.height / 2 - b.top];
        }
        function shed(vx, vy) {
          if (!trail.length) return;
          var el = trail[trailIx % trail.length], at = inHero(orbEl);
          trailIx += 1;
          el.style.left = fix(at[0], 1) + "px";
          el.style.top = fix(at[1], 1) + "px";
          el.style.setProperty("--dx", fix(-vx * 0.05 + (trailIx % 3 - 1) * 8, 1) + "px");
          el.style.setProperty("--dy", fix(-vy * 0.05 + 12, 1) + "px");
          el.classList.remove("sp-shed");
          void el.offsetWidth;
          el.classList.add("sp-shed");
        }
        function flare() {
          tip.v += 4.5;
          if (!igniteEl) return;
          var at = inHero(orbEl);
          igniteEl.style.left = fix(at[0], 1) + "px";
          igniteEl.style.top = fix(at[1], 1) + "px";
          igniteEl.classList.add("sp-ignite-on");
        }

        // ---- The loop ----
        var t0 = performance.now(), last = t0, primed = false, cast = false, grin = true;
        var wagT = 0, str = 0, ang = 0;
        svg.classList.add("sp-joy");

        function frame(now) {
          if (typeof now !== "number") now = performance.now();
          var t = now - t0, dt = clamp((now - last) / 1000, 0, 0.05), i, u;
          last = now;

          if (!act && t >= nextAt) { act = ACTS[turn % ACTS.length]; turn += 1; actAt = t; nextAt = t + 5400; }
          if (act && t - actAt >= act.dur) act = null;

          bodyAt(t - 8);
          var px = BX, py = BY;
          bodyAt(t);
          var x = BX, y = BY, vx = (x - px) / 0.008, vy = (y - py) / 0.008;
          var speed = Math.sqrt(vx * vx + vy * vy);
          var idle = smooth(1100, 2600, t), bob = t / 3400 * TAU;

          // A wave: the right hand comes up beside the face and the ghost tips toward it.
          var wave = 0, waveX = 0, waveY = 0;
          if (act && act.k === "wave") {
            u = (t - actAt) / act.dur;
            wave = smooth(0, 0.2, u) * (1 - smooth(0.78, 1, u));
            waveX = wave * (48 + 9 * Math.sin(u * TAU * 3.5));
            waveY = wave * (-50 - 4 * Math.cos(u * TAU * 7));
          }

          wagT += dt * (3.6 + speed * 0.011);
          ripT += dt * (3 + speed * 0.009);
          ripAmp = 0.5 + 0.5 * idle + Math.min(1.3, speed / 380);
          var wag = 0.06 + 0.06 * idle + Math.min(0.14, speed / 4200);

          lean.to = clamp(vx * 0.045, -16, 16) + wave * 3;
          hatLo.to = clamp(-vx * 0.0007, -0.3, 0.3) + idle * 0.04 * Math.sin(bob - 0.9);
          hatHi.to = hatLo.x * 1.7 + idle * 0.06 * Math.sin(bob - 1.7);
          tip.to = (hatHi.x - hatLo.x) * 1.4 + clamp(-vy * 0.0006, -0.4, 0.4) + idle * 0.07 * Math.sin(t / 2300 * TAU);
          hatLen.to = clamp(vy * 0.00012, -0.07, 0.08);
          var lift = clamp(vy * 0.05, -24, 26);
          wingL.to = lift + idle * 7 * Math.sin(bob - 1.3);
          wingR.to = lift + idle * 7 * Math.sin(bob - 2);
          tailLo.to = clamp(-vx * 0.0009, -0.34, 0.34) + wag * Math.sin(wagT);
          tailHi.to = clamp(tailLo.x * 1.6 + wag * 1.7 * Math.sin(wagT - 1.2), -0.62, 0.62);
          tailLen.to = clamp(-vy * 0.0007, -0.14, 0.4);
          hLX.to = clamp(-vx * 0.04, -30, 30) - idle * 2 * Math.sin(bob - 0.8);
          hLY.to = clamp(-vy * 0.04, -30, 36) + idle * 5 * Math.sin(bob - 0.8);
          hRX.to = clamp(-vx * 0.04, -30, 30) + idle * 2 * Math.sin(bob - 2.1);
          hRY.to = clamp(-vy * 0.04, -30, 36) + idle * 5 * Math.sin(bob - 2.1);
          if (!primed) {
            for (i = 0; i < SPRINGS.length; i += 1) SPRINGS[i].x = SPRINGS[i].to;
            primed = true;
          }
          for (var left = dt; left > 0; left -= 0.008) settle(Math.min(0.008, left));

          // The whole ghost: placed, leaned into its travel, stretched along it.
          str += (clamp(speed / 4200, 0, 0.07) - str) * Math.min(1, dt * 14);
          if (speed > 4) ang = Math.atan2(vy, vx);
          var size = 0.4 + 0.6 * (1 - Math.pow(1 - clamp(t / 600, 0, 1), 3));
          var breath = idle * Math.sin(bob + 0.6);
          var sx = size * (1 + 0.012 * breath), sy = size * (1 - 0.01 * breath);
          var p = 1 + str, q = 1 / p, c = Math.cos(ang), s = Math.sin(ang);
          var s11 = p * c * c + q * s * s, s12 = (p - q) * c * s, s22 = p * s * s + q * c * c;
          var lr = lean.x / DEG, cl = Math.cos(lr), sl = Math.sin(lr);
          stage.style.transform = "matrix(" +
            fix((s11 * cl + s12 * sl) * sx, 4) + "," + fix((s12 * cl + s22 * sl) * sx, 4) + "," +
            fix((s12 * cl - s11 * sl) * sy, 4) + "," + fix((s22 * cl - s12 * sl) * sy, 4) + "," +
            fix(x, 2) + "," + fix(y, 2) + ")";
          stage.style.opacity = String(fix(smooth(20, 220, t), 2));

          // The cloth and the tail.
          spine(hatX, hatYs, hatA, hatLo.x, hatHi.x, HAT_LEN * (1 + hatLen.x));
          spine(tailXs, tailYs, tailA, tailLo.x, tailHi.x, TAIL_LEN * (1 + tailLen.x));
          write(CLOTH, cloth);
          write(BODY, body);
          cloth(TIP_X, TIP_Y);
          var turnTip = "translate(" + fix(WX - TIP_X, 1) + " " + fix(WY - TIP_Y, 1) + ") rotate(" +
            fix((WA + tip.x) * DEG, 2) + " " + TIP_X + " " + TIP_Y + ")";
          tipEl.setAttribute("transform", turnTip);
          haloEl.setAttribute("transform", turnTip);
          cloth(GLINT_X, GLINT_Y);
          glintEl.setAttribute("transform", "translate(" + fix(WX - GLINT_X, 1) + " " + fix(WY - GLINT_Y, 1) +
            ") rotate(" + fix(WA * DEG, 2) + " " + GLINT_X + " " + GLINT_Y + ")");
          handL.setAttribute("transform", "translate(" + fix(hLX.x, 1) + " " + fix(hLY.x, 1) + ")");
          handR.setAttribute("transform", "translate(" + fix(hRX.x * (1 - wave) + waveX, 1) + " " +
            fix(hRY.x * (1 - wave) + waveY, 1) + ")");

          // The floor under it: fainter and smaller the higher it rides.
          if (shadowEl) {
            var high = clamp(-y / 44, -0.4, 1.2);
            shadowEl.style.opacity = String(fix(smooth(520, 1000, t) * (1 - 0.4 * high), 2));
            shadowEl.style.transform = "translate3d(" + fix(x * 0.8, 1) + "px,0,0) scale(" + fix(1 - 0.2 * high, 4) + ")";
          }

          if (t > 120 && t < 940 && t - trailAt > 50) { trailAt = t; shed(vx, vy); }
          if (grin && t >= 740) { grin = false; svg.classList.remove("sp-joy"); }
          if (!cast && t >= CAST) { cast = true; flare(); }
          if (!root.classList.contains("sp-exit")) window.requestAnimationFrame(frame);
        }

        // A boot stage landed: jump for it, and flick the tip to throw the spark.
        window.__spHop = function () {
          hopAt = performance.now() - t0;
          tip.v += 3.4;
        };
        try {
          frame(t0);
        } catch (error) {
          window.__spHop = null;
          root.classList.remove("sp-js");
        }
      })();
`;
