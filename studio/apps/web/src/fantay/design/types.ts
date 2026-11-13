// SPDX-License-Identifier: AGPL-3.0-only
// Design editor host types (spec 06 §6.1). `DesignEditorHost.tsx` and the barrel re-export them; they
// live here so the host, the viewer, the dialogs and the creation runner share them without cycles.
import type { ReactNode } from 'react';
import type {
  DesignBridgeError,
  DesignFlushReason,
  DesignFlushResult,
  DesignInsertItem,
  DesignSelection,
  DesignViewCommand,
  DesignViewState,
  WorkspaceCollabContext,
} from '@open-design/contracts';

export type DesignEditorDocument =
  | { kind: 'project'; projectId: string; path: string; createIfMissing?: boolean; readOnly?: boolean }
  /** `path` = the target `.fig`. */
  | { kind: 'convert-html'; projectId: string; path: string; sourcePath: string }
  /** `.fig .op .pen .svg .html .htm .json`. */
  | { kind: 'import-file'; projectId: string; path: string; file: File };

export interface DesignEditorState {
  phase: 'booting' | 'ready' | 'opening' | 'editing' | 'failed';
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  lastSavedAt: number | null;
  sha256: string | null;
  conflict: { currentSha256: string | null } | null;
  error: DesignBridgeError | null;
  zoom: number | null;
}

export type DesignSavedSource = { kind: 'html'; path: string } | { kind: 'file'; name: string };

export interface DesignSavedEvent {
  projectId: string;
  path: string;
  sha256: string;
  size: number;
  created: boolean;
  source: DesignSavedSource | null;
}

export type DesignSelectionChange = DesignSelection & { projectId: string; path: string };

export interface DesignEditorHostProps {
  document: DesignEditorDocument;
  /** Default true; inactive = hidden but alive. */
  active?: boolean;
  /** Default 60000; after this long inactive: flush('hidden'), then unmount the iframe. */
  keepAliveMs?: number;
  /** Default 'compact' (DesignEditorHeader). */
  header?: 'compact' | 'none';
  /** E.g. the board's "返回画板" button. */
  headerStart?: ReactNode;
  headerEnd?: ReactNode;
  workspaceContext?: WorkspaceCollabContext | null;
  /** Keybinding strings the editor forwards instead of handling, e.g. ['$mod+KeyK']. */
  forwardShortcuts?: string[];
  /** Default false. */
  closeOnEscape?: boolean;
  /**
   * Fantay addition. 'headless' = the hidden creation session of `DesignCreationRunner`: no header,
   * notices, toasts, cover export, navigation or unload guards. Default 'interactive'.
   */
  mode?: 'interactive' | 'headless';
  onShortcut?(combo: string): void;
  onStateChange?(state: DesignEditorState): void;
  onSaved?(event: DesignSavedEvent): void;
  onSelectionChange?(selection: DesignSelectionChange): void;
  onViewChange?(view: DesignViewState): void;
  onRequestClose?(): void;
  /** After convert / import / save-as-copy wrote a document under another path. */
  onDocumentReplaced?(next: { projectId: string; path: string }): void;
  className?: string;
}

export interface DesignEditorHandle {
  flush(reason?: DesignFlushReason): Promise<DesignFlushResult>;
  exportCover(opts?: { maxEdge?: number }): Promise<{ png: Blob; width: number; height: number } | null>;
  exportHtml(scope?: 'page' | 'selection'): Promise<string>;
  command(command: DesignViewCommand): Promise<void>;
  select(nodeIds: string[], reveal?: boolean): Promise<void>;
  insert(items: DesignInsertItem[]): Promise<string[]>;
  focus(): void;
}
