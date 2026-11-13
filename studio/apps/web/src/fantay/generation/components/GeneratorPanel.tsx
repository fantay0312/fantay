// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node-prompt-panel.tsx
// (panel layout: reference bar, prompt input, expand, library, model, settings, run; logic rewritten).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: the docked generator panel of spec 05 §5.2, injected through
// `BoardExtensions.renderGeneratorPanel` (plan R4): surface switch (image | video only, amendment C8),
// compiled references and warnings, the chip editor with a 300 ms debounced undoable prompt patch,
// prompt library side effects, model picker, params, Run (⌘/Ctrl+Enter), run status and next-step errors.
// Modified for Fantay on 2026-10-31: one floating composer as in the upstream panel (references, a borderless
// prompt, one control row ending in the round send button); the node's frame follows the chosen aspect.
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { Clapperboard, ImageIcon, Maximize2, X } from 'lucide-react';
import {
  clampParams,
  defaultParamsFor,
  mediaNodeSizeFor,
  paramSupportFor,
  type CompileWarning,
  type GenerationBoardOp,
  type GenerationDataPatch,
  type GenerationGraphNode,
  type GenerationParamSupport,
  type GenerationSurface,
  type GeneratorNodeData,
  type GeneratorParams,
  type MediaAspect,
} from '@open-design/contracts';

import { useT } from '../../../i18n';
import type { Dict } from '../../../i18n/types';
import { canonicalMediaModelId, imageModelIdForPromptTemplate } from '../../../media/models';
import { Button, Chip, IconButton, Segmented, SegmentedItem } from '../../ui';
import { useGeneration, useGenerationCatalog, useGeneratorView } from '../hooks';
import { findOption, modelAvailability, type GenerationModelOption } from '../model-catalog';
import { isSubmitShortcut } from '../keyboard';
import { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS, stopBoardPointer } from './board-interactive';
import { CandidateStrip } from './CandidateStrip';
import { GenerationErrorCard } from './GenerationErrorCard';
import { consumeGeneratorPanelFocus, useGeneratorPanelFocusRequest } from './generator-ui-store';
import { ModelPicker } from './ModelPicker';
import { runNextStepAction } from './next-step-runner';
import { ParamsPopover } from './ParamsPopover';
import { PromptChipEditor, type PromptChipEditorHandle } from './PromptChipEditor';
import { PromptEditorDialog } from './PromptEditorDialog';
import { cachedPromptTemplate, usePromptTemplates } from './prompt-library-data';
import { PromptLibraryPopover, type PromptLibraryApplyInput } from './PromptLibraryPopover';
import { ReferenceBar } from './ReferenceBar';
import { RunButton } from './RunButton';
import { RunStatus } from './RunStatus';
import { useGeneratorControls } from './use-generator-run';
import { useInputPreviews } from './use-input-previews';
import styles from './GeneratorPanel.module.css';

type DictKey = keyof Dict;

/** Debounce of prompt edits before they are written to the node (one coalesced undo step). */
export const PROMPT_PATCH_DEBOUNCE_MS = 300;

export interface GeneratorPanelProps {
  nodeId: string;
  onClose(): void;
}

type WarningChip = { key: string; labelKey: DictKey; vars?: Record<string, string | number>; action: 'model' | 'prompt' | null };

/** One chip per kind of compile warning (spec 05 §5.2 row 4). */
export function warningChips(warnings: readonly CompileWarning[]): WarningChip[] {
  const chips: WarningChip[] = [];
  const seen = new Set<string>();
  for (const warning of warnings) {
    if (seen.has(warning.kind)) continue;
    seen.add(warning.kind);
    if (warning.kind === 'refs-truncated') {
      chips.push({ key: warning.kind, labelKey: 'fantay.gen.refs.truncated', vars: { max: warning.kept }, action: 'model' });
    } else if (warning.kind === 'refs-ignored-by-model') {
      chips.push({ key: warning.kind, labelKey: 'fantay.gen.refs.unsupported', action: 'model' });
    } else if (warning.kind === 'reference-not-ready') {
      chips.push({ key: warning.kind, labelKey: 'fantay.gen.refs.notReady', action: null });
    } else if (warning.kind === 'unresolved-token') {
      chips.push({ key: warning.kind, labelKey: 'fantay.gen.prompt.brokenRef', action: 'prompt' });
    }
  }
  return chips;
}

/** Parameter support of a surface before a model is resolved (aspects, count, video lengths). */
export function genericSupport(surface: GenerationSurface): GenerationParamSupport {
  return paramSupportFor({ id: '', provider: '', caps: [] }, surface);
}

/** Params for a generator switched to `surface`: the surface defaults, keeping aspect and count where valid. */
export function paramsForSurface(surface: GenerationSurface, current: GeneratorParams | undefined): GeneratorParams {
  return defaultParamsFor(surface, genericSupport(surface), current ? { aspect: current.aspect, count: current.count } : undefined);
}

/** Gives the node the output's shape, keeping its top edge and horizontal centre (the docked panel stays put). */
export function reframeOp(node: GenerationGraphNode, surface: GenerationSurface, aspect: MediaAspect): GenerationBoardOp {
  const size = mediaNodeSizeFor(surface, aspect);
  return { type: 'node.setFrame', id: node.id, x: Math.round(node.x + (node.w - size.w) / 2), y: node.y, w: size.w, h: size.h };
}

function templateModelOption(
  surface: GenerationSurface,
  model: string | undefined,
  groups: Parameters<typeof findOption>[0],
): GenerationModelOption | null {
  if (!model) return null;
  const id = surface === 'image' ? imageModelIdForPromptTemplate(model) : canonicalMediaModelId(model);
  return findOption(groups, id);
}

export function GeneratorPanel({ nodeId, onClose }: GeneratorPanelProps) {
  const t = useT();
  const generation = useGeneration();
  const { board, onOpenSettings, setLastActiveGenerator, notify, service } = generation;
  const view = useGeneratorView(nodeId);
  const data = view.data;
  const surface: GenerationSurface = data?.surface ?? 'image';
  const [cloudRequested, setCloudRequested] = useState(false);
  const catalog = useGenerationCatalog(surface, { loadCloud: cloudRequested });
  const inputs = view.compiled?.inputs ?? [];
  const previews = useInputPreviews(inputs);
  const referenceCount = inputs.filter((input) => input.kind === 'image').length;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<PromptChipEditorHandle | null>(null);
  const refsAddRef = useRef<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [suggested, setSuggested] = useState<GenerationModelOption | null>(null);
  const { templates } = usePromptTemplates(Boolean(data?.templateId));
  const templateId = data?.templateId;
  const templateTitle = templateId
    ? (templates.find((template) => template.id === templateId)?.title ?? cachedPromptTemplate(templateId)?.title ?? templateId)
    : null;

  /* ── prompt draft: immediate in the editor, written to the node after 300 ms (undoable, coalesced) ── */
  const [draft, setDraft] = useState(data?.prompt ?? '');
  const pending = useRef<{ value: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const flushPrompt = useCallback(() => {
    const current = pending.current;
    if (!current) return;
    clearTimeout(current.timer);
    pending.current = null;
    board.apply([{ type: 'node.patchData', id: nodeId, patch: { prompt: current.value } }], {
      label: 'generation.prompt',
      undoable: true,
      flush: false,
      coalesceKey: `prompt:${nodeId}`,
    });
  }, [board, nodeId]);
  const storedPrompt = data?.prompt;
  useEffect(() => {
    if (pending.current || storedPrompt === undefined) return;
    setDraft(storedPrompt);
  }, [storedPrompt]);
  useEffect(() => () => flushPrompt(), [flushPrompt]);
  const onPromptChange = (next: string) => {
    setDraft(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { value: next, timer: setTimeout(flushPrompt, PROMPT_PATCH_DEBOUNCE_MS) };
  };

  const controls = useGeneratorControls(nodeId, view, { beforeRun: flushPrompt });

  useEffect(() => {
    setLastActiveGenerator(nodeId);
  }, [nodeId, setLastActiveGenerator]);

  /* ── focus requests from the node face, output nodes and "use as reference" ── */
  const focusRequest = useGeneratorPanelFocusRequest(nodeId);
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.target === 'model') {
      setPickerOpen(true);
      setCloudRequested(true);
    } else if (focusRequest.target === 'refs') {
      refsAddRef.current?.focus();
    } else {
      editorRef.current?.focus();
    }
    consumeGeneratorPanelFocus(focusRequest);
  }, [focusRequest]);

  if (!data) return null;
  const support = view.support;
  /** Without a resolved model the params still edit against the surface's generic support. */
  const paramsSupport = support ?? genericSupport(surface);
  const params = clampParams(data.params, paramsSupport, surface);

  const patch = (next: GenerationDataPatch<GeneratorNodeData>, label: string) => {
    const nextSurface = next.surface ?? surface;
    const nextAspect = next.params?.aspect ?? params.aspect;
    const ops: GenerationBoardOp[] = [{ type: 'node.patchData', id: nodeId, patch: next }];
    if (view.node && (nextSurface !== surface || nextAspect !== params.aspect)) ops.push(reframeOp(view.node, nextSurface, nextAspect));
    board.apply(ops, { label, undoable: true, flush: true });
  };

  const switchSurface = (next: string) => {
    if (next !== 'image' && next !== 'video') return;
    if (next === surface) return;
    flushPrompt();
    setSuggested(null);
    patch({ surface: next, model: null, params: paramsForSurface(next, data.params) }, 'generation.surface');
  };

  const changeModel = (id: string) => {
    const option = findOption(catalog.groups, id);
    setSuggested(null);
    patch({ model: id, params: option ? clampParams(data.params, option.support, surface) : data.params }, 'generation.model');
  };

  const changeParams = (next: GeneratorParams) => {
    patch({ params: clampParams(next, paramsSupport, surface) }, 'generation.params');
  };

  const applyTemplate = ({ prompt, template }: PromptLibraryApplyInput) => {
    if (pending.current) {
      clearTimeout(pending.current.timer);
      pending.current = null;
    }
    setDraft(prompt);
    const next: GenerationDataPatch<GeneratorNodeData> = { prompt, templateId: template.id };
    if (template.aspect && paramsSupport.aspects.includes(template.aspect) && template.aspect !== params.aspect) {
      next.params = { ...params, aspect: template.aspect };
      notify({ tone: 'info', message: t('fantay.prompts.aspectApplied', { aspect: template.aspect }) });
    }
    patch(next, 'generation.template');
    const option = templateModelOption(surface, template.model, catalog.groups);
    setSuggested(
      option && option.id !== view.model?.id && modelAvailability(option, referenceCount).selectable ? option : null,
    );
  };

  const runTargets = {
    onOpenSettings,
    focusPrompt: () => editorRef.current?.focus(),
    openModelPicker: () => {
      setPickerOpen(true);
      setCloudRequested(true);
    },
    retry: () => void service.retryFailed(nodeId),
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys from portaled popovers/menus bubble here through React; only the panel's own DOM counts.
    if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) return;
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      if (controls.state === 'idle' && !controls.disabledReason) void controls.run();
      return;
    }
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
  };

  const chips = warningChips(view.compiled?.warnings ?? []);
  const runState = view.runState;
  const showError = !runState.active && runState.firstError !== undefined && runState.total > 0;
  const title = view.node?.title?.trim() || t(surface === 'video' ? 'fantay.gen.node.titleVideo' : 'fantay.gen.node.titleImage');
  const placeholder = t(surface === 'video' ? 'fantay.gen.prompt.placeholderVideo' : 'fantay.gen.prompt.placeholderImage');
  const openPreview = (inputNodeId: string) => generation.openToolDialog({ kind: 'preview', nodeId: inputNodeId });

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-testid="fx-gen-panel"
      data-surface={surface}
      role="group"
      aria-label={title}
      {...BOARD_INTERACTIVE_PROPS}
      onWheel={stopBoardPointer}
      onKeyDown={onKeyDown}
    >
      <ReferenceBar ref={refsAddRef} generatorId={nodeId} inputs={inputs} previews={previews} />

      <PromptChipEditor
        ref={editorRef}
        value={draft}
        inputs={inputs}
        previews={previews}
        onChange={onPromptChange}
        onSubmit={() => {
          if (controls.state === 'idle' && !controls.disabledReason) void controls.run();
          else flushPrompt();
        }}
        onEscape={onClose}
        placeholder={placeholder}
        ariaLabel={t('fantay.gen.prompt.label')}
        autoFocus
        variant="bare"
        minHeight={56}
        maxHeight={220}
        onPreview={openPreview}
      />

      <div className={styles.staged}>
        {chips.length > 0 || templateTitle || suggested ? (
          <div className={styles.warnings} data-testid="fx-gen-warnings">
            {chips.map((chip) => (
              <Chip
                key={chip.key}
                size="sm"
                tone="warning"
                data-testid={`fx-gen-warning-${chip.key}`}
                tabIndex={chip.action ? undefined : -1}
                {...BOARD_CONTROL_PROPS}
                onClick={() => {
                  if (chip.action === 'model') {
                    setPickerOpen(true);
                    setCloudRequested(true);
                  }
                  else if (chip.action === 'prompt') editorRef.current?.focus();
                }}
              >
                {t(chip.labelKey, chip.vars)}
              </Chip>
            ))}
            {templateTitle ? (
              <span className={styles.templateChip} data-testid="fx-gen-template-chip">
                <Chip size="sm" tabIndex={-1} {...BOARD_CONTROL_PROPS}>
                  {t('fantay.prompts.applied', { title: templateTitle })}
                </Chip>
                <IconButton
                  size="xs"
                  aria-label={t('fantay.prompts.clearTemplate')}
                  data-testid="fx-gen-template-clear"
                  {...BOARD_CONTROL_PROPS}
                  onClick={() => patch({ templateId: undefined }, 'generation.template.clear')}
                >
                  <X strokeWidth={1.5} />
                </IconButton>
              </span>
            ) : null}
            {suggested ? (
              <span className={styles.templateChip} data-testid="fx-gen-template-model-hint">
                <Chip size="sm" tabIndex={-1} {...BOARD_CONTROL_PROPS}>
                  {t('fantay.gen.model.templateHint', { model: suggested.label })}
                </Chip>
                <Button size="sm" variant="ghost" {...BOARD_CONTROL_PROPS} onClick={() => changeModel(suggested.id)}>
                  {t('fantay.gen.model.useSuggested')}
                </Button>
              </span>
            ) : null}
          </div>
        ) : null}

        <RunStatus generatorId={nodeId} />
        {showError && runState.firstError ? (
          <GenerationErrorCard
            error={runState.firstError}
            onRetry={() => void service.retryFailed(nodeId)}
            onAction={(run) => runNextStepAction(run, runTargets)}
          />
        ) : null}
        {data.runs[0] ? <CandidateStrip generatorId={nodeId} max={8} /> : null}
      </div>

      <div className={styles.toolbar}>
        <Segmented size="sm" className={styles.surface} aria-label={t('fantay.gen.surface.label')} value={surface} onValueChange={switchSurface} data-testid="fx-gen-surface">
          <SegmentedItem value="image" aria-label={t('fantay.gen.surface.image')} title={t('fantay.gen.surface.image')} data-testid="fx-gen-surface-image">
            <ImageIcon strokeWidth={1.5} aria-hidden />
          </SegmentedItem>
          <SegmentedItem value="video" aria-label={t('fantay.gen.surface.video')} title={t('fantay.gen.surface.video')} data-testid="fx-gen-surface-video">
            <Clapperboard strokeWidth={1.5} aria-hidden />
          </SegmentedItem>
        </Segmented>
        <ParamsPopover surface={surface} support={paramsSupport} value={params} onChange={changeParams} />
        <span className={styles.spacer} />
        <IconButton aria-label={t('fantay.gen.prompt.expand')} data-testid="fx-gen-prompt-expand" {...BOARD_CONTROL_PROPS} onClick={() => setExpanded(true)}>
          <Maximize2 strokeWidth={1.5} />
        </IconButton>
        <PromptLibraryPopover surface={surface} currentPrompt={draft} onApply={applyTemplate} />
        <ModelPicker
          surface={surface}
          value={data.model}
          resolved={view.model}
          groups={catalog.groups}
          loading={catalog.loading}
          referenceCount={referenceCount}
          onChange={changeModel}
          onOpenSettings={() => onOpenSettings('media')}
          open={pickerOpen}
          onOpenChange={(next) => {
            setPickerOpen(next);
            if (next) setCloudRequested(true);
          }}
        />
        <RunButton
          state={controls.state}
          count={params.count}
          disabledReason={controls.disabledReason}
          onRun={() => void controls.run()}
          onStop={controls.stop}
        />
      </div>

      <PromptEditorDialog
        open={expanded}
        onClose={() => {
          setExpanded(false);
          flushPrompt();
        }}
        value={draft}
        inputs={inputs}
        previews={previews}
        onChange={onPromptChange}
        onSubmit={() => {
          setExpanded(false);
          if (controls.state === 'idle' && !controls.disabledReason) void controls.run();
        }}
        placeholder={placeholder}
        onPreview={openPreview}
      />
    </div>
  );
}
