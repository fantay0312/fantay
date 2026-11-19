// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — normalization and tokenization shared by the index, retrieval and conflict rules.
//
// FTS5's unicode61 tokenizer keeps a run of Han characters as one token, so Chinese is segmented here and the
// result is stored space-joined in mem_fts.tokens. Tokens consist only of letters, digits, "_" and combining
// marks; unicode61 (tokenchars '_') keeps them whole, except that it splits on combining marks, which it does the
// same way for a quoted query token, so documents and queries still agree.
//
// Token order inside one run of text is "fine tokens first, coarse tokens after": the finest pieces (camelCase
// parts, path parts, Han bigrams) stay adjacent, so FTS phrase queries over them work for partial identifiers
// and quoted Chinese; the whole word, the joined identifier and the dictionary words follow.

import { createHash } from "node:crypto";

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー`;
const WORD_CHAR = String.raw`(?:(?![${CJK}])[\p{L}\p{M}\p{N}_])`;
const CONNECTOR = String.raw`[.\-/\\:@+#~]`;
/** A CJK run, or a word run whose parts may be joined by connectors (paths, versions, dotted names, URLs). */
const RUN_PATTERN = new RegExp(String.raw`[${CJK}]+|${WORD_CHAR}+(?:${CONNECTOR}{1,3}${WORD_CHAR}+)*`, "gu");
const CJK_START = new RegExp(`^[${CJK}]`, "u");
const CONNECTOR_SPLIT = new RegExp(`${CONNECTOR}+`, "u");
const CAMEL_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;
const EDGE_UNDERSCORES = /^_+|_+$/g;
const WHITESPACE = /\s+/gu;

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

const LATIN_STOP_WORDS = new Set(
  (
    "the an and or but nor for with without that this these those what whats where when which who whom whose why " +
    "how are was were is be been being am have has had having do does did doing done from into onto about above " +
    "below please tell can could would should will shall may might must you your yours we our ours us me my mine " +
    "it its of to in on at by as if so than then too very there here their theirs they them he she his her hers " +
    "any some all just also again ever know remember recall let lets say said get got hi hello hey thanks thank " +
    "ok okay yes yeah don doesn didn isn aren wasn weren won wouldn couldn shouldn"
  ).split(" "),
);

/**
 * Single Han characters that carry no topic on their own. 会 is not one: ICU splits 周|会 and 早|会, so as a stop
 * character it would turn 周会 into a weak bigram and leave "周会什么时候开" without its topic, while as a modal
 * ("会下雨") it only adds a bigram that matches nothing.
 */
const CJK_STOP_CHARS = new Set(
  (
    "的 了 是 在 我 你 您 他 她 它 们 有 和 与 跟 同 就 不 没 都 也 很 吗 呢 吧 啊 呀 哦 嗯 哈 嘛 呗 啦 把 被 让 给 到 去 来 " +
    "说 要 能 想 还 又 这 那 哪 谁 啥 么 着 过 得 地 个 一 及 或 并 而 但 对 从 向 为 以 于 之 其 此 已 再 才 刚 将 请 帮 下"
  ).split(" "),
);

const CJK_STOP_WORDS = new Set(
  (
    "什么 什么样 怎么 怎样 怎么样 哪个 哪些 哪里 哪儿 多少 几个 请问 一下 一个 一些 什么时候 时候 为什么 如何 是否 " +
    "我们 你们 他们 她们 它们 咱们 这个 那个 这些 那些 这样 那样 这里 那里 还是 可以 能不能 有没有 是不是 要不要 知道 " +
    "告诉 现在 然后 因为 所以 但是 如果 就是 还有 已经 没有 的话 记得 你好 您好 谢谢 好的 帮我 帮忙 一起 东西 事情 " +
    "自己 觉得 应该 需要 一般 其实 比较 非常 特别 真的 可能"
  ).split(" "),
);

// ---- normalization -----------------------------------------------------------------------------------------------

/** The text an item is searched by: its content, led by its title when the content does not already say it. */
export function searchableText(title: string, content: string): string {
  const head = title.trim();
  return head && !content.includes(head) ? `${head}\n${content}` : content;
}

/** NFKC, lower-case. The form every comparison of memory text uses. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** sha256 hex of NFKC, lower-cased, whitespace-collapsed text. */
export function contentHash(text: string): string {
  const canonical = normalizeText(text).replace(WHITESPACE, " ").trim();
  return createHash("sha256").update(canonical).digest("hex");
}

/** Opaque ASCII token for one scope key, stored in mem_fts.scopes. */
export function scopeToken(scopeKey: string): string {
  return `s${createHash("sha1").update(scopeKey).digest("hex").slice(0, 20)}`;
}

/** Jaccard similarity of the two token sets; 0 when both are empty. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// ---- runs --------------------------------------------------------------------------------------------------------

interface WordRun {
  cjk: false;
  /** camelCase / snake / path parts in order (2+ chars each), or the word itself. */
  fine: string[];
  /** Whole words that were split into parts, then the joined identifier when connectors were present. */
  coarse: string[];
  /** The word itself, or the identifier joined with "_" when it had connectors. */
  primary: string | null;
  hasConnector: boolean;
}

interface CjkRun {
  cjk: true;
  chars: string[];
  /** Dictionary words with their code point offsets. */
  words: Array<{ text: string; start: number; length: number }>;
}

type Run = WordRun | CjkRun;

function splitRuns(normalized: string): Run[] {
  const runs: Run[] = [];
  for (const match of normalized.matchAll(RUN_PATTERN)) {
    const text = match[0];
    runs.push(CJK_START.test(text) ? cjkRun(text) : wordRun(text));
  }
  return runs;
}

function wordPieces(part: string): string[] {
  return part
    .split("_")
    .flatMap((piece) => piece.split(CAMEL_BOUNDARY))
    .filter((piece) => piece.length > 0);
}

/** `text` keeps its original case so camelCase boundaries can be found; tokens are lower-cased. */
function wordRun(text: string): WordRun {
  const parts = text.split(CONNECTOR_SPLIT).filter((part) => part.length > 0);
  const fine: string[] = [];
  const coarse: string[] = [];
  for (const part of parts) {
    const pieces = wordPieces(part);
    if (pieces.length === 1) {
      const only = pieces[0]!.toLowerCase();
      if (only.length >= 2) fine.push(only);
    } else if (pieces.length > 1) {
      for (const piece of pieces) if (piece.length >= 2) fine.push(piece.toLowerCase());
      const whole = part.toLowerCase().replace(EDGE_UNDERSCORES, "");
      if (whole.length >= 2) coarse.push(whole);
    }
  }
  const hasConnector = parts.length > 1;
  let primary: string | null = null;
  if (hasConnector) {
    const joined = parts
      .map((part) => part.toLowerCase().replace(EDGE_UNDERSCORES, ""))
      .filter((part) => part.length > 0)
      .join("_");
    if (joined.length >= 2) {
      coarse.push(joined);
      primary = joined;
    }
  } else {
    const whole = text.toLowerCase().replace(EDGE_UNDERSCORES, "");
    primary = whole.length >= 2 ? whole : null;
  }
  return { cjk: false, fine, coarse, primary, hasConnector };
}

function cjkRun(text: string): CjkRun {
  const chars = Array.from(text);
  const codePointAt = new Map<number, number>();
  let unit = 0;
  chars.forEach((char, index) => {
    codePointAt.set(unit, index);
    unit += char.length;
  });
  const words: CjkRun["words"] = [];
  for (const segment of segmenter.segment(text)) {
    if (!segment.isWordLike) continue;
    const start = codePointAt.get(segment.index);
    if (start === undefined) continue;
    words.push({ text: segment.segment, start, length: Array.from(segment.segment).length });
  }
  return { cjk: true, chars, words };
}

function bigrams(chars: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/** Han tokens of one run: every bigram (or the lone character), then dictionary words that are not bigrams. */
function cjkDocumentTokens(run: CjkRun): string[] {
  if (run.chars.length === 1) return [run.chars[0]!];
  const out = bigrams(run.chars);
  for (const word of run.words) if (word.length !== 2) out.push(word.text);
  return out;
}

// ---- document and query tokens -----------------------------------------------------------------------------------

/** Document tokens, with duplicates, in order. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const run of splitRuns(text.normalize("NFKC"))) {
    if (run.cjk) out.push(...cjkDocumentTokens(run));
    else out.push(...run.fine, ...run.coarse);
  }
  return out;
}

/**
 * How much a query token says about the topic. `strong`: a word, or a bigram inside one word. `cross`: a bigram of
 * two content characters that straddles a word boundary; the segmenter splits some real words (圆角 → 圆 / 角), so
 * such a bigram may be a word, or two unrelated neighbours (角定 in 圆角定的是多少). `weak`: a bigram that leans on a
 * stop character. `fallback`: a lone character.
 */
type Strength = "strong" | "cross" | "weak" | "fallback";

function isCjkStopWord(word: string, length: number): boolean {
  if (length === 1) return CJK_STOP_CHARS.has(word);
  if (CJK_STOP_WORDS.has(word)) return true;
  // Function characters the segmenter glued into one "word" (的是, 了吗, 我把) carry no topic either.
  return Array.from(word).every((char) => CJK_STOP_CHARS.has(char));
}

/** Per character of the run: whether it belongs to a stop word as segmented. */
function cjkStopChars(run: CjkRun): boolean[] {
  const stopChar = new Array<boolean>(run.chars.length).fill(false);
  for (const word of run.words) {
    if (!isCjkStopWord(word.text, word.length)) continue;
    for (let i = word.start; i < word.start + word.length; i += 1) stopChar[i] = true;
  }
  return stopChar;
}

function cjkQueryTokens(run: CjkRun, emit: (token: string, strength: Strength) => void): void {
  const stopChar = cjkStopChars(run);
  if (run.chars.length === 1) {
    if (!stopChar[0] && !CJK_STOP_CHARS.has(run.chars[0]!)) emit(run.chars[0]!, "fallback");
    return;
  }
  const wordAt = new Array<number>(run.chars.length).fill(-1);
  run.words.forEach((word, index) => {
    for (let i = word.start; i < word.start + word.length; i += 1) wordAt[i] = index;
  });
  for (let i = 0; i + 1 < run.chars.length; i += 1) {
    const left = stopChar[i]!;
    const right = stopChar[i + 1]!;
    if (left && right) continue;
    const insideWord = wordAt[i] !== -1 && wordAt[i] === wordAt[i + 1];
    emit(run.chars[i]! + run.chars[i + 1]!, left || right ? "weak" : insideWord ? "strong" : "cross");
  }
  for (const word of run.words) {
    if (word.length >= 3 && !isCjkStopWord(word.text, word.length)) emit(word.text, "strong");
    else if (word.length === 1 && !stopChar[word.start]) emit(word.text, "fallback");
  }
}

/**
 * Distinct query tokens in order of appearance, stop words dropped. Han bigrams made only of stop words are
 * dropped; single Han characters are used only when the query has nothing stronger.
 */
export function queryTokens(text: string): string[] {
  const strength = queryTokenStrengths(text);
  const hasStrong = [...strength.values()].some((level) => level === "strong" || level === "cross");
  const out: string[] = [];
  for (const [token, level] of strength) {
    if (level === "fallback" && hasStrong) continue;
    out.push(token);
  }
  return out;
}

/**
 * The query tokens that carry its content: `queryTokens` without the Han bigrams that lean on a stop character
 * ("建是" in 团建是哪天). The same as `queryTokens` when that would leave nothing.
 */
export function contentQueryTokens(text: string): string[] {
  const strong = [...queryTokenStrengths(text)].flatMap(([token, level]) =>
    level === "strong" || level === "cross" ? [token] : [],
  );
  return strong.length > 0 ? strong : queryTokens(text);
}

/**
 * The content tokens that are bigrams across a word boundary (`cross`). Whether one of them is a real word can only
 * be told from the documents: one that no document holds is two neighbours that happened to stand together.
 */
export function crossWordQueryTokens(text: string): Set<string> {
  return new Set([...queryTokenStrengths(text)].flatMap(([token, level]) => (level === "cross" ? [token] : [])));
}

function queryTokenStrengths(text: string): Map<string, Strength> {
  const strength = new Map<string, Strength>();
  const rank: Record<Strength, number> = { strong: 4, cross: 3, weak: 2, fallback: 1 };
  const emit = (token: string, level: Strength): void => {
    const known = strength.get(token);
    if (!known || rank[level] > rank[known]) strength.set(token, level);
  };
  for (const run of splitRuns(text.normalize("NFKC"))) {
    if (run.cjk) {
      cjkQueryTokens(run, emit);
      continue;
    }
    for (const token of [...run.fine, ...run.coarse]) {
      if (!LATIN_STOP_WORDS.has(token)) emit(token, "strong");
    }
  }
  return strength;
}

const LATIN_PHRASE = new RegExp(String.raw`${WORD_CHAR}+(?:[ \t]+${WORD_CHAR}+)+`, "gu");

/**
 * Runs of adjacent content words in the query, NFKC lower-cased: two or more Latin words, or three or more Han
 * characters with no stop word among them ("北京出差" in "什么时候去北京出差").
 */
export function queryPhrases(text: string): string[] {
  const normalized = normalizeText(text);
  const out = new Set<string>();
  for (const match of normalized.matchAll(LATIN_PHRASE)) {
    let words: string[] = [];
    const flush = (): void => {
      if (words.length >= 2) out.add(words.join(" "));
      words = [];
    };
    for (const word of match[0].split(/[ \t]+/u)) {
      if (LATIN_STOP_WORDS.has(word)) flush();
      else words.push(word);
    }
    flush();
  }
  for (const run of splitRuns(normalized)) {
    if (!run.cjk) continue;
    const stopChar = cjkStopChars(run);
    let current = "";
    for (let i = 0; i <= run.chars.length; i += 1) {
      if (i < run.chars.length && !stopChar[i]) {
        current += run.chars[i];
        continue;
      }
      if (Array.from(current).length >= 3) out.add(current);
      current = "";
    }
  }
  return [...out];
}

// ---- segments of a long query ------------------------------------------------------------------------------------

/**
 * Clause ends: line breaks, Chinese sentence and clause punctuation, brackets, and Latin sentence / clause marks
 * followed by a space (so "v2.3", "python:3.12" and "a,b" stay whole). The enumeration comma 、 does not end a
 * clause: "读书、会议、旅行" is one thing being asked about.
 */
const CLAUSE_END = /\n+|[。！？；，：（）【】…]+|[.!?;](?=\s|$)|[,:](?=\s)/gu;
/** A segment holds at least this many content tokens; smaller clauses join their neighbour. */
const SEGMENT_MIN_TOKENS = 3;

export interface QuerySegment {
  /** The query text of the segment, punctuation inside it kept. */
  text: string;
  /** UTF-16 offsets into the query. */
  start: number;
  end: number;
}

interface Clause {
  start: number;
  end: number;
  tokens: number;
  line: number;
}

function joinClauses(a: Clause, b: Clause): Clause {
  return { start: a.start, end: b.end, tokens: a.tokens + b.tokens, line: a.line };
}

/**
 * The query cut at clause ends into segments of at least SEGMENT_MIN_TOKENS content tokens each. A clause too small
 * to be a question on its own ("对了", "别太长") joins the next clause of its line, or the previous one at the end
 * of the line; a whole line that small joins the line before it (the first line, the one after it). A query that
 * does not split gives one segment.
 */
export function querySegments(text: string): QuerySegment[] {
  const clauses: Clause[] = [];
  let from = 0;
  let line = 0;
  const close = (to: number): void => {
    const piece = text.slice(from, to);
    const lead = piece.length - piece.trimStart().length;
    const body = piece.trim();
    if (!body) return;
    clauses.push({ start: from + lead, end: from + lead + body.length, tokens: contentQueryTokens(body).length, line });
  };
  for (const match of text.matchAll(CLAUSE_END)) {
    close(match.index);
    if (match[0].includes("\n")) line += 1;
    from = match.index + match[0].length;
  }
  close(text.length);

  const withinLines: Clause[] = [];
  const settle = (rest: Clause): void => {
    const last = withinLines[withinLines.length - 1];
    if (last && last.line === rest.line) withinLines[withinLines.length - 1] = joinClauses(last, rest);
    else withinLines.push(rest);
  };
  let open: Clause | null = null;
  for (const clause of clauses) {
    if (open && open.line !== clause.line) {
      settle(open);
      open = null;
    }
    open = open ? joinClauses(open, clause) : { ...clause };
    if (open.tokens >= SEGMENT_MIN_TOKENS) {
      withinLines.push(open);
      open = null;
    }
  }
  if (open) settle(open);

  const segments: Clause[] = [];
  for (const segment of withinLines) {
    const last = segments[segments.length - 1];
    if (last && (last.tokens < SEGMENT_MIN_TOKENS || segment.tokens < SEGMENT_MIN_TOKENS)) {
      segments[segments.length - 1] = joinClauses(last, segment);
    } else {
      segments.push(segment);
    }
  }
  return segments.map(({ start, end }) => ({ text: text.slice(start, end), start, end }));
}

// ---- literals ----------------------------------------------------------------------------------------------------

export interface LiteralPhrase {
  /** Adjacent document tokens. */
  tokens: string[];
  /** The last token is matched as a prefix. */
  prefix: boolean;
}

export interface LiteralTerm {
  /** NFKC, lower-cased text of the literal as it appeared in the query. */
  text: string;
  /** Each phrase on its own counts as a match. */
  phrases: LiteralPhrase[];
}

const QUOTED =
  /"([^"\n]{2,80})"|“([^”\n]{2,80})”|「([^」\n]{2,80})」|『([^』\n]{2,80})』|《([^》\n]{2,80})》|`([^`\n]{2,80})`|(?<![\p{L}\p{N}])'([^'\n]{2,80})'(?![\p{L}\p{N}])/gu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`，。、；！？）】」』]+/giu;
const URL_TRAILING = /[.,;:!?)\]]+$/u;
const NUMBER_WITH_UNIT =
  /(?<![\p{L}\p{N}.])\d+(?:[.,]\d+)?(?:[a-z]{1,3}(?![\p{L}\p{N}])|\s?(?:%|‰|[元块万亿个次天周月年日号点时分秒岁字人页行张条篇本台件位名度倍]))/giu;
const IDENTIFIER_MARK = /[\d_./\\:@]|\p{Ll}\p{Lu}/u;
const MAX_LITERAL_TERMS = 8;

function literalPhrases(raw: string): LiteralPhrase[] {
  const runs = splitRuns(raw);
  if (runs.length === 0) return [];
  const only = runs.length === 1 ? runs[0]! : null;
  const phrases: LiteralPhrase[] = [];
  if (only && !only.cjk) {
    if (only.primary) {
      phrases.push({ tokens: [only.primary], prefix: !only.hasConnector && only.primary.length >= 3 });
    }
    if (only.fine.length >= 2) phrases.push({ tokens: only.fine, prefix: false });
    return phrases;
  }
  const sequence: string[] = [];
  for (const run of runs) {
    if (run.cjk) sequence.push(...(run.chars.length === 1 ? run.chars : bigrams(run.chars)));
    else sequence.push(...run.fine);
  }
  const last = runs[runs.length - 1]!;
  // A trailing single Han character is usually a unit ("500字"); as a prefix it also matches "字左右".
  const prefix = last.cjk && last.chars.length === 1;
  if (sequence.length > 0) phrases.push({ tokens: sequence, prefix });
  return phrases;
}

function literalCandidates(query: string): string[] {
  const out: string[] = [];
  for (const match of query.matchAll(QUOTED)) {
    const inner = match.slice(1).find((group) => group !== undefined);
    if (inner?.trim()) out.push(inner.trim());
  }
  for (const match of query.matchAll(URL_PATTERN)) out.push(match[0].replace(URL_TRAILING, ""));
  for (const match of query.matchAll(RUN_PATTERN)) {
    const run = match[0];
    if (CJK_START.test(run)) continue;
    const allDigits = /^\d+$/u.test(run);
    if ((allDigits && run.length >= 2) || (!allDigits && run.length >= 3 && IDENTIFIER_MARK.test(run))) out.push(run);
  }
  for (const match of query.matchAll(NUMBER_WITH_UNIT)) {
    if (/\D/u.test(match[0])) out.push(match[0].replace(WHITESPACE, ""));
  }
  return out;
}

/**
 * Literal pieces of a query — quoted strings, URLs, paths, identifiers with digits / underscores / dots /
 * camelCase, numbers and numbers with units — each with the token phrases that find it in the index.
 */
export function literalTerms(query: string): LiteralTerm[] {
  const normalized = query.normalize("NFKC");
  const seen = new Set<string>();
  const out: LiteralTerm[] = [];
  for (const candidate of literalCandidates(normalized)) {
    const text = candidate.toLowerCase();
    if (text.length < 2 || seen.has(text)) continue;
    seen.add(text);
    const phrases = literalPhrases(candidate);
    if (phrases.length === 0) continue;
    out.push({ text, phrases });
    if (out.length >= MAX_LITERAL_TERMS) break;
  }
  return out;
}
