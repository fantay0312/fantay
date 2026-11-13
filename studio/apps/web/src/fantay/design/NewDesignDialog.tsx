// SPDX-License-Identifier: AGPL-3.0-only
// 新建设计 (spec 06 §6.1): name + one of three sources — a blank design, a project web page converted into
// an editable design, or a local file (.fig .op .pen .svg .html .htm .json) — and the target path the
// design will get. `onCreate` receives the DesignEditorDocument to open.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { designNameFromPath } from '@open-design/contracts';

import { useI18n } from '../../i18n';
import {
  Button,
  Callout,
  Field,
  Icon,
  Input,
  Modal,
  ModalActions,
  ModalTitle,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui';
import { suggestDesignPath } from './design-api';
import type { NewDesignSource } from './new-design-store';
import type { DesignEditorDocument } from './types';

/** Files the design editor can import (spec 06 §8). */
export const DESIGN_IMPORT_ACCEPT = '.fig,.op,.pen,.svg,.html,.htm,.json';

export interface NewDesignDialogProps {
  open: boolean;
  projectId: string;
  initialSource?: NewDesignSource;
  htmlFiles: Array<{ path: string; name: string }>;
  existingDesignPaths: string[];
  onOpenChange(open: boolean): void;
  /** `meta.title` is the name as typed (the board node title); the path is its file-safe form. */
  onCreate(doc: DesignEditorDocument, meta: { title: string }): void;
  /** Fantay additions: creation in progress / its failure (shown in the dialog). */
  busy?: boolean;
  error?: string | null;
  initialName?: string;
  /** Preselected page for 由项目网页转换. */
  initialHtmlPath?: string;
}

function isSource(value: string): value is NewDesignSource {
  return value === 'blank' || value === 'html' || value === 'file';
}

export function NewDesignDialog({
  open,
  projectId,
  initialSource = 'blank',
  htmlFiles,
  existingDesignPaths,
  onOpenChange,
  onCreate,
  busy = false,
  error = null,
  initialName,
  initialHtmlPath,
}: NewDesignDialogProps) {
  const { t } = useI18n();
  const nameId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState<NewDesignSource>(initialSource);
  const [name, setName] = useState(initialName ?? '');
  const [nameTouched, setNameTouched] = useState(Boolean(initialName));
  const [htmlPath, setHtmlPath] = useState<string>(initialHtmlPath ?? '');
  const [file, setFile] = useState<File | null>(null);

  // Each opening starts from the request's initial values.
  useEffect(() => {
    if (!open) return;
    setSource(initialSource);
    setName(initialName ?? (initialHtmlPath ? designNameFromPath(initialHtmlPath) : ''));
    setNameTouched(Boolean(initialName));
    setHtmlPath(initialHtmlPath ?? '');
    setFile(null);
  }, [open, initialSource, initialName, initialHtmlPath]);

  const defaultName = t('designEditor.new.defaultName');
  const title = name.trim() || defaultName;
  const format = source === 'file' && file && /\.op$/i.test(file.name) ? 'op' : 'fig';
  const targetPath = useMemo(() => suggestDesignPath(title, existingDesignPaths, format), [existingDesignPaths, format, title]);
  const ready = source === 'blank' || (source === 'html' && htmlPath !== '') || (source === 'file' && file !== null);

  const create = () => {
    if (!ready || busy) return;
    const meta = { title };
    if (source === 'html') onCreate({ kind: 'convert-html', projectId, path: targetPath, sourcePath: htmlPath }, meta);
    else if (source === 'file' && file) onCreate({ kind: 'import-file', projectId, path: targetPath, file }, meta);
    else onCreate({ kind: 'project', projectId, path: targetPath, createIfMissing: true }, meta);
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onOpenChange(false);
      }}
      size="md"
      data-testid="new-design-dialog"
      aria-describedby={undefined}
    >
      <ModalTitle>{t('designEditor.new.title')}</ModalTitle>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <Field label={t('designEditor.new.nameLabel')} htmlFor={nameId} labelVariant="form">
          <Input
            id={nameId}
            value={name}
            placeholder={defaultName}
            maxLength={200}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setNameTouched(true);
            }}
            data-testid="new-design-name"
          />
        </Field>
        <Segmented
          aria-label={t('designEditor.new.sourceLabel')}
          value={source}
          onValueChange={(value) => {
            if (isSource(value)) setSource(value);
          }}
          className="max-w-full flex-wrap self-start"
          disabled={busy}
        >
          <SegmentedItem value="blank" data-testid="new-design-source-blank">
            {t('designEditor.new.blank')}
          </SegmentedItem>
          <SegmentedItem value="html" data-testid="new-design-source-html">
            {t('designEditor.new.fromHtml')}
          </SegmentedItem>
          <SegmentedItem value="file" data-testid="new-design-source-file">
            {t('designEditor.new.fromFile')}
          </SegmentedItem>
        </Segmented>
        {source === 'html' ? (
          <Field label={t('designEditor.new.fromHtml')} labelVariant="form">
            <Select
              value={htmlPath === '' ? undefined : htmlPath}
              onValueChange={(value) => {
                setHtmlPath(value);
                if (!nameTouched) setName(designNameFromPath(value));
              }}
              disabled={busy || htmlFiles.length === 0}
            >
              <SelectTrigger className="w-full" data-testid="new-design-html-select" aria-label={t('designEditor.new.fromHtml')}>
                <SelectValue placeholder={htmlFiles.length === 0 ? t('designEditor.new.noHtmlPages') : undefined} />
              </SelectTrigger>
              <SelectContent>
                {htmlFiles.map((entry) => (
                  <SelectItem key={entry.path} value={entry.path}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        {source === 'file' ? (
          <Field hint={t('designEditor.new.fileHint')}>
            <input
              ref={fileInputRef}
              type="file"
              accept={DESIGN_IMPORT_ACCEPT}
              hidden
              data-testid="new-design-file-input"
              onChange={(event) => {
                const picked = event.target.files?.[0] ?? null;
                event.target.value = '';
                if (!picked) return;
                setFile(picked);
                if (!nameTouched) setName(designNameFromPath(picked.name));
              }}
            />
            <Button
              variant="default"
              block
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              data-testid="new-design-file-button"
            >
              <Icon icon={FileUp} size="sm" />
              <span className="min-w-0 truncate">{file ? file.name : t('designEditor.new.chooseFile')}</span>
            </Button>
          </Field>
        ) : null}
        <p className="m-0 truncate font-mono text-caption text-ink-faint" data-testid="new-design-path" title={targetPath}>
          {targetPath}
        </p>
        {busy && source === 'html' ? <p className="m-0 text-label text-ink-soft">{t('designEditor.convertHtml.progress')}</p> : null}
        {error ? (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        ) : null}
        <ModalActions className="mt-2">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('designEditor.new.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={busy} data-testid="new-design-create">
            {t('designEditor.new.create')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
