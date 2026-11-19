/**
 * 吉祥物在对话里的三个位置,角色对应 Claude 图标在对话里的用法:
 *
 *   空对话   ChatEmptyMascot    大一点,眼睛跟着指针,配一句问候
 *   加载会话 ChatLoadingMascot  小尺寸工作态
 *   一轮末尾 TurnMascot         这一轮**唯一**的吉祥物,跟在内容后面:在跑时工作,
 *                               跑完跳一下停在原地,下一轮开始时随 `isLast` 交给新消息
 *
 * 每轮只留一个,所以壳头不再放球:壳头的「进行中」只说状态,动起来的是末尾这一个。
 * 跑着和停着是**同一个元素、同一个高度**,状态切换不会让贴底滚动跳一下。
 * 它是装饰,状态由旁边的文字表达,所以对读屏隐身;配色是品牌色,不走 `--chat-*`。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useT } from '../../i18n';
import { useMarkdownFocus } from '../workspace/use-markdown-focus';
import { FantayMascot } from '../../fantay/brand/FantayMascot';
import styles from './ChatMascot.module.css';

/** 给 `.chat-empty-wrap` 用:全局样式把它钉在顶部,吉祥物这一档要在流水里垂直居中。 */
export const chatEmptyCentered = styles.centered;

export function ChatEmptyMascot(): ReactElement {
  const t = useT();
  return (
    <div className={styles.empty} data-testid="chat-empty-mascot">
      <FantayMascot className={styles.mascotStage} tracking appear interactive />
      <p className={styles.greeting}>{t('fantay.chat.emptyGreeting')}</p>
    </div>
  );
}

export function ChatLoadingMascot(): ReactElement {
  return (
    <span className={styles.loading} aria-hidden>
      <FantayMascot size={28} mood="working" />
    </span>
  );
}

/** 内容一次性挪动超过这么多,吉祥物才滑过去;逐行长高的小位移照常跟随,不加动画 */
const MASCOT_GLIDE_MIN_PX = 12;

export function TurnMascot({ streaming }: { streaming: boolean }): ReactElement {
  const writing = useMarkdownFocus();
  const [pulse, setPulse] = useState(0);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) setPulse((current) => current + 1);
    wasStreaming.current = streaming;
  }, [streaming]);
  /*
   * Fantay 2026-11-08:一轮收尾时页脚挂上来、执行记录收起,吉祥物原来跟着硬跳几十像素。
   * 看着这条消息的尺寸变化(ResizeObserver 在布局之后、绘制之前回调),位置一次挪得多就
   * 从旧位置滑到新位置(FLIP,360ms quint);位置量的是相对消息顶部,滚动不算挪动。
   */
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const root = el?.closest('[data-assistant-message-id]') ?? el?.parentElement;
    if (!el || !root || typeof ResizeObserver === 'undefined') return;
    const offset = (): number => el.getBoundingClientRect().top - root.getBoundingClientRect().top;
    let last = offset();
    const observer = new ResizeObserver(() => {
      const next = offset();
      const delta = last - next;
      last = next;
      if (Math.abs(delta) < MASCOT_GLIDE_MIN_PX || typeof el.animate !== 'function') return;
      if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      el.animate(
        [{ transform: `translateY(${Math.round(delta)}px)` }, { transform: 'none' }],
        { duration: 360, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      );
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={styles.turn} data-testid="chat-turn-mascot" data-state={streaming ? 'working' : 'resting'} aria-hidden>
      <FantayMascot size={28} mood={streaming ? 'working' : 'idle'} paused={writing && !streaming} pulse={pulse} />
    </div>
  );
}
