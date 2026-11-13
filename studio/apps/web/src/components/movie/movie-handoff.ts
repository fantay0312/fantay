export interface MovieHandoff {
  brief: string;
  designSystemId?: string | null;
}
const KEY = "fantay:movie-handoff";
let pending: MovieHandoff | null = null;
export function stageMovieHandoff(value: MovieHandoff): void {
  pending = value;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* Memory fallback. */
  }
}
export function takeMovieHandoff(): MovieHandoff | null {
  let value = pending;
  pending = null;
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!value && raw) value = JSON.parse(raw) as MovieHandoff;
  } catch {
    /* Memory fallback. */
  }
  return value && typeof value.brief === "string" ? value : null;
}
