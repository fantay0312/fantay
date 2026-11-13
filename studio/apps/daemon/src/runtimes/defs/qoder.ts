import path from 'node:path';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const qoderAgentDef = {
    id: 'qoder',
    name: 'Qoder CLI',
    bin: 'qodercli',
    versionArgs: ['--version'],
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: 'lite', label: 'Lite' },
      { id: 'efficient', label: 'Efficient' },
      { id: 'auto', label: 'Auto' },
      { id: 'performance', label: 'Performance' },
      { id: 'ultimate', label: 'Ultimate' },
    ],
    // Qoder print mode exits after the turn. Deliver the composed prompt via
    // stdin to avoid argv length limits, while using stream-json so the daemon
    // can surface text and usage incrementally. `--yolo` is Qoder's documented
    // non-interactive approval flag, and `-w` selects the workspace.
    // Authentication remains Qoder CLI-owned: users can rely on persisted
    // `qodercli login` state, or launch the daemon with
    // QODER_PERSONAL_ACCESS_TOKEN for automation. Do not add that token to
    // static adapter env; unlike Gemini's workspace trust flag it is a user
    // secret and already flows through the inherited process environment.
    buildArgs: (
      _prompt,
      imagePaths,
      extraAllowedDirs = [],
      options = {},
      runtimeContext = {},
    ) => {
      const permission = runtimeContext.executionPermission;
      const restricted =
        permission === 'read-only' || permission === 'workspace-write';
      const args = [
        '-p',
        '--output-format',
        'stream-json',
      ];
      if (permission === 'read-only') {
        args.push(
          '--permission-mode',
          'dont_ask',
          '--strict-mcp-config',
          '--tools',
          'Read,Glob,Grep',
          '--disallowed-tools',
          'Bash,Edit,Write',
        );
      } else if (permission === 'workspace-write') {
        args.push(
          '--permission-mode',
          'accept_edits',
          '--strict-mcp-config',
          '--tools',
          'Read,Glob,Grep,Edit,Write',
          '--disallowed-tools',
          'Bash',
        );
      } else {
        args.push('--yolo');
      }
      if (runtimeContext.cwd) {
        args.push('-w', runtimeContext.cwd);
      }
      if (options.model && options.model !== 'default') {
        args.push('--model', options.model);
      }
      const dirs = (restricted ? [] : extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && path.isAbsolute(d),
      );
      const attachments = (imagePaths || []).filter(
        (p) => typeof p === 'string' && path.isAbsolute(p),
      );
      for (const d of dirs) args.push('--add-dir', d);
      for (const p of attachments) args.push('--attachment', p);
      return args;
    },
    promptViaStdin: true,
    streamFormat: 'qoder-stream-json',
} satisfies RuntimeAgentDef;
