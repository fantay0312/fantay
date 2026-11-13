'use client';
/* SPDX-License-Identifier: AGPL-3.0-only */

import dynamic from 'next/dynamic';

const PaLab = dynamic(
  () => import('../../../src/fantay/pa/lab/PaLab').then((m) => m.PaLab),
  { ssr: false },
);

export function PaLabClient() {
  return <PaLab />;
}
