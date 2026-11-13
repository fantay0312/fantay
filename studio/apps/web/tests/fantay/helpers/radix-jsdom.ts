// SPDX-License-Identifier: Apache-2.0
// jsdom gaps that Radix primitives touch (popper sizing, pointer capture, scroll-into-view,
// media queries). Importing this module installs the stubs once; they are additive (only
// defined when jsdom lacks them) and live only in the importing test file's environment.

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class DOMRectStub {
  x: number;
  y: number;
  width: number;
  height: number;
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
  get top(): number {
    return this.y;
  }
  get left(): number {
    return this.x;
  }
  get right(): number {
    return this.x + this.width;
  }
  get bottom(): number {
    return this.y + this.height;
  }
  toJSON(): Record<string, number> {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
  static fromRect(rect: { x?: number; y?: number; width?: number; height?: number } = {}): DOMRectStub {
    return new DOMRectStub(rect.x, rect.y, rect.width, rect.height);
  }
}

export function installRadixJsdomStubs(): void {
  if (typeof window === 'undefined') return;
  const globals = globalThis as Record<string, unknown>;
  if (typeof globals.ResizeObserver !== 'function') globals.ResizeObserver = ResizeObserverStub;
  if (typeof globals.DOMRect !== 'function') globals.DOMRect = DOMRectStub;

  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto.hasPointerCapture !== 'function') proto.hasPointerCapture = () => false;
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = () => {};
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = () => {};
  if (typeof proto.scrollIntoView !== 'function') proto.scrollIntoView = () => {};

  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
}

installRadixJsdomStubs();
