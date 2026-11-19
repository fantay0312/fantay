// SPDX-License-Identifier: AGPL-3.0-only
// The 入门 starter shelf (Soul UI spec §6.2), shared by Fantay's first screen (`limit`: three cards under a heading
// with 全部角色) and the library (no limit: compact cards of every starter not met yet, then the four work templates;
// the library draws its own heading). Starters ship without portrait art: covers are monograms on the starter's
// own theme paper. One click installs when needed and opens the chat with the greeting already there.
import { useId, useMemo } from 'react';
import { PA_STARTERS, PA_STARTER_SHELF, type PaStarter } from '@open-design/contracts/soul';
import type { PaChatTheme } from '@open-design/contracts';

import { useI18n, useT } from '../../../i18n';
import { Button, Spinner, cn, toast } from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import { usePa } from '../pa-context';
import type { PaIndex } from '../pa-types';
import { paPendingKey } from '../usePaWorkspace';
import { installedStarter } from './soul-model';
import { SoulPortrait, SoulPortraitCover } from './SoulPortrait';
import { SoulTag } from './SoulPrimitives';
import styles from './SoulStarterShelf.module.css';

export interface SoulStarterShelfProps {
  limit?: number;
  onOpenLibrary?(): void;
}

type Lang = 'zh' | 'en';

/** The four work templates of the library shelf; the profile editor prefills name and 职责 from `pa.agentForm.tpl*`. */
const WORK_TEMPLATES = [
  { id: 'researcher', name: 'pa.agentForm.tplResearcher' },
  { id: 'designer', name: 'pa.agentForm.tplDesigner' },
  { id: 'writer', name: 'pa.agentForm.tplWriter' },
  { id: 'reviewer', name: 'pa.agentForm.tplReviewer' },
] as const;

const BY_ID = new Map(PA_STARTERS.map((starter) => [starter.id, starter]));

function themeOf(starter: PaStarter | undefined): PaChatTheme {
  return starter?.kind === 'character' ? starter.character.appearance?.theme ?? 'fantay' : 'fantay';
}

/** A room counts as met when a group chat with its name holds every member's installed character. */
function roomInstalled(index: PaIndex, starter: Extract<PaStarter, { kind: 'room' }>): boolean {
  const members = starter.group.members.map((id) => installedStarter(index, id)?.agentId ?? null);
  if (members.some((id) => id === null)) return false;
  for (const group of index.groups.values())
    if (group.name === starter.group.name && members.every((id) => id !== null && group.memberIds.includes(id))) return true;
  return false;
}

function isInstalled(index: PaIndex, starter: PaStarter): boolean {
  return starter.kind === 'room' ? roomInstalled(index, starter) : installedStarter(index, starter.id) !== null;
}

function useOpenStarter() {
  const t = useT();
  const { nav } = usePa();
  return (id: string) => {
    void nav.openStarter(id).catch(() => toast({ tone: 'danger', title: t('pa.soul.shell.shelf.failed') }));
  };
}

export function SoulStarterShelf({ limit, onOpenLibrary }: SoulStarterShelfProps) {
  return limit === undefined ? <LibraryShelf /> : <CompactShelf limit={limit} onOpenLibrary={onOpenLibrary} />;
}

// ---------------------------------------------------------------------------------------------------------
// Fantay's first screen: heading + three cards
// ---------------------------------------------------------------------------------------------------------

function CompactShelf({ limit, onOpenLibrary }: { limit: number; onOpenLibrary?(): void }) {
  const t = useT();
  const { locale } = useI18n();
  const lang: Lang = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const starters = PA_STARTER_SHELF.slice(0, Math.max(0, limit))
    .map((id) => BY_ID.get(id))
    .filter((starter): starter is PaStarter => Boolean(starter));
  if (starters.length === 0) return null;
  return (
    <section className={styles.shelf} data-testid="pa-starter-shelf" aria-label={t('pa.soul.shell.shelf.title')}>
      <div className={styles.head}>
        <h3 className={styles.title}>{t('pa.soul.shell.shelf.title')}</h3>
        {onOpenLibrary ? (
          <Button variant="link" size="sm" className={styles.all} onClick={onOpenLibrary}>
            {t('pa.soul.shell.shelf.all')}
          </Button>
        ) : null}
      </div>
      <div className={styles.cards}>
        {starters.map((starter) => (
          <StarterCard key={starter.id} starter={starter} lang={lang} />
        ))}
      </div>
    </section>
  );
}

function StarterCard({ starter, lang }: { starter: PaStarter; lang: Lang }) {
  const t = useT();
  const { index, data } = usePa();
  const open = useOpenStarter();
  const taglineId = useId();
  const display = starter.display[lang];
  const installed = starter.kind === 'character' ? installedStarter(index, starter.id) : null;
  const character = installed ? index.characters.get(installed.agentId) ?? null : null;
  const pending = data.pending.has(paPendingKey.soulStarter(starter.id));
  return (
    <Button
      variant="bare"
      className={styles.card}
      data-testid="pa-starter-tile"
      data-starter={starter.id}
      data-installed={installed ? '' : undefined}
      aria-label={t('pa.soul.shell.shelf.helloTo', { name: display.name })}
      aria-describedby={taglineId}
      aria-busy={pending || undefined}
      onClick={() => {
        if (!pending) open(starter.id);
      }}
    >
      <SoulPortrait
        src={paSoulAssetUrl(character?.portraitAssetId)}
        name={display.name}
        size={56}
        frame="squircle"
        theme={themeOf(starter)}
      />
      <span className={styles.cardText}>
        <span className={styles.cardNameRow}>
          <span className={styles.cardName}>{display.name}</span>
          {installed ? <SoulTag tone="outline">{t('pa.soul.shell.shelf.known')}</SoulTag> : null}
        </span>
        <span id={taglineId} className={styles.cardTagline}>
          {display.tagline}
        </span>
      </span>
      {pending ? <Spinner size="sm" className={styles.cardSpinner} /> : null}
    </Button>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Library: compact cards in the 我的角色 grid's columns (a 60 × 80 cover beside the name), then the work
// templates, so the shelf stays short and the owner's own characters stay above the fold
// ---------------------------------------------------------------------------------------------------------

function LibraryShelf() {
  const t = useT();
  const { locale } = useI18n();
  const { index, data, nav } = usePa();
  const open = useOpenStarter();
  const lang: Lang = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const starters = useMemo(() => PA_STARTERS.filter((starter) => !isInstalled(index, starter)), [index]);
  return (
    <div className={styles.tiles} data-testid="pa-starter-shelf">
      {starters.map((starter) => {
        const display = starter.display[lang];
        const pending = data.pending.has(paPendingKey.soulStarter(starter.id));
        return (
          <Button
            key={starter.id}
            variant="bare"
            className={styles.tile}
            data-testid="pa-starter-tile"
            data-starter={starter.id}
            aria-busy={pending || undefined}
            onClick={() => {
              if (!pending) open(starter.id);
            }}
          >
            <span className={styles.cover}>
              {starter.kind === 'room' ? (
                <span className={styles.roomCover}>
                  {starter.group.members.slice(0, 2).map((memberId) => {
                    const member = BY_ID.get(memberId);
                    return (
                      <SoulPortrait
                        key={memberId}
                        src={null}
                        name={member?.display[lang].name ?? ''}
                        size={30}
                        theme={themeOf(member)}
                        className={styles.roomFace}
                      />
                    );
                  })}
                </span>
              ) : (
                <SoulPortraitCover src={null} name={display.name} theme={themeOf(starter)} />
              )}
              {pending ? (
                <span className={styles.coverBusy}>
                  <Spinner size="sm" />
                </span>
              ) : null}
            </span>
            <span className={styles.tileText}>
              <span className={styles.tileName}>{display.name}</span>
              <span className={styles.tileTagline}>{display.tagline}</span>
            </span>
          </Button>
        );
      })}
      {WORK_TEMPLATES.map((template) => {
        const name = t(template.name);
        return (
          <Button
            key={template.id}
            variant="bare"
            className={styles.tile}
            data-testid="pa-starter-template"
            data-template={template.id}
            onClick={() => nav.openModal({ kind: 'agent', agentId: null, template: template.id })}
          >
            <span className={cn(styles.cover, styles.templateCover)}>
              <span aria-hidden className={styles.templateDisc}>
                {Array.from(name.trim())[0] ?? ''}
              </span>
            </span>
            <span className={styles.tileText}>
              <span className={styles.tileNameRow}>
                <span className={styles.tileName}>{name}</span>
                <SoulTag>{t('pa.soul.shell.shelf.assistant')}</SoulTag>
              </span>
              <span className={styles.tileTagline}>{t('pa.soul.shell.shelf.templateHint')}</span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}
