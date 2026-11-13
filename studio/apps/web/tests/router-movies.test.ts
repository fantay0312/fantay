import { describe, expect, it } from "vitest";
import { parseRoute, buildPath } from "../src/router";
describe("Movie Studio route", () => {
  it("keeps the workbench in the entry shell", () => {
    expect(parseRoute("/movies")).toEqual({ kind: "home", view: "movies" });
  });
  it("round trips a movie destination", () => {
    expect(buildPath({ kind: "home", view: "movies" })).toBe("/movies");
  });
  it('round trips a full-page film workspace', () => {
    const route = { kind: 'home', view: 'movies', movieProjectId: 'film-1' } as const;
    expect(buildPath(route)).toBe('/movies/film-1');
    expect(parseRoute('/movies/film-1')).toEqual(route);
  });
  it('keeps a film inside home creation mode or the chrome-free MCP surface', () => {
    const home = {kind:'home',view:'home',creationMode:'movie',movieProjectId:'film 1'} as const;
    const embedded = {kind:'home',view:'movies',embeddedMovie:true,movieProjectId:'film 1'} as const;
    expect(buildPath(home)).toBe('/create/animation/film%201');
    expect(parseRoute(buildPath(home))).toEqual(home);
    expect(buildPath(embedded)).toBe('/movie-app/film%201');
    expect(parseRoute(buildPath(embedded))).toEqual(embedded);
  });
});
