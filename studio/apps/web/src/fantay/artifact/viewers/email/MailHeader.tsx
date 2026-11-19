// SPDX-License-Identifier: AGPL-3.0-only
// The header of a message, set as type rather than as a form: the subject large, then who sent it
// (the name in ink, the address quieter, so the real address is always in view), the date in the
// reader's locale on the same line, then who else it went to. A long list shows its first few people
// and a quiet "N more" that opens the rest in place. Reply-to appears only when replies go somewhere
// other than the sender. No avatars and no coloured chips: the names are the content.
'use client';

import { Fragment } from 'react';

import { useT } from '../../../../i18n';
import { Button } from '../../../ui';
import styles from '../EmailViewer.module.css';
import { formatMailDate, personName, personTitle, sameMailbox } from './mail-format';
import type { MailAddress, MailMessage } from './mail-types';

/** A list longer than this shows its first few people, then "N more". */
const LONG_LIST = 4;
const SHOWN_OF_LONG = 3;

interface PeopleRow {
  id: 'to' | 'cc' | 'bcc' | 'replyTo';
  label: string;
  people: MailAddress[];
}

export interface MailHeaderProps {
  message: MailMessage;
  locale: string;
  /** Rows the reader opened in full. */
  expanded: readonly string[];
  onExpand(row: string, open: boolean): void;
}

function People({ row, open, onExpand }: { row: PeopleRow; open: boolean; onExpand(open: boolean): void }): JSX.Element {
  const t = useT();
  const long = row.people.length > LONG_LIST;
  const shown = long && !open ? row.people.slice(0, SHOWN_OF_LONG) : row.people;
  const hidden = row.people.length - shown.length;
  const separator = t('artifact.email.separator');
  return (
    <div className={styles.peopleRow} data-mail-people={row.id}>
      <dt className={styles.peopleLabel}>{row.label}</dt>
      <dd className={styles.peopleList}>
        {shown.map((person, index) => (
          // People repeat (one address twice in a field); the position is the identity.
          // eslint-disable-next-line react/no-array-index-key
          <Fragment key={index}>
            {index > 0 ? <span className={styles.peopleSeparator}>{separator}</span> : null}
            <span className={styles.person} title={personTitle(person)}>
              {personName(person)}
            </span>
          </Fragment>
        ))}
        {long ? (
          <Button variant="link" size="sm" className={styles.peopleMore} aria-expanded={open} onClick={() => onExpand(!open)}>
            {open ? t('artifact.notebook.showLess') : t('artifact.email.moreRecipients', { count: hidden })}
          </Button>
        ) : null}
      </dd>
    </div>
  );
}

export function MailHeader({ message, locale, expanded, onExpand }: MailHeaderProps): JSX.Element {
  const t = useT();
  const date = formatMailDate(message.date, locale);
  const replyTo = message.replyTo.filter((person) => !message.from.some((sender) => sameMailbox(sender, person)));
  const rows: PeopleRow[] = (
    [
      { id: 'to', label: t('artifact.email.to'), people: message.to },
      { id: 'cc', label: t('artifact.email.cc'), people: message.cc },
      { id: 'bcc', label: t('artifact.email.bcc'), people: message.bcc },
      { id: 'replyTo', label: t('artifact.email.replyTo'), people: replyTo },
    ] satisfies PeopleRow[]
  ).filter((row) => row.people.length > 0);
  const separator = t('artifact.email.separator');

  return (
    <header className={styles.head} data-mail-header="">
      <h1 className={styles.subject} data-missing={message.subject ? undefined : ''}>
        {message.subject ?? t('artifact.email.noSubject')}
      </h1>
      <div className={styles.fromRow}>
        <p className={styles.sender} data-mail-from="">
          {message.from.length === 0 ? <span className={styles.senderMissing}>{t('artifact.email.noSender')}</span> : null}
          {message.from.map((person, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <Fragment key={index}>
              {index > 0 ? <span className={styles.peopleSeparator}>{separator}</span> : null}
              <span className={styles.senderName}>{personName(person)}</span>
              {person.name && person.address && person.name !== person.address ? <span className={styles.senderAddress}>{person.address}</span> : null}
            </Fragment>
          ))}
        </p>
        {date ? (
          <time className={styles.date} dateTime={date.iso ?? undefined} title={date.full}>
            {date.text}
          </time>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <dl className={styles.people}>
          {rows.map((row) => (
            <People key={row.id} row={row} open={expanded.includes(row.id)} onExpand={(open) => onExpand(row.id, open)} />
          ))}
        </dl>
      ) : null}
    </header>
  );
}
