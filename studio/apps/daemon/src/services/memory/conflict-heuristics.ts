// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — built-in rules that decide whether two memories repeat or contradict each other.
// Cheap and deterministic, Chinese and English. A model judge, when configured, gets the final word on the
// pairs these rules mark (see engine.ts); without one these rules open conflicts on their own.

import { jaccard, queryTokens, tokenize } from "./text.js";
import type { JudgeRelation } from "./types.js";

export interface PairVerdict {
  relation: JudgeRelation;
  confidence: number;
  reason: string;
  /** Token Jaccard of the two full texts. */
  similarity: number;
}

const NEAR_DUPLICATE_JACCARD = 0.9;
const DUPLICATE_CONFIDENCE = 0.9;
const SAME_SUBJECT_OVERLAP = 0.5;
/** Subject overlap at which a contradiction reaches the highest rule confidence. */
const FULL_SUBJECT_OVERLAP = 0.9;
const CONTRADICTION_MIN = 0.6;
const CONTRADICTION_MAX = 0.85;
/** Shortest text (in characters) that counts as contained in the other. */
const MIN_CONTAINED_CHARS = 4;

const HAN = /\p{Script=Han}/u;

// Words that contain a negation character without negating anything. Listed first in the alternation so they
// win at the position where they start and are kept.
const ZH_NOT_NEGATION = [
  "差不多", "不得不", "毫无疑问", "不错", "不过", "不断", "不少", "不仅", "不但", "不管", "不久", "不同", "不如",
  "不止", "没错", "特别", "区别", "分别", "告别", "级别", "类别", "性别", "识别", "个别", "差别", "辨别", "鉴别",
  "离别", "派别", "别人", "别的", "别处", "别名", "未来", "无论",
];
const ZH_NEGATION = [
  "不再", "不要", "不用", "不会", "不能", "不想", "从不", "从未", "未曾", "尚未", "没有", "禁止", "无需", "无须",
  "无法", "不", "没", "别", "未", "勿",
];
const ZH_NEGATION_RE = new RegExp(`(${ZH_NOT_NEGATION.join("|")})|(${ZH_NEGATION.join("|")})`, "gu");
const EN_NEGATION_RE = /\b(?:not|never|no|nor|cannot|neither)\b|\b[a-z]+n't\b/gu;

/** Mutually exclusive stances: a text holding one side contradicts a text holding the other. */
const STANCE_PAIRS: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [["喜欢", "喜爱", "偏好", "偏爱", "爱用"], ["讨厌", "厌恶", "反感", "避免"]],
  [["支持", "赞成", "同意"], ["反对"]],
  [["接受"], ["拒绝"]],
  [["启用", "开启", "打开"], ["停用", "禁用", "关闭", "关掉"]],
  [["prefer", "like", "love", "enjoy", "favor", "favour"], ["avoid", "dislike", "hate", "detest"]],
  [["use"], ["avoid"]],
  [["enable", "allow", "permit"], ["disable", "forbid", "prohibit"]],
  [["accept", "approve"], ["reject", "refuse", "decline"]],
  [["support"], ["oppose"]],
];

function inflections(word: string): string[] {
  const stem = word.replace(/e$/u, "");
  const forms = [word, `${word}s`, `${word}es`, `${word}d`, `${word}ed`, `${word}red`, `${word}ring`, `${stem}ing`];
  return [...new Set(forms)];
}

function stanceMatcher(word: string): RegExp {
  if (HAN.test(word)) return new RegExp(word, "gu");
  return new RegExp(`\\b(?:${inflections(word).join("|")})\\b`, "gu");
}

const STANCE_MATCHERS = STANCE_PAIRS.map(
  ([left, right]) => [left.map(stanceMatcher), right.map(stanceMatcher)] as const,
);
const ALL_STANCE_MATCHERS = STANCE_MATCHERS.flatMap(([left, right]) => [...left, ...right]);

const COLOR_RE = /#[0-9a-f]{3,8}\b/gu;
const DATE_RE = /(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2})\s*日?)?/gu;
// A number that is not part of a Latin identifier (v2, gpt4), with the unit that follows it.
const NUMBER_RE = /(?<![a-z0-9_.#])(\d+(?:[.,:]\d+)*)\s*(%|[a-z]+|\p{Script=Han})?/gu;

// Days of the week and parts of the day are values too: 周三 → 周四, 上午 → 下午, Monday → Tuesday.
const ZH_WEEKDAY: Record<string, string> = { 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 日: "7", 天: "7" };
const ZH_WEEKDAY_RE = /(?:周|星期|礼拜)([一二三四五六日天])/gu;
const EN_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const EN_WEEKDAY_RE = new RegExp(`\\b(${EN_WEEKDAYS.join("|")})s?\\b`, "gu");
const DAY_PARTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["dawn", /凌晨/gu],
  ["morning", /早上|早晨|上午|\b(?:mornings?|a\.?m\.?)\b/gu],
  ["noon", /中午|\bnoon\b/gu],
  ["afternoon", /下午|\b(?:afternoons?|p\.?m\.?)\b/gu],
  ["evening", /傍晚|晚上|夜里|\b(?:evenings?|nights?|tonight)\b/gu],
];

// Counts written in Chinese numerals (两次, 三个人, 十二月五日) are read as numbers when a measure word follows.
// 第一次 is an ordinal and stays text. X点 is a clock time only where the wording around it says so (下午三点,
// 三点半, 十点开会); 两点意见 and 便宜一点 are left alone.
const ZH_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const ZH_NUMERAL = "[零〇一二两三四五六七八九十百千]+";
const ZH_MEASURES =
  "小时|分钟|个|次|天|年|月|号|日|元|块|万|人|岁|周|页|张|条|倍|遍|位|名|件|篇|份|种|期|版|轮|步|项|点(?=半|钟|整|开|到|见|前|后|出发|集合|上班|下班)";
const ZH_COUNT_RE = new RegExp(`(?<!第)(${ZH_NUMERAL})(?=${ZH_MEASURES})`, "gu");
const ZH_CLOCK_RE = new RegExp(`(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|[一二三四五六日天])(${ZH_NUMERAL})(?=点)`, "gu");

// Words that link a subject to its value. Next to a value they are not part of what the memory is about:
// 周会在周三 and 周会改到周四 are both about 周会.
const VALUE_LINKERS =
  "改到|改为|改成|改在|换成|换到|调整为|调整到|调到|变成|变为|更新为|定在|定为|定于|安排在|约在|是在|每|在|是|为|于|到";
const SLOT_MARK = "\u0001";
const LINKER_BEFORE_VALUE_RE = new RegExp(`(?:${VALUE_LINKERS})+\\s*(?=${SLOT_MARK})`, "gu");
const SLOT_MARK_RE = new RegExp(SLOT_MARK, "gu");

/** 十 → 10, 二十三 → 23, 一百零五 → 105, 三千 → 3000. Null when the run is not a well-formed number. */
function zhNumber(text: string): number | null {
  let total = 0;
  let digit: number | null = null;
  for (const ch of text) {
    const value = ZH_DIGIT[ch];
    if (value !== undefined) {
      digit = digit === null ? value : digit * 10 + value;
      continue;
    }
    const unit = ch === "十" ? 10 : ch === "百" ? 100 : ch === "千" ? 1000 : null;
    if (unit === null) return null;
    total += (digit ?? 1) * unit;
    digit = null;
  }
  return total + (digit ?? 0);
}

function arabicCounts(text: string): string {
  const toDigits = (numeral: string): string => {
    const value = zhNumber(numeral);
    return value === null ? numeral : String(value);
  };
  return text
    .replace(ZH_CLOCK_RE, (_match, before: string, numeral: string) => `${before}${toDigits(numeral)}`)
    .replace(ZH_COUNT_RE, (_match, numeral: string) => toDigits(numeral));
}

// Labels tell two things of the same kind apart: 方案 A / 方案 B, 1 号楼 / 2 号楼, 第 2 期 / 第 3 期, 上周 / 这周,
// Plan A / Plan B. Two memories that carry different labels of one sort are about different things, however
// alike the rest of their words are, so their numbers and dates are free to differ.
const LABEL_PATTERNS: ReadonlyArray<readonly [sort: string, pattern: RegExp]> = [
  ["letter", /(?<=\p{Script=Han})\s*([a-z])(?![a-z0-9])/gu],
  ["letter", /(?<![a-z0-9])([a-z])\s*(?=组|队|班|栋|座|区|方案|计划|项目|版|款|型|类)/gu],
  ["ordinal", /第\s*(\d+|[一二三四五六七八九十]+)/gu],
  ["numbered", /(\d+)\s*号\s*(?=楼|线|机|店|厂|仓|门|口|桌|房|院|馆|位|车|柜|台|区|厅)/gu],
  ["named", /\b(?:plan|option|room|team|group|phase|project|version|building|site|unit|type|class|model)\s+([a-z]|\d+)\b/gu],
  ["when", /(上周|这周|本周|下周|上个月|这个月|本月|下个月|去年|今年|明年|前天|昨天|今天|明天|后天|上次|这次|下次)/gu],
  ["when", /\b((?:last|this|next)\s+(?:week|month|year)|yesterday|today|tomorrow)\b/gu],
];

function labels(text: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const [sort, pattern] of LABEL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const values = found.get(sort) ?? new Set<string>();
      values.add(match[1]!.replace(/\s+/gu, " "));
      found.set(sort, values);
    }
  }
  return found;
}

/** True when both texts carry labels of one sort and share none of them. */
function differentLabels(a: string, b: string): boolean {
  const la = labels(a);
  const lb = labels(b);
  for (const [sort, values] of la) {
    const other = lb.get(sort);
    if (other && ![...values].some((value) => other.has(value))) return true;
  }
  return false;
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[‘’ʼ]/gu, "'");
}

function negationCount(text: string): number {
  let count = text.match(EN_NEGATION_RE)?.length ?? 0;
  for (const match of text.matchAll(ZH_NEGATION_RE)) if (match[2]) count += 1;
  return count;
}

// Han text closes up where a word is taken out, so the bigrams around it match the text that never had it.
function removeNegations(text: string): string {
  return text
    .replace(ZH_NEGATION_RE, (_match, kept: string | undefined) => kept ?? "")
    .replace(EN_NEGATION_RE, " ");
}

function matches(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return found;
}

/** True when one text takes one side of a stance pair and the other text takes the other side. */
function opposingStances(a: string, b: string): boolean {
  return STANCE_MATCHERS.some(([left, right]) => {
    const side = (text: string): "left" | "right" | null => {
      const l = left.some((re) => matches(text, re));
      const r = right.some((re) => matches(text, re));
      return l === r ? null : l ? "left" : "right";
    };
    const sa = side(a);
    const sb = side(b);
    return sa !== null && sb !== null && sa !== sb;
  });
}

function numericValue(raw: string): string {
  const plain = raw.replace(/,/gu, "");
  return /^\d+(?:\.\d+)?$/u.test(plain) ? String(Number(plain)) : plain;
}

function unitSlot(unit: string | undefined): string {
  if (!unit) return "";
  return unit.length > 3 && unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

/**
 * Numbers, dates, days of the week, parts of the day and colour codes keyed by what they measure, plus the
 * text without them and without the words that only link the subject to such a value.
 */
function quantities(text: string): { slots: Map<string, Set<string>>; rest: string } {
  const slots = new Map<string, Set<string>>();
  const add = (slot: string, value: string): string => {
    const values = slots.get(slot) ?? new Set<string>();
    values.add(value);
    slots.set(slot, values);
    return SLOT_MARK;
  };
  let rest = text.replace(SLOT_MARK_RE, " ").replace(COLOR_RE, (color) => add("color", color));
  rest = rest.replace(DATE_RE, (_match, year: string, month: string, day: string | undefined) =>
    add("date", [year, Number(month), day ? Number(day) : ""].join("-")),
  );
  rest = arabicCounts(rest);
  rest = rest.replace(ZH_WEEKDAY_RE, (_match, day: string) => add("weekday", ZH_WEEKDAY[day] ?? day));
  rest = rest.replace(EN_WEEKDAY_RE, (_match, day: string) => add("weekday", String(EN_WEEKDAYS.indexOf(day) + 1)));
  for (const [part, pattern] of DAY_PARTS) rest = rest.replace(pattern, () => add("daypart", part));
  rest = rest.replace(NUMBER_RE, (_match, value: string, unit: string | undefined) =>
    add(unitSlot(unit), numericValue(value)),
  );
  rest = rest.replace(LINKER_BEFORE_VALUE_RE, " ").replace(SLOT_MARK_RE, " ");
  return { slots, rest };
}

/** True when both texts measure the same thing and share no value for it. */
function quantitiesDisagree(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  for (const [slot, values] of a) {
    const other = b.get(slot);
    if (other && ![...values].some((value) => other.has(value))) return true;
  }
  return false;
}

function removeStances(text: string): string {
  let out = text;
  for (const re of ALL_STANCE_MATCHERS) out = out.replace(re, HAN.test(re.source) ? "" : " ");
  return out;
}

/** What a text is about once the parts that can differ (negation, stance, numbers) are taken out. */
function subjectTokens(rest: string): string[] {
  return queryTokens(removeStances(removeNegations(rest)));
}

function looseForm(text: string): string {
  return text.replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
}

function contains(longer: string, shorter: string): boolean {
  if ([...shorter.replace(/\s/gu, "")].length < MIN_CONTAINED_CHARS) return false;
  if (HAN.test(shorter)) return longer.includes(shorter);
  return ` ${longer} `.includes(` ${shorter} `);
}

function oneContainsOther(a: string, b: string): boolean {
  const la = looseForm(a);
  const lb = looseForm(b);
  return la.length >= lb.length ? contains(la, lb) : contains(lb, la);
}

type Signal = "polarity" | "quantity" | "stance";

const REASONS: Record<Signal | "duplicate" | "unrelated", { zh: string; en: string }> = {
  duplicate: { zh: "两条记忆说的几乎是同一件事。", en: "The two memories say almost the same thing." },
  polarity: {
    zh: "两条记忆说的是同一件事，但一条是肯定的，另一条是否定的。",
    en: "Both memories are about the same thing, but one says the opposite of the other.",
  },
  quantity: {
    zh: "两条记忆说的是同一件事，但数字、时间或颜色不一样。",
    en: "Both memories are about the same thing, but give a different number, time or colour.",
  },
  stance: {
    zh: "两条记忆对同一件事的态度相反。",
    en: "The two memories take opposite positions on the same thing.",
  },
  unrelated: { zh: "两条记忆说的不是同一件事。", en: "The two memories are about different things." },
};

function reasonFor(key: keyof typeof REASONS, a: string, b: string): string {
  return HAN.test(a) || HAN.test(b) ? REASONS[key].zh : REASONS[key].en;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compares a newer memory with an existing one.
 * - `duplicate` (0.9): token Jaccard ≥ 0.9, or one text contains the other, with nothing contradicting.
 * - `conflict` (0.6–0.85): the same subject once the differing part is removed, and opposite polarity, a
 *   different number/date/weekday/time of day/colour for the same unit, or opposite stances (喜欢/讨厌,
 *   prefer/avoid). Named values (住在台北 / 住在上海) need the model judge.
 * - otherwise `unrelated`. Two texts that carry different labels (方案 A / 方案 B, 上周 / 这周) are always unrelated.
 */
export function comparePair(incoming: string, existing: string): PairVerdict {
  const similarity = round2(jaccard(tokenize(incoming), tokenize(existing)));
  const a = normalize(incoming);
  const b = normalize(existing);
  if (differentLabels(a, b)) return unrelated(incoming, existing, similarity);
  const qa = quantities(a);
  const qb = quantities(b);
  const signal: Signal | null =
    negationCount(qa.rest) > 0 !== negationCount(qb.rest) > 0
      ? "polarity"
      : quantitiesDisagree(qa.slots, qb.slots)
        ? "quantity"
        : opposingStances(qa.rest, qb.rest)
          ? "stance"
          : null;

  if (signal) {
    const sa = subjectTokens(qa.rest);
    const sb = subjectTokens(qb.rest);
    const overlap = sa.length > 0 && sb.length > 0 ? jaccard(sa, sb) : 0;
    if (overlap >= SAME_SUBJECT_OVERLAP) {
      const strength = Math.min(1, (overlap - SAME_SUBJECT_OVERLAP) / (FULL_SUBJECT_OVERLAP - SAME_SUBJECT_OVERLAP));
      return {
        relation: "conflict",
        confidence: round2(CONTRADICTION_MIN + (CONTRADICTION_MAX - CONTRADICTION_MIN) * strength),
        reason: reasonFor(signal, incoming, existing),
        similarity,
      };
    }
    return unrelated(incoming, existing, similarity);
  }

  if (similarity >= NEAR_DUPLICATE_JACCARD || oneContainsOther(a, b)) {
    return {
      relation: "duplicate",
      confidence: DUPLICATE_CONFIDENCE,
      reason: reasonFor("duplicate", incoming, existing),
      similarity,
    };
  }
  return unrelated(incoming, existing, similarity);
}

function unrelated(incoming: string, existing: string, similarity: number): PairVerdict {
  return {
    relation: "unrelated",
    confidence: round2(1 - similarity),
    reason: reasonFor("unrelated", incoming, existing),
    similarity,
  };
}
