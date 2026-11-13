'use client';
/* SPDX-License-Identifier: Apache-2.0 */

import dynamic from 'next/dynamic';

// Client-only gallery (B2): Radix portals, toasts and theme state never render on the server,
// so the static export carries only this shell (precedent: app/desktop-pet).
const FantayUiGallery = dynamic(
  () => import('../../src/fantay/ui/gallery/Gallery').then((m) => m.FantayUiGallery),
  { ssr: false },
);

export function FantayUiGalleryClient() {
  return <FantayUiGallery />;
}
