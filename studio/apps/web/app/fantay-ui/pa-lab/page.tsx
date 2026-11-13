/* SPDX-License-Identifier: AGPL-3.0-only */
import type { Metadata } from 'next';

import { PaLabClient } from './client';

// Fantay workspace bench: shipped with the gallery, linked from nowhere, not indexed.
export const metadata: Metadata = {
  title: 'Fantay PA lab',
  robots: { index: false },
};

export default function PaLabPage() {
  return <PaLabClient />;
}
