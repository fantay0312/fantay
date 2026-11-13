// SPDX-License-Identifier: AGPL-3.0-only
// Prompt library of the generator panel (spec 05 §7; infinite-canvas prompt-select-dialog/prompt-card were
// UX references only). Templates of this surface from `GET /api/prompt-templates`, search and categories,
// a card grid with the template's source and licence (CC-BY templates need the credit), an argument form
// for `{argument name="…" default="…"}` placeholders, and replace / append when a prompt already exists.
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { BookOpen, Clapperboard, ImageIcon } from 'lucide-react';
import { fillTemplateArguments, parseTemplateArguments, type GenerationSurface, type TemplateArgument } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { fetchPromptTemplate } from '../../../providers/registry';
import type { PromptTemplateSummary } from '../../../types';
import { Button, Chip, Field, IconButton, Input, Popover, PopoverContent, PopoverTrigger, SearchField, Spinner } from '../../ui';
import { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS } from './board-interactive';
import { usePromptTemplates } from './prompt-library-data';
import styles from './PromptLibraryPopover.module.css';

export interface PromptLibraryApplyInput {
  prompt: string;
  mode: 'replace' | 'append';
  template: PromptTemplateSummary;
}

export interface PromptLibraryPopoverProps {
  surface: GenerationSurface;
  currentPrompt: string;
  onApply(input: PromptLibraryApplyInput): void;
  disabled?: boolean;
}

type Step =
  | { kind: 'browse' }
  | { kind: 'arguments'; template: PromptTemplateSummary; prompt: string; args: TemplateArgument[]; values: Record<string, string> }
  | { kind: 'confirm'; template: PromptTemplateSummary; text: string };

const ALL = '__all__';

function matchesTemplate(template: PromptTemplateSummary, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [template.title, template.summary, template.category, ...(template.tags ?? [])].join(' ').toLowerCase().includes(normalized);
}

/** `current + '\n\n' + text` (append), or the text alone (replace / empty prompt). */
export function combineTemplatePrompt(current: string, text: string, mode: 'replace' | 'append'): string {
  if (mode === 'replace' || !current.trim()) return text;
  return `${current.replace(/\s+$/, '')}\n\n${text}`;
}

export function PromptLibraryPopover({ surface, currentPrompt, onApply, disabled = false }: PromptLibraryPopoverProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { status, templates, retry } = usePromptTemplates(open);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL);
  const [step, setStep] = useState<Step>({ kind: 'browse' });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [detailFailedId, setDetailFailedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setStep({ kind: 'browse' });
    setPendingId(null);
    setDetailFailedId(null);
  }, [open]);

  const ofSurface = useMemo(() => templates.filter((template) => template.surface === surface), [templates, surface]);
  const categories = useMemo(() => [...new Set(ofSurface.map((template) => template.category).filter(Boolean))], [ofSurface]);
  const visible = useMemo(
    () => ofSurface.filter((template) => (category === ALL || template.category === category) && matchesTemplate(template, query)),
    [category, ofSurface, query],
  );

  const finish = (template: PromptTemplateSummary, text: string) => {
    if (!currentPrompt.trim()) {
      onApply({ prompt: text, mode: 'replace', template });
      setOpen(false);
      return;
    }
    setStep({ kind: 'confirm', template, text });
  };

  const pick = async (template: PromptTemplateSummary) => {
    setPendingId(template.id);
    setDetailFailedId(null);
    const detail = await fetchPromptTemplate(surface, template.id);
    setPendingId(null);
    if (!detail?.prompt) {
      setDetailFailedId(template.id);
      return;
    }
    const args = parseTemplateArguments(detail.prompt);
    if (args.length > 0) {
      setStep({
        kind: 'arguments',
        template,
        prompt: detail.prompt,
        args,
        values: Object.fromEntries(args.map((arg) => [arg.name, arg.defaultValue])),
      });
      return;
    }
    finish(template, detail.prompt);
  };

  let body: ReactNode;
  if (step.kind === 'arguments') {
    body = (
      <form
        className={styles.step}
        data-testid="fx-gen-library-arguments"
        onSubmit={(event) => {
          event.preventDefault();
          finish(step.template, fillTemplateArguments(step.prompt, step.values));
        }}
      >
        <span className={styles.stepTitle}>{t('fantay.prompts.arguments')}</span>
        {step.args.map((arg) => (
          <Field key={arg.name} label={arg.name} htmlFor={`fx-template-arg-${arg.name}`}>
            <Input
              id={`fx-template-arg-${arg.name}`}
              value={step.values[arg.name] ?? ''}
              data-testid={`fx-gen-library-argument-${arg.name}`}
              onChange={(event) => setStep({ ...step, values: { ...step.values, [arg.name]: event.target.value } })}
            />
          </Field>
        ))}
        <div className={styles.stepActions}>
          <Button variant="ghost" size="sm" onClick={() => setStep({ kind: 'browse' })}>
            {t('fantay.prompts.back')}
          </Button>
          <Button variant="primary" size="sm" type="submit" data-testid="fx-gen-library-insert">
            {t('fantay.prompts.insert')}
          </Button>
        </div>
      </form>
    );
  } else if (step.kind === 'confirm') {
    body = (
      <div className={styles.step} data-testid="fx-gen-library-confirm">
        <span className={styles.stepTitle}>{t('fantay.prompts.replaceConfirm')}</span>
        <div className={styles.stepActions}>
          <Button variant="ghost" size="sm" onClick={() => setStep({ kind: 'browse' })}>
            {t('fantay.prompts.back')}
          </Button>
          <Button
            variant="default"
            size="sm"
            data-testid="fx-gen-library-append"
            onClick={() => {
              onApply({ prompt: combineTemplatePrompt(currentPrompt, step.text, 'append'), mode: 'append', template: step.template });
              setOpen(false);
            }}
          >
            {t('fantay.prompts.append')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="fx-gen-library-replace"
            onClick={() => {
              onApply({ prompt: step.text, mode: 'replace', template: step.template });
              setOpen(false);
            }}
          >
            {t('fantay.prompts.replace')}
          </Button>
        </div>
      </div>
    );
  } else {
    let list: ReactNode;
    if (status === 'loading' || status === 'idle') {
      list = (
        <div className={styles.state}>
          <Spinner size="md" label={t('fantay.prompts.loading')} />
        </div>
      );
    } else if (status === 'error') {
      list = (
        <div className={styles.state} data-testid="fx-gen-library-error">
          <span>{t('promptTemplates.fetchError')}</span>
          <Button size="sm" variant="default" onClick={() => retry()}>
            {t('promptTemplates.retry')}
          </Button>
        </div>
      );
    } else if (visible.length === 0) {
      list = <div className={styles.state}>{t('promptTemplates.emptyNoMatch')}</div>;
    } else {
      list = (
        <div className={styles.grid}>
          {visible.map((template) => {
            const FallbackIcon = surface === 'video' ? Clapperboard : ImageIcon;
            return (
              <Button
                key={template.id}
                variant="ghost"
                className={styles.card}
                data-testid={`fx-gen-library-item-${template.id}`}
                loading={pendingId === template.id}
                disabled={pendingId !== null && pendingId !== template.id}
                onClick={() => void pick(template)}
              >
                <span className={styles.cover}>
                  {template.previewImageUrl ? (
                    <img src={template.previewImageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} />
                  ) : (
                    <FallbackIcon size={22} strokeWidth={1.5} aria-hidden />
                  )}
                </span>
                <span className={styles.cardBody}>
                  <span className={styles.cardTitle}>{template.title}</span>
                  <span className={styles.cardMeta}>{template.category}</span>
                  <span className={styles.cardMeta}>{t('fantay.prompts.source', { repo: template.source.repo, license: template.source.license })}</span>
                  {template.source.author ? (
                    <span className={styles.cardMeta}>{t('fantay.prompts.author', { author: template.source.author })}</span>
                  ) : null}
                  {detailFailedId === template.id ? <span className={styles.cardMeta}>{t('promptTemplates.fetchError')}</span> : null}
                </span>
              </Button>
            );
          })}
        </div>
      );
    }
    body = (
      <>
        <div className={styles.head}>
          <SearchField
            autoFocus
            value={query}
            placeholder={t('fantay.prompts.search')}
            aria-label={t('fantay.prompts.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {categories.length > 0 ? (
            <div className={styles.categories} role="group" aria-label={t('fantay.prompts.all')}>
              <Chip size="sm" variant="suggestion" on={category === ALL} aria-pressed={category === ALL} onClick={() => setCategory(ALL)}>
                {t('fantay.prompts.all')}
              </Chip>
              {categories.map((entry) => (
                <Chip key={entry} size="sm" variant="suggestion" on={category === entry} aria-pressed={category === entry} onClick={() => setCategory(entry)}>
                  {entry}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
        <div className={styles.scroll}>{list}</div>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton aria-label={t('fantay.prompts.open')} data-testid="fx-gen-library-trigger" disabled={disabled} {...BOARD_CONTROL_PROPS}>
          <BookOpen strokeWidth={1.5} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        width={560}
        align="start"
        side="top"
        className="p-0"
        aria-label={t('fantay.prompts.open')}
        data-testid="fx-gen-library"
        {...BOARD_INTERACTIVE_PROPS}
      >
        <div className={styles.content}>{body}</div>
      </PopoverContent>
    </Popover>
  );
}
