// SPDX-License-Identifier: Apache-2.0
// Emotions: the eight sprite moods, a keyword reading of the free `mood` word a reply carries, and the sprite lookup.
import { PA_EMOTIONS } from "../api/personal-agent-soul.js";
import type { PaEmotion, PaSprites } from "../api/personal-agent-soul.js";

export const PA_EMOTION_META: Record<PaEmotion, { zh: string; en: string }> = {
  neutral: { zh: "平静", en: "Calm" },
  happy: { zh: "开心", en: "Happy" },
  sad: { zh: "难过", en: "Sad" },
  angry: { zh: "生气", en: "Angry" },
  surprised: { zh: "惊讶", en: "Surprised" },
  shy: { zh: "害羞", en: "Shy" },
  worried: { zh: "不安", en: "Worried" },
  sleepy: { zh: "困倦", en: "Sleepy" },
};

/** Lower-case keywords; a keyword with a non-ASCII character is matched as Chinese, the rest as English word stems. */
const KEYWORDS: Record<PaEmotion, string> = {
  neutral: "平静 平淡 淡定 冷静 认真 专注 思考 沉思 普通 日常 默认 无表情 "
    + "neutral calm normal default idle serious thoughtful focused blank",
  happy: "开心 高兴 快乐 愉快 喜悦 欣喜 欢喜 雀跃 兴奋 期待 满足 得意 轻松 幸福 温柔 微笑 安心 放松 笑 甜 "
    + "happy joy glad cheer excit delight pleas content amus smil laugh playful proud relie gentle fond",
  sad: "难过 伤心 悲伤 失落 低落 沮丧 委屈 心酸 心疼 想哭 孤单 寂寞 落寞 遗憾 郁闷 不开心 不高兴 哭 "
    + "sad upset lonel gloom hurt disappoint melanchol cry tear depress sorrow",
  angry: "生气 愤怒 恼火 恼怒 火大 暴躁 烦躁 不爽 不满 嫌弃 气鼓鼓 气 "
    + "angry anger mad annoy irritat furious grump frustrat pout",
  surprised: "惊讶 吃惊 震惊 惊喜 意外 诧异 好奇 愣 惊 "
    + "surpris shock amaz astonish startl stun curious",
  shy: "害羞 脸红 腼腆 害臊 扭捏 不好意思 尴尬 心动 傲娇 羞 "
    + "shy blush embarrass fluster bashful awkward tsundere",
  worried: "担心 担忧 紧张 不安 害怕 恐惧 焦虑 忐忑 警惕 犹豫 纠结 心虚 慌 "
    + "worr anxi nervous afraid scare uneas tense fear hesitan concern",
  sleepy: "疲惫 疲倦 犯困 慵懒 无聊 困 累 倦 懒 "
    + "sleep tired exhaust drows weary bored yawn lazy",
};

interface Keyword { emotion: PaEmotion; rank: number; text: string; length: number; weak: boolean; negator: boolean }

const ZH_NEGATORS: ReadonlySet<string> = new Set(["不", "没", "别", "未", "无"]);
const ZH_NEGATOR_PAIRS: ReadonlySet<string> = new Set(["不太", "不怎", "没有", "不是"]);
const EN_NEGATORS: ReadonlySet<string> = new Set(["not", "no", "never"]);
/** English keywords this long or shorter must equal a word; longer ones are stems that start a word. */
const EN_EXACT_MAX = 3;

const ZH_KEYWORDS: Keyword[] = [];
const EN_KEYWORDS: Keyword[] = [];
PA_EMOTIONS.forEach((emotion, rank) => {
  for (const text of KEYWORDS[emotion].split(" ")) {
    if (!text) continue;
    const length = Array.from(text).length;
    const zh = Array.from(text).some(char => (char.codePointAt(0) ?? 0) > 0x7f);
    (zh ? ZH_KEYWORDS : EN_KEYWORDS).push({
      emotion, rank, text, length, weak: zh && length === 1, negator: zh && ZH_NEGATORS.has(text.charAt(0)),
    });
  }
});

/** Emotion ids and both meta names, lower-cased. */
const NAMES: ReadonlyMap<string, PaEmotion> = new Map(PA_EMOTIONS.flatMap((emotion): Array<[string, PaEmotion]> => [
  [emotion, emotion],
  [PA_EMOTION_META[emotion].zh.toLowerCase(), emotion],
  [PA_EMOTION_META[emotion].en.toLowerCase(), emotion],
]));

interface Hit { index: number; keyword: Keyword }

function better(a: Hit, b: Hit): boolean {
  if (a.index !== b.index) return a.index < b.index;
  if (a.keyword.length !== b.keyword.length) return a.keyword.length > b.keyword.length;
  return a.keyword.rank < b.keyword.rank;
}

/** Moods are at most a dozen code points; asset names come from foreign cards, so only their head is read. */
const MATCH_CHARS = 400;

function match(text: unknown): PaEmotion | null {
  if (typeof text !== "string") return null;
  const s = text.slice(0, MATCH_CHARS).normalize("NFKC").toLowerCase().trim();
  if (!s) return null;
  const named = NAMES.get(s);
  if (named) return named;
  const hits: Hit[] = [];
  for (const keyword of ZH_KEYWORDS) {
    for (let index = s.indexOf(keyword.text); index >= 0; index = s.indexOf(keyword.text, index + 1)) {
      const negated = !keyword.negator
        && (ZH_NEGATORS.has(s.charAt(index - 1)) || (index >= 2 && ZH_NEGATOR_PAIRS.has(s.slice(index - 2, index))));
      if (!negated) hits.push({ index, keyword });
    }
  }
  const words = Array.from(s.matchAll(/[a-z]+/g), found => ({ text: found[0], index: found.index ?? 0 }));
  words.forEach((word, position) => {
    const previous = position > 0 ? words[position - 1]?.text ?? "" : "";
    if (EN_NEGATORS.has(previous)) return;
    for (const keyword of EN_KEYWORDS) {
      const hit = keyword.length <= EN_EXACT_MAX ? word.text === keyword.text : word.text.startsWith(keyword.text);
      if (hit) hits.push({ index: word.index, keyword });
    }
  });
  const strong = hits.some(hit => !hit.keyword.weak);
  let winner: Hit | null = null;
  for (const hit of hits) {
    if (strong && hit.keyword.weak) continue;
    if (winner === null || better(hit, winner)) winner = hit;
  }
  return winner ? winner.keyword.emotion : null;
}

/** The emotion of a free mood word; 'neutral' when nothing matches. */
export function emotionOf(mood: string | null | undefined): PaEmotion {
  return match(mood ?? "") ?? "neutral";
}

/** sprites[emotion] ?? sprites.neutral ?? null. */
export function spriteFor(sprites: PaSprites | null | undefined, emotion: PaEmotion): string | null {
  if (sprites === null || typeof sprites !== "object") return null;
  const read = (key: PaEmotion): string | null => {
    const value: unknown = Object.hasOwn(sprites, key) ? sprites[key] : undefined;
    return typeof value === "string" && value !== "" ? value : null;
  };
  return read(emotion) ?? read("neutral");
}

/** For an archive's emotion image name: like emotionOf, but null when nothing matches. */
export function emotionFromAssetName(name: string): PaEmotion | null {
  if (typeof name !== "string") return null;
  return match(name.replace(/\.[A-Za-z0-9]{1,8}$/, "").replace(/[_-]/g, " "));
}
