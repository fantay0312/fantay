import styles from './WhatsNewPopup.module.css';
import { FantayMascot } from '../fantay/brand/FantayMascot';
import { FantayChangelog } from './fantay-changelog/FantayChangelog';

export function ReleaseNotesContent({ title, titleId, headline, notes, noteTestId }: {
  title: string; titleId: string; headline?: string; notes: string[]; noteTestId?: string;
}) {
  return (
    <div className={styles.content}>
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden><FantayMascot size={32} tracking={false} /></span>
        <div className={styles.heading}>
          <h2 className={styles.title} id={titleId}>{title}</h2>
          {headline && !/^Fantay(?: ?Design)?\b/i.test(headline) ? <p className={styles.headline}>{headline}</p> : null}
        </div>
      </header>
      <ul className={styles.notes}>
        {notes.map((note) => {
          const match = note.match(/^([^：:]{1,18})[：:]\s*(.+)$/s);
          return <li className={styles.note} data-testid={noteTestId} key={note}>
            {match ? <><strong className={styles.noteTitle}>{match[1]}</strong><span className={styles.noteText}>{match[2]}</span></> : <span className={styles.noteText}>{note}</span>}
          </li>;
        })}
      </ul>
    </div>
  );
}

/** Fantay's own changelog, read as a manga series (./fantay-changelog). */
export function FantayReleaseNotes({ onClose }: { onClose: () => void }) {
  return <FantayChangelog onClose={onClose} />;
}
