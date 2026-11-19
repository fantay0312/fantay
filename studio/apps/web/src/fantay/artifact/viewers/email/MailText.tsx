// SPDX-License-Identifier: AGPL-3.0-only
// A plain-text body in the reading column: the sender's line breaks kept, quoted messages quieter
// with one hairline per level, the line that introduces a quote and the signature quieter still.
// Web and mail addresses look like links and say where they go when pointed at or focused; pressing
// one hands it to the viewer (`onLink`), which copies it. Nothing here navigates.
'use client';

import { useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import styles from '../EmailViewer.module.css';
import { findAddresses, type MailTextNode } from './plain-text';

export interface MailTextProps {
  nodes: readonly MailTextNode[];
  label: string;
  onLink(address: string, element: Element): void;
  onHover(address: string | null): void;
}

function Words({ text, onLink, onHover }: { text: string } & Pick<MailTextProps, 'onLink' | 'onHover'>): JSX.Element {
  const runs = useMemo(() => findAddresses(text), [text]);
  return (
    <>
      {runs.map((run, index) => {
        if (run.kind === 'text') return run.text;
        const activate = (element: Element): void => onLink(run.text, element);
        return (
          <a
            // Runs are positional pieces of one line.
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            role="link"
            tabIndex={0}
            className={styles.textLink}
            data-mail-link={run.kind}
            onClick={(event) => {
              event.preventDefault();
              activate(event.currentTarget);
            }}
            onAuxClick={(event) => event.preventDefault()}
            onKeyDown={(event: ReactKeyboardEvent<HTMLAnchorElement>) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              activate(event.currentTarget);
            }}
            onMouseEnter={() => onHover(run.text)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(run.text)}
            onBlur={() => onHover(null)}
          >
            {run.text}
          </a>
        );
      })}
    </>
  );
}

function Nodes({ nodes, ...links }: { nodes: readonly MailTextNode[] } & Pick<MailTextProps, 'onLink' | 'onHover'>): JSX.Element {
  return (
    <>
      {nodes.map((node, index) =>
        node.kind === 'quote' ? (
          // eslint-disable-next-line react/no-array-index-key
          <blockquote key={index} className={styles.textQuote}>
            <Nodes nodes={node.children} {...links} />
          </blockquote>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <p key={index} className={styles.textLines} data-role={node.role}>
            <Words text={node.text} {...links} />
          </p>
        ),
      )}
    </>
  );
}

export function MailText({ nodes, label, onLink, onHover }: MailTextProps): JSX.Element {
  return (
    <article className={styles.text} aria-label={label} data-mail-body="text">
      <Nodes nodes={nodes} onLink={onLink} onHover={onHover} />
    </article>
  );
}
