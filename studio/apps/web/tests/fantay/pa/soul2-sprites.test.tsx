// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Stage 2 sprites in the chat header and the companion inspector (STAGE2 §6.3): the header portrait and the hero follow
// the emotion of the character's newest stored reply (its own sprite, else 平静, else the portrait), a running turn
// keeps the stored emotion, rooms keep the portrait, and TA lists the sprite set with the one on screen marked and the
// mood word the character wrote. Everything runs over the lab fixtures.
import "../helpers/radix-jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n";
import { PersonalAgentWorkspace } from "../../../src/fantay/pa/PersonalAgentWorkspace";
import { PaTransportProvider } from "../../../src/fantay/pa/pa-transport";
import { createFixtureTransport, type FixtureTransportOptions } from "../../../src/fantay/pa/lab/fixture-transport";
import { buildFixture, type PaFixture } from "../../../src/fantay/pa/lab/fixtures";
import { labSprite } from "../../../src/fantay/pa/lab/soul-fixtures";
import { buildIndex } from "../../../src/fantay/pa/pa-model";
import type { PaIndex, PaSprites } from "../../../src/fantay/pa/pa-types";
import { replyMood, shownSprite } from "../../../src/fantay/pa/soul/SoulInspector";
import { __resetSoulLiveForTests } from "../../../src/fantay/pa/soul/soul-live";
import { __resetSoulRevealForTests } from "../../../src/fantay/pa/soul/useSoulReveal";

const HOUR = 3_600_000;
const XY = "ag-xiaoyue";
const CONV = "conv-xiaoyue";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
});
afterEach(() => {
  cleanup();
  __resetSoulLiveForTests();
  __resetSoulRevealForTests();
});

function mount(fixture: PaFixture, options: { locale?: "en" | "zh-CN"; transport?: FixtureTransportOptions } = {}) {
  const transport = createFixtureTransport(fixture, { latency: 0, ...options.transport });
  render(
    <I18nProvider initial={options.locale ?? "en"}>
      <PaTransportProvider transport={transport}>
        <PersonalAgentWorkspace
          active
          onOpenProject={vi.fn()}
          projects={fixture.projects}
          initialState={{ ...fixture.ui, inspectorOpen: true, inspectorOpenCompanion: true, inspectorTab: "soul" }}
        />
      </PaTransportProvider>
    </I18nProvider>,
  );
}

/** The newest reply of 小月 in sprites-chat (xy-25, 有点困) with another mood. */
function withMood(fixture: PaFixture, mood: string): PaFixture {
  const messages = fixture.snapshot.messages.map((message) =>
    message.id === "xy-25" && message.soul ? { ...message, soul: { ...message.soul, mood } } : message,
  );
  return { ...fixture, snapshot: { ...fixture.snapshot, messages } };
}

function indexOf(fixture: PaFixture): PaIndex {
  return buildIndex(fixture.snapshot, fixture.channels, [], fixture.soul ?? null);
}

function withSprites(fixture: PaFixture, sprites: PaSprites): PaFixture {
  const soul = fixture.soul!;
  return { ...fixture, soul: { ...soul, characters: soul.characters.map((item) => (item.id === XY ? { ...item, sprites } : item)) } };
}

/** The image a portrait shows (the one fading out underneath is aria-hidden). */
function shownSrc(root: Element | null): string | null {
  if (!root) return null;
  const images = [...root.querySelectorAll("img")].filter((image) => !image.hasAttribute("aria-hidden"));
  return images[images.length - 1]?.getAttribute("src") ?? null;
}

function headerPortrait(): Element | null {
  return screen.getByTestId("pa-header-subject").querySelector("[data-emotion]");
}

async function heroPortrait(): Promise<Element> {
  const hero = await screen.findByTestId("pa-soul-hero");
  return hero.querySelector("[data-emotion]") ?? hero;
}

function tiles(): HTMLElement[] {
  return within(screen.getByTestId("pa-soul-sprites")).getAllByTestId("pa-soul-sprite");
}

function current(): string[] {
  return tiles()
    .filter((tile) => tile.getAttribute("aria-current") === "true")
    .map((tile) => tile.getAttribute("data-emotion") ?? "");
}

describe("sprite helpers", () => {
  it("draws an emotion's own sprite, else 平静, else none", () => {
    expect(shownSprite({ neutral: "a", sleepy: "b" }, "sleepy")).toBe("sleepy");
    expect(shownSprite({ neutral: "a", sleepy: "b" }, "surprised")).toBe("neutral");
    expect(shownSprite({ sleepy: "b" }, "surprised")).toBeNull();
    expect(shownSprite(undefined, "happy")).toBeNull();
  });
});

describe("header and hero follow the newest reply", () => {
  it("shows the sprite of the newest reply's mood, names it for assistive technology and marks it in TA", async () => {
    mount(buildFixture("sprites-chat"));
    await waitFor(() => expect(shownSrc(headerPortrait())).toBe(labSprite("sleepy")));
    expect(headerPortrait()!.getAttribute("data-emotion")).toBe("sleepy");

    const hero = await heroPortrait();
    expect(hero.getAttribute("data-emotion")).toBe("sleepy");
    expect(shownSrc(hero)).toBe(labSprite("sleepy"));
    expect(screen.getByTestId("pa-soul-hero-sprite").textContent).toBe("小月, Sleepy");

    const set = screen.getByTestId("pa-soul-sprites");
    expect(tiles().map((tile) => tile.getAttribute("data-emotion"))).toEqual(["neutral", "happy", "sad", "shy", "sleepy"]);
    expect(tiles().map((tile) => tile.textContent)).toEqual(["Calm", "Happy", "Sad", "Shy", "Sleepy"]);
    expect(current()).toEqual(["sleepy"]);
    expect(within(set).getByTestId("pa-soul-sprite-mood").textContent).toBe("有点困");
    const edit = within(set).getByTestId("pa-soul-sprites-edit");
    expect(within(edit).getByText("Sprites")).toBeTruthy();
    expect(within(edit).getByText("5 of 8 set")).toBeTruthy();
  });

  it("names the sprite in Chinese", async () => {
    mount(buildFixture("sprites-chat"), { locale: "zh-CN" });
    expect((await screen.findByTestId("pa-soul-hero-sprite")).textContent).toBe("小月，困倦");
    expect(within(screen.getByTestId("pa-soul-sprites-edit")).getByText("已配 5 / 8")).toBeTruthy();
  });

  it("falls back to 平静 for a mood without its own sprite, and says the mood as written", async () => {
    mount(withMood(buildFixture("sprites-chat"), "惊讶"));
    await waitFor(() => expect(headerPortrait()?.getAttribute("data-emotion")).toBe("surprised"));
    expect(shownSrc(headerPortrait())).toBe(labSprite("neutral"));
    const hero = await heroPortrait();
    expect(shownSrc(hero)).toBe(labSprite("neutral"));
    expect(screen.queryByTestId("pa-soul-hero-sprite")).toBeNull();
    expect(current()).toEqual(["neutral"]);
    expect(screen.getByTestId("pa-soul-sprite-mood").textContent).toBe("惊讶");
  });

  it("keeps the portrait when neither the emotion nor 平静 has a sprite", async () => {
    const fixture = withSprites(withMood(buildFixture("sprites-chat"), "惊讶"), { happy: labSprite("happy"), sleepy: labSprite("sleepy") });
    mount(fixture);
    await waitFor(() => expect(tiles()).toHaveLength(2));
    const shown = shownSrc(headerPortrait());
    expect(shown).not.toBeNull();
    expect([labSprite("happy"), labSprite("sleepy"), labSprite("neutral")]).not.toContain(shown);
    expect(shownSrc(await heroPortrait())).toBe(shown);
    expect(current()).toEqual([]);
    expect(screen.getByTestId("pa-soul-sprite-mood").textContent).toBe("惊讶");
  });

  it("shows 平静 and no mood word once the newest reply is older than a day", async () => {
    mount(buildFixture("sprites-chat", Date.now() - 25 * HOUR));
    await waitFor(() => expect(headerPortrait()?.getAttribute("data-emotion")).toBe("neutral"));
    expect(shownSrc(headerPortrait())).toBe(labSprite("neutral"));
    expect(screen.queryByTestId("pa-soul-hero-sprite")).toBeNull();
    await waitFor(() => expect(current()).toEqual(["neutral"]));
    expect(screen.queryByTestId("pa-soul-sprite-mood")).toBeNull();
  });

  it("keeps the stored emotion while a turn runs, then follows the new reply", async () => {
    mount(buildFixture("sprites-chat"), { transport: { chatDelays: { startMs: 5, replyMs: 600, liveMs: 60_000, streamStepMs: 0 } } });
    await waitFor(() => expect(headerPortrait()?.getAttribute("data-emotion")).toBe("sleepy"));
    const input = screen.getByTestId("pa-composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "明天一起去吗？" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("pa-header-status").textContent).toBe("typing…"));
    expect(headerPortrait()!.getAttribute("data-emotion")).toBe("sleepy");
    expect(current()).toEqual(["sleepy"]);
    // The first canned reply of the fixture carries the mood 开心.
    await waitFor(() => expect(headerPortrait()?.getAttribute("data-emotion")).toBe("happy"), { timeout: 4000 });
    expect((await heroPortrait()).getAttribute("data-emotion")).toBe("happy");
    expect(current()).toEqual(["happy"]);
    expect(screen.getByTestId("pa-soul-sprite-mood").textContent).toBe("开心");
  });

  it("opens the profile editor from the 立绘 row", async () => {
    mount(buildFixture("sprites-chat"));
    fireEvent.click(await screen.findByTestId("pa-soul-sprites-edit"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("without sprites, and in rooms", () => {
  it("keeps companion-chat as before: the portrait in the header and the hero, no 立绘 block", async () => {
    mount(buildFixture("companion-chat"));
    await screen.findByTestId("pa-soul-about");
    await waitFor(() => expect(shownSrc(headerPortrait())).not.toBeNull());
    expect(shownSrc(await heroPortrait())).toBe(shownSrc(headerPortrait()));
    expect(screen.queryByTestId("pa-soul-sprites")).toBeNull();
    expect(screen.queryByTestId("pa-soul-hero-sprite")).toBeNull();
  });

  it("draws no emotion in a room's header, nor for a member inspected from the room", async () => {
    mount(buildFixture("companion-group"));
    const members = await screen.findAllByTestId("pa-soul-member");
    expect(screen.getByTestId("pa-header-subject").querySelector("[data-emotion]")).toBeNull();
    expect(screen.getByTestId("pa-soul-hero").querySelector("[data-emotion]")).toBeNull();
    fireEvent.click(members[0]!);
    await screen.findByTestId("pa-inspector-back");
    expect(screen.getByTestId("pa-inspector").querySelector("[data-emotion]")).toBeNull();
    expect(screen.queryAllByTestId("pa-soul-sprite").filter((tile) => tile.getAttribute("aria-current") === "true")).toEqual([]);
  });

  it("reads the mood only from the character's own fresh, visible reply", () => {
    const fixture = buildFixture("sprites-chat");
    const now = Date.now();
    const index = indexOf(fixture);
    expect(replyMood(index, CONV, XY, now)).toBe("有点困");
    expect(replyMood(index, CONV, XY, now + 25 * HOUR)).toBeNull();
    expect(replyMood(index, CONV, "ag-nobody", now)).toBeNull();
  });
});

describe("motion", () => {
  it("turns the ring and label crossfade off under reduced motion", () => {
    const css = readFileSync(resolve(__dirname, "../../../src/fantay/pa/soul/SoulInspector.module.css"), "utf8");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".spriteFace::after");
    expect(reduced).toContain(".spriteLabel");
    expect(css).toMatch(/\.spriteFace::after \{[^}]*transition: opacity var\(--pa-dur-swap\)/);
  });
});
