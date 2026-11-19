// SPDX-License-Identifier: Apache-2.0
// The <turn_meta> contract: which parts are on, the contract text in the system zone, the tail reminder, and the
// canonical footer serializer used for history replay.
import type {
  PaCharacterDoc, PaChatSettingsDoc, PaMetaParts, PaStateField, PaStateOp, PaStylePresetDoc,
} from "../api/personal-agent-soul.js";
import { SOUL_TEXT, fill, type SoulLocale } from "./locale.js";
import { formatStateNumber } from "./state.js";

const NO_PARTS: PaMetaParts = { mood: false, state: false, choices: false, remember: false, play: false };

export function resolveMetaParts(input: {
  preset: PaStylePresetDoc; character: PaCharacterDoc | null; chat: PaChatSettingsDoc;
  group: boolean; care: "none" | "concern" | "crisis";
}): PaMetaParts {
  if (input.chat.turnRecord === "off" || input.care === "crisis") return { ...NO_PARTS };
  return {
    mood: input.preset.mood,
    state: !input.group && (input.character?.stateSchema.length ?? 0) > 0,
    choices: input.preset.suggestChoices,
    remember: input.character?.autoMemory === true,
    play: input.preset.playRequests,
  };
}

export function anyPart(parts: PaMetaParts): boolean {
  return parts.mood || parts.state || parts.choices || parts.remember || parts.play;
}

/** Drops rules 3 and 4 (number and list syntax) and renumbers the rest. */
function rulesWithoutState(rules: string): string {
  const [heading = "", ...items] = rules.split("\n");
  const kept = items.filter(line => !/^[34]\.\s/.test(line)).map((line, index) => line.replace(/^\d+\./, `${index + 1}.`));
  return [heading, ...kept].join("\n");
}

function fieldRow(field: PaStateField, locale: SoulLocale): string {
  const text = SOUL_TEXT[locale];
  const colon = locale === "zh" ? "：" : ": ";
  const comma = locale === "zh" ? "，" : ", ";
  const meaning = field.hint.trim() ? `${field.label}${colon}${field.hint.trim()}` : field.label;
  let type: string;
  if (field.kind === "number") {
    const min = field.min !== undefined ? formatStateNumber(field.min) : "";
    const max = field.max !== undefined ? formatStateNumber(field.max) : "";
    type = min || max ? `${text["contract.type.number"]} ${min}–${max}` : text["contract.type.number"];
  } else if (field.kind === "enum") {
    type = `${text["contract.type.enum"]}${colon}${field.options.join(" / ")}`;
  } else {
    type = text[field.kind === "text" ? "contract.type.text" : "contract.type.list"];
  }
  if (field.writable === "user") type += `${comma}${text["contract.readonly"]}`;
  return `${field.key} | ${meaning} | ${type}`;
}

function exampleBlock(parts: PaMetaParts, schema: readonly PaStateField[], locale: SoulLocale): string {
  const text = SOUL_TEXT[locale];
  const lines = ["<turn_meta>"];
  if (parts.mood) lines.push(`mood: ${text["contract.sample.mood"]}`);
  if (parts.state) {
    const number = schema.find(field => field.kind === "number" && field.writable !== "user");
    if (number) lines.push(`${number.key}: -1`);
    const list = schema.find(field => field.kind === "list" && field.writable !== "user");
    if (list && list.kind === "list") lines.push(`${list.key}+: ${list.initial[0] ?? text["contract.sample.item"]}`);
  }
  if (parts.choices) lines.push(`choices: ${text["contract.sample.choices"]}`);
  lines.push("</turn_meta>");
  return lines.join("\n");
}

export function buildFooterContract(input: {
  parts: PaMetaParts; schema: readonly PaStateField[]; decks: ReadonlyArray<{ id: string; name: string }>; locale: SoulLocale;
}): string {
  const { parts, schema, decks, locale } = input;
  if (!anyPart(parts)) return "";
  const text = SOUL_TEXT[locale];
  const bullets: string[] = [];
  if (parts.mood) bullets.push(text["contract.line.mood"]);
  if (parts.state) bullets.push(text["contract.line.state"]);
  if (parts.choices) bullets.push(text["contract.line.choices"]);
  if (parts.remember) bullets.push(text["contract.line.remember"]);
  if (parts.play) {
    bullets.push(text["contract.line.roll"]);
    if (decks.length > 0) {
      const list = decks.map(deck => `${deck.id}（${deck.name}）`).join(locale === "zh" ? "、" : ", ");
      bullets.push(fill(text["contract.line.draw"], { decks: list }));
    }
  }
  const sections = [
    text["contract.purpose"],
    [text["contract.lines"], ...bullets.map(bullet => `- ${bullet}`)].join("\n"),
    parts.state ? text["contract.rules"] : rulesWithoutState(text["contract.rules"]),
  ];
  if (parts.state) sections.push([text["contract.table"], ...schema.map(field => fieldRow(field, locale))].join("\n"));
  sections.push(`${text["contract.example"]}\n${exampleBlock(parts, schema, locale)}`);
  return sections.join("\n\n");
}

/** '' when no part is on. */
export function footerReminder(parts: PaMetaParts, locale: SoulLocale, rememberHint: boolean): string {
  if (!anyPart(parts)) return "";
  const text = SOUL_TEXT[locale];
  return rememberHint && parts.remember ? `${text.reminder}\n${text["reminder.remember"]}` : text.reminder;
}

const oneLine = (value: string) => value.replace(/\s*\n\s*/g, " ");

function opLines(op: PaStateOp): string[] {
  const { key, value } = op;
  if (op.op === "delta" && typeof value === "number" && Number.isFinite(value)) {
    return [`${key}: ${value < 0 ? "-" : "+"}${formatStateNumber(Math.abs(value))}`];
  }
  if (op.op === "set" && typeof value === "number" && Number.isFinite(value)) {
    return [value < 0 ? `${key}:= ${formatStateNumber(value)}` : `${key}: ${formatStateNumber(value)}`];
  }
  if (op.op === "set" && typeof value === "string") return [`${key}: ${oneLine(value)}`];
  if (op.op === "add" || op.op === "remove") {
    const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return items.map(item => `${key}${op.op === "add" ? "+" : "-"}: ${oneLine(item)}`);
  }
  return [];
}

/** The canonical serializer: history replay and the round-trip property test use it. */
export function renderFooter(input: { mood?: string; stateOps?: readonly PaStateOp[]; parts: PaMetaParts }): string {
  const lines = ["<turn_meta>"];
  if (input.parts.mood && input.mood !== undefined && input.mood.trim()) lines.push(`mood: ${oneLine(input.mood.trim())}`);
  if (input.parts.state) for (const op of input.stateOps ?? []) lines.push(...opLines(op));
  lines.push("</turn_meta>");
  return lines.join("\n");
}
