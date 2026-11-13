// SPDX-License-Identifier: AGPL-3.0-only
// 工具台 (Toolbox), the built-in tool plugin. It adds a sidebar page and declares the page's extension point,
// the `fantay.toolbox.tool` list slot, then registers its own three tools into that slot exactly as another
// plugin would:
//
//   ctx.slots.register(
//     { name: 'fantay.toolbox.tool', id: 'uuid', order: 40, label: () => 'UUID', description: () => '…', icon: Glyph },
//     UuidPanel, // receives ToolboxToolProps
//   );
//
// All of its text comes from its own dictionary (`toolbox` namespace), in Chinese and English.
import { Binary, Braces, Clock } from 'lucide-react';

import { icon } from '../../../ui';
import type { ToolPluginClientModule } from '../../types';
import { TOOLBOX_DICTIONARY, type Translate } from './dictionary';
import { TOOLBOX_TOOL_SLOT, ToolboxNavIcon, createToolboxPage } from './ToolboxPage';
import { createEncodeTool } from './tools/EncodeTool';
import { createJsonTool } from './tools/JsonTool';
import { createTimestampTool } from './tools/TimestampTool';

const JsonGlyph = icon(Braces);
const EncodeGlyph = icon(Binary);
const TimestampGlyph = icon(Clock);

const toolbox: ToolPluginClientModule = {
  name: 'toolbox',
  inject: ['slots', 'locale'],
  apply(ctx) {
    ctx.locale.register('toolbox', TOOLBOX_DICTIONARY);
    const t: Translate = ctx.locale.bind('toolbox');

    ctx.slots.register(
      {
        name: 'fantay.sidebar.nav',
        id: 'toolbox',
        order: 10,
        label: () => t('title'),
        icon: ToolboxNavIcon,
        children: { [TOOLBOX_TOOL_SLOT]: { kind: 'list', scope: 'root' } },
      },
      createToolboxPage(t),
    );

    ctx.slots.inject(TOOLBOX_TOOL_SLOT, () => [
      ctx.slots.register(
        {
          name: TOOLBOX_TOOL_SLOT,
          id: 'json',
          order: 10,
          label: () => t('json.label'),
          description: () => t('json.description'),
          icon: JsonGlyph,
        },
        createJsonTool(t),
      ),
      ctx.slots.register(
        {
          name: TOOLBOX_TOOL_SLOT,
          id: 'encode',
          order: 20,
          label: () => t('encode.label'),
          description: () => t('encode.description'),
          icon: EncodeGlyph,
        },
        createEncodeTool(t),
      ),
      ctx.slots.register(
        {
          name: TOOLBOX_TOOL_SLOT,
          id: 'timestamp',
          order: 30,
          label: () => t('time.label'),
          description: () => t('time.description'),
          icon: TimestampGlyph,
        },
        createTimestampTool(t),
      ),
    ]);
  },
};

export default toolbox;
