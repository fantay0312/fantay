'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay-original: the /fantay-ui gallery (spec 01 §4.6) — every primitive specimen (incl. the R14
 * extras and the B4 sizes) in the current theme and in side-by-side theme islands, plus a
 * `.fx-legacy` probe outside the Fantay root for the cascade e2e test. Sample copy is fixture text.
 * Test ids: specimen-<component>-<variant>-<size>[-<state>]; probe twins end in `--legacy`.
 */
import * as React from 'react';
import {
  Circle,
  Copy,
  Download,
  FileText,
  Film,
  Folder,
  Frame,
  Hand,
  Image as ImageGlyph,
  LayoutGrid,
  List,
  MousePointer2,
  Pencil,
  Settings,
  Share2,
  Sparkles,
  Square,
  Trash2,
  Type,
} from 'lucide-react';

import { ThemeSegmented } from '../../theme/ThemeSegmented';
import { BoundaryStatesShowcase } from '../BoundaryStatesShowcase';
import { Avatar, AvatarStack } from '../avatar';
import { Button } from '../button';
import { Callout } from '../callout';
import { Checkbox, CheckboxCard, CheckboxField } from '../checkbox';
import { Chip } from '../chip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Disclosure } from '../collapsible';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../context-menu';
import { ConfirmDialog, Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle, type ModalSize } from '../dialog';
import { Dot } from '../dot';
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuCheckboxItem,
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
} from '../dropdown-menu';
import { EmptyState } from '../empty-state';
import { Field } from '../field';
import { FxRoot } from '../fx';
import { IconButton } from '../icon-button';
import { ChevronDownIcon, Icon, InfoIcon, MoreHorizontalIcon, PlusIcon, SearchIcon, XIcon } from '../icons';
import { Input, InputGroup, InputGroupClear } from '../input';
import { Kbd, KbdCombo } from '../kbd';
import { Panel, PanelBody, PanelClose, PanelHeader, Section } from '../panel';
import { Popover, PopoverContent, PopoverTrigger, type PopoverWidth } from '../popover';
import { Progress } from '../progress';
import { SearchField } from '../search-field';
import { Segmented, SegmentedIconItem, SegmentedIcons, SegmentedItem } from '../segmented';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '../select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, type SheetSide } from '../sheet';
import { Skeleton } from '../skeleton';
import { Spinner } from '../spinner';
import { StatusLabel } from '../status-label';
import { Switch } from '../switch';
import { Tabs, TabsContent, TabsIconTrigger, TabsList, TabsTrigger } from '../tabs';
import { Textarea } from '../textarea';
import { MetaLine, Tile, TileBody, TileCover } from '../tile';
import { Toaster, toast } from '../toast';
import { Toolbar, ToolbarControl, ToolbarDot, ToolbarHighlight, ToolbarSeparator } from '../toolbar';
import { Tooltip } from '../tooltip';
import { VisuallyHidden } from '../visually-hidden';

/* ── fixture tables (literal class strings so the Tailwind scanner sees them) ─────────────── */

const COLOR_TOKENS = [
  'paper',
  'paper-deep',
  'surface',
  'sub',
  'sidebar',
  'ink',
  'ink-soft',
  'ink-faint',
  'ink-ghost',
  'line',
  'line-soft',
  'dot',
  'brand',
  'brand-hover',
  'brand-ink',
  'brand-soft',
  'on-brand',
  'accent-ink',
  'danger',
  'danger-hover',
  'on-danger',
  'success',
  'success-ink',
  'success-on-ink',
  'warning',
  'warning-ink',
  'code',
  'code-ink',
  'glaze-ring',
  'scrim',
  'focus-ring-color',
] as const;

const RADII = {
  tag: 'rounded-tag',
  row: 'rounded-row',
  control: 'rounded-control',
  pill: 'rounded-pill',
  card: 'rounded-card',
  panel: 'rounded-panel',
  modal: 'rounded-modal',
} as const;

const SHADOWS = {
  ring: 'shadow-ring',
  'ring-hover': 'shadow-ring-hover',
  float: 'shadow-float',
  pop: 'shadow-pop',
  modal: 'shadow-modal',
  card: 'shadow-card',
  'elevation-1': 'shadow-elevation-1',
  'elevation-1-hover': 'shadow-elevation-1-hover',
  'elevation-1-focus': 'shadow-elevation-1-focus',
  'elevation-2': 'shadow-elevation-2',
} as const;

const TYPE_SCALE = {
  micro: 'text-micro',
  caption: 'text-caption',
  label: 'text-label',
  body: 'text-body',
  copy: 'text-copy',
  lead: 'text-lead',
  heading: 'text-heading',
  title: 'text-title',
  display: 'text-display',
} as const;

const BUTTON_VARIANTS = ['default', 'primary', 'ghost', 'danger', 'bare', 'link', 'brand'] as const;
const BUTTON_SIZES = ['sm', 'md', 'lg'] as const;
const ICON_BUTTON_VARIANTS = ['quiet', 'danger', 'primary', 'brand', 'frosted'] as const;
const ICON_BUTTON_SIZES = ['xs', 'sm', 'md', 'lg'] as const;
const MODAL_SIZES: readonly ModalSize[] = ['sm', 'md', 'lg', 'xl', '2xl'];
const POPOVER_WIDTHS: readonly PopoverWidth[] = ['sm', 'md', 'lg', 'auto', 300];
const DOT_TONES = ['current', 'idle', 'running', 'done', 'failed', 'muted'] as const;

const TOOLS = [
  { key: 'select', label: 'Select', shortcut: 'v', glyph: MousePointer2 },
  { key: 'hand', label: 'Hand', shortcut: 'h', glyph: Hand },
  { key: 'frame', label: 'Frame', shortcut: 'f', glyph: Frame },
  { key: 'rect', label: 'Rectangle', shortcut: 'r', glyph: Square },
  { key: 'ellipse', label: 'Ellipse', shortcut: 'o', glyph: Circle },
  { key: 'text', label: 'Text', shortcut: 't', glyph: Type },
] as const;

const PEOPLE = [
  { id: 'p1', name: '张三', color: 'var(--brand)' },
  { id: 'p2', name: 'Ada Lovelace', color: 'var(--success)' },
  { id: 'p3', name: 'Grace Hopper', color: 'var(--warning)' },
  { id: 'p4', name: '李四', color: 'var(--accent-ink)' },
  { id: 'p5', name: 'Alan Turing' },
];

/* ── layout helpers ──────────────────────────────────────────────────────────────────────── */

function GallerySection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section
      data-testid={`gallery-section-${id}`}
      aria-labelledby={`gallery-${id}`}
      className="flex flex-col gap-4 border-0 border-t border-solid border-line-soft pt-5"
    >
      <h2 id={`gallery-${id}`} className="text-heading font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-28 flex-none text-caption text-ink-faint">{label}</span>
      {children}
    </div>
  );
}

/* ── sections ────────────────────────────────────────────────────────────────────────────── */

function TokensSection() {
  return (
    <GallerySection id="tokens" title="Tokens">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
        {COLOR_TOKENS.map((token) => (
          <div key={token} data-testid={`token-swatch-${token}`} className="flex items-center gap-2">
            <span
              className="size-8 flex-none rounded-control shadow-ring"
              style={{ background: `var(--${token})` }}
            />
            <span className="font-mono text-caption text-ink-soft">--{token}</span>
          </div>
        ))}
      </div>
      <Row label="Radii">
        {Object.entries(RADII).map(([name, className]) => (
          <div key={name} className="flex flex-col items-center gap-1">
            <span className={`size-12 border border-solid border-line bg-surface ${className}`} />
            <span className="text-caption text-ink-faint">{name}</span>
          </div>
        ))}
      </Row>
      <Row label="Shadows">
        {Object.entries(SHADOWS).map(([name, className]) => (
          <div key={name} className="flex flex-col items-center gap-2">
            <span className={`size-14 rounded-card bg-surface ${className}`} />
            <span className="text-caption text-ink-faint">{name}</span>
          </div>
        ))}
      </Row>
      <div className="flex flex-col gap-2">
        {Object.entries(TYPE_SCALE).map(([name, className]) => (
          <div key={name} className="flex items-baseline gap-4">
            <span className="w-20 flex-none font-mono text-caption text-ink-faint">{name}</span>
            <span className={`${className} text-ink`}>设计 Design 12.5</span>
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

function ButtonsSection() {
  return (
    <GallerySection id="buttons" title="Button">
      {BUTTON_VARIANTS.map((variant) => (
        <Row key={variant} label={variant}>
          {BUTTON_SIZES.map((size) => (
            <Button key={size} data-testid={`specimen-button-${variant}-${size}`} variant={variant} size={size}>
              <PlusIcon />
              {size === 'sm' ? 'Small' : size === 'md' ? 'Create' : 'Large action'}
            </Button>
          ))}
          <Button data-testid={`specimen-button-${variant}-md-disabled`} variant={variant} disabled>
            Disabled
          </Button>
          <Button
            data-testid={`specimen-button-${variant}-md-reason`}
            variant={variant}
            disabled
            disabledReason="Connect a model first"
          >
            With reason
          </Button>
          <Button data-testid={`specimen-button-${variant}-md-loading`} variant={variant} loading>
            Saving
          </Button>
        </Row>
      ))}
      <Row label="icon sizes">
        <Button data-testid="specimen-button-default-icon" variant="default" size="icon" aria-label="Settings">
          <Icon icon={Settings} />
        </Button>
        <Button data-testid="specimen-button-ghost-icon-sm" variant="ghost" size="icon-sm" aria-label="Copy">
          <Icon icon={Copy} />
        </Button>
        <Button data-testid="specimen-button-primary-md-block" variant="primary" block className="max-w-80">
          Block
        </Button>
      </Row>
    </GallerySection>
  );
}

function IconButtonsSection() {
  const [on, setOn] = React.useState(true);
  return (
    <GallerySection id="icon-buttons" title="IconButton">
      {ICON_BUTTON_VARIANTS.map((variant) => (
        <Row key={variant} label={variant}>
          {ICON_BUTTON_SIZES.map((size) => (
            <IconButton
              key={size}
              data-testid={`specimen-icon-button-${variant}-${size}`}
              variant={variant}
              size={size}
              aria-label={`More (${size})`}
            >
              <MoreHorizontalIcon />
            </IconButton>
          ))}
          <IconButton data-testid={`specimen-icon-button-${variant}-md-disabled`} variant={variant} disabled aria-label="Delete">
            <Icon icon={Trash2} />
          </IconButton>
          <IconButton
            data-testid={`specimen-icon-button-${variant}-md-reason`}
            variant={variant}
            disabled
            disabledReason="Nothing selected"
            aria-label="Delete"
          >
            <Icon icon={Trash2} />
          </IconButton>
        </Row>
      ))}
      <Row label="toggle / round">
        <IconButton
          data-testid="specimen-icon-button-quiet-md-on"
          aria-label="Layers"
          shortcut="mod+shift+l"
          on={on}
          onClick={() => setOn((value) => !value)}
        >
          <Icon icon={LayoutGrid} />
        </IconButton>
        <IconButton data-testid="specimen-icon-button-primary-md-round" variant="primary" shape="round" aria-label="Send">
          <Icon icon={Sparkles} />
        </IconButton>
      </Row>
    </GallerySection>
  );
}

function ToolbarSpecimen({ size, testId }: { size: 'sm' | 'md'; testId: string }) {
  const [tool, setTool] = React.useState<string>('select');
  return (
    <Toolbar aria-label={`Tools (${size})`} data-testid={testId}>
      <ToolbarHighlight activeKey={tool} />
      {TOOLS.map((entry) => (
        <ToolbarControl
          key={entry.key}
          data-testid={`specimen-toolbar-button-${size}-${entry.key}`}
          size={size}
          label={entry.label}
          shortcut={entry.shortcut}
          pressed={tool === entry.key}
          className="not-data-disabled:hover:bg-transparent"
          onClick={() => setTool(entry.key)}
        >
          <Icon icon={entry.glyph} />
          {entry.key === 'frame' ? <ToolbarDot tone="brand" /> : null}
        </ToolbarControl>
      ))}
      <ToolbarSeparator />
      <ToolbarControl data-testid={`specimen-toolbar-button-${size}-disabled`} size={size} label="Export (disabled)" disabled>
        <Icon icon={Download} />
      </ToolbarControl>
    </Toolbar>
  );
}

function ToolbarSection() {
  return (
    <GallerySection id="toolbar" title="Toolbar">
      <Row label="sm (28)">
        <ToolbarSpecimen size="sm" testId="specimen-toolbar-horizontal-sm" />
      </Row>
      <Row label="md (32)">
        <ToolbarSpecimen size="md" testId="specimen-toolbar-horizontal-md" />
      </Row>
      <Row label="vertical">
        <Toolbar aria-label="Rail" orientation="vertical" data-testid="specimen-toolbar-vertical-sm">
          <ToolbarControl label="Files" side="right">
            <Icon icon={Folder} />
          </ToolbarControl>
          <ToolbarControl label="Images" side="right">
            <Icon icon={ImageGlyph} />
            <ToolbarDot tone="success" />
          </ToolbarControl>
          <ToolbarSeparator orientation="vertical" />
          <ToolbarControl label="Videos" side="right">
            <Icon icon={Film} />
            <ToolbarDot tone="danger" />
          </ToolbarControl>
        </Toolbar>
      </Row>
    </GallerySection>
  );
}

function SegmentedSection() {
  const [view, setView] = React.useState('board');
  const [small, setSmall] = React.useState('day');
  const [layout, setLayout] = React.useState('grid');
  return (
    <GallerySection id="segmented" title="Segmented">
      <Row label="md">
        <Segmented data-testid="specimen-segmented-md" aria-label="View" value={view} onValueChange={setView}>
          <SegmentedItem value="board">画板</SegmentedItem>
          <SegmentedItem value="files">文件</SegmentedItem>
          <SegmentedItem value="system">Design system</SegmentedItem>
        </Segmented>
      </Row>
      <Row label="sm">
        <Segmented data-testid="specimen-segmented-sm" aria-label="Range" size="sm" value={small} onValueChange={setSmall}>
          <SegmentedItem value="day">Day</SegmentedItem>
          <SegmentedItem value="week">Week</SegmentedItem>
          <SegmentedItem value="month" disabled>
            Month
          </SegmentedItem>
        </Segmented>
      </Row>
      <Row label="icons">
        <SegmentedIcons data-testid="specimen-segmented-icons-md" aria-label="Layout" value={layout} onValueChange={setLayout}>
          <SegmentedIconItem value="grid" aria-label="Grid">
            <Icon icon={LayoutGrid} />
          </SegmentedIconItem>
          <SegmentedIconItem value="list" aria-label="List">
            <Icon icon={List} />
          </SegmentedIconItem>
        </SegmentedIcons>
      </Row>
      <Row label="theme">
        <ThemeSegmented size="sm" />
      </Row>
    </GallerySection>
  );
}

function TabsSection() {
  return (
    <GallerySection id="tabs" title="Tabs">
      <Tabs defaultValue="board" data-testid="specimen-tabs-line-md">
        <TabsList variant="line" size="md" aria-label="Workspace">
          <TabsTrigger value="board">画板</TabsTrigger>
          <TabsTrigger value="files">文件</TabsTrigger>
          <TabsTrigger value="system">设计系统</TabsTrigger>
          <TabsTrigger value="disabled" disabled>
            Disabled
          </TabsTrigger>
        </TabsList>
        <TabsContent value="board" className="py-3 text-body text-ink-soft">
          Board content
        </TabsContent>
        <TabsContent value="files" className="py-3 text-body text-ink-soft">
          Files content
        </TabsContent>
        <TabsContent value="system" className="py-3 text-body text-ink-soft">
          Design system content
        </TabsContent>
      </Tabs>
      <Tabs defaultValue="activity" data-testid="specimen-tabs-pill-sm">
        <TabsList aria-label="Panel">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="inspect">Inspect</TabsTrigger>
          <TabsIconTrigger value="layers" icon={<Icon icon={FileText} />}>
            Layers
          </TabsIconTrigger>
        </TabsList>
        <TabsContent value="activity" className="py-3 text-body text-ink-soft">
          Activity panel
        </TabsContent>
        <TabsContent value="inspect" className="py-3 text-body text-ink-soft">
          Inspect panel
        </TabsContent>
        <TabsContent value="layers" className="py-3 text-body text-ink-soft">
          Layers panel
        </TabsContent>
      </Tabs>
    </GallerySection>
  );
}

function MenusSection() {
  const [grid, setGrid] = React.useState(true);
  const [sort, setSort] = React.useState('recent');
  return (
    <GallerySection id="menus" title="Menus">
      <Row label="dropdown">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="specimen-dropdown-menu-trigger">
              Project
              <ChevronDownIcon size="sm" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="md">
            <DropdownMenuLabel>Ada Lovelace</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Icon icon={Pencil} />} shortcut="f2">
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Icon icon={Copy} />} shortcut="mod+d" description="Copies files and the board">
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Icon icon={Share2} />} disabled>
              Share (disabled)
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={grid} onCheckedChange={(value) => setGrid(value === true)}>
              Show grid
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCaption>Sort by</DropdownMenuCaption>
            <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
              <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name" description="A to Z">
                Name
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={<Icon icon={Download} />}>Export</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>PNG</DropdownMenuItem>
                <DropdownMenuItem>PDF</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" icon={<Icon icon={Trash2} />} shortcut="backspace">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>
      <Row label="context">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              data-testid="specimen-context-menu-area"
              className="grid h-20 w-64 place-items-center rounded-card border border-dashed border-line text-caption text-ink-faint"
            >
              Right-click here
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>Node</ContextMenuLabel>
            <ContextMenuItem icon={<Icon icon={Copy} />} shortcut="mod+c">
              Copy
            </ContextMenuItem>
            <ContextMenuCheckboxItem checked>Locked</ContextMenuCheckboxItem>
            <ContextMenuSeparator />
            <ContextMenuItem tone="danger" shortcut="backspace">
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Row>
    </GallerySection>
  );
}

function OverlaysSection() {
  const [modalSize, setModalSize] = React.useState<ModalSize | null>(null);
  const [confirm, setConfirm] = React.useState<'default' | 'destructive' | null>(null);
  const [sheet, setSheet] = React.useState<SheetSide | null>(null);
  return (
    <GallerySection id="overlays" title="Tooltip · Dialog · Popover · Sheet">
      <Row label="tooltip">
        <Tooltip label="Search the workspace" shortcut="mod+k">
          <Button data-testid="specimen-tooltip-trigger" variant="ghost">
            <SearchIcon />
            Hover or focus me
          </Button>
        </Tooltip>
      </Row>
      <Row label="modal">
        {MODAL_SIZES.map((size) => (
          <Button key={size} data-testid={`specimen-modal-open-${size}`} onClick={() => setModalSize(size)}>
            Modal {size}
          </Button>
        ))}
        <Modal open={modalSize !== null} onClose={() => setModalSize(null)} size={modalSize ?? 'md'} data-testid="specimen-modal">
          <ModalEyebrow>Board</ModalEyebrow>
          <ModalTitle>New design</ModalTitle>
          <ModalLede>Pick a size; you can change it later.</ModalLede>
          <div className="mt-4 flex flex-col gap-3">
            <Field label="Name" htmlFor="gallery-modal-name" labelVariant="form">
              <Input id="gallery-modal-name" placeholder="Untitled design" />
            </Field>
          </div>
          <ModalActions>
            <Button variant="ghost" onClick={() => setModalSize(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setModalSize(null)}>
              Create
            </Button>
          </ModalActions>
        </Modal>
      </Row>
      <Row label="confirm">
        <Button data-testid="specimen-confirm-open-default" onClick={() => setConfirm('default')}>
          Confirm
        </Button>
        <Button data-testid="specimen-confirm-open-destructive" variant="danger" onClick={() => setConfirm('destructive')}>
          Delete…
        </Button>
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={confirm === 'destructive' ? 'Delete this board?' : 'Publish the gallery?'}
          description="Fixture copy for the gallery."
          confirmLabel={confirm === 'destructive' ? 'Delete board' : undefined}
          destructive={confirm === 'destructive'}
          onConfirm={() => setConfirm(null)}
        />
      </Row>
      <Row label="popover">
        {POPOVER_WIDTHS.map((width) => (
          <Popover key={String(width)}>
            <PopoverTrigger asChild>
              <Button data-testid={`specimen-popover-${width}`} variant="ghost">
                {typeof width === 'number' ? `${width}px` : width}
              </Button>
            </PopoverTrigger>
            <PopoverContent width={width} className="p-3">
              <p className="text-body text-ink">Popover width: {String(width)}</p>
              <p className="mt-1 text-caption text-ink-faint">Escape or an outside click closes it.</p>
            </PopoverContent>
          </Popover>
        ))}
      </Row>
      <Row label="sheet">
        {(['right', 'left', 'bottom'] as const).map((side) => (
          <Button key={side} data-testid={`specimen-sheet-open-${side}`} onClick={() => setSheet(side)}>
            Sheet {side}
          </Button>
        ))}
        <Sheet
          open={sheet !== null}
          onOpenChange={(open) => {
            if (!open) setSheet(null);
          }}
        >
          <SheetContent side={sheet ?? 'right'} width={sheet === 'left' ? 280 : 520} data-testid="specimen-sheet">
            <SheetHeader>
              <SheetTitle>素材库</SheetTitle>
              <SheetDescription>Fixture sheet content.</SheetDescription>
            </SheetHeader>
            <div className="px-4 text-body text-ink-soft">Body</div>
            <SheetFooter>
              <Button variant="primary" onClick={() => setSheet(null)}>
                Done
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Row>
    </GallerySection>
  );
}

function InputsSection() {
  const [query, setQuery] = React.useState('board');
  return (
    <GallerySection id="inputs" title="Input · InputGroup · Textarea · Field · SearchField">
      <Row label="input">
        <Input data-testid="specimen-input-default-sm" inputSize="sm" placeholder="Small" className="w-48" />
        <Input data-testid="specimen-input-default-md" placeholder="Project name" className="w-48" />
        <Input data-testid="specimen-input-default-lg" inputSize="lg" placeholder="Large" className="w-48" />
        <Input data-testid="specimen-input-well-md" variant="well" placeholder="Well" className="w-48" />
        <Input data-testid="specimen-input-mono-md" variant="mono" defaultValue="1440" className="w-24" />
        <Input data-testid="specimen-input-title-md" variant="title" defaultValue="Untitled board" className="w-48" />
      </Row>
      <Row label="states">
        <Input data-testid="specimen-input-default-md-invalid" aria-invalid defaultValue="bad value" className="w-48" />
        <Input data-testid="specimen-input-default-md-disabled" disabled defaultValue="Disabled" className="w-48" />
      </Row>
      <Row label="group">
        <InputGroup
          data-testid="specimen-input-group-md"
          className="w-64"
          leading={<SearchIcon size="sm" />}
          trailing={query ? <InputGroupClear onClear={() => setQuery('')} /> : <Kbd>⌘K</Kbd>}
        >
          <Input
            variant="bare"
            inputSize="auto"
            className="h-full flex-1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
          />
        </InputGroup>
        <InputGroup data-testid="specimen-input-group-sm-invalid" size="sm" invalid className="w-48">
          <Input variant="bare" inputSize="auto" className="h-full flex-1" defaultValue="Invalid" aria-invalid />
        </InputGroup>
      </Row>
      <Row label="search">
        <SearchField data-testid="specimen-search-field-ring" placeholder="Search projects" className="w-64" trailing={<Kbd>⌘K</Kbd>} />
        <div className="w-80 rounded-card bg-surface shadow-ring">
          <SearchField data-testid="specimen-search-field-bar" variant="bar" placeholder="Type a command" />
        </div>
      </Row>
      <Row label="textarea">
        <Textarea data-testid="specimen-textarea-default" rows={3} placeholder="Describe the design" className="w-64" />
        <Textarea data-testid="specimen-textarea-well" variant="well" rows={3} placeholder="Well" className="w-48" />
        <Textarea data-testid="specimen-textarea-code" variant="code" rows={3} defaultValue={'<div class="hero">\n  Hi\n</div>'} className="w-64" />
      </Row>
      <Row label="field">
        <Field className="w-56" label="Name" hint="Shown on the board." htmlFor="gallery-field-name" labelVariant="form">
          <Input id="gallery-field-name" placeholder="Untitled" />
        </Field>
        <Field className="w-56" label="Width" error="Must be at least 64." htmlFor="gallery-field-width">
          <Input id="gallery-field-width" variant="mono" aria-invalid defaultValue="12" />
        </Field>
      </Row>
    </GallerySection>
  );
}

function SelectSection() {
  const [model, setModel] = React.useState('');
  return (
    <GallerySection id="select" title="Select">
      <Row label="md / sm">
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger data-testid="specimen-select-md" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Image</SelectLabel>
              <SelectItem value="gpt-image">GPT Image</SelectItem>
              <SelectItem value="nano-banana">Nano Banana</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Video</SelectLabel>
              <SelectItem value="veo">Veo</SelectItem>
              <SelectItem value="disabled" disabled>
                Unavailable
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select defaultValue="1:1">
          <SelectTrigger data-testid="specimen-select-sm" size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1:1">1:1</SelectItem>
            <SelectItem value="16:9">16:9</SelectItem>
            <SelectItem value="9:16">9:16</SelectItem>
          </SelectContent>
        </Select>
        <Select disabled>
          <SelectTrigger data-testid="specimen-select-md-disabled" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="x">X</SelectItem>
          </SelectContent>
        </Select>
      </Row>
    </GallerySection>
  );
}

function ControlsSection() {
  const [live, setLive] = React.useState(true);
  const [checked, setChecked] = React.useState(true);
  const [card, setCard] = React.useState(false);
  const [chipOn, setChipOn] = React.useState(false);
  const [removed, setRemoved] = React.useState(false);
  return (
    <GallerySection id="controls" title="Switch · Checkbox · Chip · Kbd">
      <Row label="switch">
        <Switch data-testid="specimen-switch-md" aria-label="Live preview" checked={live} onCheckedChange={setLive} />
        <Switch data-testid="specimen-switch-sm" size="sm" aria-label="Small switch" defaultChecked />
        <Switch data-testid="specimen-switch-md-disabled" aria-label="Disabled switch" disabled />
      </Row>
      <Row label="checkbox">
        <CheckboxField
          data-testid="specimen-checkbox-checked"
          label="Include assets"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
        <CheckboxField data-testid="specimen-checkbox-indeterminate" label="Some selected" indeterminate defaultChecked={false} />
        <CheckboxField data-testid="specimen-checkbox-disabled" label="Disabled" description="Needs an account" disabled />
        <label className="relative inline-flex items-center gap-2 text-body text-ink">
          <Checkbox data-testid="specimen-checkbox-bare" aria-label="Bare checkbox" defaultChecked />
          Bare
        </label>
      </Row>
      <Row label="checkbox card">
        <CheckboxCard
          className="w-80"
          checked={card}
          onChange={setCard}
          title="Keep the original"
          description="A copy is made next to it."
        />
      </Row>
      <Row label="chip">
        <Chip data-testid="specimen-chip-solid-md" icon={<Icon icon={ImageGlyph} />}>
          Image
        </Chip>
        <Chip data-testid="specimen-chip-solid-sm" size="sm">
          16:9 · 5 s
        </Chip>
        <Chip
          data-testid="specimen-chip-suggestion-md"
          variant="suggestion"
          on={chipOn}
          icon={<Icon icon={Sparkles} />}
          onClick={() => setChipOn((value) => !value)}
        >
          Suggestion
        </Chip>
        <Chip data-testid="specimen-chip-warning-md" tone="warning" icon={<InfoIcon />}>
          3 references ignored
        </Chip>
        <Chip data-testid="specimen-chip-danger-sm" tone="danger" size="sm">
          Broken reference
        </Chip>
        {removed ? null : (
          <Chip data-testid="specimen-chip-solid-md-removable" onRemove={() => setRemoved(true)}>
            Template: Poster
          </Chip>
        )}
        <Chip data-testid="specimen-chip-solid-md-disabled" disabled>
          Disabled
        </Chip>
      </Row>
      <Row label="kbd">
        <Kbd>Esc</Kbd>
        <KbdCombo shortcut="mod+shift+k" />
        <span className="inline-flex items-center gap-2 rounded-row bg-ink px-2 py-1 text-caption text-paper">
          On ink
          <KbdCombo shortcut="mod+enter" variant="onInk" />
        </span>
        <KbdCombo shortcut="alt+backspace" variant="plain" />
      </Row>
    </GallerySection>
  );
}

function PeopleAndStatusSection() {
  return (
    <GallerySection id="status" title="Avatar · Dot · StatusLabel · Spinner · Skeleton · Progress">
      <Row label="avatar">
        <Avatar data-testid="specimen-avatar-18" name="Ada Lovelace" color="var(--brand)" size={18} />
        <Avatar data-testid="specimen-avatar-24" name="张三" color="var(--success)" />
        <Avatar data-testid="specimen-avatar-32" name="Grace Hopper" color="var(--warning)" size={32} />
        <Avatar data-testid="specimen-avatar-40" name="李四" size={40} />
        <Avatar data-testid="specimen-avatar-ink" name="Alan Turing" tone="ink" size={28} />
        <Avatar data-testid="specimen-avatar-agent" name="Agent" kind="agent" glaze icon={<Icon icon={Sparkles} size="sm" />} />
        <AvatarStack data-testid="specimen-avatar-stack" people={PEOPLE} />
      </Row>
      <Row label="dot">
        {DOT_TONES.map((tone) => (
          <span key={tone} className="inline-flex items-center gap-1.5 text-caption text-ink-soft">
            <Dot tone={tone} />
            {tone}
          </span>
        ))}
        <Dot tone="running" shape="square" size="lg" />
      </Row>
      <Row label="status label">
        <StatusLabel data-testid="specimen-status-label-done" tone="done">
          Connected
        </StatusLabel>
        <StatusLabel data-testid="specimen-status-label-muted">Not connected</StatusLabel>
      </Row>
      <Row label="spinner">
        <Spinner size="xs" />
        <Spinner size="sm" />
        <Spinner size="md" label="Loading" />
        <Spinner size="lg" className="text-brand" />
      </Row>
      <Row label="skeleton">
        <Skeleton shape="line" className="w-40" />
        <Skeleton shape="row" index={1} className="w-48" />
        <Skeleton shape="card" index={2} className="w-48" />
        <Skeleton shape="tile" index={3} className="w-48" />
      </Row>
      <Row label="progress">
        <Progress data-testid="specimen-progress-0" aria-label="Upload 0%" value={0} className="w-40" />
        <Progress data-testid="specimen-progress-40" aria-label="Upload 40%" value={40} className="w-40" />
        <Progress data-testid="specimen-progress-100" aria-label="Upload done" value={100} className="w-40" />
        <Progress data-testid="specimen-progress-indeterminate" aria-label="Rendering" value={null} className="w-40" />
      </Row>
    </GallerySection>
  );
}

function SurfacesSection() {
  const [width, setWidth] = React.useState(300);
  const [open, setOpen] = React.useState(false);
  return (
    <GallerySection id="surfaces" title="Panel · Section · Collapsible · Callout · EmptyState · Tile">
      <Row label="panel">
        <div className="relative h-72 w-[min(640px,100%)] overflow-hidden rounded-card border border-solid border-line-soft bg-paper">
          <Panel
            data-testid="specimen-panel-docked"
            surface="docked"
            resize={{ edge: 'end', width, min: 220, max: 480, onResize: setWidth }}
          >
            <PanelHeader>
              Inspector
              <PanelClose />
            </PanelHeader>
            <PanelBody>
              <Section title="Layout" actions={<IconButton size="xs" aria-label="Add"><PlusIcon /></IconButton>}>
                <p className="text-body text-ink-soft">Width {width}px</p>
              </Section>
              <Section title="Fill" collapsible data-testid="specimen-section-collapsible">
                <p className="text-body text-ink-soft">Collapsible body</p>
              </Section>
            </PanelBody>
          </Panel>
        </div>
      </Row>
      <Row label="collapsible">
        <Collapsible open={open} onOpenChange={setOpen} data-testid="specimen-collapsible">
          <CollapsibleTrigger>Advanced options</CollapsibleTrigger>
          <CollapsibleContent className="mt-2 text-body text-ink-soft">Seed, steps, guidance.</CollapsibleContent>
        </Collapsible>
        <Disclosure data-testid="specimen-disclosure" label="What changed">
          <p className="text-body text-ink-soft">The body stays mounted while folded.</p>
        </Disclosure>
      </Row>
      <Row label="callout">
        <Callout data-testid="specimen-callout-neutral">A reset link was sent.</Callout>
        <Callout data-testid="specimen-callout-error" tone="error">
          The render failed: no frames.
        </Callout>
        <Callout data-testid="specimen-callout-success" tone="success">
          Exported 3 images.
        </Callout>
      </Row>
      <div className="grid gap-4 md:grid-cols-2">
        <EmptyState
          data-testid="specimen-empty-state-card"
          title="No boards yet"
          description="Start from a prompt, or drop images here."
          action={<Button variant="primary">New board</Button>}
        />
        <EmptyState
          data-testid="specimen-empty-state-dashed"
          variant="dashed"
          illustration={<Icon icon={Folder} size="xl" className="text-ink-faint" />}
          title="Nothing here"
          description="Files you create appear in this list."
          action={<Button>Upload</Button>}
        />
      </div>
      <Row label="tile">
        {(['frosted', 'solid'] as const).map((tone) => (
          <Tile key={tone} data-testid={`specimen-tile-${tone}`} tone={tone} className="w-56">
            <TileCover>
              <Icon icon={ImageGlyph} size="xl" className="text-ink-faint" />
            </TileCover>
            <TileBody>
              <div className="truncate text-body font-medium text-ink">Poster series</div>
              <MetaLine trailing={<StatusLabel tone="done">Live</StatusLabel>}>
                <span>12 images</span>
                {tone === 'solid' ? null : <span>2 h ago</span>}
                <span>Ada</span>
              </MetaLine>
            </TileBody>
          </Tile>
        ))}
      </Row>
      <Row label="visually hidden">
        <Button data-testid="specimen-visually-hidden" variant="ghost" size="icon">
          <XIcon />
          <VisuallyHidden>Close preview</VisuallyHidden>
        </Button>
      </Row>
    </GallerySection>
  );
}

function ToastSection() {
  return (
    <GallerySection id="toast" title="Toast">
      <Row label="toast">
        <Button data-testid="specimen-toast-default" onClick={() => toast({ title: 'Board saved' })}>
          Default
        </Button>
        <Button
          data-testid="specimen-toast-success"
          onClick={() => toast({ title: 'Exported', description: '3 images in Downloads', tone: 'success' })}
        >
          Success
        </Button>
        <Button
          data-testid="specimen-toast-danger"
          onClick={() => toast({ title: 'Render failed', tone: 'danger', action: { label: 'Retry', onClick: () => undefined } })}
        >
          Danger
        </Button>
        <Button data-testid="specimen-toast-busy" onClick={() => toast({ id: 'gallery-busy', title: 'Rendering video…', busy: true, duration: 0 })}>
          Busy (sticky)
        </Button>
      </Row>
    </GallerySection>
  );
}

/** A subset of specimens inside fixed theme islands, so both themes are visible at once. */
function ThemeIslands() {
  return (
    <GallerySection id="themes" title="Both themes">
      <div className="grid gap-4 md:grid-cols-2">
        {(['light', 'dark'] as const).map((theme) => (
          <div
            key={theme}
            data-theme={theme}
            data-testid={`theme-island-${theme}`}
            className="flex flex-col gap-3 rounded-card bg-paper p-4 text-ink shadow-ring"
          >
            <span className="text-caption text-ink-faint">{theme}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Primary</Button>
              <Button>Default</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="brand">Brand</Button>
              <Button variant="danger">Delete</Button>
              <Button variant="primary" disabled>
                Disabled
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <IconButton aria-label="More">
                <MoreHorizontalIcon />
              </IconButton>
              <IconButton aria-label="Toggle" on>
                <Icon icon={LayoutGrid} />
              </IconButton>
              <Input placeholder="Project name" className="w-40" />
              <Chip tone="warning">Warning</Chip>
              <Switch aria-label={`Switch (${theme})`} defaultChecked />
            </div>
            <Callout tone="error">Error callout</Callout>
            <Progress aria-label={`Progress (${theme})`} value={60} />
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

/* ── the cascade probe (outside the Fantay root) ─────────────────────────────────────────── */

function LegacyProbe() {
  const [view, setView] = React.useState('board');
  return (
    <div className="fx-legacy" data-testid="fx-legacy-probe">
      <div className="flex flex-wrap items-center gap-3 p-6">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} data-testid={`specimen-button-${variant}-md--legacy`} variant={variant} size="md">
            <PlusIcon />
            Create
          </Button>
        ))}
        <Button data-testid="specimen-button-primary-sm--legacy" variant="primary" size="sm">
          <PlusIcon />
          Small
        </Button>
        <Button data-testid="specimen-button-primary-lg--legacy" variant="primary" size="lg">
          <PlusIcon />
          Large action
        </Button>
        <Button data-testid="specimen-button-primary-md-disabled--legacy" variant="primary" disabled>
          Disabled
        </Button>
        <IconButton data-testid="specimen-icon-button-quiet-md--legacy" aria-label="More (md)">
          <MoreHorizontalIcon />
        </IconButton>
        <IconButton data-testid="specimen-icon-button-primary-sm--legacy" variant="primary" size="sm" aria-label="More (sm)">
          <MoreHorizontalIcon />
        </IconButton>
        <IconButton data-testid="specimen-icon-button-brand-lg--legacy" variant="brand" size="lg" aria-label="More (lg)">
          <MoreHorizontalIcon />
        </IconButton>
        <Input data-testid="specimen-input-default-md--legacy" placeholder="Project name" className="w-48" />
        <Input data-testid="specimen-input-default-sm--legacy" inputSize="sm" placeholder="Small" className="w-48" />
        <Input data-testid="specimen-input-well-md--legacy" variant="well" placeholder="Well" className="w-48" />
        <Select defaultValue="1:1">
          <SelectTrigger data-testid="specimen-select-sm--legacy" size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1:1">1:1</SelectItem>
            <SelectItem value="16:9">16:9</SelectItem>
          </SelectContent>
        </Select>
        <Select>
          <SelectTrigger data-testid="specimen-select-md--legacy" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="gpt-image">GPT Image</SelectItem>
          </SelectContent>
        </Select>
        <Segmented data-testid="specimen-segmented-md--legacy" aria-label="View (legacy)" value={view} onValueChange={setView}>
          <SegmentedItem value="board">画板</SegmentedItem>
          <SegmentedItem value="files">文件</SegmentedItem>
          <SegmentedItem value="system">Design system</SegmentedItem>
        </Segmented>
        <Segmented data-testid="specimen-segmented-sm--legacy" aria-label="Range (legacy)" size="sm" value="day" onValueChange={() => undefined}>
          <SegmentedItem value="day">Day</SegmentedItem>
          <SegmentedItem value="week">Week</SegmentedItem>
          <SegmentedItem value="month" disabled>
            Month
          </SegmentedItem>
        </Segmented>
        <button type="button" className="primary" data-testid="legacy-raw-primary">
          Legacy primary
        </button>
        <button type="button" data-testid="legacy-raw-button">
          Legacy raw
        </button>
      </div>
    </div>
  );
}

export function FantayUiGallery() {
  return (
    <main className="min-h-screen bg-paper">
      <FxRoot data-testid="fx-gallery" className="min-h-screen bg-paper p-6 text-ink">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-6">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-title font-semibold text-ink">Fantay UI</h1>
              <p className="mt-1 text-copy text-ink-soft">Primitives, tokens and states — fixture gallery.</p>
            </div>
            <ThemeSegmented />
          </header>
          <TokensSection />
          <ButtonsSection />
          <IconButtonsSection />
          <ToolbarSection />
          <SegmentedSection />
          <TabsSection />
          <MenusSection />
          <OverlaysSection />
          <InputsSection />
          <SelectSection />
          <ControlsSection />
          <PeopleAndStatusSection />
          <SurfacesSection />
          <GallerySection id="boundary-states" title="Boundary States (Empty · Error · Loading · Long Text)">
            <BoundaryStatesShowcase />
          </GallerySection>
          <ToastSection />
          <ThemeIslands />
          <section data-testid="fx-region" className="flex flex-col gap-2 border-0 border-t border-solid border-line-soft pt-5">
            <h2 className="text-heading font-semibold text-ink">Raw element inside .fx</h2>
            <div>
              <button type="button" data-testid="fx-raw-button">
                Raw
              </button>
            </div>
          </section>
        </div>
      </FxRoot>
      <LegacyProbe />
      <Toaster />
    </main>
  );
}
