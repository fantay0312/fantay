import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { evaluateAcpPermissionRequest } from '../src/agent-protocol/acp/permission-policy.js';
import { replyExtensionUi } from '../src/agent-protocol/pi-rpc/session.js';

const STANDARD_OPTIONS = [
  { optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'allow-all', kind: 'allow_always', name: 'Allow always' },
  { optionId: 'reject-1', kind: 'reject_once', name: 'Reject once' },
];

describe('ACP and Pi-RPC permission enforcement', () => {
  it('auto-allows ACP permission requests when executionPermission is unset or danger-full-access', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'od-acp-perm-'));
    try {
      const shellReq = {
        options: STANDARD_OPTIONS,
        toolCall: { kind: 'execute', name: 'bash', rawInput: { command: 'rm -rf /tmp/x' } },
      };
      expect(
        evaluateAcpPermissionRequest({ params: shellReq, executionPermission: null, cwd }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } });
      expect(
        evaluateAcpPermissionRequest({
          params: shellReq,
          executionPermission: 'danger-full-access',
          cwd,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('enforces read-only in ACP by allowing in-workspace reads and rejecting writes, shell, and outside reads', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-acp-ro-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'od-acp-outside-'));
    try {
      writeFileSync(path.join(root, 'index.html'), '<main>ok</main>');
      writeFileSync(path.join(outside, 'secret.txt'), 'nope');
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape-link.txt'));

      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: STANDARD_OPTIONS,
            toolCall: { kind: 'read', name: 'read_file', locations: [{ path: 'index.html' }] },
          },
          executionPermission: 'read-only',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } });

      // Reject file write in read-only
      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: STANDARD_OPTIONS,
            toolCall: { kind: 'edit', name: 'write_file', locations: [{ path: 'index.html' }] },
          },
          executionPermission: 'read-only',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-1' } });

      // Reject shell in read-only
      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: STANDARD_OPTIONS,
            toolCall: { kind: 'execute', name: 'bash', rawInput: { command: 'ls' } },
          },
          executionPermission: 'read-only',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-1' } });

      // Reject symlink escape on read
      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: STANDARD_OPTIONS,
            toolCall: { kind: 'read', name: 'read_file', locations: [{ path: 'escape-link.txt' }] },
          },
          executionPermission: 'read-only',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-1' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('enforces workspace-write in ACP with path, dotfile, and symlink validation and cancelled fallback', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-acp-rw-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'od-acp-rw-out-'));
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      symlinkSync(outside, path.join(root, 'linked-out'));

      // Allow creating/editing regular file inside workspace
      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: STANDARD_OPTIONS,
            toolCall: { kind: 'edit', name: 'write_file', rawInput: { file_path: 'src/app.tsx' } },
          },
          executionPermission: 'workspace-write',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } });

      // Reject unscoped write without target path
      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: STANDARD_OPTIONS,
            toolCall: { kind: 'edit', name: 'write_file', rawInput: {} },
          },
          executionPermission: 'workspace-write',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-1' } });

      // Reject .env write inside workspace
      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: STANDARD_OPTIONS,
            toolCall: { kind: 'edit', name: 'write_file', rawInput: { path: '.env.local' } },
          },
          executionPermission: 'workspace-write',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-1' } });

      // Reject symlink parent escape
      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: STANDARD_OPTIONS,
            toolCall: { kind: 'edit', name: 'write_file', rawInput: { path: 'linked-out/pwn.txt' } },
          },
          executionPermission: 'workspace-write',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-1' } });

      // When the agent offers only allow options, fall back to ACP `{ outcome: 'cancelled' }`
      expect(
        evaluateAcpPermissionRequest({
          params: {
            options: [{ optionId: 'allow-only', kind: 'allow_once', name: 'Allow' }],
            toolCall: { kind: 'execute', name: 'bash', rawInput: { command: 'whoami' } },
          },
          executionPermission: 'workspace-write',
          cwd: root,
        }),
      ).toEqual({ outcome: { outcome: 'cancelled' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('denies Pi-RPC extension UI confirmation dialogs when restricted', () => {
    const readLine = (perm: 'read-only' | 'workspace-write' | 'danger-full-access' | null) => {
      const stream = new PassThrough();
      replyExtensionUi(
        stream,
        { id: 'req-1', method: 'confirm', params: { message: 'Run shell?' } },
        { executionPermission: perm },
      );
      return JSON.parse(stream.read()?.toString('utf8') ?? '{}');
    };

    expect(readLine('read-only').confirmed).toBe(false);
    expect(readLine('workspace-write').confirmed).toBe(false);
    expect(readLine('danger-full-access').confirmed).toBe(true);
    expect(readLine(null).confirmed).toBe(true);
  });
});
