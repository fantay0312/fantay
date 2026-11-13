/** Execution-shell prose: shared od-card decoding plus Markdown code preservation. */
import { Fragment, type ReactElement } from 'react';
import { splitShellCards } from '../../runtime/chat/split-shell-cards';

import { OdCardView, type BrandBrowserAssistConfirm } from '../OdCard';
import { SayText } from './primitives/SayText';

export interface SayBlockProps {
  text: string;
  /** 这一段是**这一刻还在往里写的那一段**吗 —— 语义与 `SayText.live` 相同。 */
  live?: boolean;
  /** Compatibility scope forwarded from existing shell callers; retired rules no longer use it. */
  instanceScope?: string;
  onBrandBrowserAssistConfirm?: BrandBrowserAssistConfirm;
}

export function SayBlock({
  text,
  live,
  instanceScope,
  onBrandBrowserAssistConfirm,
}: SayBlockProps): ReactElement | null {
  const split = splitShellCards(text, Boolean(live));
  /*
   * 没有卡片时也走下面那条带 key 的数组(Fantay 2026-11-08)。原来这一档直接返回一只裸
   * `<SayText>`,卡片一闭合就换成 Fragment 数组 —— 树形变了,React 卸掉旧的 SayText 再挂
   * 一只新的,已经读完的那句叙述被当成新到的字从头化开一遍。两档同形,卡片前那段文字
   * 始终是 `text-0` 那一只实例。
   */
  const segments = split.some((seg) => seg.kind === 'card')
    ? split
    : [{ kind: 'text' as const, text: split.map((seg) => seg.kind === 'text' ? seg.text : '').join('') }];

  /* 逐字化开只发给**最后**那一段散文 —— 前面几段被卡片隔开,早就写完了 */
  let lastTextIndex = -1;
  segments.forEach((seg, i) => {
    if (seg.kind === 'text' && seg.text.trim()) lastTextIndex = i;
  });

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'card') {
          return (
            <OdCardView
              key={`card-${i}`}
              card={seg.card}
              instanceScope={instanceScope ? `${instanceScope}:${i}` : undefined}
              onBrandBrowserAssistConfirm={onBrandBrowserAssistConfirm}
            />
          );
        }
        if (!seg.text.trim()) return null;
        return (
          <Fragment key={`text-${i}`}>
            <SayText text={seg.text} live={live && i === lastTextIndex} />
          </Fragment>
        );
      })}
    </>
  );
}
