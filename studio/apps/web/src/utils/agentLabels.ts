const AGENT_LABELS: Record<string, string> = {
  aider: 'Aider',
  amp: 'Amp',
  claude: 'Claude',
  codex: 'Codex',
  devin: 'Devin',
  gemini: 'Gemini',
  kimi: 'Kimi CLI',
  kiro: 'Kiro',
  opencode: 'OpenCode',
  // The built-in BYOK agent (runs on pi). Its legacy id `byok-opencode` and saved
  // names like `BYOK OpenCode` map here instead of falling through to the
  // `opencode` substring match (OpenCode label and logo).
  byok: 'BYOK',
  amr: 'TokenToSea',
  tokentosea: 'TokenToSea',
  'cursor-agent': 'Cursor',
  cursor: 'Cursor',
  qwen: 'Qwen',
  qoder: 'Qoder',
  copilot: 'Copilot',
  'deepseek-harness': 'DeepSeek Harness',
  deepseek: 'DeepSeek',
  antigravity: 'Antigravity',
  'anthropic-api': 'Anthropic API via BYOK',
  'openai-api': 'OpenAI API via BYOK',
  'azure-openai-api': 'Azure OpenAI via BYOK',
  'google-gemini-api': 'Google Gemini via BYOK',
  'ollama-cloud-api': 'Ollama Cloud API via BYOK',
  'senseaudio-api': 'SenseAudio API via BYOK',
  'aihubmix-api': 'AIHubMix API via BYOK',
  'bedrock-api': 'AWS Bedrock via BYOK',
};

const AGENT_ALIASES: Record<string, string> = {
  'amp cli': 'amp',
  'claude code': 'claude',
  'codex cli': 'codex',
  'devin for terminal': 'devin',
  'gemini cli': 'gemini',
  'kiro cli': 'kiro',
  'kiro-cli': 'kiro',
  'cursor agent': 'cursor-agent',
  'qwen code': 'qwen',
  'qoder cli': 'qoder',
  'qodercli': 'qoder',
  'github copilot cli': 'copilot',
  'deepseek tui': 'deepseek',
  'deepseek-tui': 'deepseek',
  'deepseek harness': 'deepseek-harness',
  'aider cli': 'aider',
  'aider chat': 'aider',
  agy: 'antigravity',
  // Conversations saved while the BYOK agent was still named after OpenCode.
  'byok-opencode': 'byok',
  'byok opencode': 'byok',
};

export function agentDisplayName(
  agentId?: string | null,
  fallbackName?: string | null,
): string | null {
  for (const raw of [agentId, fallbackName]) {
    const known = knownAgentLabel(raw);
    if (known) return known;
  }
  for (const raw of [fallbackName, agentId]) {
    const fallback = safeFallbackLabel(raw);
    if (fallback) return fallback;
  }
  return null;
}

// Canonical icon id for `AgentIcon` (maps to `apps/web/public/agent-icons/`).
// Returns the agent id whose brand asset should render; falls back to a
// normalized basename so `AgentIcon`'s letter fallback still reads sensibly.
export function agentIconId(
  agentId?: string | null,
  fallbackName?: string | null,
): string {
  for (const raw of [agentId, fallbackName]) {
    if (!raw) continue;
    const base = raw.split(' · ')[0]?.trim() || raw;
    const key = normalizeKey(base);
    const alias = AGENT_ALIASES[key] ?? key;
    if (AGENT_LABELS[alias]) return alias;
    if (alias.includes('cursor-agent')) return 'cursor-agent';
    if (isByokAgentKey(alias)) return 'byok';
    for (const id of Object.keys(AGENT_LABELS)) {
      if (alias.includes(id)) return id;
    }
  }
  const fallback = normalizeKey(agentId ?? fallbackName ?? '');
  return fallback || 'claude';
}

export function exactAgentDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = normalizeKey(raw);
  const alias = AGENT_ALIASES[key] ?? key;
  return AGENT_LABELS[alias] ?? null;
}

export function agentModelDisplayName(
  agentId?: string | null,
  fallbackName?: string | null,
  model?: string | null,
): string | undefined {
  const label = agentDisplayName(agentId, fallbackName) ?? undefined;
  const modelId = displayableModelId(model);
  if (!modelId) return label;
  return label ? `${label} · ${modelId}` : modelId;
}

function knownAgentLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = normalizeKey(raw);
  const alias = AGENT_ALIASES[key] ?? key;
  const direct = AGENT_LABELS[alias];
  if (direct) return direct;
  if (key.includes('cursor-agent')) return 'Cursor';
  if (key.includes('copilot')) return 'Copilot';
  if (isByokAgentKey(key)) return AGENT_LABELS.byok ?? null;
  for (const [agentId, label] of Object.entries(AGENT_LABELS)) {
    if (key.includes(agentId)) return label;
  }
  return null;
}

/** `byok`, its legacy id `byok-opencode`, or a saved name like `BYOK OpenCode · model`. */
function isByokAgentKey(key: string): boolean {
  return key === 'byok' || key.includes('byok-opencode') || key.includes('byok opencode');
}

function safeFallbackLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

function displayableModelId(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === 'default') return null;
  return trimmed;
}

function normalizeKey(raw: string): string {
  const basename = raw.trim().split(/[\\/]/).pop() ?? raw.trim();
  return basename
    .replace(/\.(cmd|exe|bat)$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
