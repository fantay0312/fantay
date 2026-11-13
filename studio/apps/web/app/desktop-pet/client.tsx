'use client';

import dynamic from 'next/dynamic';
import { DesktopAppGate } from '../../src/components/DesktopAppGate';

const DesktopPetSurface = dynamic(
  () => import('../../src/components/pet/DesktopPetSurface').then((m) => m.DesktopPetSurface),
  { ssr: false },
);

export function DesktopPetClient() {
  return <DesktopAppGate><DesktopPetSurface /></DesktopAppGate>;
}
