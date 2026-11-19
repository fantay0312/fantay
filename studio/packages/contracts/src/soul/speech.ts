// SPDX-License-Identifier: Apache-2.0
// Spoken text: what a stored message reads aloud as. Speech and plain text stay; markup, code, links, markdown
// markers and stage directions go (a message that is only narration is read as written).
import { foldCardMarkup, tokenizeRoleplay } from "./format.js";

/** Each pass only removes text, so a handful of passes reaches the fixed point that makes the result idempotent. */
const PASSES = 8;

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
// Bounded spans keep the scans linear on hostile text (a line of 30 000 `[`).
const IMAGE = /!\[([^\]\n]{0,300})\]\([^)\n]{0,2000}\)/g;
const LINK = /\[([^\]\n]{0,300})\]\([^)\n]{0,2000}\)/g;
const BARE_URL = /https?:\/\/\S+/gi;
const LINE_MARKERS = /^[ \t]*(?:(?:#+|>+)[ \t]*)*(?:[-*+•][ \t]+)?/;
const RULE_OR_TABLE_LINE = /^[\s|:=\-]*$/;

function dropFences(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line);
      if (close?.[1] && close[1].charAt(0) === fence) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open?.[1]) {
      fence = open[1].charAt(0);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function spokenTokens(text: string): string {
  const tokens = tokenizeRoleplay(text);
  const spoken = tokens.filter(token => token.kind !== "action").map(token => token.text).join("");
  if (spoken.trim() !== "") return spoken;
  return tokens.filter(token => token.kind === "action").map(token => token.text).join("");
}

function unwrapLine(line: string): string {
  const trimmed = line.trim();
  for (const [open, close] of [["（", "）"], ["(", ")"]] as const) {
    if (trimmed.length > open.length + close.length - 1 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      const inner = trimmed.slice(open.length, trimmed.length - close.length);
      if (!inner.includes(open) && !inner.includes(close)) return inner;
    }
  }
  return trimmed;
}

function stripMarkers(text: string): string {
  return text.split("\n")
    .map(line => line.replace(LINE_MARKERS, ""))
    .filter(line => line.trim() === "" || !RULE_OR_TABLE_LINE.test(line))
    .map(line => unwrapLine(line.replace(/[*_~`]/g, "").replace(/\|/g, " ")))
    .join("\n");
}

function collapse(text: string): string {
  return text.split("\n")
    .map(line => line.replace(/[ \t\f\v 　]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function pass(input: string): string {
  let text = foldCardMarkup(input).filter(segment => segment.kind === "text").map(segment => segment.text).join("");
  text = text.replace(/\r\n?/g, "\n");
  text = dropFences(text);
  text = text.replace(IMAGE, "$1").replace(LINK, "$1").replace(BARE_URL, "");
  text = spokenTokens(text);
  return collapse(stripMarkers(text));
}

/** What is read aloud for a stored message: speech and plain text, without markup, code, links or stage directions. */
export function speechText(content: string): string {
  if (typeof content !== "string" || content === "") return "";
  try {
    let current = content;
    for (let round = 0; round < PASSES; round += 1) {
      const next = pass(current);
      if (next === current) return current;
      current = next;
    }
    return current;
  } catch {
    return "";
  }
}

const SAMPLE_LINES: Record<"zh" | "en" | "ja", (name: string) => string> = {
  zh: name => (name ? `你好，我是${name}。今天想聊点什么？` : "你好，这是我的声音。今天想聊点什么？"),
  en: name => (name ? `Hi, I'm ${name}. What shall we talk about today?` : "Hello, this is how I sound. What shall we talk about today?"),
  ja: name => (name ? `こんにちは、${name}です。今日は何を話しましょうか。` : "こんにちは、これが私の声です。今日は何を話しましょうか。"),
};

/** The line a voice sample (试听) reads, in the voice's language: '' reads the Chinese line, a code other than zh, en
 *  or ja the English one. `name` is the character's name, when there is one to say. */
export function speechSampleText(language: string, name = ""): string {
  const code = typeof language === "string" ? language.trim().toLowerCase().split(/[-_]/)[0] ?? "" : "";
  const line = code === "" || code === "zh" ? SAMPLE_LINES.zh : code === "ja" ? SAMPLE_LINES.ja : SAMPLE_LINES.en;
  return line(typeof name === "string" ? Array.from(name.trim()).slice(0, 60).join("") : "");
}
