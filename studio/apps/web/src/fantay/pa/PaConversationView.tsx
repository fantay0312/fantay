// SPDX-License-Identifier: AGPL-3.0-only
// One conversation (spec §6): header (52) → channel callout → transcript (the only scroller) → composer. With no
// conversation it shows the start state; before the first snapshot, three skeleton lines. The stale-poll callout
// is the root's (PersonalAgentWorkspace StaleBar), above this column.
import { useState } from 'react';
import { Info, PanelLeftOpen } from 'lucide-react';

import { useT } from '../../i18n';
import { Callout, Icon, IconButton, Skeleton } from '../ui';
import { PaChatHeader } from './PaChatHeader';
import { PaComposer } from './PaComposer';
import { PaEmptyChat } from './PaEmptyChat';
import { PaTranscript } from './PaTranscript';
import { platformName } from './PaTurnTail';
import { usePa } from './pa-context';
import { conversationKind } from './pa-model';
import { soulThemeAttrs, soulThemeStyle } from './soul/soul-theme';
import { conversationMode, resolveChatAppearance } from './soul/soul-model';
import styles from './PaConversation.module.css';

export function PaConversationView({ conversationId, active = true }: { conversationId: string | null; active?: boolean }) {
  const t = useT();
  const { index, data, layout, nav } = usePa();
  const [followNonce, setFollowNonce] = useState(0);
  const conversation = conversationId ? index.conversations.get(conversationId) ?? null : null;
  const narrow = layout.width < 900 ? '' : undefined;

  if (!data.snapshot && data.load === 'loading') {
    return (
      <div className={styles.view} data-testid="pa-conversation">
        <div className={styles.header} aria-hidden />
        <div className={styles.loading} data-narrow={narrow}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} shape="line" index={i} className={styles.loadingLine} />
          ))}
        </div>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className={styles.view} data-testid="pa-conversation">
        {layout.roster === 'sheet' ? (
          <header className={styles.header}>
            <IconButton size="sm" variant="quiet" aria-label={t('pa.roster.openList')} onClick={() => nav.openRosterSheet()}>
              <Icon icon={PanelLeftOpen} size="md" />
            </IconButton>
          </header>
        ) : null}
        <div className={styles.transcriptWrap}>
          <div className={styles.transcript}>
            <div className={styles.column} data-narrow={narrow}>
              <PaEmptyChat conversation={null} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const channel = conversationKind(conversation) === 'channel' ? index.channels.get(conversation.channelId ?? '') : undefined;
  // Companion chats carry the chat's theme on the whole column (header, transcript, the ground around the composer);
  // work chats keep the default skin (Soul UI spec §4.1, §8.4).
  const mode = conversationMode(index, conversation);
  const appearance = mode === 'companion' ? resolveChatAppearance(index, conversation) : null;

  return (
    <div
      className={styles.view}
      data-testid="pa-conversation"
      data-mode={mode}
      {...(appearance ? soulThemeAttrs(appearance) : {})}
      style={appearance ? soulThemeStyle(appearance) : undefined}
    >
      <PaChatHeader conversation={conversation} />
      {channel || conversationKind(conversation) === 'channel' ? (
        <div className={styles.calloutColumn} data-narrow={narrow}>
          <Callout tone="neutral" className={styles.channelCallout}>
            <Icon icon={Info} size={14} className={styles.channelCalloutIcon} />
            <span>
              {t('pa.chat.fromChannel', {
                platform: platformName(t, channel?.type),
                name: channel?.name ?? conversation.title,
              })}
            </span>
          </Callout>
        </div>
      ) : null}
      <PaTranscript conversation={conversation} mode={mode} followNonce={followNonce} />
      <PaComposer conversation={conversation} active={active} onSent={() => setFollowNonce((n) => n + 1)} />
    </div>
  );
}
