// SPDX-License-Identifier: AGPL-3.0-only
// Agent prose (spec §6.3): the upstream renderMarkdown inside `.prose-block`, wrapped in FxLegacy so the `.fx`
// preflight does not strip list bullets and heading sizes. Links never navigate the app: http(s)/mailto open in
// the system browser, everything else is swallowed. Images are never fetched (model and channel text is
// untrusted); they render as a "Image · host" link that goes through the same handler. `styles.markdown` tunes
// the upstream code block for the PA column (the global `code` rule would otherwise paint every code line).
import { useCallback, useMemo, type MouseEvent } from 'react';
import { Image as ImageIcon } from 'lucide-react';

import { useT } from '../../i18n';
import { openExternalUrl } from '../../providers/registry';
import { renderMarkdown } from '../../runtime/markdown';
import { FxLegacy, Icon, cn } from '../ui';
import styles from './PaConversation.module.css';

const EXTERNAL_HREF = /^(https?:|mailto:)/i;

function imageHost(src: string): string {
  try {
    const url = new URL(src, 'http://local.invalid');
    if (url.protocol === 'data:' || url.protocol === 'blob:') return url.protocol.slice(0, -1);
    return url.host === 'local.invalid' ? url.pathname.split('/').filter(Boolean).pop() ?? src : url.host;
  } catch {
    return src.slice(0, 40);
  }
}

export function PaMarkdown({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const onLinkClick = useCallback((href: string, event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (EXTERNAL_HREF.test(href)) void openExternalUrl(href);
  }, []);
  const content = useMemo(
    () =>
      renderMarkdown(text, {
        onLinkClick,
        images: 'link',
        imageLinkLabel: ({ src }) => (
          <span className={styles.imageLink}>
            <Icon icon={ImageIcon} size={13} />
            {t('pa.chat.image', { host: imageHost(src) })}
          </span>
        ),
      }),
    [text, onLinkClick, t],
  );
  return (
    <FxLegacy>
      <div className={cn('prose-block', styles.markdown, className)}>{content}</div>
    </FxLegacy>
  );
}
