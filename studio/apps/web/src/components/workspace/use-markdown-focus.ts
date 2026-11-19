// Adjacent decorative animations can rest while the document or its mode bar owns input.
import { useSyncExternalStore } from 'react';

function subscribe(notify: () => void) {
  const afterFocusChange = () => queueMicrotask(notify);
  document.addEventListener('focusin', notify);
  document.addEventListener('focusout', afterFocusChange);
  return () => {
    document.removeEventListener('focusin', notify);
    document.removeEventListener('focusout', afterFocusChange);
  };
}

export function useMarkdownFocus(): boolean {
  return useSyncExternalStore(subscribe, () => !!document.activeElement?.closest('[data-markdown-document]'), () => false);
}
