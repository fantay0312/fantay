// SPDX-License-Identifier: AGPL-3.0-only
// Editor strings (spec 06 §9): the host passes every `designEditor.*` key of `en`, resolved in the active
// locale, to the editor in `init.messages` and in `locale` events. The editor has no catalog of its own.
import { DESIGN_BRIDGE_LIMITS } from '@open-design/contracts';

import { en } from '../../i18n/locales/en';
import type { Dict } from '../../i18n/types';

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

const DESIGN_EDITOR_MESSAGE_KEYS: readonly (keyof Dict)[] = (Object.keys(en) as (keyof Dict)[])
  .filter((key) => key.startsWith('designEditor.'))
  .slice(0, DESIGN_BRIDGE_LIMITS.maxMessageKeys);

export function designEditorMessageKeys(): readonly (keyof Dict)[] {
  return DESIGN_EDITOR_MESSAGE_KEYS;
}

export function designEditorMessages(t: Translate): Record<string, string> {
  const messages: Record<string, string> = {};
  for (const key of DESIGN_EDITOR_MESSAGE_KEYS) messages[key] = t(key);
  return messages;
}
