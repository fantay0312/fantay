import { Film } from 'lucide-react';

import { useT } from '../i18n';

/** The 视频与动画 mark on project cards, wearing the same film glyph as its sidebar row. */
export function MotionProjectTag() {
  const t = useT();
  return (
    <span className="design-card-tag tag-media">
      <Film size={12} aria-hidden className="design-card-tag__icon" />
      {t('fantayShell.sidebar.motion')}
    </span>
  );
}
