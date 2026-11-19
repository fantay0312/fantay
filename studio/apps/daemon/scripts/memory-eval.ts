// SPDX-License-Identifier: Apache-2.0
/**
 * Retrieval evaluation for Fantay Memory: loads the fixed set in memory-eval-data.json into an in-memory engine,
 * runs every question at the three levels (lexical; + local vectors; + local reranker) and prints Recall@5,
 * Recall@12, MRR, how often a question with no answer still got hits, unrelated hits, and recall latency — one table
 * for short questions and one for long requests (categories `long_*`: working requests that mention a remembered
 * fact in passing, Personal Agent goal / amendment / last-message text, and requests that need two memories).
 *
 * A question names its gold memories (`gold`), or for a request that needs two of them, one list per needed fact
 * (`parts`; "all parts @12" counts requests with every part in the first 12 hits). `related` lists on-topic memories
 * that are not needed for the answer: they count neither as gold nor as unrelated hits.
 *
 * Questions are split per category: every third one (by id) is held out. Constants are tuned on the other two
 * thirds (`--split tune`); the held-out third is the number to report (`--split holdout`, the default table).
 *
 * Usage (from apps/daemon):
 *   tsx scripts/memory-eval.ts --models <folder with the local models> [--out <file.md>] [--split holdout,tune,all]
 *   tsx scripts/memory-eval.ts --models <folder> --sweep          # final scores of every candidate, gate off
 *   --dims <n> embeds at another Matryoshka size (default 0: the model's default, 512 for Qwen3-Embedding).
 *   --levels lexical,hybrid runs only those levels (default: all three with --models).
 * Without --models only the lexical level runs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { MemoryScopeRef, UpdateMemoryEngineConfigRequest } from "@open-design/contracts";
import { buildWindows, createMemoryEngine, type IngestMessage, type MemoryEngineApi } from "../src/services/memory/index.js";

type Level = "lexical" | "hybrid" | "hybrid_rerank";
type Split = "tune" | "holdout";

interface EvalItem {
  id: string;
  scope: string;
  kind: NonNullable<Parameters<MemoryEngineApi["remember"]>[0]["kind"]>;
  date: string;
  content: string;
}
interface EvalConversation {
  id: string;
  project: string;
  title: string;
  date: string;
  messages: Array<[string, string, string]>;
}
interface EvalQuestion {
  id: string;
  category: string;
  q: string;
  /** The data gives either `gold` or `parts`; withGold fills `gold` from `parts`. */
  gold: string[];
  parts?: string[][];
  related?: string[];
}
interface EvalData {
  now: string;
  asker: { surface: "studio"; projectId: string; conversationId: string };
  items: EvalItem[];
  conversations: EvalConversation[];
  questions: EvalQuestion[];
}

interface Hit {
  id: string;
  score: number;
  gold: boolean;
  related: boolean;
  /** Passed along as "possibly related": below the cut, in a section of its own. */
  possible: boolean;
  /** Indexes of the question's `parts` this hit answers. */
  parts: number[];
}
interface Answer {
  question: EvalQuestion;
  split: Split;
  hits: Hit[];
  latencyMs: number;
}

function levelConfigs(dimensions: number): Record<Level, UpdateMemoryEngineConfigRequest> {
  return {
    lexical: { embedding: { provider: "off" }, reranker: { provider: "builtin" } },
    hybrid: { embedding: { provider: "local", dimensions }, reranker: { provider: "builtin" } },
    hybrid_rerank: { embedding: { provider: "local", dimensions }, reranker: { provider: "local" } },
  };
}

function args(): Map<string, string> {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) out.set(key.slice(2), "true");
    else {
      out.set(key.slice(2), value);
      i += 1;
    }
  }
  return out;
}

function scopeOf(key: string): MemoryScopeRef {
  if (key === "profile") return { kind: "profile", id: "" };
  const [kind, id] = key.split(":") as [MemoryScopeRef["kind"], string];
  return { kind, id };
}

/** Every third question of each category, by id, is held out from tuning. */
function splits(questions: readonly EvalQuestion[]): Map<string, Split> {
  const byCategory = new Map<string, EvalQuestion[]>();
  for (const q of questions) byCategory.set(q.category, [...(byCategory.get(q.category) ?? []), q]);
  const out = new Map<string, Split>();
  for (const group of byCategory.values()) {
    [...group].sort((a, b) => a.id.localeCompare(b.id)).forEach((q, i) => out.set(q.id, i % 3 === 2 ? "holdout" : "tune"));
  }
  return out;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function load(engine: MemoryEngineApi, data: EvalData): void {
  for (const item of data.items) {
    const at = Date.parse(`${item.date}T12:00:00+08:00`);
    engine.remember({
      id: item.id,
      scope: scopeOf(item.scope),
      kind: item.kind,
      content: item.content,
      origin: "user_explicit",
      source: "evaluation",
      createdAt: at,
      updatedAt: at,
      actor: "owner",
    });
  }
  for (const conversation of data.conversations) {
    const messages: IngestMessage[] = conversation.messages.map(([time, speaker, text], n) => ({
      id: `${conversation.id}-${n}`,
      speaker,
      agentId: null,
      text,
      at: Date.parse(`${conversation.date}T${time}:00+08:00`),
      dataClass: "standard",
    }));
    engine.chunkSink.writeWindows({
      source: "studio",
      conversationId: conversation.id,
      fromSeq: 0,
      windows: buildWindows(messages, { fromSeq: 0 }),
      dataClass: "standard",
      principalId: "owner",
      cursor: { messageCount: messages.length, prefixHash: "evaluation" },
      scope: { source: "studio", conversationId: conversation.id, projectId: conversation.project },
    });
  }
}

/** `gold` of a question that lists `parts` is every part's ids. */
function withGold(question: EvalQuestion): EvalQuestion {
  return question.parts ? { ...question, gold: question.parts.flat() } : question;
}

const isLong = (question: EvalQuestion): boolean => question.category.startsWith("long_");

async function ask(engine: MemoryEngineApi, data: EvalData, question: EvalQuestion, split: Split): Promise<Answer> {
  const gold = new Set(question.gold);
  const related = new Set(question.related ?? []);
  const started = performance.now();
  const result = await engine.recall({ query: question.q, access: data.asker });
  const latencyMs = performance.now() - started;
  const hits = result.hits.map((hit) => {
    const ids = [hit.id, ...(hit.chunk?.messageIds ?? [])];
    const isGold = ids.some((id) => gold.has(id));
    return {
      id: hit.id,
      score: hit.score,
      gold: isGold,
      related: !isGold && ids.some((id) => related.has(id)),
      possible: hit.possible === true,
      parts: (question.parts ?? []).flatMap((part, i) => (ids.some((id) => part.includes(id)) ? [i] : [])),
    };
  });
  return { question, split, hits, latencyMs };
}

interface Row {
  questions: number;
  r5: number;
  r12: number;
  mrr: number;
  nothingWithHits: number;
  nothingCount: number;
  extraHits: number;
  /** Recall@5 counting only the hits above the cut, without the "possibly related" ones. */
  r5Sure: number;
  /** No-answer questions that got a hit above the cut. */
  nothingWithSure: number;
  /** "Possibly related" hits per question (answerable or not). */
  possiblePerQuestion: number;
  paraphraseR5: number;
  /** Share of the questions with `parts` that have every part in the first 12 hits; null when there are none. */
  allPartsR12: number | null;
  p50: number;
  p95: number;
}

function summarize(answers: readonly Answer[], minScore = 0): Row {
  const kept = (a: Answer) => a.hits.filter((hit) => hit.score >= minScore);
  const answerable = answers.filter((a) => a.question.gold.length > 0);
  const nothing = answers.filter((a) => a.question.gold.length === 0);
  const firstGold = (a: Answer) => kept(a).findIndex((hit) => hit.gold) + 1;
  const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);
  const paraphrase = answerable.filter((a) => a.question.category === "paraphrase");
  const multi = answerable.filter((a) => (a.question.parts?.length ?? 0) > 1);
  const within = (a: Answer, k: number) => (firstGold(a) > 0 && firstGold(a) <= k ? 1 : 0);
  const sure = (a: Answer) => kept(a).filter((hit) => !hit.possible);
  const firstSureGold = (a: Answer) => sure(a).findIndex((hit) => hit.gold) + 1;
  return {
    questions: answers.length,
    r5Sure: mean(answerable.map((a) => (firstSureGold(a) > 0 && firstSureGold(a) <= 5 ? 1 : 0))),
    nothingWithSure: nothing.filter((a) => sure(a).length > 0).length,
    possiblePerQuestion: mean(answers.map((a) => kept(a).filter((hit) => hit.possible).length)),
    r5: mean(answerable.map((a) => within(a, 5))),
    r12: mean(answerable.map((a) => within(a, 12))),
    mrr: mean(answerable.map((a) => (firstGold(a) > 0 ? 1 / firstGold(a) : 0))),
    nothingWithHits: nothing.filter((a) => kept(a).length > 0).length,
    nothingCount: nothing.length,
    extraHits: mean(answerable.map((a) => kept(a).filter((hit) => !hit.gold && !hit.related).length)),
    paraphraseR5: mean(paraphrase.map((a) => within(a, 5))),
    allPartsR12: multi.length
      ? mean(multi.map((a) => (new Set(kept(a).slice(0, 12).flatMap((hit) => hit.parts)).size === a.question.parts!.length ? 1 : 0)))
      : null,
    p50: percentile(answers.map((a) => a.latencyMs), 50),
    p95: percentile(answers.map((a) => a.latencyMs), 95),
  };
}

function table(rows: Array<[string, Row]>, set: "short" | "long"): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const extra = set === "short" ? "paraphrase R@5" : "all parts @12";
  const lines = [
    `| level | questions | Recall@5 | Recall@12 | MRR | ${extra} | no-answer questions with hits | unrelated hits / answerable | Recall@5 above the cut only | no-answer with hits above the cut | "possibly related" per question | p50 ms | p95 ms |`,
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, r] of rows) {
    const special = set === "short" ? pct(r.paraphraseR5) : r.allPartsR12 === null ? "–" : pct(r.allPartsR12);
    lines.push(
      `| ${name} | ${r.questions} | ${pct(r.r5)} | ${pct(r.r12)} | ${r.mrr.toFixed(3)} | ${special} | ` +
        `${r.nothingWithHits}/${r.nothingCount} | ${r.extraHits.toFixed(2)} | ${pct(r.r5Sure)} | ${r.nothingWithSure}/${r.nothingCount} | ` +
        `${r.possiblePerQuestion.toFixed(2)} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} |`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = args();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(readFileSync(options.get("data") ?? path.join(here, "memory-eval-data.json"), "utf8")) as EvalData;
  data.questions = data.questions.map(withGold);
  const modelsDir = options.get("models") ?? process.env.OD_MEMORY_MODELS_DIR;
  if (modelsDir) process.env.OD_MEMORY_MODELS_DIR = path.resolve(modelsDir);
  const sweep = options.has("sweep");
  const shows = (options.get("split") ?? "holdout").split(",") as Array<Split | "all">;
  const now = Date.parse(data.now);
  const LEVELS = levelConfigs(Number(options.get("dims") ?? 0));

  const titles = new Map(data.conversations.map((c) => [c.id, c.title]));
  const engine = createMemoryEngine({ db: new Database(":memory:"), dataDir: "", now: () => now });
  engine.setLabeler((scope) => (scope.kind === "conversation" ? titles.get(scope.id) : undefined));
  load(engine, data);
  if (sweep) engine.updateConfig({ recall: { minScore: 0 } });

  const levels = (options.get("levels")?.split(",") ?? (modelsDir ? ["lexical", "hybrid", "hybrid_rerank"] : ["lexical"])) as Level[];
  if (levels.some((level) => level !== "lexical")) {
    const started = performance.now();
    engine.updateConfig(LEVELS.hybrid);
    await engine.flush();
    const status = engine.status();
    if (status.embedding.waiting > 0 || !status.embedding.ready) {
      throw new Error(`embedding did not finish: ${JSON.stringify(status.embedding)}`);
    }
    console.error(`indexed ${status.documents} documents, embedded in ${Math.round(performance.now() - started)} ms`);
  }

  const split = splits(data.questions);
  const results = new Map<Level, Answer[]>();
  for (const level of levels) {
    engine.updateConfig(LEVELS[level]);
    await engine.recall({ query: "预热", access: data.asker });
    const answers: Answer[] = [];
    for (const question of data.questions) {
      const answer = await ask(engine, data, question, split.get(question.id)!);
      answers.push(answer);
    }
    const reached = (await engine.recall({ query: "青岚", access: data.asker })).level;
    if (reached !== level) throw new Error(`asked for ${level}, the engine ran at ${reached}: ${JSON.stringify(engine.status())}`);
    results.set(level, answers);
  }
  engine.dispose();

  const sets = [
    { set: "short" as const, title: "Short questions", member: (a: Answer) => !isLong(a.question) },
    { set: "long" as const, title: "Long requests", member: (a: Answer) => isLong(a.question) },
  ];
  const inSplit = (a: Answer, show: Split | "all") => show === "all" || a.split === show;
  const parts: string[] = [];
  for (const show of shows) for (const { set, title, member } of sets) {
    const pick = (answers: Answer[], keep: (a: Answer) => boolean) => answers.filter((a) => keep(a) && inSplit(a, show));
    parts.push(`### ${title} — split: ${show}`);
    if (!sweep) {
      parts.push(table([...results].map(([level, answers]) => [level, summarize(pick(answers, member))]), set));
      continue;
    }
    for (const [level, answers] of results) {
      const rows: Array<[string, Row]> = [];
      for (const t of [0, 0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.28, 0.3, 0.35, 0.4]) {
        rows.push([`${level} ≥ ${t}`, summarize(pick(answers, member), t)]);
      }
      parts.push(table(rows, set));
      const best = (a: Answer) => a.hits[0]?.score ?? 0;
      const nothing = pick(answers, member).filter((a) => a.question.gold.length === 0).map(best);
      const goldScores = pick(answers, member).flatMap((a) => a.hits.filter((h) => h.gold).slice(0, 1).map((h) => h.score));
      parts.push(
        `${level}: top score on no-answer questions p50 ${percentile(nothing, 50).toFixed(3)} max ${Math.max(0, ...nothing).toFixed(3)}; ` +
          `best gold score p10 ${percentile(goldScores, 10).toFixed(3)} p50 ${percentile(goldScores, 50).toFixed(3)}`,
      );
    }
  }
  const report = parts.join("\n\n");
  if (options.has("details")) {
    for (const [level, answers] of results) {
      for (const a of answers.filter((a) => shows.some((show) => inSplit(a, show)))) {
        const first = a.hits.findIndex((h) => h.gold) + 1;
        const marks = a.hits
          .slice(0, 5)
          .map((h) => `${h.gold ? "*" : h.related ? "~" : ""}${h.id}:${h.score.toFixed(2)}`)
          .join(" ");
        console.error(`${level}\t${a.question.id}\t${a.question.category}\tfirst=${first}\t${marks}`);
      }
    }
  }
  console.log(report);
  const out = options.get("out");
  if (out) writeFileSync(out, `${report}\n`);
}

await main();
