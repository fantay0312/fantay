// SPDX-License-Identifier: Apache-2.0
// Play kit: dice, built-in decks, interlude beats and the one-line story text of each item.
import type { PaCharacterDoc, PaDeck } from "../api/personal-agent-soul.js";
import { SOUL_LIMITS } from "./limits.js";
import type { SoulLocale } from "./locale.js";

export interface DiceRoll { notation: string; rolls: number[]; modifier: number; total: number; dc?: number; outcome?: "success" | "fail" }

const DICE = /^(\d{0,2})d(\d{1,4}|%)([+-]\d{1,4})?$/;

/** Uniform index in [0, size) from one rng draw; an rng outside [0, 1) is clamped. */
function pickIndex(size: number, rng: () => number): number {
  const index = Math.floor(rng() * size);
  return Number.isFinite(index) ? Math.min(size - 1, Math.max(0, index)) : 0;
}

/** `NdM±K` (spaces ignored, `d%` is `d100`); null outside 1–40 dice of 2–1000 sides. An invalid `dc` is ignored. */
export function rollDice(notation: string, rng: () => number, dc?: number): DiceRoll | null {
  const match = DICE.exec(notation.replace(/\s+/g, "").toLowerCase());
  if (!match) return null;
  const count = match[1] ? Number.parseInt(match[1], 10) : 1;
  const sides = match[2] === "%" ? 100 : Number.parseInt(match[2] ?? "", 10);
  if (!(count >= 1 && count <= 40) || !(sides >= 2 && sides <= 1000)) return null;
  const modifier = match[3] ? Number.parseInt(match[3], 10) : 0;
  const rolls: number[] = [];
  for (let die = 0; die < count; die += 1) rolls.push(pickIndex(sides, rng) + 1);
  const total = rolls.reduce((sum, value) => sum + value, 0) + modifier;
  const normalised = `${count > 1 ? count : ""}d${sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : ""}`;
  const roll: DiceRoll = { notation: normalised, rolls, modifier, total };
  if (dc !== undefined && Number.isInteger(dc) && dc >= 1 && dc <= 999) {
    roll.dc = dc;
    roll.outcome = total >= dc ? "success" : "fail";
  }
  return roll;
}

// ---- built-in decks (original wording; Chinese content in every locale) ----------------------------------------
function questionDeck(id: string, name: string, questions: readonly string[]): PaDeck {
  return { id, name, cards: questions.map(title => ({ title, text: "", secret: "" })) };
}
function pairDeck(id: string, name: string, pairs: ReadonlyArray<readonly [string, string]>): PaDeck {
  return { id, name, cards: pairs.map(([title, text]) => ({ title, text, secret: "" })) };
}

export const PA_BUILTIN_DECKS: readonly PaDeck[] = [
  questionDeck("topic", "话题", [
    "最近一次让你笑出声的小事是什么？",
    "如果明天放一天假，谁也不用回消息，你会怎么过？",
    "有没有一样东西，你一直留着没舍得扔？",
    "小时候最喜欢的一样吃的，现在还吃得到吗？",
    "最近在反复听的一首歌是什么？",
    "你觉得自己哪个小习惯，别人不太理解？",
    "说一个你去过还想再去的地方。",
    "如果能立刻学会一样新本事，你选什么？",
    "最近一次觉得“今天真不错”，是因为什么？",
    "有没有一句别人随口说的话，你记了很久？",
    "你理想里的一个普通周末是什么样的？",
    "最近有什么事，让你有点拿不定主意？",
    "你手机里最舍不得删的一张照片，拍的是什么？",
    "下雨天你最想做什么？",
    "有没有一件小事，你其实挺得意，但没跟人说过？",
    "如果给现在的心情播一段天气预报，会怎么说？",
  ]),
  questionDeck("truth", "真心话", [
    "最近一次哭是什么时候？",
    "有没有一件事，你一直想道歉但没说出口？",
    "你最怕别人发现你的哪一面？",
    "现在最想见的一个人是谁？",
    "你做过最冲动的一个决定是什么？后悔吗？",
    "有没有一个瞬间，你觉得自己长大了？",
    "你对现在的生活，最不满意的一点是什么？",
    "上一次真心夸自己，是为了什么？",
    "有没有一个秘密，你只打算告诉一个人？",
    "你最近一次说“没事”，其实是有事吗？",
    "如果可以对一年前的自己说一句话，说什么？",
    "你希望别人怎样记得你？",
  ]),
  questionDeck("dare", "大冒险", [
    "用三个词形容对方，现在就说。",
    "发一句你平时绝对不会说的肉麻话。",
    "用播天气预报的语气，说说你今天的心情。",
    "给自己起一个新外号，并解释为什么。",
    "五秒内说出此刻手边的三样东西。",
    "只用表情符号讲一遍你的今天，让对方猜。",
    "认真夸对方一句，不许开玩笑。",
    "说出一件你一直想做但没敢做的小事，并定个日子。",
    "用一句话给今天写个标题。",
    "现在站起来伸个懒腰，再回来报告感受。",
  ]),
  pairDeck("tarot", "塔罗", [
    ["愚者", "新的开始，带着一点莽撞出发。"],
    ["魔术师", "手里的东西已经够用，动手就行。"],
    ["女祭司", "先别急着说，答案在你没说出口的地方。"],
    ["女皇", "被好好照顾，也去照顾点什么。"],
    ["皇帝", "立个规矩，然后自己先守住。"],
    ["教皇", "找个懂的人问问，不丢人。"],
    ["恋人", "一次要用心做的选择。"],
    ["战车", "方向对了，就别松缰绳。"],
    ["力量", "温柔比硬撑更有力气。"],
    ["隐士", "独处一阵，把灯举给自己看。"],
    ["命运之轮", "事情在转，轮到你了。"],
    ["正义", "该还的还，该要的要。"],
    ["倒吊人", "换个角度，暂时不动也是一种动。"],
    ["死神", "一件事结束了，腾出地方。"],
    ["节制", "一点一点调，别一口闷。"],
    ["恶魔", "看清是什么在牵着你走。"],
    ["高塔", "塌掉的本来就不稳，别可惜。"],
    ["星星", "许个愿，然后睡个好觉。"],
    ["月亮", "看不清的时候，慢一点走。"],
    ["太阳", "今天可以大大方方地开心。"],
    ["审判", "旧事来敲门，这次好好回答。"],
    ["世界", "一段路走完了，值得庆祝。"],
  ]),
  pairDeck("fortune", "签", [
    ["上上签 · 风来帆满", "想做的事，今天开个头最顺。"],
    ["上签 · 柳暗花明", "卡住的地方会松动，再等一等。"],
    ["上签 · 故人来信", "有人正想起你，回一条消息吧。"],
    ["上签 · 得一知己", "把心里话说给一个人听。"],
    ["中上签 · 细水长流", "不必一次做完，每天一点就好。"],
    ["中上签 · 新茶", "试一样没试过的小东西。"],
    ["中签 · 云开半日", "好坏各半，上午用来做事，下午用来歇。"],
    ["中签 · 且慢", "今天不宜做大决定，睡一觉再说。"],
    ["中签 · 守得住", "守住手上的，比追新的要紧。"],
    ["中下签 · 小雨", "会有点小麻烦，带把伞，带点耐心。"],
    ["下签 · 逆风", "今天多半不顺，那就少做一点，早点休息。"],
    ["上上签 · 灯火可亲", "今晚适合和喜欢的人待在一起。"],
  ]),
];

/** The character's decks first, then the built-in decks whose id the character does not shadow. */
export function availableDecks(character: Pick<PaCharacterDoc, "decks"> | null): PaDeck[] {
  const own = character?.decks ?? [];
  const shadowed = new Set(own.map(deck => deck.id));
  return [...own, ...PA_BUILTIN_DECKS.filter(deck => !shadowed.has(deck.id))];
}

// ---- deck editing ------------------------------------------------------------------------------------------------
const DECK_LIST_MARKER = /^(?:[-*•]\s+|\d{1,3}[.．、)）]\s*)/;
const DECK_SEPARATOR = /[|｜\t]/;
const DECK_ID_BASE = 32;

/** At most `max` UTF-16 units, never ending inside a surrogate pair (the schema counts units). */
function cutUnits(text: string, max: number): string {
  let out = text.length > max ? text.slice(0, max) : text;
  const last = out.charCodeAt(out.length - 1);
  if (out.length < text.length && last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trim();
}

/** Cards from pasted text, one per line: `title | text | secret` (`|`, `｜` or a tab; the last two parts optional). */
export function parseDeckLines(text: string, room: number): { cards: PaDeck["cards"]; skipped: number } {
  const cards: PaDeck["cards"] = [];
  let skipped = 0;
  const free = Number.isFinite(room) ? Math.max(0, Math.floor(room)) : 0;
  const source = typeof text === "string" ? text.slice(0, SOUL_LIMITS.deckPasteChars) : "";
  for (const rawLine of source.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim().replace(DECK_LIST_MARKER, "").trim();
    if (line === "") continue;
    const [title = "", body = "", ...rest] = line.split(DECK_SEPARATOR);
    const card = {
      title: cutUnits(title.trim(), SOUL_LIMITS.cardTitle),
      text: cutUnits(body.trim(), SOUL_LIMITS.cardText),
      secret: cutUnits(rest.map(part => part.trim()).join(" | ").trim(), SOUL_LIMITS.cardSecret),
    };
    if (card.title === "" || cards.length >= free) {
      skipped += 1;
      continue;
    }
    cards.push(card);
  }
  return { cards, skipped };
}

/** A free deck id for a name: slug of its ASCII letters and digits, else 'deck'; never a taken or built-in id. */
export function deckIdFor(name: string, taken: ReadonlySet<string>): string {
  const folded = (typeof name === "string" ? name : "").normalize("NFKC").toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, DECK_ID_BASE).replace(/-+$/, "");
  const base = slug || "deck";
  const builtin = new Set(PA_BUILTIN_DECKS.map(deck => deck.id));
  const used = (id: string) => taken.has(id) || builtin.has(id);
  if (!used(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used(candidate)) return candidate;
  }
}

/** One uniform draw. A schema-valid deck has at least two cards; an empty deck is a caller error. */
export function drawCard(deck: PaDeck, rng: () => number): { index: number; card: PaDeck["cards"][number] } {
  const index = pickIndex(deck.cards.length, rng);
  const card = deck.cards[index];
  if (!card) throw new RangeError(`deck "${deck.id}" has no cards`);
  return { index, card };
}

// ---- interludes --------------------------------------------------------------------------------------------------
export interface PaInterludeBeat { id: string; title: { zh: string; en: string }; summary: { zh: string; en: string } }

function beat(id: string, zhTitle: string, zhSummary: string, enTitle: string, enSummary: string): PaInterludeBeat {
  return { id, title: { zh: zhTitle, en: enTitle }, summary: { zh: zhSummary, en: enSummary } };
}

export const PA_INTERLUDE_BEATS: readonly PaInterludeBeat[] = [
  beat("arrival", "有人来了", "一个没想到的人出现在门口，带着一件要紧的事。",
    "Someone arrives", "An unexpected person shows up at the door with something urgent."),
  beat("revelation", "说漏了嘴", "一句无心的话，露出了一件一直没说的事。",
    "A slip of the tongue", "A careless remark reveals something that had been left unsaid."),
  beat("complication", "节外生枝", "原本顺利的事忽然多出一个麻烦。",
    "A complication", "Something that was going smoothly suddenly gains a problem."),
  beat("offer", "一个提议", "有人提出了一个让人心动、但要付出点什么的提议。",
    "An offer", "Someone makes a tempting proposal that comes at a price."),
  beat("weather", "变天了", "天气忽然变了，眼下的安排得跟着改。",
    "The weather turns", "The weather changes abruptly and the plan must change with it."),
  beat("lost-found", "失而复得", "一样以为丢了的东西，在意想不到的地方出现。",
    "Lost and found", "Something thought lost turns up where nobody expected."),
  beat("acquaintance", "旧相识", "遇见一个很久没见的人，对方还记得一件旧事。",
    "An old acquaintance", "A long-unseen person appears and still remembers an old matter."),
  beat("accident", "小意外", "打翻、摔坏、走错路：一个小意外打断了正在做的事。",
    "A small accident", "Something spilled, broken or a wrong turn interrupts what was going on."),
  beat("message", "一条消息", "一封信、一条留言或一个口信，改变了接下来的打算。",
    "A message", "A letter, a note or word of mouth changes what happens next."),
  beat("deadline", "时间不多了", "忽然发现，一件事必须在很短的时间内做完。",
    "Running out of time", "It turns out something must be finished very soon."),
  beat("quiet", "安静的片刻", "周围忽然静了下来，适合说一句平时不会说的话。",
    "A quiet moment", "Everything goes still; a good time to say what usually goes unsaid."),
  beat("memory", "想起一件事", "眼前的一样东西，让人想起了很久以前的事。",
    "A memory surfaces", "Something in sight brings back a moment from long ago."),
];

/** Uniform among the beats whose id is not excluded; all beats when that leaves none. */
export function drawInterlude(excludeIds: readonly string[], rng: () => number): PaInterludeBeat {
  const excluded = new Set(excludeIds);
  const open = PA_INTERLUDE_BEATS.filter(item => !excluded.has(item.id));
  const pool = open.length > 0 ? open : PA_INTERLUDE_BEATS;
  const picked = pool[pickIndex(pool.length, rng)];
  if (!picked) throw new RangeError("no interlude beats");
  return picked;
}

export const PA_EVENT_TURNS = 3;                 // turns an accepted interlude stays active

// ---- story items -------------------------------------------------------------------------------------------------
export type StoryItem =
  | { kind: "roll"; roll: DiceRoll; label?: string }
  | { kind: "draw"; deckName: string; title: string; text: string }
  | { kind: "event"; title: string; phase: "accepted" | "ended" };

/** Story text is one line: line breaks inside a field become single spaces. */
function oneLine(text: string): string {
  return text.replace(/[ \t]*(?:\r\n|\r|\n)[ \t]*/g, " ");
}

/** The one-line plain text stored as the message content of a story item. */
export function storyText(item: StoryItem, locale: SoulLocale): string {
  const zh = locale === "zh";
  if (item.kind === "roll") {
    const { roll } = item;
    const label = oneLine(item.label ?? "").trim();
    let text = `${zh ? "掷骰" : "Roll"} ${label ? `${label} ` : ""}${roll.notation} = ${roll.total}`;
    if (roll.dc !== undefined) {
      const success = (roll.outcome ?? (roll.total >= roll.dc ? "success" : "fail")) === "success";
      text += zh
        ? `（目标 ${roll.dc}，${success ? "成功" : "失败"}）`
        : ` (target ${roll.dc}, ${success ? "success" : "failure"})`;
    }
    return text;
  }
  if (item.kind === "draw") {
    const title = oneLine(item.title);
    const deckName = oneLine(item.deckName);
    const body = oneLine(item.text);
    if (zh) return `抽到「${title}」· ${deckName}${body ? `：${body}` : ""}`;
    return `Drew "${title}" from ${deckName}${body ? `: ${body}` : ""}`;
  }
  const title = oneLine(item.title);
  if (zh) return `${item.phase === "accepted" ? "小插曲开始" : "小插曲结束"}：${title}`;
  return `${item.phase === "accepted" ? "Interlude begins" : "Interlude ends"}: ${title}`;
}

/** Appended to a draw's text in the prompt only, never stored on the message. */
export function secretSuffix(secret: string, locale: SoulLocale): string {
  return locale === "zh" ? `（只有你知道：${secret}）` : `(Only you know: ${secret})`;
}
