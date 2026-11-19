// SPDX-License-Identifier: AGPL-3.0-only
// 角色库 content (Soul UI spec §6.2): the character tile grid with its row actions, and the hairline row lists of the
// 世界书, 我的人设 and 文风 tabs. Every edit opens a modal through `nav.openModal`; deletes confirm first. The world-book
// import used by the page's 导入 and by the card import modal's 当作世界书导入 lives here too, so both run one path.
import { useCallback, useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { embedCard, resolveAppearance } from '@open-design/contracts/soul';

import { useI18n } from '../../../i18n';
import { FantayMascotStill } from '../../brand/FantayMascot';
import {
  Button,
  CheckboxField,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EmptyState,
  Icon,
  IconButton,
  MetaLine,
  Modal,
  ModalActions,
  ModalLede,
  ModalTitle,
  MoreHorizontalIcon,
  Skeleton,
  Tile,
  TileBody,
  TileCover,
  cn,
  toast,
} from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import { usePa } from '../pa-context';
import { isFantay } from '../pa-model';
import type { PaCharacterView, PaIndex, PaLorebookSummary, PaPersona, PaStylePreset, PersonalAgent, TFn } from '../pa-types';
import { displayName } from './soul-model';
import { charxArchive, downloadBytes, downloadJson, portraitPngBytes } from './soul-files';
import { SoulPortrait, SoulPortraitCover } from './SoulPortrait';
import { SoulTag } from './SoulPrimitives';
import pages from '../PaPages.module.css';
import styles from './SoulLibraryPage.module.css';

const TAG_LIMIT = 12;
const SKELETON_TILES = [0, 1, 2, 3, 4, 5];

function notifyError(error: unknown) {
  toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) });
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

function matches(needle: string, locale: string, ...fields: string[]): boolean {
  return !needle || fields.some((field) => field.toLocaleLowerCase(locale).includes(needle));
}

/** A download name without path separators or characters a file system refuses. */
function fileStem(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'character';
}

// ---------------------------------------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------------------------------------

export interface LibraryCharacter {
  agent: PersonalAgent;
  character: PaCharacterView | null;
  fantay: boolean;
  name: string;
  tagline: string;
  tags: string[];
  activity: number;
}

/** Every agent as a library entry: Fantay first, then enabled ones by last activity, disabled last. */
export function libraryCharacters(index: PaIndex): LibraryCharacter[] {
  const entries = [...index.agents.values()].map((agent): LibraryCharacter => {
    const character = index.characters.get(agent.id) ?? null;
    const recent = index.directByAgent.get(agent.id)?.[0];
    return {
      agent,
      character,
      fantay: isFantay(index, agent.id),
      name: displayName(index, agent.id) || agent.name,
      tagline: character?.tagline.trim() || firstLine(agent.role),
      tags: character?.tags ?? [],
      activity: Math.max(recent ? (index.lastActivity.get(recent.id) ?? recent.createdAt) : 0, agent.updatedAt),
    };
  });
  const rank = (entry: LibraryCharacter) => (entry.fantay ? 0 : entry.agent.enabled ? 1 : 2);
  return entries.sort((a, b) => rank(a) - rank(b) || b.activity - a.activity || a.name.localeCompare(b.name));
}

/** The most used character tags (by count, then by name), at most twelve. */
export function libraryTags(index: PaIndex): string[] {
  const counts = new Map<string, number>();
  for (const character of index.characters.values()) {
    for (const tag of new Set(character.tags.map((value) => value.trim()).filter(Boolean))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TAG_LIMIT)
    .map(([tag]) => tag);
}

export function SoulCharacterGrid({ query, tag }: { query: string; tag: string | null }) {
  const { data, index, nav } = usePa();
  const { t, locale } = useI18n();
  const [disabling, setDisabling] = useState<PersonalAgent | null>(null);
  const [disableBusy, setDisableBusy] = useState(false);
  const [removing, setRemoving] = useState<LibraryCharacter | null>(null);

  const all = useMemo(() => libraryCharacters(index), [index]);
  const needle = query.trim().toLocaleLowerCase(locale);
  const shown = all.filter(
    (entry) =>
      (!tag || entry.tags.includes(tag)) &&
      matches(needle, locale, entry.name, entry.agent.name, entry.character?.nickname ?? '', entry.tagline, ...entry.tags),
  );

  if (data.load === 'loading' && !data.snapshot) {
    return (
      <div className={styles.grid} aria-hidden>
        {SKELETON_TILES.map((i) => (
          <Skeleton key={i} shape="tile" index={i} className={styles.skeletonTile} />
        ))}
      </div>
    );
  }
  if (shown.length === 0) return <p className={pages.noMatch}>{t('pa.soul.library.noMatch.characters')}</p>;

  const exportCard = async (entry: LibraryCharacter, as: 'json' | 'png' | 'charx') => {
    try {
      const card = await data.actions.exportCard(entry.agent.id, false);
      const stem = fileStem(entry.agent.name);
      if (as === 'json') downloadJson(`${stem}.json`, card);
      else if (as === 'charx') downloadBytes(`${stem}.charx`, await charxArchive(card, entry.character ?? {}), 'application/zip');
      else {
        const art = await portraitPngBytes(paSoulAssetUrl(entry.character?.portraitAssetId));
        downloadBytes(`${stem}.png`, embedCard(art, card), 'image/png');
      }
      toast({ tone: 'success', title: t('pa.soul.library.tile.exported') });
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <>
      <div className={styles.grid}>
        {shown.map((entry) => (
          <CharacterTile
            key={entry.agent.id}
            entry={entry}
            t={t}
            onOpen={() => void nav.openAgent(entry.agent.id).catch(notifyError)}
            onEdit={() => nav.openModal({ kind: 'agent', agentId: entry.agent.id })}
            onExport={(as) => void exportCard(entry, as)}
            onDuplicate={() =>
              void data.actions
                .cloneAgent(entry.agent.id)
                .then((copy) => toast({ tone: 'success', title: t('pa.roster.duplicated', { name: copy?.name ?? entry.agent.name }) }))
                .catch(notifyError)
            }
            onToggle={() =>
              entry.agent.enabled ? setDisabling(entry.agent) : void data.actions.setAgentEnabled(entry.agent, true).catch(notifyError)
            }
            onRemoveCard={() => setRemoving(entry)}
            manage={index.canManageLibrary}
          />
        ))}
      </div>

      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(open) => {
          if (!open && !disableBusy) setDisabling(null);
        }}
        title={t('pa.roster.disableTitle', { name: disabling?.name ?? '' })}
        description={t('pa.roster.disableBody')}
        confirmLabel={t('pa.disable')}
        cancelLabel={t('pa.cancel')}
        destructive
        busy={disableBusy}
        onConfirm={() => {
          const agent = disabling;
          if (!agent) return;
          setDisableBusy(true);
          void data.actions
            .setAgentEnabled(agent, false)
            .catch(notifyError)
            .finally(() => {
              setDisableBusy(false);
              setDisabling(null);
            });
        }}
      />
      <RemoveCardDialog entry={removing} onDone={() => setRemoving(null)} />
    </>
  );
}

interface CharacterTileProps {
  entry: LibraryCharacter;
  t: TFn;
  onOpen(): void;
  onEdit(): void;
  onExport(as: 'json' | 'png' | 'charx'): void;
  onDuplicate(): void;
  onToggle(): void;
  onRemoveCard(): void;
  /** False for a member who only reads the library (enterprise mode): the tile opens the chat and offers no edits. */
  manage: boolean;
}

function CharacterTile({ entry, t, onOpen, onEdit, onExport, onDuplicate, onToggle, onRemoveCard, manage }: CharacterTileProps) {
  const { agent, character, fantay, name, tagline, tags } = entry;
  const theme = useMemo(() => (character ? resolveAppearance(character.appearance).theme : 'fantay'), [character]);
  const review = character?.needsReview.length ?? 0;
  const lore = character?.lorebookIds.length ?? 0;
  const shownTags = tags.slice(0, 2);
  const hasFoot = fantay || !character || review > 0 || shownTags.length > 0 || lore > 0;

  return (
    <Tile
      tone="solid"
      className={styles.tile}
      data-testid="pa-library-tile"
      data-agent={agent.id}
      data-disabled={agent.enabled ? undefined : ''}
    >
      <Button variant="link" className={styles.open} aria-label={name} onClick={onOpen} />
      <TileCover className={styles.cover}>
        <SoulPortraitCover src={paSoulAssetUrl(character?.portraitAssetId)} name={name} theme={theme} mascot={fantay} />
      </TileCover>
      <TileBody className={styles.body}>
        <div className={styles.tileName}>{name}</div>
        <div className={styles.tagline}>{tagline}</div>
        {hasFoot ? (
          <div className={styles.foot}>
            {fantay ? <SoulTag>{t('pa.soul.library.tile.main')}</SoulTag> : !character ? <SoulTag>{t('pa.soul.library.tile.assistant')}</SoulTag> : null}
            {review > 0 ? <SoulTag tone="outline">{t('pa.soul.library.tile.review', { n: review })}</SoulTag> : null}
            {shownTags.length > 0 || lore > 0 ? (
              <MetaLine className={styles.meta}>
                {shownTags.map((value) => (
                  <span key={value} className={styles.metaText}>
                    {value}
                  </span>
                ))}
                {lore > 0 ? <span className={styles.metaFixed}>{t('pa.soul.library.tile.lore', { n: lore })}</span> : null}
              </MetaLine>
            ) : null}
          </div>
        ) : null}
      </TileBody>
      {manage ? (
      <div className={styles.actions}>
        <IconButton size="sm" variant="frosted" aria-label={t('pa.soul.library.tile.edit')} onClick={onEdit}>
          <Icon icon={Pencil} size="sm" />
        </IconButton>
        {fantay ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" variant="frosted" aria-label={t('pa.soul.library.tile.more')} tooltip={false}>
                <MoreHorizontalIcon size="sm" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent width="md" align="end">
              <DropdownMenuItem onSelect={onEdit}>{t('pa.soul.library.tile.edit')}</DropdownMenuItem>
              {character ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>{t('pa.soul.library.tile.export')}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onSelect={() => onExport('json')}>{t('pa.soul.library.tile.exportJson')}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onExport('png')}>{t('pa.soul.library.tile.exportPng')}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onExport('charx')}>{t('pa.soul.library.tile.exportCharx')}</DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
              <DropdownMenuItem onSelect={onDuplicate}>{t('pa.soul.library.tile.duplicate')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={onToggle}>{agent.enabled ? t('pa.disable') : t('pa.enable')}</DropdownMenuItem>
              {character ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem tone="danger" onSelect={onRemoveCard}>
                    {t('pa.soul.library.tile.removeCard')}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      ) : null}
    </Tile>
  );
}

/** 删除 {name} 的角色设定？ with the 同时删除记忆 checkbox (default on). ConfirmDialog has no slot for a checkbox. */
function RemoveCardDialog({ entry, onDone }: { entry: LibraryCharacter | null; onDone(): void }) {
  const { data, index } = usePa();
  const { t } = useI18n();
  const [forget, setForget] = useState(true);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<LibraryCharacter | null>(entry);
  if (entry && entry !== held) {
    setHeld(entry);
    setForget(true);
  }
  const shown = entry ?? held;
  const name = shown?.name ?? '';
  const memories = shown
    ? [...index.memories.values()].filter((memory) => memory.scope === 'agent' && memory.scopeId === shown.agent.id).length
    : 0;

  const confirm = () => {
    if (!entry || busy) return;
    setBusy(true);
    void data.actions
      .removeCharacter(entry.agent.id, memories > 0 && forget)
      .then(onDone)
      .catch(notifyError)
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      open={entry !== null}
      onClose={() => {
        if (!busy) onDone();
      }}
      size="sm"
      showClose={false}
      data-testid="pa-library-remove-card"
    >
      <ModalTitle>{t('pa.soul.library.confirm.cardTitle', { name })}</ModalTitle>
      <ModalLede>{t('pa.soul.library.confirm.cardBody', { name })}</ModalLede>
      {memories > 0 ? (
        <CheckboxField
          className={styles.confirmCheck}
          checked={forget}
          onChange={(event) => setForget(event.target.checked)}
          label={t('pa.soul.library.confirm.cardMemories', { name, n: memories })}
        />
      ) : null}
      <ModalActions>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          {t('pa.cancel')}
        </Button>
        <Button variant="danger" loading={busy} onClick={confirm}>
          {t('pa.soul.library.confirm.cardConfirm')}
        </Button>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------
// World books
// ---------------------------------------------------------------------------------------------------------

/** Imports a parsed world-book file, opens the lorebook editor on the result and reports it in a toast. */
export function useSoulWorldImport(): (world: unknown, fileName: string) => Promise<boolean> {
  const { data, nav } = usePa();
  const { t } = useI18n();
  return useCallback(
    async (world: unknown, fileName: string) => {
      try {
        const { lorebook, report } = await data.actions.importWorld({ world, fileName });
        nav.openModal({ kind: 'lorebook', lorebookId: lorebook.id });
        toast({
          tone: 'success',
          title:
            report.length > 0
              ? t('pa.soul.library.lore.importedReview', { name: lorebook.name, n: report.length })
              : t('pa.soul.library.lore.imported', { name: lorebook.name }),
        });
        return true;
      } catch (error) {
        notifyError(error);
        return false;
      }
    },
    [data.actions, nav, t],
  );
}

function boundNames(index: PaIndex, book: PaLorebookSummary): string[] {
  const names: string[] = [];
  for (const character of index.characters.values()) {
    if (character.lorebookIds.includes(book.id)) names.push(displayName(index, character.id));
  }
  return names;
}

export function SoulLorebookRows({ query, onCreate }: { query: string; onCreate(): void }) {
  const { data, index, nav } = usePa();
  const { t, locale } = useI18n();
  const [deleting, setDeleting] = useState<PaLorebookSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const books = useMemo(() => [...index.lorebooks.values()].sort((a, b) => b.updatedAt - a.updatedAt), [index]);
  const needle = query.trim().toLocaleLowerCase(locale);
  const shown = books.filter((book) => matches(needle, locale, book.name, book.description));
  const joiner = locale.startsWith('zh') ? '、' : ', ';

  if (books.length === 0) {
    return (
      <LibraryEmpty
        title={t('pa.soul.library.lore.emptyTitle')}
        body={t('pa.soul.library.lore.emptyBody')}
        action={t('pa.soul.library.new.lorebook')}
        onAction={onCreate}
      />
    );
  }
  if (shown.length === 0) return <p className={pages.noMatch}>{t('pa.soul.library.noMatch.generic')}</p>;

  const exportBook = async (book: PaLorebookSummary) => {
    try {
      downloadJson(`${fileStem(book.name)}.json`, await data.actions.exportWorld(book.id));
      toast({ tone: 'success', title: t('pa.soul.library.tile.exported') });
    } catch (error) {
      notifyError(error);
    }
  };
  const bindings = deleting ? boundNames(index, deleting).length : 0;

  return (
    <>
      <div className={pages.rowGroup}>
        {shown.map((book) => {
          const names = boundNames(index, book);
          return (
            <div key={book.id} className={styles.row} data-testid="pa-library-lorebook">
              <Button variant="link" className={styles.open} aria-label={book.name} onClick={() => nav.openModal({ kind: 'lorebook', lorebookId: book.id })} />
              <div className={styles.rowText}>
                <span className={styles.rowName}>{book.name}</span>
                {book.description.trim() ? <span className={styles.rowDesc}>{firstLine(book.description)}</span> : null}
                <div className={styles.rowMeta}>
                  <MetaLine className={styles.meta}>
                    <span className={styles.metaFixed}>{t('pa.soul.library.lore.entries', { n: book.entryCount })}</span>
                    {book.constantCount > 0 ? (
                      <span className={styles.metaFixed}>{t('pa.soul.library.lore.constant', { n: book.constantCount })}</span>
                    ) : null}
                    <span className={styles.metaText}>
                      {names.length > 0 ? t('pa.soul.library.lore.bound', { names: names.join(joiner) }) : t('pa.soul.library.lore.unbound')}
                    </span>
                  </MetaLine>
                  {book.global ? <SoulTag>{t('pa.soul.library.lore.global')}</SoulTag> : null}
                  {book.needsReviewCount > 0 ? (
                    <SoulTag tone="outline">{t('pa.soul.library.tile.review', { n: book.needsReviewCount })}</SoulTag>
                  ) : null}
                </div>
              </div>
              {index.canManageLibrary ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton size="xs" variant="quiet" className={styles.rowMenu} aria-label={t('pa.soul.library.tile.more')} tooltip={false}>
                    <MoreHorizontalIcon size="sm" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent width="sm" align="end">
                  <DropdownMenuItem onSelect={() => nav.openModal({ kind: 'lorebook', lorebookId: book.id })}>{t('pa.edit')}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportBook(book)}>{t('pa.soul.library.lore.export')}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem tone="danger" onSelect={() => setDeleting(book)}>
                    {t('pa.soul.library.lore.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              ) : null}
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
        title={t('pa.soul.library.confirm.loreTitle', { name: deleting?.name ?? '' })}
        description={t('pa.soul.library.confirm.loreBody', { n: bindings })}
        confirmLabel={t('pa.delete')}
        cancelLabel={t('pa.cancel')}
        destructive
        busy={busy}
        onConfirm={() => {
          const book = deleting;
          if (!book) return;
          setBusy(true);
          void data.actions
            .removeLorebook({ id: book.id, revision: book.revision })
            .catch(notifyError)
            .finally(() => {
              setBusy(false);
              setDeleting(null);
            });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------------------------------------

export function SoulPersonaRows({ query, onCreate }: { query: string; onCreate(): void }) {
  const { index, nav } = usePa();
  const { t, locale } = useI18n();
  const personas = useMemo(
    () => [...index.personas.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt - a.updatedAt),
    [index],
  );
  const needle = query.trim().toLocaleLowerCase(locale);
  const shown = personas.filter((persona) => matches(needle, locale, persona.name, persona.description));

  if (personas.length === 0) {
    return (
      <LibraryEmpty
        title={t('pa.soul.library.persona.emptyTitle')}
        body={t('pa.soul.library.persona.emptyBody')}
        action={t('pa.soul.library.new.persona')}
        onAction={onCreate}
      />
    );
  }
  if (shown.length === 0) return <p className={pages.noMatch}>{t('pa.soul.library.noMatch.generic')}</p>;

  return (
    <div className={pages.rowGroup}>
      {shown.map((persona: PaPersona) => (
        <div key={persona.id} className={styles.row} data-testid="pa-library-persona">
          <Button
            variant="link"
            className={styles.open}
            aria-label={persona.name}
            onClick={() => nav.openModal({ kind: 'persona', personaId: persona.id })}
          />
          <div className={styles.rowLead}>
            <SoulPortrait src={paSoulAssetUrl(persona.avatarAssetId)} name={persona.name} size={40} frame="circle" />
            <div className={styles.rowText}>
              <span className={styles.rowTitle}>
                <span className={styles.rowName}>{persona.name}</span>
                {persona.isDefault ? <SoulTag>{t('pa.soul.library.persona.default')}</SoulTag> : null}
              </span>
              {persona.description.trim() ? <span className={cn(styles.rowDesc, styles.rowDescClamp)}>{persona.description}</span> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------------------

function presetTraits(preset: PaStylePreset, t: TFn): string[] {
  const traits = [t(`pa.soul.library.preset.trait.${preset.format}`), t(`pa.soul.library.preset.trait.${preset.replyLength}`)];
  if (preset.suggestChoices) traits.push(t('pa.soul.library.preset.trait.choices'));
  if (preset.playRequests) traits.push(t('pa.soul.library.preset.trait.play'));
  return traits;
}

function PresetRow({ preset, t, onOpen }: { preset: PaStylePreset; t: TFn; onOpen(): void }) {
  return (
    <div className={styles.row} data-testid="pa-library-preset" data-builtin={preset.builtin ? '' : undefined}>
      <Button variant="link" className={styles.open} aria-label={preset.name} onClick={onOpen} />
      <div className={styles.rowText}>
        <span className={styles.rowName}>{preset.name}</span>
        {preset.description.trim() ? <span className={cn(styles.rowDesc, styles.rowDescClamp)}>{preset.description}</span> : null}
        <div className={styles.rowMeta}>
          {presetTraits(preset, t).map((trait) => (
            <SoulTag key={trait}>{trait}</SoulTag>
          ))}
          {preset.builtin ? <SoulTag tone="outline">{t('pa.soul.library.preset.builtin')}</SoulTag> : null}
        </div>
      </div>
    </div>
  );
}

export function SoulPresetRows({ query }: { query: string }) {
  const { index, nav } = usePa();
  const { t, locale } = useI18n();
  const presets = useMemo(() => [...index.presets.values()], [index]);
  const needle = query.trim().toLocaleLowerCase(locale);
  const keep = (preset: PaStylePreset) => matches(needle, locale, preset.name, preset.description);
  const builtins = presets.filter((preset) => preset.builtin && keep(preset));
  const mine = presets
    .filter((preset) => !preset.builtin)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const mineShown = mine.filter(keep);
  const open = (preset: PaStylePreset) => nav.openModal({ kind: 'preset', presetId: preset.id });

  if (needle && builtins.length === 0 && mineShown.length === 0) {
    return <p className={pages.noMatch}>{t('pa.soul.library.noMatch.generic')}</p>;
  }

  return (
    <div>
      {builtins.length > 0 ? (
        <section className={styles.section}>
          <h2 className={cn(pages.groupTitle, styles.groupTitle)}>{t('pa.soul.library.preset.builtin')}</h2>
          <div className={pages.rowGroup}>
            {builtins.map((preset) => (
              <PresetRow key={preset.id} preset={preset} t={t} onOpen={() => open(preset)} />
            ))}
          </div>
          {mine.length === 0 && !needle ? <p className={styles.quiet}>{t('pa.soul.library.preset.hint')}</p> : null}
        </section>
      ) : null}
      {mineShown.length > 0 ? (
        <section className={styles.section}>
          <h2 className={cn(pages.groupTitle, styles.groupTitle)}>{t('pa.soul.library.preset.mine')}</h2>
          <div className={pages.rowGroup}>
            {mineShown.map((preset) => (
              <PresetRow key={preset.id} preset={preset} t={t} onOpen={() => open(preset)} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------------------

function LibraryEmpty({ title, body, action, onAction }: { title: string; body: string; action: string; onAction(): void }) {
  return (
    <EmptyState
      variant="card"
      className={styles.empty}
      illustration={<FantayMascotStill size={48} />}
      title={title}
      description={body}
      action={
        <Button variant="primary" onClick={onAction}>
          {action}
        </Button>
      }
    />
  );
}
