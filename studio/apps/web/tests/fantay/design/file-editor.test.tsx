// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '@open-design/contracts';

vi.mock('../../../src/fantay/design/DesignDocumentViewer', () => ({ DesignDocumentViewer: () => null }));

import { DesignDocumentViewer } from '../../../src/fantay/design/DesignDocumentViewer';
import { designFileEditor } from '../../../src/fantay/design/file-editor';
import { renderFileEditorFrom } from '../../../src/fantay/editors/file-editors';
import { getEditorContext, resetEditorContextsForTests } from '../../../src/fantay/editors/editor-context-store';

function file(name: string, type: ProjectFile['type'] = 'file'): ProjectFile {
  return { name, path: name, type, size: 1, mtime: 1, kind: 'binary', mime: 'application/octet-stream' };
}

describe('designFileEditor', () => {
  it('matches .fig and .op project files only', () => {
    expect(designFileEditor.id).toBe('design');
    expect(designFileEditor.matches(file('designs/首页.fig'))).toBe(true);
    expect(designFileEditor.matches(file('Board.OP'))).toBe(true);
    expect(designFileEditor.matches(file('designs/a.fig.png'))).toBe(false);
    expect(designFileEditor.matches(file('movie-studio.json'))).toBe(false);
    expect(designFileEditor.matches(file('designs.fig', 'dir'))).toBe(false);
  });

  it('renders the design document viewer with the editor context (C2 writer included)', () => {
    resetEditorContextsForTests();
    const target = file('designs/首页.fig');
    const element = renderFileEditorFrom([designFileEditor], { projectId: 'p1', file: target, active: true, runInFlight: false, viewerOnly: true });
    expect(isValidElement(element)).toBe(true);
    const props = (element as ReactElement<Record<string, unknown>>).props;
    expect((element as ReactElement).type).toBe(DesignDocumentViewer);
    expect(props).toMatchObject({ projectId: 'p1', file: target, active: true, runInFlight: false, viewerOnly: true });
    const report = props.onActiveContextChange as (item: unknown) => void;
    report({ id: 'design:designs/首页.fig:1:2', kind: 'file', label: '首页.fig · Hero', path: 'designs/首页.fig' });
    expect(getEditorContext('p1', 'designs/首页.fig')).toMatchObject({ id: 'design:designs/首页.fig:1:2' });
  });
});
