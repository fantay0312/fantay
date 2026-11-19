// SPDX-License-Identifier: Apache-2.0
// Crisis detection over the newest owner texts. Pure and deterministic; the daemon applies the effects (section 4.4).

export type CareLevel = "none" | "concern" | "crisis";
type CareResult = { level: CareLevel; rule: string };

const NONE: CareResult = { level: "none", rule: "" };
const MAX_CHARS = 2000;
const ZERO_WIDTH = /[᠎​-‍⁠﻿]/g;
const CJK = "\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef\\u{20000}-\\u{10ffff}";
const CJK_GAP = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "gu");

/** NFKC, lower case, no zero-width characters, no whitespace between two CJK characters, the last 2000 chars. */
function normalise(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(ZERO_WIDTH, "").replace(CJK_GAP, "$1").slice(-MAX_CHARS);
}

// ---- crisis tier: an explicit first-person statement of intent, plan or act ----------------------------------------
const DEGREE = "(?:累|困|饿|渴|热|冷|气|烦|羞|尴尬|疼|痛|吓|急|忙|丑|穷|笑|撑|无聊)(?:得|到)?(?:要)?";
const CRISIS_RULES: ReadonlyArray<{ id: string; zh: boolean; pattern: RegExp }> = [
  { id: "zh-intent", zh: true, pattern: /想(?:要)?(?:自杀|轻生|自尽|结束(?:自己的?)?生命|了结自己)/g },
  { id: "zh-live", zh: true, pattern: /不想活(?:了|下去)|活不下去/g },
  { id: "zh-plan", zh: true, pattern: /(?:准备|打算|决定|计划)(?:去)?(?:自杀|跳楼|割腕|上吊|吞药|烧炭)/g },
  { id: "zh-act", zh: true, pattern: /自残|割腕|紫砂|自鲨/g },
  { id: "zh-die", zh: true, pattern: new RegExp(`(?<!${DEGREE})想死(?!你|我了)`, "g") },
  { id: "zh-go", zh: true, pattern: /我(?:真的|好|很)?(?:想|要|该)去死/g },
  { id: "en", zh: false, pattern: /kill myself|end my life|take my own life|suicid|want to die|self[- ]?harm|cut myself/g },
];

const ZH_NEGATION = /不是|没|别|不会|不要|并不/;
const ZH_THIRD_PERSON = /他|她|(?<![a-z])ta(?![a-z])/g;
const EN_DOWNGRADE = /\b(?:not|never|don['’]t|doesn['’]t|didn['’]t|won['’]t|he|she|they) /g;

/** The last match of `pattern` (global) in `text` that starts within `span` chars before `index`. */
function lastMarker(text: string, index: number, span: number, pattern: RegExp): { start: number; end: number } | null {
  let found: { start: number; end: number } | null = null;
  for (const match of text.slice(0, index).matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start >= index - span) found = { start, end: start + match[0].length };
  }
  return found;
}

/** Negated or third-person: the match counts as concern, not crisis. */
function downgraded(text: string, index: number, zh: boolean): boolean {
  if (!zh) return lastMarker(text, index, 20, EN_DOWNGRADE) !== null;
  if (ZH_NEGATION.test(text.slice(Math.max(0, index - 6), index))) return true;
  const third = lastMarker(text, index, 8, ZH_THIRD_PERSON);
  return third !== null && !text.slice(third.end, index).includes("我");
}

function crisisTier(text: string): CareResult {
  let weaker = "";
  for (const rule of CRISIS_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      if (!downgraded(text, match.index ?? 0, rule.zh)) return { level: "crisis", rule: rule.id };
      weaker ||= rule.id;
    }
  }
  return weaker ? { level: "concern", rule: weaker } : NONE;
}

// ---- concern tier: despair wording outside narration spans --------------------------------------------------------
const NARRATION = /\*[^*\n]*\*|（[^）\n]*）|\([^)\n]*\)/g;
const CONCERN_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "zh-concern", pattern: /绝望|撑不下去|撑不住了|崩溃|活着没意思|活着有什么意思|消失算了|想消失|不想醒来/ },
  { id: "en-concern", pattern: /hopeless|can['’]t go on|cannot go on|no reason to live|want to disappear|worthless/ },
];

function evaluate(text: string): CareResult {
  const crisis = crisisTier(text);
  if (crisis.level !== "none") return crisis;
  const spoken = text.replace(NARRATION, " ");
  const concern = CONCERN_RULES.find(rule => rule.pattern.test(spoken));
  return concern ? { level: "concern", rule: concern.id } : NONE;
}

/** `texts`: the newest owner texts, newest first, at most 3. Pure and deterministic. */
export function detectCrisis(texts: readonly string[], options?: { fiction?: boolean }): { level: CareLevel; rule: string } {
  const recent = texts.slice(0, 3).map(text => normalise(typeof text === "string" ? text : ""));
  const [newest, ...older] = recent;
  let result = newest === undefined ? NONE : evaluate(newest);
  if (result.level === "none") {
    for (const text of older) {
      const crisis = crisisTier(text);
      if (crisis.level === "crisis") {
        result = { level: "concern", rule: crisis.rule };
        break;
      }
    }
  }
  if (options?.fiction === true && result.level === "concern") return { ...NONE };
  return { ...result };
}
