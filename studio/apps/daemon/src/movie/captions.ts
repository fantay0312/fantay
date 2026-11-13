import { movieShotStarts, type MovieDocument } from "@open-design/contracts";
const stamp = (seconds: number) => {
  const n = Math.round(seconds * 1000);
  return `${String(Math.floor(n / 3600000)).padStart(2, "0")}:${String(Math.floor(n / 60000) % 60).padStart(2, "0")}:${String(Math.floor(n / 1000) % 60).padStart(2, "0")},${String(n % 1000).padStart(3, "0")}`;
};
export function movieSrt(doc: MovieDocument): string {
  const starts = movieShotStarts(doc);
  return doc.shots.flatMap((shot, i) => (shot.captions ?? []).map(c => ({...c,start:starts[i]!+c.start,end:starts[i]!+c.end})))
    .sort((a,b) => a.start-b.start || a.end-b.end)
    .map((c,i) => `${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join("\n");
}
