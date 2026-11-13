import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { buildMovieHtml, createMovieDocument } from "@open-design/contracts";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

describe("movie video clock", () => {
  it("seeks, plays and pauses an imported video with the composition clock", () => {
    const doc = createMovieDocument();
    doc.shots = [
      {
        id: "clip",
        title: "A video shot",
        body: "",
        duration: 3,
        layout: "split",
        media: "clip.mp4",
      },
    ];
    const dom = new JSDOM(buildMovieHtml(doc), {
      runScripts: "outside-only",
      url: "http://localhost/",
    });
    const video = dom.window.document.querySelector("video")!;
    let isPaused = true;
    Object.defineProperty(video, "paused", { get: () => isPaused });
    Object.defineProperty(video, "duration", { get: () => 3 });
    video.play = vi.fn(async () => {
      isPaused = false;
    });
    video.pause = vi.fn(() => {
      isPaused = true;
    });
    let currentTime = 0;
    let paused = true;
    let update = () => {};
    const timeline = {
      set() {
        return this;
      },
      fromTo() {
        return this;
      },
      to() {
        return this;
      },
      eventCallback(_name: string, callback: () => void) {
        update = callback;
        return this;
      },
      time() {
        return currentTime;
      },
      paused() {
        return paused;
      },
      repeat() {
        return this;
      },
      pause(time?: number) {
        paused = true;
        if (time !== undefined) currentTime = time;
        return this;
      },
      play() {
        paused = false;
        return this;
      },
    };
    (dom.window as unknown as { gsap: unknown }).gsap = {
      timeline: () => timeline,
    };
    const inline = [...dom.window.document.scripts].find(
      (s) => !s.src,
    )!.textContent!;
    dom.window.eval(inline);
    const send = (action: string, time?: number) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window.parent,
          data: { type: "fantay-movie", action, time },
        }),
      );
    send("seek", 1.5);
    expect(video.currentTime).toBeCloseTo(1.5);
    send("play");
    expect(video.play).toHaveBeenCalled();
    timeline.pause();
    expect(video.paused).toBe(true);
    timeline.play();
    expect(video.paused).toBe(false);
    send("pause");
    expect(video.pause).toHaveBeenCalled();
    expect(video.paused).toBe(true);
    dom.window.close();
  });
});
