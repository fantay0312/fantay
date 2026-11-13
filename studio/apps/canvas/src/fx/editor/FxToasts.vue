<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/** Editor toasts (toasts.ts) with the vendored AppToast, top centre. */
import { ToastProvider, ToastViewport } from 'reka-ui';

import AppToast from '@/components/ui/feedback/AppToast.vue';

import { useI18n } from '../engine/op';
import { dismissToast, useToasts } from './toasts';

const toasts = useToasts();
const { common } = useI18n();
</script>

<template>
  <ToastProvider swipe-direction="up">
    <AppToast
      v-for="toast in toasts"
      :key="toast.id"
      :message="toast.message"
      :variant="toast.variant"
      :count="toast.count"
      :duration="toast.duration"
      :copyable="toast.variant !== 'default'"
      :copy-label="common.copyMessage"
      :copied-label="common.copiedExclamation"
      :close-label="common.close"
      @close="dismissToast(toast.id)"
    />
    <ToastViewport class="fixed top-2 left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-1.5 outline-none" />
  </ToastProvider>
</template>
