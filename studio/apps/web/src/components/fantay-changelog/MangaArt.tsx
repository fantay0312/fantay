// SPDX-License-Identifier: AGPL-3.0-only
// The manga's drawing kit: Fantay's star-hat spirit mascot drawn in tankōbon ink and spot colour, focus lines, speed
// lines, starbursts, speech balloons, narration captions, chapter seals and sound effects.
// Every procedural shape is deterministic (seeded), so a page draws identically on every open.
import { useId, useMemo, type CSSProperties, type ReactNode } from 'react';

import styles from './FantayChangelog.module.css';

export type InkMascotStyle = 'ink' | 'inverse' | 'color' | 'paper';
export type InkMascotMood = 'calm' | 'happy' | 'shock' | 'wink' | 'sparkle' | 'focused';
export type InkMascotPose = 'float' | 'wave' | 'cheer' | 'point' | 'peek' | 'proud';

// Exact vector landmarks from public/fantay-sprite.svg (viewBox 0 0 512 512), layered for manga ink & spot-colour print.
const CAPE_LEFT =
  'M57.5 386C61 379.7 64 373.3 67.5 367C72.4 358.3 77.5 349.7 82.5 341C87.3 332.7 91 323.6 97 316C103 308.4 111 302.7 118 296C122.3 307.3 128 318.2 131 330C133.6 340.1 133.3 350.7 134.5 361C131.2 356.2 126.2 350 121 350C114.4 350 106.6 352.9 100 356C91.5 360 83.7 365.6 76 371C69.5 375.6 63.7 381 57.5 386Z';
const CAPE_RIGHT =
  'M453.6 368.5C453.2 370.9 450 375.7 447.5 375.5C443.4 375.1 437.7 372.1 433 370C427.2 367.4 422.1 363.1 416 361.5C412.3 360.5 407.8 360.6 404.5 362.5C400 365.1 397.5 370.2 394 374C394.7 363.7 391.1 352.1 396 343C402.2 331.4 415.3 325 425 316C430.3 320.7 437.3 323.9 441 330C446.7 339.4 450 350.2 452.3 361C452.8 363.5 454 366.5 453.6 368.5Z';
const BODY =
  'M266 238C308.8 238 353 256.7 386 284C403.4 298.4 403.1 327.5 401.5 350C400 371.9 387.2 393.1 372 409C356 425.8 332.3 432.9 312 444C301.6 449.6 289 451.4 280 459C271.7 466.1 267.1 476.8 262 486.5C252 480 242.4 472.8 232 467C213.7 456.9 193.3 450.6 176 439C162.7 430.1 148.6 420.1 141 406C132.9 391.1 131 373 131 356C131 331.5 127.5 300.1 146 284C178.3 255.8 223.2 238 266 238Z';
const BODY_SHADE =
  'M404 336C398.3 340.7 388.3 342.8 387 350C384.6 363.7 381.9 377.9 375 390C369.2 400.2 359.4 407.9 350 415C340.2 422.4 328.8 427.2 318 433C308.8 437.9 298.5 441 290 447C283.6 451.5 278.5 457.6 274 464C269 471.1 266 479.3 262 487C274.7 491.3 287.3 495.7 300 500C343.3 473.3 386.7 446.7 430 420C421.3 392 412.7 364 404 336Z';
const HAT_BODY =
  'M314 27.2C320.1 27.4 326.3 27.5 332 29.7C335.9 31.2 339.9 32.5 343.5 34.6C344.8 42.1 348.3 49.6 347 57C345.3 66.9 340.5 76.3 334.7 84.6C330.2 85.2 327.9 93.5 327.6 98C327.2 103.2 331 108.1 334.5 112C338.9 116.9 345.7 119.1 350.5 123.5C358.4 130.8 365.8 138.7 372.5 147C384 161.2 395.8 175.3 405 191C414.1 206.4 422 222.8 427 240C432.6 259.5 432.3 280.2 436.5 300C440.8 320.6 447.2 340.7 452.5 361C447.8 354.5 443.4 347.8 438.5 341.5C434.4 336.2 429.8 331.2 425.5 326C424 339.9 422.1 352.5 416.5 352.5C409.3 352.5 397.2 331 386 322C371.3 310.2 357.9 290.5 339 290.5C323.2 290.5 313.1 308.7 300 317.5C288.8 325 278.1 339.5 266 339.5C253.9 339.5 243.1 325.1 232 317.5C218.8 308.5 209 289.5 193 289.5C174 289.5 161.1 310.4 146 322C135.1 330.4 121.9 349.5 115 349.5C111.6 349.5 107.4 340.4 107.5 337C107.8 327.5 109.5 318 110.5 308.5C102.9 320.6 93.2 331.3 85 343C76.7 354.9 69 367.3 61 379.5C70.8 359.7 83.4 341 90.5 320C97.5 299.4 97 276.9 103 256C109.2 234.1 116.4 212.2 127 192C138.9 169.2 154.7 148.6 170 128C187.4 104.6 203.1 79.2 225 60C240.5 46.4 260.6 38.6 280 31.5C290.7 27.5 302.6 26.8 314 27.2Z';
const HAT_SHADE_EDGE =
  'M398 176C402.3 191.3 407.5 206.4 411 222C414.2 236.5 416 251.3 418 266C419.5 277.3 420.1 288.7 421.5 300C422.6 308.7 424.2 317.3 425.5 326C428 334 430.5 342 433 350C448.7 360 464.3 370 480 380C476.7 310 473.3 240 470 170C446 172 422 174 398 176Z';
const HAT_SHADE_CREASE =
  'M333 78C328.9 76.9 324.3 80.3 321.7 83.7C319.9 85.9 319.9 89.2 319.8 92C319.7 96 319.9 100.3 321.5 104C323.4 108.2 326.3 112.3 330 115C336 119.4 343.5 121.3 350 125C354 127.3 362.7 122.6 362 118C360.5 107.2 351.4 98.8 345 90C341.7 85.4 338.5 79.5 333 78Z';
const HAT_LIGHT =
  'M290 14C287.7 19.7 287.2 26.5 283 31C275.4 39 263.6 42 256 50C249.6 56.7 244.5 65.1 242 74C238.2 87.2 239.6 101.4 237.5 115C234.9 132.1 231.7 149.1 228 166C224.5 181.8 221.3 197.7 216 213C212.9 221.9 209.2 230.9 203 238C195.8 246.3 183.9 249.5 177 258C169.5 267.3 164.5 278.6 161 290C157.4 301.6 157.8 314 156 326C154.1 338.7 152 351.3 150 364C132 363.3 114 362.7 96 362C97.3 352.7 97.5 343.1 100 334C102.4 325.1 112.1 317.6 110.5 308.5C109.4 298.3 107.6 288.1 106 278C104.3 267.6 102.3 257.3 100.5 247C90.3 244.7 80.2 242.3 70 240C76.7 193.3 83.3 146.7 90 100C156.7 71.3 223.3 42.7 290 14Z';
const HAT_TIP =
  'M303 58A27 27 0 0 1 347.4 37.3C353.6 42.6 361.9 45.6 367 52C371 57 373.8 63.6 373.6 70C373.4 75 374.1 80.1 373 85C371.8 90.3 372.4 100 367 100C363.2 100 360.5 94.6 359 92C357 88.5 351 84.4 346 84.4C341.4 84.4 336.9 84.5 332.4 84.9A27 27 0 0 1 303 58Z';
const HAT_TIP_SHADE =
  'M366 82C361.5 77.3 353.5 77.5 347 77.5C342.3 77.5 337.5 76.9 333 78C328.9 79 324.3 80.3 321.7 83.7C319.9 85.9 319.9 89.2 319.8 92C319.4 102.7 334.5 109.6 345 112C354.1 114.1 366.6 111.7 372 104C376.4 97.8 371.2 87.5 366 82Z';
const ORB_LIGHT = 'M353.8 115.3A26 26 0 0 1 392.8 87C390.8 101 377 113 353.8 115.3Z';
const ORB_SHADE = 'M356.9 122.6A26 26 0 1 0 397.6 90.9A26 26 0 0 1 356.9 122.6Z';

const HAT_STARS = [
  'M288 176C288 185.8 292.2 190 302 190C292.2 190 288 194.2 288 204C288 194.2 283.8 190 274 190C283.8 190 288 185.8 288 176Z',
  'M295 112C295 120.4 298.6 124 307 124C298.6 124 295 127.6 295 136C295 127.6 291.4 124 283 124C291.4 124 295 120.4 295 112Z',
  'M262 67C262 74 265 77 272 77C265 77 262 80 262 87C262 80 259 77 252 77C259 77 262 74 262 67Z',
  'M349 201C349 208 352 211 359 211C352 211 349 214 349 221C349 214 346 211 339 211C346 211 349 208 349 201Z',
  'M136 200C136 207 139 210 146 210C139 210 136 213 136 220C136 213 133 210 126 210C133 210 136 207 136 200Z',
  'M180 225C180 232 183 235 190 235C183 235 180 238 180 245C180 238 177 235 170 235C177 235 180 232 180 225Z',
  'M128 279.5C128 286.2 130.9 289 137.5 289C130.9 289 128 291.9 128 298.5C128 291.9 125.2 289 118.5 289C125.2 289 128 286.2 128 279.5Z',
  'M195 133.5C195 138.8 197.3 141 202.5 141C197.3 141 195 143.3 195 148.5C195 143.3 192.8 141 187.5 141C192.8 141 195 138.8 195 133.5Z',
  'M350 152C350 157.6 352.4 160 358 160C352.4 160 350 162.4 350 168C350 162.4 347.6 160 342 160C347.6 160 350 157.6 350 152Z',
  'M397 197.5C397 202.8 399.3 205 404.5 205C399.3 205 397 207.3 397 212.5C397 207.3 394.8 205 389.5 205C394.8 205 397 202.8 397 197.5Z',
  'M228 241.5C228 246.8 230.3 249 235.5 249C230.3 249 228 251.3 228 256.5C228 251.3 225.8 249 220.5 249C225.8 249 228 246.8 228 241.5Z',
  'M402 280.5C402 285.8 404.3 288 409.5 288C404.3 288 402 290.3 402 295.5C402 290.3 399.8 288 394.5 288C399.8 288 402 285.8 402 280.5Z',
] as const;

interface HandSpec {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  r?: number;
  tilt?: number;
  motion?: 'wave' | 'cheer' | 'point';
}

const POSE_SPEC: Record<InkMascotPose, HandSpec> = {
  float: { lx: 124.5, ly: 393, rx: 414, ry: 390.5 },
  wave: { lx: 124, ly: 396, rx: 435, ry: 318, tilt: -2.5, motion: 'wave' },
  cheer: { lx: 102, ly: 326, rx: 432, ry: 322, tilt: -1.5, motion: 'cheer' },
  point: { lx: 108, ly: 338, rx: 414, ry: 392, tilt: 2, motion: 'point' },
  peek: { lx: 162, ly: 410, rx: 370, ry: 410, r: 22.5 },
  proud: { lx: 134, ly: 386, rx: 400, ry: 384, tilt: -3 },
};

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** Small, fast, seeded PRNG so every page draws identically. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function starPath(x: number, y: number, r: number): string {
  const c = (r * 0.28).toFixed(1);
  return `M${x} ${y - r}C${x} ${y - Number(c)} ${x + Number(c)} ${y} ${x + r} ${y}C${x + Number(c)} ${y} ${x} ${y + Number(c)} ${x} ${y + r}C${x} ${y + Number(c)} ${x - Number(c)} ${y} ${x - r} ${y}C${x - Number(c)} ${y} ${x} ${y - Number(c)} ${x} ${y - r}Z`;
}

function PuffHand({ cx: x, cy: y, r = 25, shadeId }: { cx: number; cy: number; r?: number; shadeId: string }) {
  const dx = r * 0.82;
  const dy = r * 0.58;
  const ux = r * 0.68;
  const uy = r * 0.74;
  return (
    <g className={styles.mascotHandGroup}>
      <circle className={styles.mascotHand} cx={x} cy={y} r={r} />
      <path
        className={styles.mascotHandShade}
        style={{ '--hand-tone': `url(#${shadeId})` } as CSSProperties}
        d={`M${(x - dx).toFixed(1)} ${(y + dy).toFixed(1)}A${r} ${r} 0 1 0 ${(x + ux).toFixed(1)} ${(y - uy).toFixed(1)}A${r} ${r} 0 0 1 ${(x - dx).toFixed(1)} ${(y + dy).toFixed(1)}Z`}
      />
      <circle className={styles.mascotHandRing} cx={x} cy={y} r={r} />
    </g>
  );
}

/**
 * Fantay's star-hat spirit redrawn as a tankōbon manga character.
 * `ink` uses G-pen outlines, cross-hatched cape corners and dot screentones on paper;
 * `inverse` renders crisp paper-white linework on dark panels;
 * `color` and `paper` render spot-colour cover illustrations faithful to public/fantay-sprite.svg.
 */
export function InkMascot({
  look = 'ink',
  mood = 'calm',
  pose = 'float',
  mirrored = false,
  className,
  style,
}: {
  look?: InkMascotStyle;
  mood?: InkMascotMood;
  pose?: InkMascotPose;
  mirrored?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const id = `fm-${rawId}`;
  const isColor = look === 'color' || look === 'paper';
  const spec = POSE_SPEC[pose];
  const groupTransform = [
    mirrored ? 'translate(512 0) scale(-1 1)' : '',
    spec.tilt ? `rotate(${spec.tilt} 266 300)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      className={cx(styles.mascot, className)}
      data-look={look}
      data-mood={mood}
      data-pose={pose}
      viewBox="0 0 512 512"
      style={style}
      aria-hidden
      focusable="false"
    >
      <defs>
        <clipPath id={`${id}-clip-hat`}>
          <path d={HAT_BODY} />
        </clipPath>
        <clipPath id={`${id}-clip-tip`}>
          <path d={HAT_TIP} />
        </clipPath>
        <clipPath id={`${id}-clip-body`}>
          <path d={BODY} />
        </clipPath>
        <clipPath id={`${id}-clip-eye-l`}>
          <ellipse cx="194" cy="348" rx="35.5" ry="45.5" />
        </clipPath>
        <clipPath id={`${id}-clip-eye-r`}>
          <ellipse cx="338" cy="348" rx="35.5" ry="45.5" />
        </clipPath>
        {/* Manga cross-hatching for the coral inner cape in B&W print */}
        <pattern id={`${id}-hatch`} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(-38)">
          <rect width="14" height="14" className={styles.mascotPatternPaper} />
          <line x1="0" y1="3.5" x2="14" y2="3.5" className={styles.mascotPatternInk} strokeWidth="2.4" />
          <line x1="0" y1="10.5" x2="14" y2="10.5" className={styles.mascotPatternInk} strokeWidth="2.4" />
        </pattern>
        {/* Fine halftone dots for soft spirit shadows and iris glow */}
        <pattern id={`${id}-dots`} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(18)">
          <circle cx="3" cy="3" r="2.1" className={styles.mascotPatternDot} />
          <circle cx="9" cy="9" r="2.1" className={styles.mascotPatternDot} />
        </pattern>
        <pattern id={`${id}-dots-light`} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(-15)">
          <circle cx="4" cy="4" r="1.9" className={styles.mascotPatternLightDot} />
          <circle cx="11" cy="11" r="1.9" className={styles.mascotPatternLightDot} />
        </pattern>
        {isColor ? (
          <>
            <radialGradient id={`${id}-eye`} cx=".5" cy="1" r=".78">
              <stop offset="0" stopColor="#9da0ff" />
              <stop offset=".32" stopColor="#7d80f1" />
              <stop offset=".54" stopColor="#4447d6" />
              <stop offset=".72" stopColor="#2b2c8c" />
              <stop offset=".88" stopColor="#20215f" />
            </radialGradient>
            <radialGradient id={`${id}-skin`} cx=".44" cy=".36" r=".62">
              <stop offset=".55" stopColor="#faf9ff" />
              <stop offset="1" stopColor="#e8e8fc" />
            </radialGradient>
            <radialGradient id={`${id}-blush`}>
              <stop offset="0" stopColor="#ff9482" stopOpacity=".88" />
              <stop offset=".5" stopColor="#ff9482" stopOpacity=".42" />
              <stop offset="1" stopColor="#ff9482" stopOpacity="0" />
            </radialGradient>
            <radialGradient id={`${id}-glow`}>
              <stop offset="0" stopColor="#ff9a80" stopOpacity=".46" />
              <stop offset=".5" stopColor="#ff9a80" stopOpacity=".16" />
              <stop offset="1" stopColor="#ff9a80" stopOpacity="0" />
            </radialGradient>
          </>
        ) : null}
      </defs>

      <g transform={groupTransform || undefined}>
        {/* 1. Coral inner cape wings peeking out from under the starry hood */}
        <g className={styles.mascotCapes}>
          <path
            className={styles.mascotCape}
            style={!isColor ? ({ fill: `url(#${id}-hatch)` } as CSSProperties) : undefined}
            d={CAPE_LEFT}
          />
          <path
            className={styles.mascotCape}
            style={!isColor ? ({ fill: `url(#${id}-hatch)` } as CSSProperties) : undefined}
            d={CAPE_RIGHT}
          />
        </g>

        {/* 2. Spirit body, crescent volume shadow and hood forehead cast shadow */}
        <g className={styles.mascotBodyGroup}>
          <path
            className={styles.mascotBody}
            style={isColor ? ({ fill: `url(#${id}-skin)` } as CSSProperties) : undefined}
            d={BODY}
          />
          <g clipPath={`url(#${id}-clip-body)`}>
            <path
              className={styles.mascotBodyShade}
              style={!isColor ? ({ fill: `url(#${id}-dots)` } as CSSProperties) : undefined}
              d={BODY_SHADE}
            />
            <path className={styles.mascotForeheadShade} d={HAT_BODY} transform="translate(0 12)" />
          </g>
          <path className={styles.mascotBodyOutline} d={BODY} />
        </g>

        {/* 3. Expressive manga face */}
        <g className={styles.mascotFace}>
          {[194, 338].map((x, index) => {
            const clipId = index === 0 ? `${id}-clip-eye-l` : `${id}-clip-eye-r`;
            const isHappyClosed = mood === 'happy';
            const isWinkClosed = mood === 'wink' && index === 1;

            if (isHappyClosed) {
              const outer = index === 0 ? -1 : 1;
              return (
                <g key={x}>
                  <path
                    className={styles.mascotLid}
                    d={`M ${x - 32} 357 C ${x - 19} 323, ${x + 19} 323, ${x + 32} 357`}
                  />
                  <path
                    className={styles.mascotLashFlick}
                    d={`M ${x + outer * 27} 344 L ${x + outer * 39} 337`}
                  />
                </g>
              );
            }

            if (isWinkClosed) {
              return (
                <g key={x}>
                  <path className={styles.mascotLid} d={`M ${x - 31} 352 Q ${x - 2} 324 ${x + 31} 348`} />
                  <path className={styles.mascotWinkCrease} d={`M ${x - 18} 364 Q ${x + 2} 358 ${x + 20} 363`} />
                </g>
              );
            }

            const isSparkle = mood === 'sparkle';
            const isShock = mood === 'shock';
            const rx = isSparkle ? 37 : isShock ? 36.5 : 35.5;
            const ry = isSparkle ? 46.5 : isShock ? 46 : 45.5;

            return (
              <g key={x}>
                <ellipse
                  className={styles.mascotEye}
                  style={isColor ? ({ fill: `url(#${id}-eye)` } as CSSProperties) : undefined}
                  cx={x}
                  cy="348"
                  rx={rx}
                  ry={ry}
                />
                {/* Lower iris manga halftone glow in B&W print */}
                {!isColor ? (
                  <g clipPath={`url(#${clipId})`}>
                    <ellipse
                      cx={x}
                      cy="380"
                      rx="28"
                      ry="20"
                      style={{ fill: `url(#${id}-dots-light)` } as CSSProperties}
                    />
                  </g>
                ) : null}
                {/* Upper lash line for extra manga crispness */}
                <path
                  className={styles.mascotUpperLash}
                  d={`M ${x - rx + 2} 336 C ${x - 22} 296, ${x + 22} 296, ${x + rx - 2} 336`}
                />
                {isSparkle ? (
                  <>
                    <path className={styles.mascotGlint} d={starPath(x - 8, 336, 15)} />
                    <ellipse className={styles.mascotGlint} cx={x + 14} cy="364" rx="6" ry="7.5" />
                    <circle className={styles.mascotGlint} cx={x - 17} cy="363" r="3.5" />
                  </>
                ) : isShock ? (
                  <>
                    <ellipse className={styles.mascotGlint} cx={x - 11} cy="331" rx="10.5" ry="13.5" />
                    <path className={styles.mascotGlint} d={starPath(x + 9, 357, 9.5)} />
                    <circle className={styles.mascotGlint} cx={x - 12} cy="366" r="4" />
                  </>
                ) : (
                  <>
                    <ellipse className={styles.mascotGlint} cx={x - 11.5} cy="332" rx="11" ry="14.5" />
                    <ellipse className={styles.mascotGlint} cx={x + 12.5} cy="365.5" rx="5" ry="6.5" />
                  </>
                )}
                {mood === 'focused' ? (
                  <path
                    className={styles.mascotBrow}
                    d={index === 0 ? 'M162 304 L222 315' : 'M370 304 L310 315'}
                  />
                ) : isShock ? (
                  <path
                    className={styles.mascotBrow}
                    d={index === 0 ? 'M164 300 Q192 289 218 301' : 'M314 301 Q340 289 368 300'}
                  />
                ) : null}
              </g>
            );
          })}

          {/* Cheek blush: soft coral glow on covers + diagonal manga blush ticks */}
          {isColor ? (
            <>
              <ellipse cx="160" cy="391" rx="17" ry="9.5" style={{ fill: `url(#${id}-blush)` }} />
              <ellipse cx="372" cy="391" rx="17" ry="9.5" style={{ fill: `url(#${id}-blush)` }} />
            </>
          ) : null}
          <g className={styles.mascotBlushLines}>
            <path d="M148 395 L154 385 M156 396 L162 386 M164 395 L170 385" />
            <path d="M362 395 L368 385 M370 396 L376 386 M378 395 L384 385" />
          </g>

          {/* Mouth */}
          {mood === 'shock' ? (
            <ellipse className={styles.mascotSurpriseMouth} cx="266" cy="393" rx="8.5" ry="10.5" />
          ) : mood === 'happy' || mood === 'sparkle' ? (
            <g>
              <path
                className={styles.mascotHappyMouth}
                d="M245 385 C249 392, 261 392, 266 384 C271 392, 283 392, 287 385 C286 404, 246 404, 245 385 Z"
              />
              <path className={styles.mascotMouth} d="M244 385c1 6 5.5 8.5 11 8.5s11-2.8 11-8c0 5.2 5.5 8 11 8s10-2.5 11-8.5" />
            </g>
          ) : mood === 'focused' ? (
            <path className={styles.mascotMouth} d="M250 391 Q268 396 287 385" />
          ) : (
            <path
              className={styles.mascotMouth}
              d="M245.5 386.5c0 6.2 4.6 9.3 10 9.3s10.2-3.1 10.2-8.6c0 5.5 4.6 8.6 10.2 8.6s10-3.1 10-9.3"
            />
          )}
        </g>

        {/* 4. Starry night-cap hood, folded tail and glowing coral pom-pom orb */}
        <g className={styles.mascotHatGroup}>
          {isColor ? (
            <circle cx="379" cy="109" r="64" style={{ fill: `url(#${id}-glow)` }} />
          ) : (
            <g className={styles.mascotOrbRays}>
              <circle cx="379" cy="109" r="36" strokeDasharray="4 7" />
              <path d={starPath(418, 76, 8)} className={styles.mascotRayStar} />
            </g>
          )}

          <path className={styles.mascotHat} d={HAT_BODY} />
          <g clipPath={`url(#${id}-clip-hat)`}>
            <path className={styles.mascotHatShade} d={HAT_SHADE_EDGE} />
            <path className={styles.mascotHatShade} d={HAT_SHADE_CREASE} />
            <path
              className={styles.mascotHatLight}
              style={!isColor ? ({ fill: `url(#${id}-dots-light)` } as CSSProperties) : undefined}
              d={HAT_LIGHT}
            />
          </g>
          <ellipse
            className={styles.mascotHatGlint}
            cx="207"
            cy="214"
            rx="25"
            ry="21.5"
            transform="rotate(-20 207 214)"
          />
          <g className={styles.mascotStars}>
            {HAT_STARS.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>
          <path className={styles.mascotHatOutline} d={HAT_BODY} />

          {/* Folded drooping cap tip */}
          <path className={styles.mascotHat} d={HAT_TIP} />
          <g clipPath={`url(#${id}-clip-tip)`}>
            <path className={styles.mascotHatShade} d={HAT_TIP_SHADE} />
          </g>
          <path className={styles.mascotHatTipSeam} d="M304 59C308 75 320 84 335 85" />
          <path className={styles.mascotHatOutline} d={HAT_TIP} />

          {/* Glowing pom-pom orb */}
          <g className={styles.mascotOrbGroup}>
            <circle className={styles.mascotOrb} cx="379" cy="109" r="26" />
            {isColor ? (
              <>
                <path fill="#ffd3c2" d={ORB_LIGHT} />
                <path fill="#e9644c" d={ORB_SHADE} />
              </>
            ) : (
              <path
                className={styles.mascotOrbTone}
                style={{ fill: `url(#${id}-dots)` } as CSSProperties}
                d={ORB_SHADE}
              />
            )}
            <ellipse
              className={styles.mascotOrbGlint}
              cx="369.5"
              cy="99"
              rx="8.3"
              ry="5.6"
              transform="rotate(-24 369.5 99)"
            />
            <circle className={styles.mascotOrbRing} cx="379" cy="109" r="26" />
          </g>
        </g>

        {/* 5. Floating round spirit hands & manga gesture accents */}
        <PuffHand cx={spec.lx} cy={spec.ly} r={spec.r} shadeId={`${id}-dots`} />
        <PuffHand cx={spec.rx} cy={spec.ry} r={spec.r} shadeId={`${id}-dots`} />

        {spec.motion === 'wave' ? (
          <g className={styles.mascotMotion}>
            <path d="M466 293 Q479 313 470 335" />
            <path d="M479 300 Q489 315 482 331" />
          </g>
        ) : spec.motion === 'cheer' ? (
          <g className={styles.mascotSparkleMarks}>
            <path d={starPath(72, 286, 13)} />
            <path d={starPath(458, 278, 15)} />
          </g>
        ) : spec.motion === 'point' ? (
          <g className={styles.mascotMotion}>
            <path d="M74 316 L88 325 M70 334 L85 337" />
          </g>
        ) : null}

        {mood === 'sparkle' ? (
          <g className={styles.mascotSparkleMarks}>
            <path d={starPath(80, 224, 14)} />
            <path d={starPath(454, 228, 12)} />
          </g>
        ) : null}
      </g>
    </svg>
  );
}

/** 集中線: ink wedges converging on a point, the manga way of saying "look here". Coordinates are panel percentages. */
export function FocusLines({
  x = 50,
  y = 50,
  count = 64,
  inner = 26,
  seed = 1,
  className,
}: {
  x?: number;
  y?: number;
  count?: number;
  inner?: number;
  seed?: number;
  className?: string;
}) {
  const d = useMemo(() => {
    const rnd = seeded(seed);
    const outer = 160;
    let path = '';
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2 + rnd() * 0.05;
      const w = 0.006 + rnd() * 0.016;
      const r = inner + rnd() * 18;
      const p = (angle: number, radius: number) =>
        `${(x + Math.cos(angle) * radius).toFixed(2)} ${(y + Math.sin(angle) * radius).toFixed(2)}`;
      path += `M ${p(a - w, outer)} L ${p(a, r)} L ${p(a + w, outer)} Z `;
    }
    return path;
  }, [count, inner, seed, x, y]);
  return (
    <svg className={cx(styles.fill, className)} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
      <path className={styles.inkFill} d={d} />
    </svg>
  );
}

/** Parallel speed lines sweeping across a panel at an angle. */
export function SpeedLines({ angle = -12, seed = 3, className }: { angle?: number; seed?: number; className?: string }) {
  const d = useMemo(() => {
    const rnd = seeded(seed);
    let path = '';
    for (let i = 0; i < 28; i += 1) {
      const y = -20 + i * 5.2 + rnd() * 2.8;
      const start = rnd() * 38;
      const length = 32 + rnd() * 72;
      const t = 0.14 + rnd() * 0.48;
      path += `M ${start.toFixed(2)} ${y.toFixed(2)} L ${(start + length).toFixed(2)} ${(y - t).toFixed(2)} L ${(start + length).toFixed(2)} ${(y + t).toFixed(2)} Z `;
    }
    return path;
  }, [seed]);
  return (
    <svg className={cx(styles.fill, className)} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
      <path className={styles.inkFill} d={d} transform={`rotate(${angle} 50 50)`} />
    </svg>
  );
}

/** The jagged explosion balloon a shout lives in. */
export function Starburst({
  children,
  seed = 7,
  className,
  style,
}: {
  children: ReactNode;
  seed?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const d = useMemo(() => {
    const rnd = seeded(seed);
    const spikes = 22;
    let path = '';
    for (let i = 0; i < spikes * 2; i += 1) {
      const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? 47.5 + rnd() * 2.2 : 38.5 + rnd() * 3.8;
      path += `${i === 0 ? 'M' : 'L'} ${(50 + Math.cos(a) * r).toFixed(2)} ${(50 + Math.sin(a) * r).toFixed(2)} `;
    }
    return `${path}Z`;
  }, [seed]);
  return (
    <div className={cx(styles.starburst, className)} style={style}>
      <svg className={styles.fill} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
        <path className={styles.burstShape} d={d} />
      </svg>
      <p className={styles.burstText}>{children}</p>
    </div>
  );
}

export type BubbleTail = 'left' | 'right' | 'center';

/** A plump manga speech balloon (吹き出し); the tail joins the rim seamlessly and points toward the speaker. */
export function Bubble({
  children,
  tail = 'center',
  emphasis = false,
  className,
  style,
}: {
  children: ReactNode;
  tail?: BubbleTail;
  emphasis?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const tipX = tail === 'left' ? 3 : tail === 'right' ? 17 : 10;
  return (
    <div className={cx(styles.bubble, emphasis && styles.bubbleEmphasis, className)} data-tail={tail} style={style}>
      <p className={styles.bubbleText}>{children}</p>
      <svg className={styles.bubbleTail} viewBox="0 0 20 24" aria-hidden focusable="false">
        <polygon className={styles.bubbleTailFill} points={`2.6,-1.5 ${tipX},21 17.4,-1.5`} />
        <path className={styles.bubbleTailStroke} d={`M 3 0.2 L ${tipX} 21 L 17 0.2`} />
      </svg>
    </div>
  );
}

/** A rectangular manga narration box. `dark` sets paper type on solid ink. */
export function Caption({
  children,
  dark = false,
  className,
  style,
}: {
  children: ReactNode;
  dark?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <p className={cx(styles.caption, dark && styles.captionDark, className)} style={style}>
      <span className={styles.captionText}>{children}</span>
    </p>
  );
}

/** Small tankōbon chapter seal stamped in the corner of a story panel so every chapter maps to Contents. */
export function ChapterSeal({
  number,
  inverse = false,
  className,
}: {
  number: number;
  inverse?: boolean;
  className?: string;
}) {
  return (
    <span className={cx(styles.chapterSeal, inverse && styles.chapterSealInverse, className)} aria-hidden>
      {String(number).padStart(2, '0')}
    </span>
  );
}

/** A hand-lettered sound effect: decoration, hidden from assistive technology. */
export function Sfx({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <span className={cx(styles.sfx, className)} style={style} aria-hidden>
      {children}
    </span>
  );
}

/** Screentone: a dot screen laid over part of a panel. `fade` grades it out the way printed tone is cut. */
export function Tone({
  fade = 'none',
  dense = false,
  className,
  style,
}: {
  fade?: 'none' | 'left' | 'right' | 'up' | 'down' | 'radial';
  dense?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return <span className={cx(styles.tone, dense && styles.toneDense, className)} data-fade={fade} style={style} aria-hidden />;
}
