// SPDX-License-Identifier: AGPL-3.0-only
// Prompt template summaries for the library popover (spec 05 §7): `GET /api/prompt-templates` once per
// session (module cache); a failed read is not cached, so "retry" fetches again.
import { useCallback, useEffect, useState } from 'react';

import { fetchPromptTemplates } from '../../../providers/registry';
import type { PromptTemplateSummary } from '../../../types';

export interface PromptTemplatesResult {
  ok: boolean;
  templates: PromptTemplateSummary[];
}

let cached: Promise<PromptTemplatesResult> | null = null;
let resolved: PromptTemplatesResult | null = null;

/** The session's template list; `force` drops a cached result first. */
export function loadPromptTemplates(force = false): Promise<PromptTemplatesResult> {
  if (force) {
    cached = null;
    resolved = null;
  }
  if (!cached) {
    let ok = true;
    cached = fetchPromptTemplates({ onReadResult: (success) => (ok = success) })
      .then((templates) => ({ ok: ok && Array.isArray(templates), templates: Array.isArray(templates) ? templates : [] }))
      .catch(() => ({ ok: false, templates: [] }))
      .then((result) => {
        if (result.ok) resolved = result;
        else cached = null;
        return result;
      });
  }
  return cached;
}

/** The cached summary of a template id (null until the list loaded). */
export function cachedPromptTemplate(id: string): PromptTemplateSummary | null {
  return resolved?.templates.find((template) => template.id === id) ?? null;
}

export type PromptTemplatesStatus = 'idle' | 'loading' | 'ready' | 'error';

export function usePromptTemplates(enabled: boolean): {
  status: PromptTemplatesStatus;
  templates: PromptTemplateSummary[];
  retry(): void;
} {
  const [state, setState] = useState<{ status: PromptTemplatesStatus; templates: PromptTemplateSummary[] }>(() =>
    resolved ? { status: 'ready', templates: resolved.templates } : { status: 'idle', templates: [] },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    if (resolved && attempt === 0) {
      setState({ status: 'ready', templates: resolved.templates });
      return undefined;
    }
    setState((current) => ({ status: 'loading', templates: current.templates }));
    void loadPromptTemplates(attempt > 0).then((result) => {
      if (!alive) return;
      setState(result.ok ? { status: 'ready', templates: result.templates } : { status: 'error', templates: [] });
    });
    return () => {
      alive = false;
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { status: state.status, templates: state.templates, retry };
}

export function resetPromptTemplatesForTests(): void {
  cached = null;
  resolved = null;
}
