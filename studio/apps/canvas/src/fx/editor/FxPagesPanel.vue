<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  SPDX-FileCopyrightText: 2026 Fantay contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/PagesPanel.vue
  Modified by Fantay: presence markers and design-check badges removed; the title comes from the
  Fantay messages.
-->
<script setup lang="ts">
import { templateRef } from '@vueuse/core';
import { ContextMenuContent, ContextMenuItem, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger } from 'reka-ui';
import { tv } from 'tailwind-variants';
import { ref, watch, type ComponentPublicInstance } from 'vue';

import IconButton from '@/components/ui/button/IconButton.vue';
import { useMenuUI } from '@/components/ui/menu/menu';
import MenuScrollArea from '@/components/ui/menu/MenuScrollArea.vue';
import pageListTheme from '@/theme/page-list';

import { t } from '../../host/i18n';
import { PageListRoot, useFlatReorderDrag, useI18n, useInlineRename, type SceneNode } from '../engine/op';

type PageItem = Pick<SceneNode, 'id' | 'name' | 'childIds'>;

interface PageActions {
  rename: (pageId: string, name: string) => void;
  move: (pageId: string, index: number) => void;
}

const { readOnly = false } = defineProps<{ readOnly?: boolean }>();

const pageInput = templateRef<HTMLInputElement>('pageInput');
const rename = useInlineRename((id, name) => pageActions.value?.rename(id, name));
const { panels, pages: pageMessages } = useI18n();
const menuCls = useMenuUI({ content: 'min-w-36', item: 'justify-start gap-2' });
const pageListStyles = tv(pageListTheme);
const baseStyles = pageListStyles();

const pageActions = ref<Pick<PageActions, 'rename'> | null>(null);
const currentPages = ref<readonly PageItem[]>([]);
const currentMovePage = ref<PageActions['move'] | null>(null);
const pageReorder = useFlatReorderDrag<PageItem>({
  items: () => currentPages.value,
  onMove: (pageId, index) => currentMovePage.value?.(pageId, index),
});

watch(pageInput, (input) => {
  if (input) void rename.focusInput(input);
});

function startRename(page: PageItem, renamePage: (pageId: string, name: string) => void) {
  if (readOnly) return;
  pageActions.value = { rename: renamePage };
  rename.start(page.id, page.name);
}

function pageDropPosition(page: PageItem): 'before' | 'after' | undefined {
  if (pageReorder.instructionTargetId.value !== page.id) return undefined;
  if (pageReorder.instruction.value?.operation === 'reorder-before') return 'before';
  if (pageReorder.instruction.value?.operation === 'reorder-after') return 'after';
  return undefined;
}

function pageStyles(page: PageItem, currentPageId: string) {
  return pageListStyles({
    active: page.id === currentPageId,
    dragging: pageReorder.draggingId.value === page.id,
    dropPosition: pageDropPosition(page),
  });
}

function setupPageRowRef(value: Element | ComponentPublicInstance | null, page: PageItem, pages: readonly PageItem[], movePage: PageActions['move']) {
  currentPages.value = pages;
  currentMovePage.value = movePage;
  if (!readOnly) pageReorder.setupItem(value instanceof HTMLElement ? value : null, () => ({ id: page.id }));
}
</script>

<template>
  <PageListRoot v-slot="{ pages, currentPageId, isDivider, actions }">
    <div data-test-id="pages-panel" :class="baseStyles.panel()">
      <div :class="baseStyles.header()">
        <span data-test-id="pages-header" :class="baseStyles.title()">{{ t('designEditor.panel.pages') }}</span>
        <IconButton v-if="!readOnly" :label="panels.addPage" data-test-id="pages-add" @click="actions.add()">
          <icon-lucide-plus class="size-3.5" />
        </IconButton>
      </div>
      <div :class="baseStyles.body()">
        <div data-test-id="pages-scroll" :class="baseStyles.viewport()">
          <ContextMenuRoot v-for="page in pages" :key="page.id" :modal="false">
            <ContextMenuTrigger as-child :disabled="readOnly">
              <div
                data-test-id="pages-row"
                :ref="(value) => setupPageRowRef(value, page, pages, actions.move)"
                :class="pageStyles(page, currentPageId).row()"
                :data-page-id="page.id"
                :data-active="page.id === currentPageId || undefined"
                :data-dragging="pageReorder.draggingId.value === page.id || undefined"
                :data-drop-position="pageDropPosition(page)"
              >
                <div
                  v-if="pageDropPosition(page) === 'before'"
                  data-test-id="pages-drop-indicator"
                  :class="pageStyles(page, currentPageId).dropIndicator()"
                />
                <div v-if="rename.editingId.value === page.id" :class="pageStyles(page, currentPageId).renameRow()">
                  <icon-lucide-file :class="pageStyles(page, currentPageId).icon()" />
                  <input
                    ref="pageInput"
                    data-test-id="pages-item-input"
                    :aria-label="pageMessages.pageNameLabel"
                    :class="pageStyles(page, currentPageId).renameInput()"
                    :value="page.name"
                    @blur="rename.commit(page.id, $event)"
                    @keydown.stop="rename.onKeydown"
                  />
                </div>
                <div
                  v-else-if="isDivider(page)"
                  data-test-id="pages-divider"
                  :class="pageStyles(page, currentPageId).divider()"
                  @dblclick="startRename(page, actions.rename)"
                >
                  <div :class="pageStyles(page, currentPageId).dividerLine()" />
                </div>
                <button
                  v-else
                  type="button"
                  data-test-id="pages-item"
                  :class="pageStyles(page, currentPageId).item()"
                  @click="actions.switch(page.id)"
                  @dblclick="startRename(page, actions.rename)"
                >
                  <icon-lucide-file :class="pageStyles(page, currentPageId).icon()" />
                  <span :class="pageStyles(page, currentPageId).label()">{{ page.name }}</span>
                </button>
                <div
                  v-if="pageDropPosition(page) === 'after'"
                  data-test-id="pages-drop-indicator"
                  :class="pageStyles(page, currentPageId).dropIndicator()"
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuPortal>
              <ContextMenuContent :class="menuCls.content" :side-offset="2" align="start">
                <MenuScrollArea>
                  <ContextMenuItem data-test-id="pages-context-rename" :class="menuCls.item" @select="startRename(page, actions.rename)">
                    <icon-lucide-pencil :class="menuCls.icon" />
                    <span>{{ pageMessages.rename }}</span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    data-test-id="pages-context-delete"
                    :class="menuCls.item"
                    :disabled="pages.length <= 1"
                    @select="actions.delete(page.id)"
                  >
                    <icon-lucide-trash-2 :class="menuCls.icon" />
                    <span>{{ pageMessages.delete }}</span>
                  </ContextMenuItem>
                </MenuScrollArea>
              </ContextMenuContent>
            </ContextMenuPortal>
          </ContextMenuRoot>
        </div>
      </div>
    </div>
  </PageListRoot>
</template>
