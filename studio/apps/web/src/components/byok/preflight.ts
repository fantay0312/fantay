import type { ByokChatProtocol, ByokChatProviderConfig } from '@open-design/contracts';
import type { TrackingByokPreflightBlockReason } from '@open-design/contracts/analytics';
import { KNOWN_PROVIDERS } from '../../state/config';
import type { AppConfig } from '../../types';
import { byokProviderRequiresApiKey } from '../../utils/byokProvider';
import { blockingByokDraftIssues, validateByokDraft } from './validation';

export const BYOK_AGENT_UNAVAILABLE_MESSAGE =
  'BYOK API runs require the built-in agent (pi), which is unavailable. Restart Fantay or reinstall it, then rescan agents in Settings before retrying.';
export const BYOK_PROVIDER_REQUIRED_MESSAGE =
  'BYOK requires a provider, API key, and model. Complete BYOK settings before starting a run.';
export const BEDROCK_BYOK_UNSUPPORTED_MESSAGE =
  'AWS Bedrock BYOK chat requires AWS credential signing and is not supported by the current API-key proxy.';

type ByokPreflightConfig = Pick<
  AppConfig,
  'apiKey' | 'apiProtocol' | 'apiProviderBaseUrl' | 'baseUrl' | 'model'
>;

export function isSupportedByokChatProtocol(
  protocol: AppConfig['apiProtocol'],
): protocol is ByokChatProtocol {
  return (
    protocol === 'anthropic' ||
    protocol === 'openai' ||
    protocol === 'azure' ||
    protocol === 'google' ||
    protocol === 'ollama' ||
    protocol === 'senseaudio' ||
    protocol === 'aihubmix'
  );
}

export function byokProviderFromConfig(
  config: AppConfig,
): ByokChatProviderConfig | undefined {
  if (!isSupportedByokChatProtocol(config.apiProtocol)) return undefined;
  const selectedProvider = KNOWN_PROVIDERS.find(
    (provider) =>
      provider.protocol === config.apiProtocol &&
      provider.baseUrl === config.baseUrl &&
      (config.apiProviderBaseUrl == null || provider.baseUrl === config.apiProviderBaseUrl),
  );
  const model = config.model.trim();
  if (
    (byokProviderRequiresApiKey(config.apiProtocol, selectedProvider, config.baseUrl)
      && !config.apiKey.trim())
    || !model
    || model.toLowerCase() === 'default'
    || (config.apiProtocol === 'azure' && !config.baseUrl.trim())
  ) {
    return undefined;
  }
  return {
    protocol: config.apiProtocol,
    apiKey: config.apiKey.trim(),
    baseUrl: config.baseUrl.trim(),
    model,
    ...(config.apiProtocol === 'azure' && config.apiVersion?.trim()
      ? { apiVersion: config.apiVersion.trim() }
      : {}),
    ...(config.apiProtocol === 'azure' && typeof config.reasoningModel === 'boolean'
      ? { reasoningModel: config.reasoningModel }
      : {}),
    requiresApiKey: byokProviderRequiresApiKey(
      config.apiProtocol,
      selectedProvider,
      config.baseUrl,
    ),
  };
}

export function byokPreflightBlockReason(
  config: ByokPreflightConfig,
): TrackingByokPreflightBlockReason | null {
  const protocol = config.apiProtocol ?? 'anthropic';
  const selectedProvider = KNOWN_PROVIDERS.find(
    (provider) =>
      provider.protocol === protocol &&
      provider.baseUrl === config.baseUrl &&
      (config.apiProviderBaseUrl == null || provider.baseUrl === config.apiProviderBaseUrl),
  );
  const validation = validateByokDraft(
    protocol,
    {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    },
    {
      requiresApiKey: byokProviderRequiresApiKey(
        protocol,
        selectedProvider,
        config.baseUrl,
      ),
    },
  );
  const missingReasons = new Set<TrackingByokPreflightBlockReason>();
  const invalidReasons = new Set<TrackingByokPreflightBlockReason>();
  for (const issue of blockingByokDraftIssues(validation)) {
    if (issue.field === 'api_key') {
      if (issue.code === 'api_key_required') {
        missingReasons.add('api_key_required');
      } else {
        invalidReasons.add('api_key_invalid');
      }
    } else if (issue.field === 'base_url') {
      if (issue.code === 'base_url_required') {
        missingReasons.add('base_url_required');
      } else {
        invalidReasons.add('base_url_invalid');
      }
    } else if (issue.field === 'model') {
      missingReasons.add('model_required');
    }
  }
  if (config.model.trim().toLowerCase() === 'default') {
    missingReasons.add('model_default');
  }
  // A missing activation field is the actionable run blocker even when a
  // second field also fails stricter Settings validation. This keeps the
  // event aligned with the run preflight instead of reporting, for example,
  // an unrelated key-shape warning alongside a missing model.
  const reasons = missingReasons.size > 0 ? missingReasons : invalidReasons;
  if (reasons.size === 0) return null;
  if (reasons.size > 1) return 'multiple';
  return reasons.values().next().value ?? 'config_invalid';
}
