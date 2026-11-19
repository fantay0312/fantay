// SPDX-License-Identifier: AGPL-3.0-only
// Roleplay text (Soul UI spec §4.4.5): narration and speech styled from `tokenizeRoleplay`, never by changing the
// stored text. `*动作*` loses its asterisks, full-width and CJK half-width brackets stay. Agent text that carries
// markdown (lists, tables, code, links, bold) keeps rendering through PaMarkdown (inside FxLegacy, images never
// fetched); its emphasis takes the action style. Imported card markup (`foldCardMarkup`) folds into one inert
// disclosure row. Owner text (`markdown={false}`) is shown as typed: tokens only, no markdown, no folding.
import { Fragment, useMemo, type ReactNode } from 'react';
import { foldCardMarkup, tokenizeRoleplay, type RoleplayToken } from '@open-design/contracts/soul';

import { cn } from '../../ui';
import { PaDisclosure } from '../PaDisclosure';
import { PaMarkdown } from '../PaMarkdown';
import styles from './SoulRoleplayText.module.css';

export interface SoulRoleplayTextProps {
  text: string;
  side: 'in' | 'out' | 'paper';
  markdown?: boolean; // default true; false for owner text
  markupLabel: string; // t('pa.soul.chat.markupFold')
  className?: string;
}

/* Text that needs the markdown renderer: a block marker at a line start, or inline code, bold, a link or a bare URL.
   Single-asterisk actions alone never send a reply down the markdown path. */
const MARKDOWN_BLOCK = /^ {0,3}(?:#{1,6}[ \t]|[-+*][ \t]|\d{1,9}[.)][ \t]|>|\||```|~~~|(?:[-*_][ \t]*){3,}$)/m;
const MARKDOWN_INLINE = /`|\*\*|__|\]\(|https?:\/\/|(?:^|[^\p{L}\p{N}_])_[^_\s][^_\n]*_(?![\p{L}\p{N}_])/u;

function needsMarkdown(text: string): boolean {
  return MARKDOWN_BLOCK.test(text) || MARKDOWN_INLINE.test(text);
}

/** Every token is an `action` or whitespace, and there is at least one action (a narration-only bubble). */
export function isNarrationOnly(text: string): boolean {
  let action = false;
  for (const token of tokenizeRoleplay(text)) {
    if (token.kind === 'action') action = true;
    else if (token.text.trim() !== '') return false;
  }
  return action;
}

function insideLinkText(before: string): boolean {
  const line = before.slice(before.lastIndexOf('\n') + 1);
  return line.lastIndexOf('[') > line.lastIndexOf(']');
}

/** Bracket actions become markdown emphasis, so the markdown path styles them like the plain path. A bracket that
 *  touches another asterisk, sits in link text or holds markdown characters is left alone. */
function emphasiseBracketActions(text: string): string {
  const tokens = tokenizeRoleplay(text);
  let out = '';
  tokens.forEach((token, index) => {
    const next = tokens[index + 1]?.text ?? '';
    const wrap =
      token.kind === 'action' &&
      !token.text.startsWith('*') &&
      !/[*_`[\]]/.test(token.text) &&
      !out.endsWith('*') &&
      !next.startsWith('*') &&
      !insideLinkText(out);
    out += wrap ? `*${token.text}*` : token.text;
  });
  return out;
}

function renderTokens(tokens: readonly RoleplayToken[]): ReactNode[] {
  return tokens.map((token, index) => {
    if (token.kind === 'action') {
      const starred = token.text.length > 1 && token.text.startsWith('*') && token.text.endsWith('*');
      return (
        <span key={index} data-kind="action" className={styles.action}>
          {starred ? token.text.slice(1, -1) : token.text}
        </span>
      );
    }
    if (token.kind === 'speech') {
      return (
        <span key={index} data-kind="speech">
          {token.text}
        </span>
      );
    }
    return <Fragment key={index}>{token.text}</Fragment>;
  });
}

/** Blank lines separate paragraphs; single line breaks stay as breaks. */
function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[^\S\n]*\n\s*/)
    .map((paragraph) => paragraph.replace(/^\n+|\s+$/g, ''))
    .filter((paragraph) => paragraph.trim() !== '');
}

function TextSegment({ text, markdown }: { text: string; markdown: boolean }) {
  const rich = markdown && needsMarkdown(text);
  const prepared = useMemo(() => (rich ? emphasiseBracketActions(text) : null), [rich, text]);
  const paragraphs = useMemo(() => (rich ? [] : paragraphsOf(text).map((paragraph) => tokenizeRoleplay(paragraph))), [rich, text]);
  if (prepared !== null) return <PaMarkdown text={prepared} className={styles.markdown} />;
  return (
    <>
      {paragraphs.map((tokens, index) => (
        <p key={index} className={styles.p}>
          {renderTokens(tokens)}
        </p>
      ))}
    </>
  );
}

export function SoulRoleplayText({ text, side, markdown = true, markupLabel, className }: SoulRoleplayTextProps) {
  const segments = useMemo(() => (markdown ? foldCardMarkup(text) : [{ kind: 'text' as const, text }]), [markdown, text]);
  return (
    <div data-slot="soul-text" data-side={side} className={cn(styles.root, className)}>
      {segments.map((segment, index) => {
        if (segment.text.trim() === '') return null;
        if (segment.kind === 'markup') {
          return (
            <PaDisclosure key={index} label={markupLabel} className={styles.markup}>
              <pre className={styles.markupBody}>{segment.text.trim()}</pre>
            </PaDisclosure>
          );
        }
        return <TextSegment key={index} text={segment.text} markdown={markdown} />;
      })}
    </div>
  );
}
