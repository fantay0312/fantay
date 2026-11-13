// SPDX-License-Identifier: AGPL-3.0-only
// Lucide glyph per node kind (spec 03 §6.8 "kinds"); stroke 1.5 everywhere (D1).
import {
  AppWindow,
  Clapperboard,
  Film,
  Globe,
  Group,
  Image as ImageIcon,
  Music,
  PenTool,
  Shapes,
  Sparkles,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';

import type { BoardNodeKind } from '../../model/types';

export const KIND_ICONS: Readonly<Record<BoardNodeKind, LucideIcon>> = {
  frame: AppWindow,
  web: Globe,
  image: ImageIcon,
  video: Film,
  audio: Music,
  note: StickyNote,
  shape: Shapes,
  group: Group,
  generator: Sparkles,
  design: PenTool,
  motion: Clapperboard,
};

export const ICON_STROKE = 1.5;
