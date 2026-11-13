import type { AgentModelVariant } from '@open-design/contracts';
import type { AgentInfo, AgentModelChoice, AppConfig } from '../types';
import { agentModelDisplayName } from '../utils/agentLabels';
import { apiProtocolAgentId, apiProtocolModelLabel } from '../utils/apiProtocol';

/** The parts of a model option that the effort / speed pairing rules read. */
type AgentModelRoute = {
  id: string;
  reasoningOptions?: ReadonlyArray<{ id: string; default?: boolean }>;
  serviceTierOptions?: ReadonlyArray<{ id: string }>;
  variants?: readonly AgentModelVariant[];
};

type AgentModelSource =
  | {
      id: AgentInfo['id'];
      models?: Array<{ id: string; enabled?: boolean; default?: boolean } & Omit<AgentModelRoute, 'id'>>;
    }
  | null
  | undefined;

export function defaultAgentModelId(agent: AgentModelSource): string | null {
  const models = agent?.models ?? [];
  return (
    models.find((model) => model.default === true && model.enabled !== false)?.id ??
    models.find((model) => model.enabled !== false)?.id ??
    null
  );
}

function claude55Replacement(agent: NonNullable<AgentModelSource>, modelId: string): string | undefined {
  const routePrefix = (id: string) => id.slice(0, id.lastIndexOf('/') + 1);
  const modelName = (id: string) => id.slice(routePrefix(id).length).replace(/^official:/i, '').toLowerCase();
  const family = /^claude-(opus|sonnet|haiku)-\d+(?:[.-]\d+)?(?:-|$)/.exec(modelName(modelId))?.[1];
  if (!family) return undefined;
  const replacements = agent.models?.filter((model) => model.enabled !== false &&
    new RegExp(`^claude-${family}-5[.-]5(?:-|$)`).test(modelName(model.id)));
  return (replacements?.find((model) => routePrefix(model.id) === routePrefix(modelId)) ?? replacements?.[0])?.id;
}

export function normalizeAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | null {
  const configuredModel =
    typeof choice?.model === 'string' && choice.model ? choice.model : null;
  if (agent?.id !== 'tokentosea' || !configuredModel) return null;
  if (configuredModel === 'default') return null;

  const matchingModel = agent.models?.find((model) => model.id === configuredModel) ?? null;
  if (!matchingModel && (agent.models?.length ?? 0) === 0) {
    return null;
  }
  if (matchingModel && matchingModel.enabled !== false) return null;

  const fallbackModel = claude55Replacement(agent, configuredModel) ?? defaultAgentModelId(agent);
  if (!fallbackModel || fallbackModel === configuredModel) return null;

  return {
    ...choice,
    model: fallbackModel,
  };
}

/**
 * Whether `model`'s concrete ids carry the effort (Cursor `-high`, Antigravity
 * `(High)`), as opposed to a family whose ids differ only by speed tier while
 * effort stays a CLI flag (Grok Build keeps its `--effort` ladder on the
 * family). Mirrors the daemon's `encodesEffort` / `effortIsFlag` test.
 */
export function variantsEncodeEffort(model: AgentModelRoute | null | undefined): boolean {
  return (model?.variants ?? []).some((variant) => Boolean(variant.reasoning));
}

/**
 * Reads a saved concrete CLI id as the family the daemon now folds it into.
 *
 * Cursor Agent, Antigravity and Grok Build list every effort / speed pairing as
 * its own model id (`gemini-4-argon-high`, `grok-4.7-build-fast`). The daemon
 * folds those into one option whose `variants` keep the concrete ids, and the
 * pickers write `{ model: family, reasoning, serviceTier }`. A choice saved
 * before the fold still names a concrete id; this maps it onto the family form
 * so every surface shows the family, its effort and its speed tier instead of
 * treating the id as unknown. Null when the saved model is an option id itself
 * or no family lists it.
 */
export function normalizeAgentModelVariantChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | null {
  const configuredModel = typeof choice?.model === 'string' ? choice.model.trim() : '';
  if (!configuredModel || configuredModel === 'default') return null;
  const models = agent?.models ?? [];
  if (models.some((model) => model.id === configuredModel)) return null;
  for (const family of models) {
    const variant = family.variants?.find((candidate) => candidate.id === configuredModel);
    if (!variant) continue;
    const next: AgentModelChoice = { ...choice, model: family.id };
    // Only ids that encode effort decide it; where effort is a flag the saved
    // effort is what the run passed and still passes.
    if (variantsEncodeEffort(family)) {
      if (variant.reasoning) next.reasoning = variant.reasoning;
      else delete next.reasoning;
    }
    if (variant.serviceTier) next.serviceTier = variant.serviceTier;
    else delete next.serviceTier;
    return next;
  }
  return null;
}

export function effectiveAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  return (
    normalizeAgentModelChoice(agent, choice) ??
    normalizeAgentModelVariantChoice(agent, choice) ??
    choice
  );
}

/**
 * The effort `model` runs at for `reasoning`: the chosen effort when the
 * model's ladder offers it, else the effort the ladder flags as default.
 */
export function modelEffectiveReasoning(
  model: AgentModelRoute | null | undefined,
  reasoning: string | null | undefined,
): string | null {
  const options = model?.reasoningOptions ?? [];
  if (reasoning && options.some((option) => option.id === reasoning)) return reasoning;
  return options.find((option) => option.default)?.id ?? null;
}

/**
 * Whether `model` can run speed tier `tierId` at effort `reasoning`.
 *
 * Flag-style tiers (Codex passes the tier as its own setting, so the model has
 * no `variants`) apply at every effort. A folded family runs only the pairings
 * it has a concrete CLI id for: Cursor may ship `-high-fast` but no `-low-fast`,
 * and offering that pair would save a choice the CLI cannot run. When the ids
 * encode effort, a variant without one stands for the family's default effort;
 * when they do not (Grok Build: effort is a flag, ids differ only by tier), a
 * tier's id runs at every effort. A null / `default` tier asks about the
 * standard tier.
 */
export function modelServiceTierAvailability(
  model: AgentModelRoute | null | undefined,
  reasoning: string | null | undefined,
  tierId: string | null | undefined,
): boolean {
  if (!model) return false;
  const variants = model.variants ?? [];
  if (variants.length === 0) return true;
  const tier = tierId && tierId !== 'default' ? tierId : null;
  const encodesEffort = variantsEncodeEffort(model);
  const effort = modelEffectiveReasoning(model, reasoning);
  const defaultEffort = modelEffectiveReasoning(model, null);
  return variants.some(
    (variant) =>
      (variant.serviceTier ?? null) === tier &&
      (!encodesEffort || (variant.reasoning ?? defaultEffort) === effort),
  );
}

/** The efforts of `model`'s ladder at which speed tier `tierId` runs, in ladder order. */
export function modelServiceTierEfforts(
  model: AgentModelRoute | null | undefined,
  tierId: string,
): string[] {
  return (model?.reasoningOptions ?? [])
    .filter((option) => modelServiceTierAvailability(model, option.id, tierId))
    .map((option) => option.id);
}

/**
 * `choice` without its speed tier when `model` cannot run that tier at the
 * choice's effort, so an effort or model change never saves an impossible pair.
 * A model the catalog does not describe leaves the choice alone: there is
 * nothing to judge the pair against.
 */
export function dropUnavailableServiceTier(
  model: AgentModelRoute | null | undefined,
  choice: AgentModelChoice,
): AgentModelChoice {
  if (!model || !choice.serviceTier || choice.serviceTier === 'default') return choice;
  if (modelServiceTierAvailability(model, choice.reasoning, choice.serviceTier)) return choice;
  const next = { ...choice };
  delete next.serviceTier;
  return next;
}

export function effectiveAgentModelId(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): string | null {
  const configuredModel = effectiveAgentModelChoice(agent, choice)?.model?.trim();
  return configuredModel && configuredModel !== 'default'
    ? configuredModel
    : defaultAgentModelId(agent);
}

/**
 * Whether `modelId` may be OFFERED to the user as a selectable model.
 *
 * This is the single definition of "locked" for every model-list surface — the
 * home composer's compact list, the execution-settings picker, and the project
 * composer's `AvatarMenu` list all ask it instead of re-deriving the rule. Only
 * AMR's catalog carries plan entitlement (`enabled: false` is what `vela model
 * list --json` reports for a model above the caller's plan); every other agent's
 * list is its own model ids and stays fully selectable.
 *
 * The invariant that makes it safe: this predicate is AT LEAST as strict as
 * `normalizeAgentModelChoice`. Every model normalization would coerce away is
 * unselectable here, so a surface that gates its rows on this can never offer a
 * pick that gets written and then silently reverted — which is exactly what the
 * compact list shipped with: the click was accepted, re-normalized back to the
 * default, and the chip snapped to the previous model with no explanation.
 * `agentModelSelection.test.ts` pins the strictness relation directly, so a
 * future change to either function that broke it would fail rather than quietly
 * reopen the silent-revert hole.
 */
/**
 * The models an agent offers in the pickers: everything except what Settings
 * left unchecked. The CLI default stays, and so does `currentModelId`, so hiding
 * the model in use never changes what a run sends.
 */
export function visibleAgentModels<T extends { id: string }>(
  models: readonly T[],
  hiddenModelIds: readonly string[] | undefined,
  currentModelId: string | null | undefined,
): T[] {
  if (!hiddenModelIds?.length) return [...models];
  const hidden = new Set(hiddenModelIds);
  return models.filter(
    (model) => !hidden.has(model.id) || model.id === 'default' || model.id === currentModelId,
  );
}

export function agentModelIsSelectable(
  agent: AgentModelSource,
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  if (agent?.models?.find(model => model.id === modelId)?.enabled === false) return false;
  if (agent?.id !== 'tokentosea') return true;
  if (modelId === 'default') return true;
  const models = agent.models ?? [];
  // No catalog yet (vela not queried) — nothing to gate against, and no surface
  // can render a row for a model it has not been told about.
  if (models.length === 0) return true;
  const option = models.find((model) => model.id === modelId) ?? null;
  return option !== null && option.enabled !== false;
}

/**
 * Who a turn sent right now would be answered by: the identity stamped on the
 * assistant placeholder of a real turn and of the optimistic first turn a
 * Home send draws (OPEND-3334). One resolution, so the role row reads the
 * same on both sides of that hand-off.
 */
export function selectedAssistantIdentity(
  config: AppConfig,
  agents: readonly AgentInfo[],
): { agentId: string | undefined; agentName: string | undefined } {
  if (config.mode === 'daemon') {
    const selectedAgent = config.agentId
      ? agents.find((agent) => agent.id === config.agentId) ?? null
      : null;
    const selectedChoice = config.agentId ? config.agentModels?.[config.agentId] : undefined;
    const effectiveChoice = effectiveAgentModelChoice(selectedAgent, selectedChoice);
    return {
      agentId: config.agentId ?? undefined,
      agentName: agentModelDisplayName(config.agentId, selectedAgent?.name, effectiveChoice?.model),
    };
  }
  return {
    agentId: apiProtocolAgentId(config.apiProtocol),
    agentName: apiProtocolModelLabel(config.apiProtocol, config.model),
  };
}
