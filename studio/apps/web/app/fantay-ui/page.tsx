/* SPDX-License-Identifier: Apache-2.0 */
import type { Metadata } from 'next';

import { FantayUiGalleryClient } from './client';

// The primitives gallery (spec 01 §4.6): shipped in every build, linked from nowhere, not indexed.
export const metadata: Metadata = {
  title: 'Fantay UI',
  robots: { index: false },
};

export default function FantayUiPage() {
  return <FantayUiGalleryClient />;
}
