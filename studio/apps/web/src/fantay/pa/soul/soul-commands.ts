// SPDX-License-Identifier: AGPL-3.0-only
// Fantay Soul: one registry for the companion composer's slash commands and its ＋ menu. Pure.
import { rollDice } from '@open-design/contracts/soul';

export type SoulCommandId = 'roll' | 'draw' | 'event' | 'continue' | 'task';
export interface SoulCommand {
  id: SoulCommandId;
  slash: string;
  aliases: readonly string[];
  /** i18n key of the label (`pa.soul.chat.cmd.<id>`). */
  labelKey: `pa.soul.chat.cmd.${SoulCommandId}`;
  group: 'play' | 'turn' | 'bridge';
  takesArg: boolean;
}

/** Order is the ＋ menu's: the `play` group, a separator, then `task`. 接着说 (`continue`) sits under the newest reply. */
export const SOUL_COMMANDS: readonly SoulCommand[] = [
  { id: 'roll', slash: '/roll', aliases: ['/r', '/掷骰'], labelKey: 'pa.soul.chat.cmd.roll', group: 'play', takesArg: true },
  { id: 'draw', slash: '/draw', aliases: ['/抽', '/抽一张'], labelKey: 'pa.soul.chat.cmd.draw', group: 'play', takesArg: true },
  { id: 'event', slash: '/event', aliases: ['/插曲', '/小插曲'], labelKey: 'pa.soul.chat.cmd.event', group: 'play', takesArg: false },
  { id: 'continue', slash: '/continue', aliases: ['/c', '/接着说'], labelKey: 'pa.soul.chat.cmd.continue', group: 'turn', takesArg: false },
  { id: 'task', slash: '/task', aliases: ['/任务'], labelKey: 'pa.soul.chat.cmd.task', group: 'bridge', takesArg: true },
];

const fold = (word: string) => word.toLowerCase();

function namesOf(command: SoulCommand): string[] {
  return [command.slash, ...command.aliases].map(fold);
}

/** The command word and the rest of the text, or null when the text does not start with `/`. */
function splitCommand(text: string): { word: string; rest: string; complete: boolean } | null {
  const body = text.replace(/^\s+/, '');
  if (!body.startsWith('/')) return null;
  const match = /^(\S+)(\s[\s\S]*)?$/.exec(body);
  if (!match) return null;
  return { word: fold(match[1] ?? ''), rest: (match[2] ?? '').trim(), complete: match[2] !== undefined };
}

/** `/roll d20+2 翻墙` → `{ id: 'roll', arg: 'd20+2 翻墙' }`; null when the text is not a command. */
export function parseSlash(text: string): { id: SoulCommandId; arg: string } | null {
  const parts = splitCommand(text);
  if (!parts) return null;
  const command = SOUL_COMMANDS.find((item) => namesOf(item).includes(parts.word));
  return command ? { id: command.id, arg: parts.rest } : null;
}

/** Commands whose slash or an alias starts with the typed prefix (the completion list). Once the command word is
 *  followed by a space, only an exact name matches. */
export function matchSlash(prefix: string): SoulCommand[] {
  const parts = splitCommand(prefix);
  if (!parts) return [];
  return SOUL_COMMANDS.filter((command) =>
    namesOf(command).some((name) => (parts.complete ? name === parts.word : name.startsWith(parts.word))),
  );
}

const DC = /^(?:dc)?(\d{1,3})$/i;
/** The roll route takes a label of at most 40 UTF-16 units. */
const LABEL_MAX = 40;

function cutLabel(text: string): string {
  let out = '';
  for (const char of text) {
    if (out.length + char.length > LABEL_MAX) break;
    out += char;
  }
  return out.trim();
}

/** `d20+2 翻墙 12` → `{ notation: 'd20+2', label: '翻墙', dc: 12 }`; null when the first word is not dice notation
 *  (the engine's `rollDice` decides; the notation comes back normalised). A trailing whole number 1–999 (or `dc12`) is
 *  the target; the words between are the label, cut to what the roll route accepts. */
export function parseRollArg(arg: string): { notation: string; label?: string; dc?: number } | null {
  const words = arg.trim().split(/\s+/).filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) return null;
  const roll = rollDice(first, () => 0);
  if (!roll) return null;
  const rest = words.slice(1);
  let dc: number | undefined;
  const last = rest[rest.length - 1];
  const target = last !== undefined ? DC.exec(last) : null;
  if (target) {
    const value = Number.parseInt(target[1] ?? '', 10);
    if (value >= 1 && value <= 999) {
      dc = value;
      rest.pop();
    }
  }
  const label = cutLabel(rest.join(' '));
  return { notation: roll.notation, ...(label ? { label } : {}), ...(dc !== undefined ? { dc } : {}) };
}
