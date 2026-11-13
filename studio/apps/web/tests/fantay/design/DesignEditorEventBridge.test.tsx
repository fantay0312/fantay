// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real runner would boot a hidden editor; the bridge contract ends at the queued job.
vi.mock('../../../src/fantay/design/DesignCreationRunner', () => ({ DesignCreationRunner: () => null }));

import { DesignEditorEventBridge } from '../../../src/fantay/design/DesignEditorEventBridge';
import {
  registerDesignCreationRunner,
  resetNewDesignStoreForTests,
  updateDesignCreationJob,
  useDesignCreationJobs,
} from '../../../src/fantay/design/new-design-store';
import { __resetToastsForTests, useToasts } from '../../../src/fantay/ui';
import { FANTAY_OPEN_DESIGN_EDITOR_EVENT, type OpenDesignEditorDetail } from '../../../src/fantay/workspace/design-editor-events';

let unregisterRunner: (() => void) | null = null;

beforeEach(() => {
  unregisterRunner = registerDesignCreationRunner({});
});

afterEach(() => {
  cleanup();
  unregisterRunner?.();
  resetNewDesignStoreForTests();
  __resetToastsForTests();
  vi.useRealTimers();
});

function dispatch(detail: Partial<OpenDesignEditorDetail> & { ack: OpenDesignEditorDetail['ack'] }): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(FANTAY_OPEN_DESIGN_EDITOR_EVENT, { detail }));
  });
}

function request(overrides: Partial<OpenDesignEditorDetail['request']> = {}): OpenDesignEditorDetail['request'] {
  return { kind: 'new-from-image', image: { path: 'images/hero.png', mime: 'image/png', width: 800, height: 600 }, title: 'Hero', sourceNodeId: 'img-1', ...overrides };
}

let jobsSnapshot: ReturnType<typeof useDesignCreationJobs> = [];
let toastsSnapshot: ReturnType<typeof useToasts> = [];
function Probe() {
  jobsSnapshot = useDesignCreationJobs();
  toastsSnapshot = useToasts();
  return null;
}

describe('DesignEditorEventBridge', () => {
  it('acks its own project within the 1500 ms budget and queues a new-from-image job with lineage', () => {
    vi.useFakeTimers();
    render(
      <>
        <DesignEditorEventBridge projectId="p1" />
        <Probe />
      </>,
    );
    const ack = vi.fn();
    dispatch({ projectId: 'p1', request: request(), ack });
    // Answered synchronously — no timer had to run.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(jobsSnapshot).toHaveLength(1);
    expect(jobsSnapshot[0]).toMatchObject({
      status: 'queued',
      input: {
        projectId: 'p1',
        title: 'Hero',
        source: { kind: 'new-from-image', image: { path: 'images/hero.png' } },
        sourceNodeId: 'img-1',
        origin: 'event',
      },
    });
    vi.advanceTimersByTime(1500);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('ignores other projects (another bridge or the sender timeout answers them)', () => {
    render(<DesignEditorEventBridge projectId="p1" />);
    const ack = vi.fn();
    dispatch({ projectId: 'p2', request: request(), ack });
    expect(ack).not.toHaveBeenCalled();
  });

  it('answers each request once even with two bridges mounted', () => {
    render(
      <>
        <DesignEditorEventBridge projectId="p1" />
        <DesignEditorEventBridge projectId="p1" />
        <Probe />
      </>,
    );
    const ack = vi.fn();
    dispatch({ projectId: 'p1', request: request(), ack });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(jobsSnapshot).toHaveLength(1);
  });

  it('declines read-only projects, unsupported requests and the absence of a creation runner', () => {
    const { rerender } = render(<DesignEditorEventBridge projectId="p1" readOnly />);
    const readOnlyAck = vi.fn();
    dispatch({ projectId: 'p1', request: request(), ack: readOnlyAck });
    expect(readOnlyAck).toHaveBeenCalledWith({ ok: false, message: 'Read-only' });

    rerender(<DesignEditorEventBridge projectId="p1" />);
    const unsupportedAck = vi.fn();
    dispatch({ projectId: 'p1', request: { kind: 'edit-something' } as unknown as OpenDesignEditorDetail['request'], ack: unsupportedAck });
    expect(unsupportedAck).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));

    unregisterRunner?.();
    unregisterRunner = null;
    const noRunnerAck = vi.fn();
    dispatch({ projectId: 'p1', request: request(), ack: noRunnerAck });
    expect(noRunnerAck).toHaveBeenCalledWith({ ok: false });
  });

  it('shows a busy toast while the job runs and the reason when it fails', () => {
    render(
      <>
        <DesignEditorEventBridge projectId="p1" />
        <Probe />
      </>,
    );
    dispatch({ projectId: 'p1', request: request({ title: '' }), ack: vi.fn() });
    expect(jobsSnapshot[0]?.input.title).toBe('hero');
    expect(toastsSnapshot).toHaveLength(1);
    expect(toastsSnapshot[0]).toMatchObject({ title: 'Creating the design…', busy: true });
    const jobId = jobsSnapshot[0]!.id;
    act(() => updateDesignCreationJob(jobId, { status: 'running' }));
    expect(toastsSnapshot[0]).toMatchObject({ busy: true });
    act(() => updateDesignCreationJob(jobId, { status: 'failed', error: 'engine down' }));
    expect(toastsSnapshot).toHaveLength(1);
    expect(toastsSnapshot[0]).toMatchObject({ title: "Couldn't open this design: engine down", tone: 'danger' });
  });
});
