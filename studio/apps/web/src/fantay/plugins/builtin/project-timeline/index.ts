// SPDX-License-Identifier: AGPL-3.0-only
import { ListTree } from 'lucide-react';

import { icon } from '../../../ui';
import type { ToolPluginClientModule } from '../../types';
import { ProjectTimelinePage } from './ProjectTimelinePage';
import { TIMELINE_NAME } from './copy';

const timeline: ToolPluginClientModule = {
  name: 'project-timeline',
  inject: ['slots', 'locale'],
  apply(ctx) {
    ctx.locale.register('project-timeline', {
      zh: { title: TIMELINE_NAME.zh },
      en: { title: TIMELINE_NAME.en },
    });
    const t = ctx.locale.bind('project-timeline');
    ctx.slots.register(
      { name: 'fantay.sidebar.nav', id: 'timeline', order: 20, label: () => t('title'), icon: icon(ListTree) },
      ProjectTimelinePage,
    );
  },
};

export default timeline;
