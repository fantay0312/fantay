// fx-governance-allow-raw: the option rows are whole cards and the free-text row borrows their frame
'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// First-run welcome, shown once after model setup. Three short questions with the mascot watching: it hops on a pick
// and somersaults when a step is done. Every answer does something: what the user makes and how they like to start
// become custom instructions (the daemon sends those with each run, and the user can edit them in Settings); the
// appearance applies as soon as it is picked. Answers stay in this component until the last step, so closing the
// dialog saves nothing but the "seen" flag.
import { useRef, useState } from 'react';
import type * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Check, ChevronLeft, CornerDownLeft, X } from 'lucide-react';

import { useI18n, useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { FantayMascot } from '../brand/FantayMascot';
import { isThemePreference, useTheme } from '../theme/theme';
import { Button, IconButton, overlayClass } from '../ui';
import { cn } from '../ui/cn';
import { FX } from '../ui/fx';
import styles from './FantayWelcome.module.css';

type DictKey = keyof Dict;
type StepId = 'content' | 'start' | 'theme';

interface WelcomeOption {
  id: string;
  labelKey: DictKey;
}

interface WelcomeStep {
  id: StepId;
  titleKey: DictKey;
  questionKey: DictKey;
  multi: boolean;
  options: readonly WelcomeOption[];
  /** Placeholder of the free-text row; absent = options only. */
  otherKey?: DictKey;
}

const STEPS: readonly WelcomeStep[] = [
  {
    id: 'content',
    titleKey: 'fantay.welcome.title.content',
    questionKey: 'fantay.welcome.q.content',
    multi: true,
    otherKey: 'fantay.welcome.q.content.other',
    options: [
      { id: 'social', labelKey: 'fantay.welcome.q.content.social' },
      { id: 'product', labelKey: 'fantay.welcome.q.content.product' },
      { id: 'deck', labelKey: 'fantay.welcome.q.content.deck' },
      { id: 'video', labelKey: 'fantay.welcome.q.content.video' },
    ],
  },
  {
    id: 'start',
    titleKey: 'fantay.welcome.title.start',
    questionKey: 'fantay.welcome.q.start',
    multi: false,
    otherKey: 'fantay.welcome.q.start.other',
    options: [
      { id: 'directions', labelKey: 'fantay.welcome.q.start.directions' },
      { id: 'copy', labelKey: 'fantay.welcome.q.start.copy' },
      { id: 'ask', labelKey: 'fantay.welcome.q.start.ask' },
    ],
  },
  {
    id: 'theme',
    titleKey: 'fantay.welcome.title.theme',
    questionKey: 'fantay.welcome.q.theme',
    multi: false,
    options: [
      { id: 'light', labelKey: 'fantay.theme.light' },
      { id: 'dark', labelKey: 'fantay.theme.dark' },
    ],
  },
];

export interface WelcomeAnswers {
  /** The labels the user picked, in the display language, plus any free text. */
  content: readonly string[];
  start: string | null;
}

export type WelcomeTranslate = (key: DictKey, vars?: Record<string, string | number>) => string;

/** The custom-instructions block for these answers; null when there is nothing to tell the agent. */
export function welcomeInstructions(answers: WelcomeAnswers, t: WelcomeTranslate, list: (items: readonly string[]) => string): string | null {
  const lines: string[] = [];
  if (answers.content.length > 0) lines.push(t('fantay.welcome.instruction.content', { items: list(answers.content) }));
  if (answers.start) lines.push(t('fantay.welcome.instruction.start', { item: answers.start }));
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Appends the block after what the user already wrote; never replaces it. */
export function mergeCustomInstructions(existing: string | undefined, block: string): string {
  const current = existing?.trim();
  return current ? `${current}\n\n${block}` : block;
}

/** A tiny window in the theme it stands for; 系统 is split down the middle. */
function ThemeSwatch({ theme }: { theme: string }) {
  return (
    <span className={styles.swatch} data-swatch={theme} aria-hidden>
      <span className={styles.swatchBar} />
      <span className={styles.swatchLine} />
      <span className={styles.swatchLine} data-short="" />
    </span>
  );
}

export interface FantayWelcomeProps {
  open: boolean;
  /** `instructions` is null when closed early or nothing was answered. */
  onComplete(instructions: string | null): void;
}

export function FantayWelcome({ open, onComplete }: FantayWelcomeProps) {
  const t = useT();
  const { locale } = useI18n();
  const { preference, setPreference } = useTheme();
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<Record<StepId, readonly string[]>>({ content: [], start: [], theme: [preference] });
  const [other, setOther] = useState<Record<StepId, string>>({ content: '', start: '', theme: '' });
  const [pulse, setPulse] = useState(0);
  const [flip, setFlip] = useState(0);
  const otherRef = useRef<HTMLInputElement | null>(null);
  const step = STEPS[index]!;
  const stepPicked = picked[step.id];
  const stepOther = other[step.id];
  const last = index === STEPS.length - 1;
  const canConfirm = stepPicked.length > 0 || stepOther.trim().length > 0;

  const toggle = (optionId: string) => {
    setPulse((current) => current + 1);
    if (step.id === 'theme' && isThemePreference(optionId)) setPreference(optionId);
    setPicked((current) => {
      const selected = current[step.id];
      if (!step.multi) return { ...current, [step.id]: [optionId] };
      const next = selected.includes(optionId) ? selected.filter((id) => id !== optionId) : [...selected, optionId];
      return { ...current, [step.id]: next };
    });
    if (!step.multi) setOther((current) => ({ ...current, [step.id]: '' }));
  };

  const editOther = (value: string) => {
    setOther((current) => ({ ...current, [step.id]: value }));
    if (!step.multi && value) setPicked((current) => ({ ...current, [step.id]: [] }));
  };

  const finish = (answered: { picked: typeof picked; other: typeof other }) => {
    const labelOf = (stepId: StepId, optionId: string) => {
      const option = STEPS.find((entry) => entry.id === stepId)?.options.find((entry) => entry.id === optionId);
      return option ? t(option.labelKey) : optionId;
    };
    const content = [...answered.picked.content.map((id) => labelOf('content', id))];
    const customContent = answered.other.content.trim();
    if (customContent) content.push(customContent);
    const startId = answered.picked.start[0];
    const start = startId ? labelOf('start', startId) : answered.other.start.trim() || null;
    const format = new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' });
    onComplete(welcomeInstructions({ content, start }, t, (items) => format.format(items)));
  };

  const advance = (answered: { picked: typeof picked; other: typeof other }) => {
    setFlip((current) => current + 1);
    if (last) finish(answered);
    else setIndex(index + 1);
  };

  const confirm = () => {
    if (canConfirm) advance({ picked, other });
  };

  const skip = () => {
    const nextPicked = { ...picked, [step.id]: [] };
    const nextOther = { ...other, [step.id]: '' };
    setPicked(nextPicked);
    setOther(nextOther);
    advance({ picked: nextPicked, other: nextOther });
  };

  const rows = step.options.length + (step.otherKey ? 1 : 0);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const typing = target.matches('input');
    if (event.key === 'Enter') {
      // Enter confirms from an option too; only the real buttons keep it.
      if (target.matches('button') && !target.matches('[role="checkbox"], [role="radio"]')) return;
      event.preventDefault();
      confirm();
      return;
    }
    if (typing || event.key.length !== 1) return;
    const row = event.key.toUpperCase().charCodeAt(0) - 65;
    if (row < 0 || row >= rows) return;
    event.preventDefault();
    if (row < step.options.length) toggle(step.options[row]!.id);
    else otherRef.current?.focus();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : onComplete(null))}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlayClass} />
        <DialogPrimitive.Content
          className={cn(FX, styles.dialog)}
          aria-describedby={undefined}
          data-testid="fantay-welcome"
          onOpenAutoFocus={(event) => {
            // The letter keys need focus inside, but not on the close button, where it draws a ring on arrival.
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
          onKeyDown={onKeyDown}
        >
          <DialogPrimitive.Close asChild>
            <IconButton className={styles.close} shape="round" aria-label={t('common.close')} tooltip={false}>
              <X strokeWidth={1.5} />
            </IconButton>
          </DialogPrimitive.Close>

          <div className={styles.hero}>
            <span className={styles.mascot}>
              <FantayMascot size={128} tracking grounded appear pulse={pulse} flip={flip} />
            </span>
            <DialogPrimitive.Title key={step.id} className={styles.title}>
              {t(step.titleKey)}
            </DialogPrimitive.Title>
            {step.multi ? <p className={styles.prompt}>{t(step.questionKey)}</p> : null}
          </div>

          <div key={step.id} className={styles.question}>
            <div
              className={styles.options}
              data-layout={step.id}
              role={step.multi ? 'group' : 'radiogroup'}
              aria-label={t(step.questionKey)}
            >
              {step.options.map((option, row) => {
                const on = stepPicked.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={styles.option}
                    role={step.multi ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    data-on={on ? '' : undefined}
                    data-testid={`fantay-welcome-option-${option.id}`}
                    onClick={() => toggle(option.id)}
                  >
                    {step.id === 'theme' ? <ThemeSwatch theme={option.id} /> : null}
                    <span className={styles.optionRow}>
                      <span className={styles.key} aria-hidden>
                        {on ? <Check size={13} strokeWidth={2.5} /> : String.fromCharCode(65 + row)}
                      </span>
                      {t(option.labelKey)}
                    </span>
                  </button>
                );
              })}
              {step.otherKey ? (
                <label className={styles.option} data-other="" data-on={stepOther.trim() ? '' : undefined}>
                  <span className={styles.optionRow}>
                    <span className={styles.key} aria-hidden>
                      {stepOther.trim() ? <Check size={13} strokeWidth={2.5} /> : String.fromCharCode(65 + step.options.length)}
                    </span>
                    <input
                      ref={otherRef}
                      className={styles.other}
                      value={stepOther}
                      placeholder={t(step.otherKey)}
                      aria-label={t(step.otherKey)}
                      data-testid="fantay-welcome-other"
                      onChange={(event) => editOther(event.target.value)}
                    />
                  </span>
                </label>
              ) : null}
            </div>
            {last ? <p className={styles.note}>{t('fantay.welcome.note')}</p> : null}
          </div>

          <footer className={styles.footer}>
            <span className={styles.progress}>
              {index > 0 ? (
                <IconButton size="xs" aria-label={t('fantay.welcome.prev')} tooltip={false} onClick={() => setIndex(index - 1)}>
                  <ChevronLeft strokeWidth={1.5} />
                </IconButton>
              ) : null}
              <span className={styles.dots} aria-label={`${index + 1} / ${STEPS.length}`} data-testid="fantay-welcome-page">
                {STEPS.map((entry, dot) => (
                  <span key={entry.id} className={styles.dot} data-on={dot <= index ? '' : undefined} />
                ))}
              </span>
            </span>
            <span className={styles.actions}>
              <Button variant="ghost" data-testid="fantay-welcome-skip" onClick={skip}>
                {t('fantay.welcome.skip')}
              </Button>
              <Button variant="primary" disabled={!canConfirm} data-testid="fantay-welcome-confirm" onClick={confirm}>
                {t(last ? 'fantay.welcome.finish' : 'fantay.welcome.confirm')}
                <CornerDownLeft strokeWidth={1.5} aria-hidden />
              </Button>
            </span>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
