'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Kind controls of the context bar (spec 03 §4.1, §4.6, §4.7, §6.3; amendment C4): the frame Size menu with the
// device and social-media presets, frame image export at 1×/2×, note colour and size, shape fill/stroke/radius,
// text size and weight, Open editor for design documents, and Align for multi-selections. Built from the Fantay
// primitives; every change is one undoable `style` transaction.
import { ChevronDown } from 'lucide-react';
import {
  BOARD_FRAME_PRESET_GROUPS,
  BOARD_FRAME_PRESETS,
  matchBoardFramePreset,
  type BoardPaletteColor,
  type BoardTextStyle,
} from '@open-design/contracts';

import { useT } from '../../../i18n';
import { Button } from '../../ui/button';
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { IconButton } from '../../ui/icon-button';
import { Segmented, SegmentedItem } from '../../ui/segmented';
import { useBoardEngine, useBoardSelector } from '../context';
import {
  boardColorCss,
  DEFAULT_SHAPE_TEXT_STYLE,
  NOTE_DEFAULT_COLOR,
  NOTE_DEFAULT_SIZE,
  NOTE_SIZE_OPTIONS,
  NOTE_SWATCHES,
  noteColorCss,
  SHAPE_FONT_WEIGHTS,
  SHAPE_RADII,
  SHAPE_SWATCHES,
  SHAPE_TEXT_SIZES,
} from '../model/defaults';
import type { DictKey, EngineNode } from '../model/types';
import { useChromeActions } from './chrome-context';
import type { ContextBarWidget } from './context-bar-model';
import { CHROME_ICON_STROKE, ICONS } from './icons';
import { ToolButton } from './ToolButton';
import styles from './chrome.module.css';

function useNode(nodeId: string): EngineNode | undefined {
  return useBoardSelector((state) => state.doc.nodes.get(nodeId));
}

function Swatch({ css, none = false }: { css: string | undefined; none?: boolean }) {
  return <span className={styles.swatch} data-none={none ? '' : undefined} style={none ? undefined : { background: css }} aria-hidden />;
}

/** Frame Size ▾ (C4): device presets, then social-media presets; the matching preset is checked. */
function FrameSizeMenu({ nodeId }: { nodeId: string }) {
  const t = useT();
  const actions = useChromeActions();
  const node = useNode(nodeId);
  const readOnly = useBoardSelector((state) => state.readOnly);
  if (!node || node.kind !== 'frame') return null;
  const matched = matchBoardFramePreset(node.w, node.h);
  const label = matched ? t(matched.labelKey as DictKey) : `${node.w} × ${node.h}`;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="bare" data-testid="board-frame-size" aria-label={`${t('board.node.device')}: ${label}`} disabled={readOnly}>
          <span className={styles.sizeLabel}>{label}</span>
          <ChevronDown strokeWidth={CHROME_ICON_STROKE} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" width="md" data-testid="board-frame-size-menu">
        <DropdownMenuRadioGroup
          value={matched?.id ?? ''}
          onValueChange={(id) => {
            const preset = BOARD_FRAME_PRESETS.find((entry) => entry.id === id);
            if (preset) actions.resizeFrame(nodeId, preset);
          }}
        >
          {BOARD_FRAME_PRESET_GROUPS.map((group, index) => [
            index > 0 ? <DropdownMenuSeparator key={`separator-${group.id}`} /> : null,
            <DropdownMenuGroup key={group.id} data-testid={`board-frame-size-group-${group.id}`}>
              <DropdownMenuCaption>{t(group.labelKey as DictKey)}</DropdownMenuCaption>
              {BOARD_FRAME_PRESETS.filter((preset) => preset.group === group.id).map((preset) => (
                <DropdownMenuRadioItem
                  key={preset.id}
                  value={preset.id}
                  data-testid={`board-frame-size-${preset.id}`}
                  description={`${preset.w} × ${preset.h}`}
                >
                  {t(preset.labelKey as DictKey)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuGroup>,
          ])}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 导出图片 ▾ (C4): 1× / 2× of the frame's CSS size. */
function FrameExportMenu({ nodeId, disabledReasonKey }: { nodeId: string; disabledReasonKey?: DictKey }) {
  const t = useT();
  const actions = useChromeActions();
  const node = useNode(nodeId);
  if (!node) return null;
  const label = t('board.export.image');
  if (disabledReasonKey) {
    return (
      <ToolButton size="sm" data-testid="board-frame-export" label={label} disabledReason={t(disabledReasonKey)}>
        <ICONS.exportImage strokeWidth={CHROME_ICON_STROKE} />
      </ToolButton>
    );
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ToolButton size="sm" data-testid="board-frame-export" label={label}>
          <ICONS.exportImage strokeWidth={CHROME_ICON_STROKE} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" width="sm" data-testid="board-frame-export-menu">
        <DropdownMenuCaption>{label}</DropdownMenuCaption>
        {([1, 2] as const).map((scale) => (
          <DropdownMenuItem
            key={scale}
            data-testid={`board-frame-export-${scale}x`}
            description={`${node.w * scale} × ${node.h * scale}`}
            onSelect={() => actions.exportFrame(nodeId, scale)}
          >
            {t(scale === 1 ? 'board.export.scale1x' : 'board.export.scale2x')}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NoteColors({ nodeId }: { nodeId: string }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const node = useNode(nodeId);
  if (!node || node.kind !== 'note') return null;
  const current = node.data.color ?? NOTE_DEFAULT_COLOR;
  return (
    <span className={styles.swatchRow} role="group" aria-label={t('board.selection.noteColor')}>
      {NOTE_SWATCHES.map((swatch) => (
        <IconButton
          key={swatch.color}
          size="sm"
          shape="round"
          data-testid={`board-note-color-${swatch.color}`}
          aria-label={t(swatch.labelKey)}
          on={swatch.color === current}
          onClick={() => commands.updateNode(nodeId, { data: { color: swatch.color } }, { label: 'style' })}
        >
          <Swatch css={noteColorCss(swatch.color)} />
        </IconButton>
      ))}
    </span>
  );
}

function NoteSizes({ nodeId }: { nodeId: string }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const node = useNode(nodeId);
  if (!node || node.kind !== 'note') return null;
  return (
    <Segmented
      size="sm"
      aria-label={t('board.selection.fontSize')}
      value={node.data.size ?? NOTE_DEFAULT_SIZE}
      onValueChange={(size) => commands.updateNode(nodeId, { data: { size: size as 'sm' | 'md' | 'lg' } }, { label: 'style' })}
    >
      {NOTE_SIZE_OPTIONS.map((option) => (
        <SegmentedItem key={option.size} value={option.size} data-testid={`board-note-size-${option.size}`}>
          {t(option.labelKey)}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

function ShapeColorMenu({ nodeId, part }: { nodeId: string; part: 'fill' | 'stroke' }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const node = useNode(nodeId);
  if (!node || node.kind !== 'shape') return null;
  const value = part === 'fill' ? node.data.fill : node.data.stroke;
  const current = value ?? (part === 'fill' ? 'gray' : 'none');
  const labelKey: DictKey = part === 'fill' ? 'board.selection.fill' : 'board.selection.stroke';
  const choose = (next: string) => {
    if (part === 'fill') commands.updateNode(nodeId, { data: { fill: next as BoardPaletteColor | 'none' } }, { label: 'style' });
    else commands.updateNode(nodeId, { data: { stroke: next as BoardPaletteColor | 'none', strokeWidth: next === 'none' ? null : node.data.strokeWidth ?? 2 } }, { label: 'style' });
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ToolButton size="sm" data-testid={`board-shape-${part}`} label={t(labelKey)}>
          <Swatch css={current === 'none' ? undefined : boardColorCss(current)} none={current === 'none'} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" width="sm">
        <DropdownMenuCaption>{t(labelKey)}</DropdownMenuCaption>
        <DropdownMenuRadioGroup value={current} onValueChange={choose}>
          {SHAPE_SWATCHES.map((swatch) => (
            <DropdownMenuRadioItem key={swatch.color} value={swatch.color}>
              <span className={styles.menuSwatch}>
                <Swatch css={boardColorCss(swatch.color)} />
                {t(swatch.labelKey)}
              </span>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value="none">
            <span className={styles.menuSwatch}>
              <Swatch css={undefined} none />
              {t('common.none')}
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShapeRadiusMenu({ nodeId }: { nodeId: string }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const node = useNode(nodeId);
  if (!node || node.kind !== 'shape') return null;
  const current = String(node.data.radius ?? 0);
  const label = (radius: number) => (radius >= 1000 ? t('board.selection.radiusFull') : String(radius));
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ToolButton size="sm" data-testid="board-shape-radius" label={t('board.selection.radius')}>
          <ICONS.radius strokeWidth={CHROME_ICON_STROKE} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" width="sm">
        <DropdownMenuCaption>{t('board.selection.radius')}</DropdownMenuCaption>
        <DropdownMenuRadioGroup value={current} onValueChange={(value) => commands.updateNode(nodeId, { data: { radius: Number(value) } }, { label: 'style' })}>
          {SHAPE_RADII.map((radius) => (
            <DropdownMenuRadioItem key={radius} value={String(radius)}>
              {label(radius)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function textStyleOf(node: EngineNode): BoardTextStyle {
  return node.kind === 'shape' && node.data.textStyle ? node.data.textStyle : DEFAULT_SHAPE_TEXT_STYLE;
}

function TextSizes({ nodeId }: { nodeId: string }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const node = useNode(nodeId);
  if (!node || node.kind !== 'shape') return null;
  const style = textStyleOf(node);
  return (
    <Segmented
      size="sm"
      aria-label={t('board.selection.fontSize')}
      value={String(style.fontSize)}
      onValueChange={(value) => commands.updateNode(nodeId, { data: { textStyle: { ...style, fontSize: Number(value) } } }, { label: 'style' })}
    >
      {SHAPE_TEXT_SIZES.map((option) => (
        <SegmentedItem key={option.fontSize} value={String(option.fontSize)}>
          {t(option.labelKey)}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

function TextWeights({ nodeId }: { nodeId: string }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const node = useNode(nodeId);
  if (!node || node.kind !== 'shape') return null;
  const style = textStyleOf(node);
  const current = style.fontWeight >= 600 ? '600' : '400';
  return (
    <Segmented
      size="sm"
      aria-label={t('board.selection.fontWeight')}
      value={current}
      onValueChange={(value) => commands.updateNode(nodeId, { data: { textStyle: { ...style, fontWeight: Number(value) as BoardTextStyle['fontWeight'] } } }, { label: 'style' })}
    >
      {SHAPE_FONT_WEIGHTS.map((weight) => (
        <SegmentedItem
          key={weight}
          value={String(weight)}
          aria-label={`${t('board.selection.fontWeight')} ${weight}`}
          data-testid={`board-text-weight-${weight}`}
          className={weight >= 600 ? 'font-semibold data-[state=on]:font-semibold' : 'data-[state=on]:font-normal'}
        >
          {/* a type sample, not a word: the item is named by its aria-label */}
          <span aria-hidden>Aa</span>
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

function OpenEditor({ path, disabledReasonKey }: { path: string; disabledReasonKey?: DictKey }) {
  const t = useT();
  const actions = useChromeActions();
  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid="board-open-editor"
      disabled={disabledReasonKey !== undefined}
      {...(disabledReasonKey ? { disabledReason: t(disabledReasonKey) } : {})}
      onClick={() => actions.openEditor(path)}
    >
      <ICONS.design strokeWidth={CHROME_ICON_STROKE} />
      {t('board.node.openEditor')}
    </Button>
  );
}

function AlignMenu({ nodeIds }: { nodeIds: string[] }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const entries: Array<{ id: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'; key: DictKey; icon: (typeof ICONS)[keyof typeof ICONS] }> = [
    { id: 'left', key: 'board.menu.alignLeft', icon: ICONS.alignLeft },
    { id: 'center', key: 'board.menu.alignCenter', icon: ICONS.alignCenter },
    { id: 'right', key: 'board.menu.alignRight', icon: ICONS.alignRight },
    { id: 'top', key: 'board.menu.alignTop', icon: ICONS.alignTop },
    { id: 'middle', key: 'board.menu.alignMiddle', icon: ICONS.alignMiddle },
    { id: 'bottom', key: 'board.menu.alignBottom', icon: ICONS.alignBottom },
  ];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ToolButton size="sm" data-testid="board-align" label={t('board.menu.align')}>
          <ICONS.alignLeft strokeWidth={CHROME_ICON_STROKE} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" width="md">
        {entries.map((entry) => {
          const Glyph = entry.icon;
          return (
            <DropdownMenuItem key={entry.id} icon={<Glyph strokeWidth={CHROME_ICON_STROKE} />} onSelect={() => commands.align(nodeIds, entry.id)}>
              {t(entry.key)}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<ICONS.distributeH strokeWidth={CHROME_ICON_STROKE} />} disabled={nodeIds.length < 3} onSelect={() => commands.distribute(nodeIds, 'h')}>
          {t('board.menu.distributeH')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<ICONS.distributeV strokeWidth={CHROME_ICON_STROKE} />} disabled={nodeIds.length < 3} onSelect={() => commands.distribute(nodeIds, 'v')}>
          {t('board.menu.distributeV')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ContextBarWidgetView({ widget }: { widget: ContextBarWidget }) {
  switch (widget.type) {
    case 'frame-size':
      return <FrameSizeMenu nodeId={widget.nodeId} />;
    case 'frame-export':
      return <FrameExportMenu nodeId={widget.nodeId} {...(widget.disabledReasonKey ? { disabledReasonKey: widget.disabledReasonKey } : {})} />;
    case 'note-color':
      return <NoteColors nodeId={widget.nodeId} />;
    case 'note-size':
      return <NoteSizes nodeId={widget.nodeId} />;
    case 'shape-fill':
      return <ShapeColorMenu nodeId={widget.nodeId} part="fill" />;
    case 'shape-stroke':
      return <ShapeColorMenu nodeId={widget.nodeId} part="stroke" />;
    case 'shape-radius':
      return <ShapeRadiusMenu nodeId={widget.nodeId} />;
    case 'text-size':
      return <TextSizes nodeId={widget.nodeId} />;
    case 'text-weight':
      return <TextWeights nodeId={widget.nodeId} />;
    case 'open-editor':
      return <OpenEditor path={widget.path} {...(widget.disabledReasonKey ? { disabledReasonKey: widget.disabledReasonKey } : {})} />;
    case 'align':
      return <AlignMenu nodeIds={widget.nodeIds} />;
    default:
      return null;
  }
}
