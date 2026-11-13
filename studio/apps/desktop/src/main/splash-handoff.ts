// Splash → app hand-off as one surface changing its contents, not two layers
// crossing.
//
// The splash wears the app window's frame and the app window takes the
// splash's bounds (see `createSplashWindow` and the reveal in `runtime.ts`), so
// the two windows are the same rectangle. The app's document sits behind the
// splash under a boot curtain: a layer in the splash's own ground colour in
// front of its content (`runtime.ts`, "Boot curtain"). That makes the order
// simple:
//
//   0. the app's document is told to lift its curtain after a short hold, and
//      nothing else happens until it has taken that in;
//   1. the splash's content fades out in place, leaving its bare ground;
//   2. the app window is shown — at full opacity, and at that instant pixel for
//      pixel the same bare ground, so the swap itself cannot be seen;
//   3. the splash, now covered, closes; the curtain's hold runs out and it
//      fades, letting the app's content in.
//
// Step 0 is a gate, and the reason is measured. An app that has just mounted
// keeps its renderer busy for several hundred milliseconds; a lift requested
// in step 2 waited that long behind a blank window (~700ms), and one requested
// in step 1 nearly as long (~560ms). So the visible part does not begin until
// the document has answered: the wait is spent with the splash still playing,
// and from then on the fade is the compositor's own clock.
//
// Two things this deliberately does not do. It does not animate the window's
// opacity: the app window's backing is vibrancy glass, which ignores the
// window's opacity — a window shown at opacity 0 over the splash already
// replaces the splash's white with frosted grey, so a window fade puts a grey
// flash between the splash and the app. And it does not put the app window on
// screen early, unseen, to warm it: under Stage Manager a second window
// joining the stage sends the splash flying off to the side.

/** The splash page's own exit (150ms) is over by the time the app window is shown. */
export const SPLASH_HANDOFF_LEAD_MS = 160;
/**
 * How long the covered splash stays, so the app window has presented before
 * nothing is behind it. Shorter than the curtain's hold (`runtime.ts`): the
 * splash goes while the curtain is still whole, and what the curtain then
 * lifts on is the app as it will stay — its glass over the desktop, not over
 * a splash about to vanish.
 */
export const SPLASH_HANDOFF_SETTLE_MS = 40;
/** A document that never answers does not hold the splash for longer than this. */
export const SPLASH_HANDOFF_ARM_MAX_MS = 1500;

export type HandoffSplashWindow = {
  isDestroyed(): boolean;
  close(): void;
  webContents: { executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> };
};

export type SplashHandoffInput = {
  splash: HandoffSplashWindow | null;
  /**
   * Arms the lift of the app's boot curtain and resolves once the app's
   * document has taken it in. Called exactly once, first.
   */
  arm: () => Promise<unknown>;
  /** Shows and focuses the app window. Called exactly once, when the splash's content has left. */
  show: () => void;
};

/**
 * Retires the splash and reveals the app window. Whatever goes wrong on the
 * way, the things that must hold do: `arm` and `show` have each run once, and
 * the splash ends up closed.
 */
export function handOffFromSplash(input: SplashHandoffInput): void {
  const { splash } = input;
  const closeSplash = (): void => {
    if (splash != null && !splash.isDestroyed()) splash.close();
  };

  let armed: Promise<unknown>;
  try {
    armed = input.arm();
  } catch (error) {
    armed = Promise.reject(error);
  }

  // No splash to leave: nothing to wait for (the curtain also lifts by itself).
  if (splash == null || splash.isDestroyed()) {
    armed.catch(() => undefined);
    input.show();
    return;
  }

  let begun = false;
  const begin = (): void => {
    if (begun) return;
    begun = true;
    clearTimeout(giveUp);
    // The splash may have been closed while the document was busy.
    if (splash.isDestroyed()) {
      input.show();
      return;
    }
    void splash.webContents
      .executeJavaScript("window.__odSplashExit && window.__odSplashExit();", true)
      .catch(() => undefined);
    setTimeout(() => {
      try {
        input.show();
      } finally {
        setTimeout(closeSplash, SPLASH_HANDOFF_SETTLE_MS);
      }
    }, SPLASH_HANDOFF_LEAD_MS);
  };
  const giveUp = setTimeout(begin, SPLASH_HANDOFF_ARM_MAX_MS);
  void armed.then(begin, begin);
}
