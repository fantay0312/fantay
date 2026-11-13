/* SPDX-License-Identifier: AGPL-3.0-only */
import type { Metadata } from 'next';

import { ChatLabClient } from './client';

// Fantay chat motion bench: shipped with the gallery, linked from nowhere, not indexed.
export const metadata: Metadata = {
  title: 'Fantay chat lab',
  robots: { index: false },
};

export default function ChatLabPage() {
  return <ChatLabClient />;
}
