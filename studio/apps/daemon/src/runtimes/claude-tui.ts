import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import Xterm from '@xterm/headless';
import { terminateProcessGroup } from '@open-design/platform';
import type { IPty } from 'node-pty';
import { loadNodePty } from '../services/node-pty.js';
import { recordAgentProcessUntilGroupExits, type SpawnAgentProcessRequest, type SpawnedAgentProcess } from './agent-process.js';

type Row = Record<string, any>;

/** Treat all user text as a paste, never as terminal controls or slash commands. */
export function claudeTuiPaste(text: string): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  return /^[\s]*[/!#&]/.test(clean) ? `\n${clean}` : clean;
}

/** Only the native transcript's turn_duration is evidence of a completed turn. */
export class ClaudeTuiTranscript {
  private buffer = '';
  private submitted = false;
  constructor(private readonly emit: (row: Row) => void, private readonly end: (error?: string) => void) {}
  begin(): void { this.submitted = true; }
  feed(text: string): void {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let row: Row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.isSidechain || !this.submitted) continue;
      if (row.type === 'assistant' && row.message) {
        // Message stop_reason may precede tool execution and native Stop hooks.
        // Keep daemon stdin open until the real native turn boundary arrives.
        this.emit({ ...row, message: { ...row.message, stop_reason: null } });
        if (row.isApiErrorMessage) {
          this.submitted = false;
          this.end((row.message.content ?? []).filter((b: Row) => b.type === 'text').map((b: Row) => b.text).join('\n') || 'Claude Code TUI request failed');
        }
      } else if (row.type === 'user') {
        this.emit(row);
      } else if (row.type === 'system' && row.subtype === 'turn_duration') {
        this.submitted = false;
        this.end();
      }
    }
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error('Claude Code transcript row exceeded 8 MiB');
  }
}

function findTranscript(root: string, cwd: string, id: string): string {
  const projects = path.join(root, 'projects');
  const expected = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  if (fs.existsSync(expected)) return expected;
  // Claude owns the directory encoding; support version/platform differences
  // without opening any other session's contents.
  try {
    for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(projects, dir.name, `${id}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* the first session has not created projects/ yet */ }
  return expected;
}

/**
 * Native PTY with a ChildProcess-compatible lifecycle. Its PID is the real
 * owned PTY child, recorded by the same durable reaper as pipe-based agents.
 * Terminal pixels are never mixed into the structured chat stream.
 */
export async function spawnClaudeTuiProcess(
  request: SpawnAgentProcessRequest & { allowWorkspaceTrust?: boolean; onTerminalData?: (data: string) => void },
): Promise<SpawnedAgentProcess> {
  const idIndex = request.args.findIndex((a) => a === '--resume' || a === '--session-id');
  const sessionId = idIndex >= 0 ? request.args[idIndex + 1] : null;
  if (!sessionId || !/^[\da-f-]{36}$/i.test(sessionId)) throw new Error('Claude Code TUI requires a UUID session id');
  const configRoot = request.env.CLAUDE_CONFIG_DIR || path.join(request.env.HOME || os.homedir(), '.claude');
  let transcriptPath = findTranscript(configRoot, request.cwd, sessionId);
  let offset = fs.existsSync(transcriptPath) ? fs.statSync(transcriptPath).size : 0;
  const decoder = new StringDecoder('utf8');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new ChildProcess();
  const ptyModule = await loadNodePty();
  const env = Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  // Let the real interactive CLI choose its own entrypoint. Never impersonate
  // another client by assigning an entrypoint or patching request headers.
  for (const key of Object.keys(env)) {
    if (['CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID'].includes(key)
      || key.startsWith('CLAUDE_CODE_MESSAGING_')) delete env[key];
  }
  const spawnedAtMs = Date.now();
  const terminal: IPty = ptyModule.spawn(request.command, [...request.args], {
    cwd: request.cwd, env, name: 'xterm-256color', cols: 200, rows: 50,
  });
  const queue: string[] = [];
  let input = '';
  let ready = false;
  let busy = false;
  let completed = false;
  let failure: string | null = null;
  let exited = false;
  const display = new Xterm.Terminal({ cols: 200, rows: 50, scrollback: 0, allowProposedApi: true });
  display.onData((reply) => { if (!exited) terminal.write(reply); });
  let lastDrawAt = 0;
  let trustYesAt = 0;
  let trustDownAt = 0;
  let trustConfirmations = 0;
  let lastLocate = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!exited) fn(); }, ms);
    timers.add(timer);
  };
  const emit = (row: Row) => { stdout.write(`${JSON.stringify(row)}\n`); };
  const stop = () => {
    if (process.platform !== 'win32') {
      void terminateProcessGroup(terminal.pid, { termGraceMs: 2000, killGraceMs: 1000 }).catch(() => {});
    } else {
      try { terminal.kill(); } catch { /* already exited */ }
    }
  };
  const fail = (message: string) => {
    if (failure || completed || exited) return;
    failure = message;
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [message] });
    stop();
  };
  const parser = new ClaudeTuiTranscript(emit, (error) => {
    busy = false;
    if (error) { fail(error); return; }
    if (queue.length) { later(submit, 200); return; }
    completed = true;
    emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: sessionId });
    later(stop, 100);
  });
  function submit(): void {
    if (!ready || busy || completed || failure || !queue.length) return;
    busy = true;
    parser.begin();
    const prompt = claudeTuiPaste(queue.shift()!);
    terminal.write(`\x1b[200~${prompt}\x1b[201~`);
    later(() => terminal.write('\r'), 300);
  }
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      try {
        input += chunk.toString();
        let newline: number;
        while ((newline = input.indexOf('\n')) >= 0) {
          const frame = JSON.parse(input.slice(0, newline));
          input = input.slice(newline + 1);
          if (frame.type !== 'user' || !Array.isArray(frame.message?.content)) throw new Error('Unsupported Claude TUI input frame');
          const blocks = frame.message.content;
          if (blocks.some((b: Row) => b.type !== 'text')) throw new Error('Claude TUI expects file references in text');
          queue.push(blocks.map((b: Row) => b.text).join('\n'));
          submit();
        }
        done();
      } catch (error) { fail(String(error)); done(); }
    },
    final(done) { if (completed || failure) stop(); done(); },
  });
  Object.assign(child, { pid: terminal.pid, stdin, stdout, stderr });
  child.kill = (signal = 'SIGTERM') => {
    try { terminal.kill(typeof signal === 'string' ? signal : undefined); Object.assign(child, { killed: true }); return true; } catch { return false; }
  };
  const drain = () => {
    if (Date.now() - lastLocate > 1000 && !fs.existsSync(transcriptPath)) {
      transcriptPath = findTranscript(configRoot, request.cwd, sessionId); lastLocate = Date.now();
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(transcriptPath, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < offset) throw new Error('Claude Code transcript was truncated during this run');
      // Drain all available complete rows before an exit is classified.
      while (offset < size) {
        const buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
        const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
        if (!count) break;
        offset += count;
        parser.feed(decoder.write(buffer.subarray(0, count)));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(`Unable to read Claude Code transcript: ${String(error)}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const inspectScreen = () => {
    if (exited || completed || failure) return;
    const buffer = display.buffer.active;
    const screen = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\n');
    const compact = screen.replace(/\s/g, '').toLowerCase();
    if (!ready) {
      if (/trustthisfolder|trustthefilesinthisfolder/.test(compact)) {
        if (!request.allowWorkspaceTrust) {
          fail('Claude Code TUI needs folder trust. Open this project in Claude Code and trust it, then retry.'); return;
        }
        if (trustConfirmations >= 3) return;
        // Wait for the real rendered selection, including incremental cursor
        // redraws. An Enter sent before the selection settles can accept No.
        if (/❯(?:1\.)?yes,?itrustthisfolder/.test(compact)) {
          if (!trustYesAt) trustYesAt = Date.now();
          if (Date.now() - trustYesAt >= 350) {
            trustConfirmations++; trustYesAt = 0; terminal.write('\r');
          }
        } else if (/❯no,?exit/.test(compact) && Date.now() - trustDownAt >= 1000) {
          trustYesAt = 0; trustDownAt = Date.now(); terminal.write('\x1b[B');
        }
        return;
      }
      if (/select.*theme|signin|loginmethod|choosethetextstyle/.test(compact)) {
        fail('Complete Claude Code setup and login in your terminal, then retry TUI mode.'); return;
      }
      if (/allowexternalclaude\.mdfileimports|securitynotes:/.test(compact)) {
        fail('Claude Code TUI needs native setup or external-file approval. Complete it in Claude Code, then retry.'); return;
      }
      // A selection arrow is not an input prompt. Menus such as external
      // CLAUDE.md approval must never receive the user's task as keystrokes.
      // The native empty input uses a non-breaking space before its optional
      // "Try ..." placeholder; menu rows use ordinary spaces and a label.
      if (/^[ \t]*[❯›](?:\u00a0|[ \t]*$)/m.test(screen) && Date.now() - lastDrawAt >= 300) {
        ready = true;
        emit({ type: 'system', subtype: 'init', session_id: sessionId });
        later(submit, 150);
      }
    } else if (/(?:doyouwantto(?:proceed|allow)|allowthis(?:tool|command))[\s\S]{0,2000}1[.)]yes/.test(compact)) {
      fail('Claude Code TUI is waiting for a tool permission. Authorize the tool in Claude Code and retry, or select print (-p) mode.');
    }
  };
  const poll = setInterval(() => { drain(); inspectScreen(); }, 100);
  terminal.onData((data) => {
    request.onTerminalData?.(data);
    lastDrawAt = Date.now();
    display.write(data);
  });
  terminal.onExit(({ exitCode, signal }) => {
    drain();
    exited = true;
    clearInterval(poll);
    display.dispose();
    for (const timer of timers) clearTimeout(timer);
    if (!completed && !failure) stderr.write('Claude Code TUI exited before a native turn-completion record was received.\n');
    stdout.end(); stderr.end();
    const code = completed ? 0 : failure ? 1 : exitCode || 1;
    const exitSignal = completed || failure ? null
      : (Object.entries(os.constants.signals).find(([, value]) => value === signal)?.[0] as NodeJS.Signals | undefined) ?? null;
    Object.assign(child, { exitCode: code, signalCode: exitSignal });
    child.emit('exit', code, exitSignal);
    child.emit('close', code, exitSignal);
  });
  recordAgentProcessUntilGroupExits(child, {
    processGroupId: process.platform === 'win32' ? null : terminal.pid,
    runDir: request.runDir, runId: request.runId, launchPath: request.command,
    spawnedAtMs, spawnReturnedAtMs: Date.now(),
  });
  later(() => { if (!ready) fail('Claude Code TUI did not reach its prompt within 45 seconds. Complete native setup or select print (-p) mode.'); }, 45000);
  queueMicrotask(() => child.emit('spawn'));
  return { child, processGroupId: process.platform === 'win32' ? null : terminal.pid, promptDeliveredAtSpawn: false };
}
