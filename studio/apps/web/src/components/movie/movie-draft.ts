import type {
  MovieDocument,
  MovieStartMode,
  MovieStyle,
} from "@open-design/contracts";
export interface MovieCreationDraft {
  title: string;
  brief: string;
  mode: MovieStartMode;
  aspect: MovieDocument["aspect"];
  style: MovieStyle;
  designSystemId?: string;
}
const key = (scope: string) => `fantay:movie-draft:v1:${scope}`;
export function readMovieDraft(scope: string): MovieCreationDraft | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(key(scope)) ?? "null",
    ) as MovieCreationDraft | null;
    if (
      !value ||
      typeof value.title !== "string" ||
      typeof value.brief !== "string" ||
      value.title.length > 200 ||
      value.brief.length > 20000 ||
      !["library", "remix", "personal", "blank"].includes(value.mode) ||
      !["16:9", "9:16", "1:1"].includes(value.aspect)
    )
      return null;
    const style = value.style;
    if (
      !style ||
      typeof style.id !== "string" ||
      typeof style.name !== "string" ||
      typeof style.description !== "string" ||
      ![style.background, style.foreground, style.accent].every((color) =>
        /^#[0-9a-f]{6}$/i.test(color),
      ) ||
      !["sans", "serif", "mono"].includes(style.font) ||
      !["rise", "slide", "scale"].includes(style.motion)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function saveMovieDraft(scope: string, draft: MovieCreationDraft): void {
  try {
    localStorage.setItem(key(scope), JSON.stringify(draft));
  } catch {
    /* The composer remains usable when storage is unavailable. */
  }
}
export function clearMovieDraft(scope: string): void {
  try {
    localStorage.removeItem(key(scope));
  } catch {}
}
