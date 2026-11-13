'use client';
/* SPDX-License-Identifier: AGPL-3.0-only */

import dynamic from 'next/dynamic';

const ChatLab = dynamic(
  () => import('../../../src/fantay/chat-lab/ChatLab').then((m) => m.ChatLab),
  { ssr: false },
);

export function ChatLabClient() {
  return <ChatLab />;
}
