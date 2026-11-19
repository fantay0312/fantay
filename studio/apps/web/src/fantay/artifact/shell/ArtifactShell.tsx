// SPDX-License-Identifier: AGPL-3.0-only
// The frame every artifact viewer sits in: one quiet bar, then the stage.
// The bar reads left to right as "what this is" (where the file lives, its name, a few facts), then
// "how I am looking at it" (view switch, zoom, page), then "what I can do with it" (icon actions, the
// overflow menu, at most one filled action). Identity left and a handful of 28px ghost buttons right
// is the layout the 代码 surface already uses, and the one t3code, LobeHub and Codex converge on.
// A viewer supplies data; it never draws its own toolbar, so every file type wears the same chrome.
'use client';

import { ChevronRight, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FxRoot,
  IconButton,
  Segmented,
  SegmentedItem,
  Spinner,
} from '../../ui';
import styles from './ArtifactShell.module.css';

export interface ArtifactMode {
  id: string;
  label: string;
}

export interface ArtifactAction {
  id: string;
  /** Tooltip and accessible name; also the visible text when `emphasis` is not `icon`. */
  label: string;
  icon: LucideIcon;
  onSelect(): void;
  /** Toggle state. Leave undefined for a plain action. */
  on?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  shortcut?: string;
  /** `icon` (default) is a 28px glyph; `label` adds the text; `primary` is the one filled action. */
  emphasis?: 'icon' | 'label' | 'primary';
}

export interface ArtifactMenuEntry {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect(): void;
  disabled?: boolean;
  shortcut?: string;
  tone?: 'default' | 'danger';
  /** Draws a separator above this entry. */
  separated?: boolean;
}

export type ArtifactShellState =
  /** `quiet` draws nothing: the grace period before a load is worth mentioning. */
  | { kind: 'loading'; label?: string; quiet?: boolean }
  | {
      kind: 'notice';
      /** The glyph above the title. */
      icon?: LucideIcon;
      title: string;
      description?: string;
      /** The one button under the text. */
      action?: { label: string; onSelect(): void };
      secondaryAction?: { label: string; onSelect(): void };
    };

/** How the stage holds the content. */
export type ArtifactStage =
  /** Edge to edge; the viewer scrolls itself (pages, grids, code). */
  | 'fill'
  /** One object centred on a quiet ground (an image, a model, a player). */
  | 'canvas'
  /** A reading column on paper (a document, an e-book, a notebook). */
  | 'page';

export interface ArtifactShellProps {
  /** Stable viewer id, for tests and per-viewer styling. */
  viewer: string;
  /** Project-relative path of the file. Drawn at the left of the bar as "folder › name". */
  path?: string;
  modes?: readonly ArtifactMode[];
  mode?: string;
  onModeChange?(mode: string): void;
  modesLabel?: string;
  /** Right, after the view switch: zoom, page, sheet and other "how I look at it" controls. */
  controls?: ReactNode;
  /** Quiet facts about the file ("960 × 640 · 5.6 KB"). The first thing dropped when space is short. */
  meta?: ReactNode;
  actions?: readonly ArtifactAction[];
  menu?: readonly ArtifactMenuEntry[];
  menuLabel?: string;
  /** Right edge of the bar, after the menu. */
  trailing?: ReactNode;
  /** Under the stage: sheet tabs, a page strip. */
  footer?: ReactNode;
  stage?: ArtifactStage;
  /** When set, replaces the content. */
  state?: ArtifactShellState | null;
  /** Stays mounted (hidden) behind a state, for viewers that must keep decoding. */
  keepContentMounted?: boolean;
  children?: ReactNode;
}

function ShellAction({ action }: { action: ArtifactAction }): JSX.Element {
  const Glyph = action.icon;
  if (action.emphasis === 'label' || action.emphasis === 'primary') {
    return (
      <Button
        size="sm"
        variant={action.emphasis === 'primary' ? 'primary' : 'ghost'}
        data-artifact-action={action.id}
        aria-pressed={action.on}
        disabled={action.disabled}
        disabledReason={action.disabledReason}
        onClick={action.onSelect}
      >
        <Glyph aria-hidden="true" strokeWidth={1.75} />
        {action.label}
      </Button>
    );
  }
  return (
    <IconButton
      size="sm"
      aria-label={action.label}
      data-artifact-action={action.id}
      tooltipSide="bottom"
      shortcut={action.shortcut}
      on={action.on}
      disabled={action.disabled}
      disabledReason={action.disabledReason}
      onClick={action.onSelect}
    >
      <Glyph aria-hidden="true" strokeWidth={1.75} />
    </IconButton>
  );
}

function ShellState({ state }: { state: ArtifactShellState }): JSX.Element {
  if (state.kind === 'loading') {
    if (state.quiet) return <div className={styles.state} data-artifact-state="pending" aria-busy="true" />;
    return (
      <div className={styles.state} role="status" data-artifact-state="loading">
        <Spinner size="md" label={state.label} />
        {state.label ? <span className={styles.stateHint}>{state.label}</span> : null}
      </div>
    );
  }
  const Glyph = state.icon;
  return (
    <div className={styles.state} data-artifact-state="notice">
      {Glyph ? (
        <span className={styles.stateGlyph}>
          <Glyph aria-hidden="true" size={22} strokeWidth={1.5} />
        </span>
      ) : null}
      <p className={styles.stateTitle}>{state.title}</p>
      {state.description ? <p className={styles.stateDescription}>{state.description}</p> : null}
      {state.action || state.secondaryAction ? (
        <div className={styles.stateActions}>
          {state.action ? (
            <Button size="sm" variant="primary" onClick={state.action.onSelect}>
              {state.action.label}
            </Button>
          ) : null}
          {state.secondaryAction ? (
            <Button size="sm" variant="ghost" onClick={state.secondaryAction.onSelect}>
              {state.secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "office/reports/q3.pdf" → folder "office / reports", name "q3.pdf". Exported for the web-page
 * viewer, which keeps its own toolbar but opens it with the same identity as every other file.
 */
export function ArtifactPath({ path }: { path: string }): JSX.Element {
  const parts = path.split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? path;
  const folder = parts.slice(0, -1).join(' / ');
  return (
    <span className={styles.identity} title={path} data-artifact-path="">
      {folder ? (
        <>
          <span className={styles.folder}>{folder}</span>
          <ChevronRight className={styles.separator} size={12} strokeWidth={1.75} aria-hidden="true" />
        </>
      ) : null}
      <span className={styles.name}>{name}</span>
    </span>
  );
}

export function ArtifactShell({
  viewer,
  path,
  modes,
  mode,
  onModeChange,
  modesLabel,
  controls,
  meta,
  actions,
  menu,
  menuLabel,
  trailing,
  footer,
  stage = 'fill',
  state = null,
  keepContentMounted = false,
  children,
}: ArtifactShellProps): JSX.Element {
  const hasModes = modes !== undefined && modes.length > 1 && mode !== undefined;
  const hasActions =
    hasModes || Boolean(controls) || (actions?.length ?? 0) > 0 || (menu?.length ?? 0) > 0 || Boolean(trailing);

  return (
    <FxRoot className={styles.root} data-artifact-viewer={viewer} data-testid="artifact-viewer">
      <div className={styles.bar} data-artifact-bar="">
        <div className={styles.lead}>
          {path ? <ArtifactPath path={path} /> : null}
          {meta ? <span className={styles.meta}>{meta}</span> : null}
        </div>
        {hasActions ? (
          <div className={styles.actions}>
            {hasModes ? (
              <Segmented
                size="sm"
                value={mode}
                onValueChange={(next) => onModeChange?.(next)}
                aria-label={modesLabel ?? ''}
                data-artifact-modes=""
              >
                {modes.map((item) => (
                  <SegmentedItem key={item.id} value={item.id}>
                    {item.label}
                  </SegmentedItem>
                ))}
              </Segmented>
            ) : null}
            {controls}
            {(hasModes || controls) && ((actions?.length ?? 0) > 0 || (menu?.length ?? 0) > 0) ? (
              <span className={styles.gap} aria-hidden="true" />
            ) : null}
            {actions?.map((action) => <ShellAction key={action.id} action={action} />)}
            {menu && menu.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton size="sm" aria-label={menuLabel ?? ''} tooltipSide="bottom" data-artifact-action="more">
                    <MoreHorizontal aria-hidden="true" strokeWidth={1.75} />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent width="md">
                  {menu.map((entry) => {
                    const Glyph = entry.icon;
                    return (
                      <Fragment key={entry.id}>
                        {entry.separated ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuItem
                          tone={entry.tone ?? 'default'}
                          disabled={entry.disabled}
                          shortcut={entry.shortcut}
                          icon={Glyph ? <Glyph aria-hidden="true" strokeWidth={1.75} /> : undefined}
                          onSelect={entry.onSelect}
                        >
                          {entry.label}
                        </DropdownMenuItem>
                      </Fragment>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {trailing}
          </div>
        ) : null}
      </div>
      <div className={styles.stage} data-stage={stage} data-artifact-stage="">
        {state ? <ShellState state={state} /> : null}
        {state && !keepContentMounted ? null : (
          <div className={styles.content} hidden={state !== null} data-stage={stage}>
            {children}
          </div>
        )}
      </div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </FxRoot>
  );
}
