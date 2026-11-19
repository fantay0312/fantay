// SPDX-License-Identifier: Apache-2.0
// Write security gate for Fantay Memory Center, PA memories, and Studio markdown memories.
// Blocks private keys, API credentials/tokens, and prompt-injection control overrides prior to persistence.

import { PaError } from "../../storage/personal-agent-store.js";

export interface MemorySecurityRule {
  id: string;
  kind: "secret" | "prompt_injection";
  pattern: RegExp;
  label: string;
}

const SECURITY_RULES: readonly MemorySecurityRule[] = [
  {
    id: "pem_private_key",
    kind: "secret",
    pattern: /-----BEGIN\s+[A-Z0-9 ]*PRIVATE\s+KEY-----/i,
    label: "PEM 私钥块",
  },
  {
    id: "openai_or_anthropic_sk",
    kind: "secret",
    pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
    label: "API 密钥 (sk-*)",
  },
  {
    id: "github_token",
    kind: "secret",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    label: "GitHub 访问令牌",
  },
  {
    id: "aws_access_key",
    kind: "secret",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    label: "AWS Access Key ID",
  },
  {
    id: "slack_token",
    kind: "secret",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    label: "Slack API 令牌",
  },
  {
    id: "google_api_key",
    kind: "secret",
    pattern: /\bAIza[0-9A-Za-z_-]{32,}\b/,
    label: "Google API Key",
  },
  {
    id: "bearer_jwt_or_secret",
    kind: "secret",
    pattern: /\bBearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    label: "Bearer JWT 令牌",
  },
  {
    id: "chatml_system_override",
    kind: "prompt_injection",
    pattern: /<\|im_start\|>\s*(?:system|developer)\b/i,
    label: "ChatML 系统控制标记注入",
  },
  {
    id: "llama_inst_sys_override",
    kind: "prompt_injection",
    pattern: /\[INST\]\s*<<SYS>>|<\/SYS>>/i,
    label: "系统指令边界注入",
  },
  {
    id: "prompt_injection_ignore_all",
    kind: "prompt_injection",
    pattern: /(?:^|\n)\s*(?:IGNORE|DISREGARD|FORGET)\s+(?:ALL\s+)?(?:PREVIOUS|PRIOR|SYSTEM)\s+INSTRUCTIONS\b/i,
    label: "覆盖系统指令的提示词注入载荷",
  },
];

let inProcessBlockedWrites = 0;
const blockListeners = new Set<(ruleId: string, kind: "secret" | "prompt_injection") => void>();

export function onMemoryWriteBlocked(
  listener: (ruleId: string, kind: "secret" | "prompt_injection") => void,
): () => void {
  blockListeners.add(listener);
  return () => blockListeners.delete(listener);
}

export function getInProcessBlockedWriteCount(): number {
  return inProcessBlockedWrites;
}

export type MemoryWriteSecurityVerdict =
  | { ok: true }
  | {
      ok: false;
      kind: "secret" | "prompt_injection";
      matchedRule: string;
      label: string;
      reason: string;
    };

export function inspectMemoryWriteSecurity(text: string): MemoryWriteSecurityVerdict {
  const normalized = String(text ?? "");
  if (!normalized) return { ok: true };
  for (const rule of SECURITY_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        ok: false,
        kind: rule.kind,
        matchedRule: rule.id,
        label: rule.label,
        reason: `记忆写入被安全门禁拦截：检测到${rule.label}（规则 ${rule.id}）`,
      };
    }
  }
  return { ok: true };
}

export function assertSafeMemoryWrite(text: string): void {
  const verdict = inspectMemoryWriteSecurity(text);
  if (verdict.ok) return;
  inProcessBlockedWrites += 1;
  for (const listener of blockListeners) {
    try {
      listener(verdict.matchedRule, verdict.kind);
    } catch {
      // Telemetry listeners must never mask security enforcement.
    }
  }
  throw new PaError(verdict.reason, 400, "PA_MEMORY_SECRET_BLOCKED");
}
