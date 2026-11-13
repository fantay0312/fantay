<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TokenToSeaSharePanel } from '../../web/src/components/share/TokenToSeaSharePanel';
const props = defineProps<{ canvas: { id: string; sha256: string; html: string } }>();
const host = ref<HTMLElement | null>(null);
let root: Root | undefined;
onMounted(() => { root = createRoot(host.value!); root.render(createElement(TokenToSeaSharePanel, { canvas: props.canvas })); });
onBeforeUnmount(() => root?.unmount());
</script>
<template><div ref="host"></div></template>
