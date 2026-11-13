import type { AgentModelVariant } from '@open-design/contracts';

import { DEFAULT_MODEL_OPTION, findKnownModel, type KnownModelSource } from './models.js';
import type { RuntimeBuildOptions, RuntimeModelOption } from './types.js';

// Some CLIs (Cursor Agent, Antigravity, Grok Build) list every effort / speed
// pairing as its own model id (`claude-opus-5-5-high-fast`). The daemon folds
// those ids into ONE model option (a "family") whose `reasoningOptions` are the
// effort ladder and whose `serviceTierOptions` carry `fast`, and keeps the
// concrete ids in `variants` so spawn can pick the exact one again.

/** Effort ladder, weakest first. Every folded `reasoningOptions` list follows this order. */
export const REASONING_EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_LADDER)[number];

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export const FAST_SERVICE_TIER = 'fast';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORT_LADDER as readonly string[]).includes(value);
}

/** Ladder-ordered `reasoningOptions` with exactly one `default: true` (when `defaultEffort` is listed). */
export function reasoningEffortOptions(
  efforts: Iterable<string>,
  defaultEffort?: string | null,
): RuntimeModelOption[] {
  const present = new Set(efforts);
  return REASONING_EFFORT_LADDER.filter((effort) => present.has(effort)).map((effort) => ({
    id: effort,
    label: REASONING_EFFORT_LABELS[effort],
    ...(effort === defaultEffort ? { default: true } : {}),
  }));
}

/** Strips zero-width characters CLIs leave in labels and collapses whitespace. */
export function normalizeModelLabel(label: string | null | undefined): string {
  return String(label ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ANY_EFFORT_WORD_RE = /\b(?:none|minimal|low|medium|high|x-?high|max)\b/i;

const EFFORT_WORD_RE: Record<ReasoningEffort, RegExp> = {
  none: /\bnone\b/gi,
  minimal: /\bminimal\b/gi,
  low: /\blow\b/gi,
  medium: /\bmedium\b/gi,
  high: /\bhigh\b/gi,
  xhigh: /\b(?:extra[\s-]*high|x-?high)\b/gi,
  max: /\bmax\b/gi,
};

function labelHasEffortWord(label: string): boolean {
  return ANY_EFFORT_WORD_RE.test(label);
}

function removeLastMatch(label: string, pattern: RegExp): string {
  let last: RegExpExecArray | null = null;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(label); match; match = pattern.exec(label)) last = match;
  pattern.lastIndex = 0;
  if (!last) return label;
  return label.slice(0, last.index) + label.slice(last.index + last[0].length);
}

function tidyLabel(label: string): string {
  return label
    .replace(/\(\s*\)/g, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ModelVariantParse = {
  /** Family key shared by every id of one model; becomes the folded option id. */
  family: string;
  /** Effort the id encodes, when it encodes one. */
  reasoning?: string;
  /** True when the id is the fast service-tier variant. */
  fast?: boolean;
};

export type ModelVariantParser = (id: string, label: string) => ModelVariantParse | null;

type FoldEntry = {
  model: RuntimeModelOption;
  label: string;
  parsed: ModelVariantParse | null;
};

type FoldMember = FoldEntry & { parsed: ModelVariantParse; reasoning?: ReasoningEffort; fast: boolean };

function sanitizeParse(parsed: ModelVariantParse | null): ModelVariantParse | null {
  if (!parsed || typeof parsed.family !== 'string' || parsed.family.length === 0) return null;
  if (parsed.reasoning !== undefined && !isReasoningEffort(parsed.reasoning)) return null;
  return parsed;
}

/**
 * Folds CLI model ids that differ only by effort / speed into one option per
 * family. `default` and ids the parser does not recognise stay unchanged and
 * in place; a family with a single id is left untouched. The folded option sits
 * where the family's first id was, so the CLI's own ordering survives.
 */
export function foldModelVariants(
  models: RuntimeModelOption[],
  parseVariant: ModelVariantParser,
): RuntimeModelOption[] {
  if (!Array.isArray(models) || models.length === 0) return models;
  const entries: FoldEntry[] = models.map((model) => {
    const label = normalizeModelLabel(model.label);
    const parsed =
      !model?.id || model.id === DEFAULT_MODEL_OPTION.id || Array.isArray(model.variants)
        ? null
        : sanitizeParse(parseVariant(model.id, label));
    return { model, label, parsed };
  });

  // An id that is itself another group's family key is that family's base
  // (e.g. `gpt-5.1-codex-max` beside `gpt-5.1-codex-max-high`), not a `max`
  // variant of a shorter family.
  const familyKeys = new Set(
    entries.flatMap((entry) => (entry.parsed ? [entry.parsed.family] : [])),
  );
  for (const entry of entries) {
    if (entry.parsed && entry.parsed.family !== entry.model.id && familyKeys.has(entry.model.id)) {
      entry.parsed = { family: entry.model.id };
    }
  }

  const groups = new Map<string, FoldMember[]>();
  for (const entry of entries) {
    if (!entry.parsed) continue;
    const member: FoldMember = {
      ...entry,
      parsed: entry.parsed,
      ...(entry.parsed.reasoning ? { reasoning: entry.parsed.reasoning as ReasoningEffort } : {}),
      fast: entry.parsed.fast === true,
    };
    const group = groups.get(entry.parsed.family);
    if (group) group.push(member);
    else groups.set(entry.parsed.family, [member]);
  }

  const allIds = new Set(entries.map((entry) => entry.model.id));
  const foldedById = new Map<string, { family: RuntimeModelOption; first: boolean }>();
  for (const [family, group] of groups) {
    const folded = foldFamily(family, group);
    if (!folded) continue;
    // The family id must not collide with an id left outside the fold (an
    // ambiguous suffix-less id); keep the whole family unfolded then.
    if (allIds.has(family) && !folded.members.some((member) => member.model.id === family)) continue;
    folded.members.forEach((member, index) => {
      foldedById.set(member.model.id, { family: folded.option, first: index === 0 });
    });
  }

  const out: RuntimeModelOption[] = [];
  for (const entry of entries) {
    const folded = foldedById.get(entry.model.id);
    if (!folded) out.push(entry.model);
    else if (folded.first) out.push(folded.family);
  }
  return out;
}

function foldFamily(
  family: string,
  group: FoldMember[],
): { option: RuntimeModelOption; members: FoldMember[] } | null {
  if (group.length < 2) return null;
  const encodesEffort = group.some((member) => member.reasoning);
  let members = group;
  if (encodesEffort) {
    // A suffix-less id encodes the CLI's default effort. Cursor uses it for
    // `medium` (gpt-5.2, gpt-5.3-codex); when an explicit medium id exists the
    // suffix-less one is ambiguous and stays its own option.
    const hasExplicitMedium = group.some((member) => member.reasoning === 'medium');
    members = group
      .filter((member) => member.reasoning || !hasExplicitMedium)
      .map((member) => (member.reasoning ? member : { ...member, reasoning: 'medium' as const }));
  }
  // Two ids for the same (effort, tier) pairing: keep the first one only.
  const seenPairs = new Set<string>();
  members = members.filter((member) => {
    const key = `${member.reasoning ?? ''}\0${member.fast ? FAST_SERVICE_TIER : ''}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
    return true;
  });
  if (members.length < 2) return null;

  const standard = members.filter((member) => !member.fast);
  // Cursor labels the effort it uses by default without an effort word:
  // "Claude Opus 5.5 1M" is the medium id, "Claude Opus 4.7 1M" the xhigh one.
  const plainDefault = standard.find((member) => !labelHasEffortWord(member.label));
  const efforts = members.flatMap((member) => (member.reasoning ? [member.reasoning] : []));
  const defaultEffort = encodesEffort
    ? plainDefault?.reasoning ??
      (efforts.includes('medium') ? 'medium' : members.find((member) => member.reasoning)?.reasoning)
    : undefined;

  const label = familyLabel(family, plainDefault, standard, members);
  const base = (plainDefault ?? standard[0] ?? members[0])!.model;
  const {
    reasoningOptions: baseReasoningOptions,
    serviceTierOptions: baseServiceTierOptions,
    default: _baseDefault,
    enabled: _baseEnabled,
    variants: _baseVariants,
    ...rest
  } = base;
  const anyFast = members.some((member) => member.fast);
  const reasoningOptions = encodesEffort
    ? reasoningEffortOptions(efforts, defaultEffort)
    : baseReasoningOptions?.map((option) => ({ ...option }));
  const serviceTierOptions = anyFast
    ? [{ id: FAST_SERVICE_TIER, label: 'Fast' }]
    : baseServiceTierOptions?.map((option) => ({ ...option }));
  const variants: AgentModelVariant[] = members.map((member) => ({
    id: member.model.id,
    ...(member.label && member.label !== member.model.id ? { label: member.label } : {}),
    ...(member.reasoning ? { reasoning: member.reasoning } : {}),
    ...(member.fast ? { serviceTier: FAST_SERVICE_TIER } : {}),
  }));

  const option: RuntimeModelOption = {
    ...rest,
    id: family,
    label,
    ...(members.every((member) => member.model.enabled === false) ? { enabled: false } : {}),
    ...(members.some((member) => member.model.default === true) ? { default: true } : {}),
    ...(reasoningOptions && reasoningOptions.length > 0 ? { reasoningOptions } : {}),
    ...(serviceTierOptions && serviceTierOptions.length > 0 ? { serviceTierOptions } : {}),
    variants,
  };
  return { option, members };
}

function familyLabel(
  family: string,
  plainDefault: FoldMember | undefined,
  standard: FoldMember[],
  members: FoldMember[],
): string {
  if (plainDefault?.label) return tidyLabel(plainDefault.label);
  const firstStandard = standard.find((member) => member.label);
  if (firstStandard) {
    return tidyLabel(withoutEffortWord(firstStandard.label, firstStandard.reasoning)) || family;
  }
  const firstFast = members.find((member) => member.fast && member.label);
  if (firstFast) {
    const withoutFast = removeLastMatch(firstFast.label, /\bfast\b/gi);
    return tidyLabel(withoutEffortWord(withoutFast, firstFast.reasoning)) || family;
  }
  return family;
}

function withoutEffortWord(label: string, effort: ReasoningEffort | undefined): string {
  return effort ? removeLastMatch(label, EFFORT_WORD_RE[effort]) : label;
}

function variantTier(variant: AgentModelVariant): string | undefined {
  return variant.serviceTier === FAST_SERVICE_TIER ? FAST_SERVICE_TIER : undefined;
}

/** The effort a family uses when none is chosen; undefined when its ids encode no effort. */
export function defaultVariantEffort(option: RuntimeModelOption): string | undefined {
  const variants = option.variants ?? [];
  if (!variants.some((variant) => variant.reasoning)) return undefined;
  const marked = option.reasoningOptions?.find((reasoning) => reasoning.default === true)?.id;
  if (marked && variants.some((variant) => variant.reasoning === marked)) return marked;
  if (variants.some((variant) => variant.reasoning === 'medium')) return 'medium';
  return variants.find((variant) => variant.reasoning)?.reasoning;
}

/**
 * Picks the concrete CLI id for a (reasoning, serviceTier) choice on a folded
 * option. Falls back in order: same effort on the standard tier, the default
 * effort on the requested tier, the default effort on the standard tier, and
 * finally the first variant. An option without variants resolves to itself.
 */
export function resolveModelVariant(
  option: RuntimeModelOption,
  reasoning?: string | null,
  serviceTier?: string | null,
): string {
  const variants = option.variants;
  if (!Array.isArray(variants) || variants.length === 0) return option.id;
  const tier = serviceTier === FAST_SERVICE_TIER ? FAST_SERVICE_TIER : undefined;
  const encodesEffort = variants.some((variant) => variant.reasoning);
  const defaultEffort = defaultVariantEffort(option);
  const requestedEffort = encodesEffort && reasoning && reasoning !== 'default' ? reasoning : defaultEffort;
  const find = (effort: string | undefined, wantedTier: string | undefined) =>
    variants.find(
      (variant) => (variant.reasoning ?? undefined) === effort && variantTier(variant) === wantedTier,
    );
  const picked =
    find(requestedEffort, tier) ??
    find(requestedEffort, undefined) ??
    find(defaultEffort, tier) ??
    find(defaultEffort, undefined) ??
    variants[0]!;
  return picked.id;
}

export type ResolvedVariantModel = {
  /** The id to hand the CLI; unchanged when the choice is not a folded family. */
  model: string | null | undefined;
  /** The family's ids encode effort, so the chosen effort is already in `model`. */
  reasoningConsumed: boolean;
  /** The family's ids encode the service tier, so `fast` is already in `model`. */
  serviceTierConsumed: boolean;
};

/**
 * Spawn-time helper for defs whose CLI encodes effort / speed in the model id:
 * resolves a saved family choice to the concrete id. `default`, custom ids, and
 * ids that are not folded families pass through unchanged.
 */
export function resolveVariantModelId(
  def: KnownModelSource,
  options: RuntimeBuildOptions = {},
  scope?: string | null,
): ResolvedVariantModel {
  const model = options.model;
  const unchanged = { model, reasoningConsumed: false, serviceTierConsumed: false };
  if (!model || model === DEFAULT_MODEL_OPTION.id) return unchanged;
  const option = findKnownModel(def, model, scope);
  const variants = option?.variants;
  if (!option || !Array.isArray(variants) || variants.length === 0) return unchanged;
  return {
    model: resolveModelVariant(option, options.reasoning, options.serviceTier),
    reasoningConsumed: variants.some((variant) => variant.reasoning),
    serviceTierConsumed: variants.some((variant) => variant.serviceTier),
  };
}
