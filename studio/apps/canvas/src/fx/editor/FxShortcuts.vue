<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/** Renderless: installs the editor's keyboard shortcuts (shortcuts.ts) inside the provided editor. */
import { onBeforeUnmount, onMounted } from 'vue';

import { useEditorStore } from '@/app/editor/active-store';

import { t } from '../../host/i18n';
import { useEditorCommands } from '../engine/op';
import { getEditorSession } from './session';
import { installShortcuts } from './shortcuts';
import { editorUi, setPanelsVisible } from './ui-state';

const store = useEditorStore();
const { runCommand, setOpacityTarget } = useEditorCommands();
let uninstall: (() => void) | null = null;

onMounted(() => {
  uninstall = installShortcuts({
    store,
    runCommand,
    setOpacityTarget,
    isReadOnly: () => editorUi.readOnly,
    isOpDocument: () => editorUi.format === 'op',
    saveNow: () => void getEditorSession()?.saveNow(),
    toggleUi: () => setPanelsVisible(!editorUi.panelsVisible),
    forwardShortcuts: () => getEditorSession()?.forwardShortcuts() ?? [],
    closeOnEscape: () => getEditorSession()?.closeOnEscape() ?? false,
    requestClose: () => getEditorSession()?.requestClose(),
    forwardShortcut: (combo) => getEditorSession()?.forwardShortcut(combo),
    clipboardBlockedMessage: () => t('designEditor.toast.clipboardBlocked'),
  });
});

onBeforeUnmount(() => {
  uninstall?.();
  uninstall = null;
});
</script>

<template>
  <slot />
</template>
