// SPDX-License-Identifier: AGPL-3.0-only
// The Fantay entry's icon: the zero-JS still, swapped for the live working mascot while Fantay has running work
// (held 600 ms so a short task does not flicker). Spec §5.3.
import { useDwell } from '../../components/chat/useDwell';
import { FantayMascot, FantayMascotStill } from '../brand/FantayMascot';
import { usePaActivity } from './pa-activity';

export function PaNavIcon({ size }: { size: 16 | 20 }) {
  const activity = usePaActivity();
  const working = useDwell(activity.running > 0, 600);
  return working ? <FantayMascot size={size} mood="working" /> : <FantayMascotStill size={size} />;
}
