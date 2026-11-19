// SPDX-License-Identifier: AGPL-3.0-only
// The companion composer's ＋ menu (Soul UI spec §4.5.1) with its dice popover, and the persona chip of the end
// cluster (§4.5.3). The menu lists the play group of the slash registry (掷骰 ▸, 抽一张 ▸, 小插曲), then 作为任务交给 TA,
// then 提及成员 (rooms) and 展开输入框. Every play item waits while a chat turn runs.
import { useRef, useState, type KeyboardEvent } from 'react';
import { AtSign, ChevronDown, Dices, Layers, ListChecks, Maximize2, Minimize2, Plus, Sparkles } from 'lucide-react';
import { availableDecks } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import {
  Button,
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Switch,
  Tooltip,
  cn,
} from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import { errorToast } from '../PaTurnTail';
import { usePa } from '../pa-context';
import { conversationKind } from '../pa-model';
import type { PaConversation } from '../pa-types';
import { SoulPortrait } from './SoulPortrait';
import { SoulTag } from './SoulPrimitives';
import { SOUL_COMMANDS, parseRollArg } from './soul-commands';
import { activeChatTask, characterOf, chatOf, displayName, personaFor } from './soul-model';
import styles from '../PaComposer.module.css';

/** The dice presets of the 掷骰 submenu and the popover's die buttons: notation is data, not copy. */
const PRESET_ROLLS = ['d6', 'd20', 'd100', '2d6'] as const;
const DIE_BUTTONS = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'] as const;
const NOTATION_EXAMPLE = '2d6+3';
const LABEL_MAX = 40;

function slashOf(id: 'roll' | 'draw' | 'event' | 'task'): string {
  return SOUL_COMMANDS.find((command) => command.id === id)?.slash ?? '';
}

/** The decks a conversation can draw from: the character's own, then the built-in set; rooms use the built-in set. */
export function soulDecksFor(index: ReturnType<typeof usePa>['index'], conversation: PaConversation) {
  return availableDecks(conversationKind(conversation) === 'direct' ? characterOf(index, conversation.agentId) : null);
}

function MenuLabel({ label, slash }: { label: string; slash: string }) {
  return (
    <span className={styles.playRow}>
      <span className={styles.playLabel}>{label}</span>
      {slash ? <span className={styles.playSlash}>{slash}</span> : null}
    </span>
  );
}

export interface SoulPlayMenuProps {
  conversation: PaConversation;
  /** Classes of the composer's round tool button and its ＋ glyph. */
  triggerClassName: string;
  glyphClassName: string;
  diceOpen: boolean;
  onDiceOpenChange(open: boolean): void;
  expanded: boolean;
  onToggleExpand(): void;
  onMention: (() => void) | null;
  onTask(): void;
  onDone(): void;
}

export function SoulPlayMenu({
  conversation,
  triggerClassName,
  glyphClassName,
  diceOpen,
  onDiceOpenChange,
  expanded,
  onToggleExpand,
  onMention,
  onTask,
  onDone,
}: SoulPlayMenuProps) {
  const t = useT();
  const { index, data } = usePa();
  const cid = conversation.id;
  const busy = activeChatTask(index, cid) !== null;
  const chat = chatOf(index, cid);
  const decks = soulDecksFor(index, conversation);
  const name = conversation.agentId ? displayName(index, conversation.agentId) : conversation.title;
  const busyText = busy ? t('pa.soul.chat.menu.busy', { name }) : undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const label = t('pa.soul.chat.composer.plus');
  /* A chosen item hands the focus back to the composer (or the dice popover), not to ＋ and its tooltip; Escape
     still returns it to ＋. */
  const chose = useRef(false);
  const choose = (action: () => void) => () => {
    chose.current = true;
    action();
  };

  const run = (work: Promise<unknown>) => {
    chose.current = true;
    void work.catch(errorToast);
    onDone();
  };

  return (
    <Popover open={diceOpen} onOpenChange={onDiceOpenChange}>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverAnchor asChild>
          <span className={styles.plusAnchor}>
            <Tooltip label={label}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  variant="quiet"
                  shape="round"
                  size="md"
                  tooltip={false}
                  data-testid="pa-composer-plus"
                  aria-label={label}
                  className={triggerClassName}
                >
                  <Icon icon={Plus} size="md" className={glyphClassName} />
                </IconButton>
              </DropdownMenuTrigger>
            </Tooltip>
          </span>
        </PopoverAnchor>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={10}
          width="md"
          data-testid="pa-soul-play-menu"
          onCloseAutoFocus={(event) => {
            if (diceOpen || chose.current) event.preventDefault();
            chose.current = false;
          }}
        >
          <DropdownMenuCaption>{t('pa.soul.chat.play.label')}</DropdownMenuCaption>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger icon={<Icon icon={Dices} size="sm" />} disabled={busy}>
              <MenuLabel label={t('pa.soul.chat.play.roll')} slash={slashOf('roll')} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={styles.playSub}>
              {PRESET_ROLLS.map((notation) => (
                <DropdownMenuItem key={notation} className={styles.playMono} onSelect={() => run(data.actions.roll(cid, { notation, respond: true }))}>
                  {notation}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={choose(() => window.setTimeout(() => onDiceOpenChange(true), 0))}>
                {t('pa.soul.chat.play.rollCustom')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger icon={<Icon icon={Layers} size="sm" />} disabled={busy}>
              <MenuLabel label={t('pa.soul.chat.play.draw')} slash={slashOf('draw')} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={styles.playSub}>
              {decks.map((deck) => (
                <DropdownMenuItem key={deck.id} onSelect={() => run(data.actions.draw(cid, { deckId: deck.id, respond: true }))}>
                  {deck.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            icon={<Icon icon={Sparkles} size="sm" />}
            disabled={busy || chat.activeEvent !== null || chat.candidateEvent !== null}
            description={busyText}
            onSelect={() => run(data.actions.eventAction(cid, 'draw'))}
          >
            <MenuLabel label={t('pa.soul.chat.play.event')} slash={slashOf('event')} />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Icon icon={ListChecks} size="sm" />} onSelect={choose(onTask)}>
            <MenuLabel label={t('pa.soul.chat.play.task', { name })} slash={slashOf('task')} />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {onMention ? (
            <DropdownMenuItem icon={<Icon icon={AtSign} size="sm" />} onSelect={choose(onMention)}>
              {t('pa.composer.actionMention')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem icon={<Icon icon={expanded ? Minimize2 : Maximize2} size="sm" />} onSelect={choose(onToggleExpand)}>
            {expanded ? t('pa.composer.collapseInput') : t('pa.composer.expandInput')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent side="top" align="start" sideOffset={10} width="md" className={styles.dice} data-testid="pa-soul-dice">
        {diceOpen ? (
          <SoulDiceForm
            name={name}
            onRoll={(body) => {
              onDiceOpenChange(false);
              run(data.actions.roll(cid, body));
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The dice popover: notation (with seven die buttons), an optional label and target, 让 TA 接着回应, 掷. */
function SoulDiceForm({
  name,
  onRoll,
}: {
  name: string;
  onRoll(body: { notation: string; label?: string; dc?: number; respond: boolean }): void;
}) {
  const t = useT();
  const [notation, setNotation] = useState('');
  const [label, setLabel] = useState('');
  const [target, setTarget] = useState('');
  const [respond, setRespond] = useState(true);
  const written = notation.trim();
  const parsed = written && !/\s/.test(written) ? parseRollArg(written) : null;
  const invalid = written !== '' && parsed === null;
  const dc = target.trim() === '' ? undefined : Number(target.trim());
  const dcInvalid = dc !== undefined && !(Number.isInteger(dc) && dc >= 1 && dc <= 999);
  const ready = parsed !== null && !dcInvalid;
  const submit = () => {
    if (!ready || !parsed) return;
    onRoll({
      notation: parsed.notation,
      ...(label.trim() ? { label: label.trim().slice(0, LABEL_MAX) } : {}),
      ...(dc !== undefined ? { dc } : {}),
      respond,
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className={styles.diceForm}>
      <div className={styles.diceTitle}>{t('pa.soul.chat.dice.title')}</div>
      <div className={styles.diceField}>
        <Input
          variant="mono"
          autoFocus
          value={notation}
          placeholder={NOTATION_EXAMPLE}
          aria-label={t('pa.soul.chat.dice.notation')}
          aria-invalid={invalid || undefined}
          onChange={(event) => setNotation(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {invalid ? <div className={styles.diceError}>{t('pa.soul.chat.dice.invalid')}</div> : null}
      </div>
      <div className={styles.diceGrid}>
        {DIE_BUTTONS.map((die) => (
          <Button key={die} variant="secondary" size="sm" className={styles.diceButton} onClick={() => setNotation(die)}>
            {die}
          </Button>
        ))}
      </div>
      <div className={styles.diceRow}>
        <Input
          value={label}
          maxLength={LABEL_MAX}
          placeholder={t('pa.soul.chat.dice.name')}
          aria-label={t('pa.soul.chat.dice.name')}
          className={styles.diceLabel}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Input
          variant="mono"
          inputMode="numeric"
          value={target}
          placeholder={t('pa.soul.chat.dice.target')}
          aria-label={t('pa.soul.chat.dice.target')}
          aria-invalid={dcInvalid || undefined}
          className={styles.diceTarget}
          onChange={(event) => setTarget(event.target.value.replace(/[^\d]/g, '').slice(0, 3))}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className={styles.diceFoot}>
        <label className={styles.diceRespond}>
          <Switch size="sm" checked={respond} onCheckedChange={(value) => setRespond(value === true)} />
          <span>{t('pa.soul.chat.dice.respond', { name })}</span>
        </label>
        <Button variant="primary" size="sm" disabled={!ready} onClick={submit} data-testid="pa-soul-dice-roll">
          {t('pa.soul.chat.dice.roll')}
        </Button>
      </div>
    </div>
  );
}

/** The persona chip: shown when the owner has two or more personas or the chat pins one. Below a 520 px column only
 *  the avatar shows (the composer's container query). */
export function SoulPersonaChip({ conversation }: { conversation: PaConversation }) {
  const t = useT();
  const { index, data, nav } = usePa();
  const cid = conversation.id;
  const chat = chatOf(index, cid);
  if (index.personas.size < 2 && chat.personaId === null) return null;
  const current = personaFor(index, conversation);
  const persona = current.id ? index.personas.get(current.id) ?? null : null;
  const personas = [...index.personas.values()];
  return (
    <DropdownMenu>
      <Tooltip label={t('pa.soul.chat.persona.as', { name: current.name })}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={styles.personaChip} data-testid="pa-soul-persona-chip" aria-label={t('pa.soul.chat.persona.as', { name: current.name })}>
            <SoulPortrait src={paSoulAssetUrl(persona?.avatarAssetId)} name={current.name} size={20} />
            <span className={styles.personaName}>{current.name}</span>
            <Icon icon={ChevronDown} size={12} className={styles.personaCaret} />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent width="md" side="top" align="end">
        <DropdownMenuLabel className={styles.personaMenuLabel}>{t('pa.soul.chat.persona.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current.id ?? ''}
          onValueChange={(personaId) => {
            if (personaId && personaId !== current.id) void data.actions.saveChat(cid, { personaId }).catch(errorToast);
          }}
        >
          {personas.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <span className={cn(styles.personaRow)}>
                <span className={styles.personaRowName}>{item.name}</span>
                {item.isDefault ? <SoulTag>{t('pa.soul.chat.persona.default')}</SoulTag> : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => nav.openPlace('library', { libraryTab: 'personas' })}>{t('pa.soul.chat.persona.manage')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
