import { describe, it, expect } from "vitest";
import {
  MOVIE_SAMPLES,
  createMovieDocument,
  buildMovieHtml,
  movieDuration,
} from "@open-design/contracts";
import { parseMovieInput } from "../../src/movie/store.js";
describe("Complete motion sample recipes", () => {
  it.each(MOVIE_SAMPLES)(
    "$id preserves distinct scenes and timed motion through saving",
    (style) => {
      const doc = createMovieDocument(style.name, "library", style),
        parsed = parseMovieInput(doc);
      expect(movieDuration(doc)).toBe(12);
      expect(parsed.shots).toHaveLength(3);
      expect(parsed.shots.map((s) => s.visual?.layers)).toEqual(
        doc.shots.map((s) => s.visual?.layers),
      );
      expect(JSON.stringify(parsed.shots[0]?.visual)).not.toBe(
        JSON.stringify(parsed.shots[1]?.visual),
      );
      expect(
        parsed.shots.some((s) =>
          s.visual?.layers.some((l) => l.keyframes?.length),
        ),
      ).toBe(true);
      const html = buildMovieHtml(doc);
      expect(html).toContain("scene-world");
      expect(html).toContain("#shot-2 .copy");
    },
  );
  it("rejects non-finite and backwards keyframes", () => {
    const doc = createMovieDocument("Invalid", "library", MOVIE_SAMPLES[0]!);
    doc.shots[0]!.visual!.layers[0]!.keyframes = [
      { at: 0.8, x: 0 },
      { at: 0.2, x: Infinity },
    ];
    expect(() => parseMovieInput(doc)).toThrow("increasing");
  });
});
