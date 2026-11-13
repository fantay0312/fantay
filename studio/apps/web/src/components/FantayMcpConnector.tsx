// Fantay's own MCP server, listed on its own at the top of 插件 ▸ 连接器: not a third-party connector, so it never
// joins the catalogue below it, and collapsed to one row so its long setup command does not outweigh the list. Opening
// the row resolves the daemon's install paths and shows the setup for the chosen coding agent.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';

import { FantayMascot } from '../fantay/brand/FantayMascot';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import styles from './FantayMcpConnector.module.css';

// Per-client install paths. Each entry's `snippet` is what the user
// copies; some clients also support a richer `deeplink` flow that
// triggers a one-click install with an in-client approval dialog.
//
// Schemas drift between clients in deliberate ways. VS Code keys
// servers under "servers" with a required "type" field; Zed uses
// "context_servers"; Cursor, Kiro, Windsurf, and Antigravity share
// "mcpServers"; Claude Code is best served by its CLI which writes
// to the local config for you. Verified against each tool's official
// docs in May 2026.
//
// Important: every snippet uses absolute paths to the daemon's current
// Node-compatible runtime and built cli.js, fetched at runtime. macOS
// and Linux ship a system /usr/bin/od (octal-dump) that shadows any
// `od` we might add to PATH, and most OpenDesign users run from
// source where `od` is not installed globally. The installer panel
// must NOT reference bare `od`.
type McpClientId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'kiro'
  | 'vscode'
  | 'zed'
  | 'windsurf'
  | 'antigravity';

interface McpInstallInfo {
  command: string;
  args: string[];
  env?: Record<string, string>;
  daemonUrl: string;
  platform: 'darwin' | 'linux' | 'win32' | string;
  cliExists: boolean;
  nodeExists: boolean;
  buildHint: string | null;
}

interface McpStdioServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpClient {
  id: McpClientId;
  label: string;
  // Function so the dropdown can show different methods per OS
  // (Claude Code uses CLI on POSIX but JSON edit on Windows because
  // the bash/PowerShell/cmd.exe quoting is too fragile to reliably
  // emit a single command that works in every shell).
  buildMethod: (info: McpInstallInfo) => string;
  // Function so per-OS path hints (~/.cursor on POSIX vs
  // %USERPROFILE%\.cursor on Windows) and shortcut differences
  // (⌘⇧P vs Ctrl+Shift+P) can be rendered correctly.
  buildInstruction: (info: McpInstallInfo) => string;
  buildSnippet: (info: McpInstallInfo) => string;
  buildSnippetLang: (info: McpInstallInfo) => 'bash' | 'json' | 'toml';
  // Optional one-click install action. Currently only Cursor
  // supports deeplinks of this shape.
  buildDeeplink?: (info: McpInstallInfo) => string;
  deeplinkLabel?: () => string;
}

// Path hint per OS. Localizes the "where to paste" copy so a
// Windows user does not see ~/.cursor/mcp.json (which their shell
// will not expand) or a Linux user does not see %APPDATA% paths.
function homeConfigPath(
  platform: McpInstallInfo['platform'],
  posix: string,
  windows: string,
): string {
  return platform === 'win32' ? windows : posix;
}

function commandPaletteShortcut(platform: McpInstallInfo['platform']): string {
  return platform === 'darwin' ? '⌘⇧P' : 'Ctrl+Shift+P';
}

function settingsShortcut(platform: McpInstallInfo['platform']): string {
  return platform === 'darwin' ? '⌘,' : 'Ctrl+,';
}

// btoa() requires every input character be representable in Latin-1
// (codepoints 0-255). A Mac/Linux home directory like
// "/Users/Émile/.fnm/.../node" trips that and throws
// InvalidCharacterError. UTF-8-encode the string into bytes first,
// then map each byte back to a Latin-1 char before base64'ing.
function utf8Btoa(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function buildMcpStdioServerConfig(info: McpInstallInfo): McpStdioServerConfig {
  const env = info.env && Object.keys(info.env).length > 0 ? info.env : undefined;
  return {
    command: info.command,
    args: info.args,
    ...(env ? { env } : {}),
  };
}

function buildCodexEnvToml(info: McpInstallInfo): string {
  const entries = Object.entries(info.env ?? {});
  if (entries.length === 0) return '';
  return `

[mcp_servers.open-design.env]
${entries.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}`;
}

function buildSharedMcpJson(info: McpInstallInfo): string {
  const inner = buildMcpStdioServerConfig(info);
  const innerJson = JSON.stringify(inner, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `    ${line}`))
    .join('\n');
  return `{
  "mcpServers": {
    "open-design": ${innerJson}
  }
}`;
}

// One-click install toggle for Codex: queries the daemon for whether
// `codex mcp get open-design` succeeds, and POSTs/DELETEs the install
// endpoint to call `codex mcp add/remove` on the user's behalf. The
// copy-snippet path still works for users who prefer to paste manually
// or whose Codex CLI is not on PATH (button shows a disabled hint in
// that case).
function CodexInstallToggle(): JSX.Element | null {
  const { t } = useI18n();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp/install/codex/status');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { available: boolean; installed: boolean };
      setAvailable(Boolean(data.available));
      setInstalled(Boolean(data.installed));
    } catch {
      // Daemon unreachable or endpoint missing — hide the toggle
      // entirely rather than spook the user with a permanent error.
      setAvailable(false);
      setInstalled(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(
    async (method: 'POST' | 'DELETE', successKey: 'settings.mcpCodexInstallSuccess' | 'settings.mcpCodexUninstallSuccess') => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await fetch('/api/mcp/install/codex', { method });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(body?.error?.message || `HTTP ${res.status}`);
        }
        setMessage({ kind: 'success', text: t(successKey) });
        await refresh();
      } catch (err) {
        setMessage({
          kind: 'error',
          text: t('settings.mcpCodexInstallError', { error: err instanceof Error ? err.message : String(err) }),
        });
      } finally {
        setBusy(false);
      }
    },
    [refresh, t],
  );

  if (available === null) return null;

  if (!available) {
    return (
      <div className={styles.inlineAction}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled
        >
          {t('settings.mcpCodexOneClickInstall')}
        </Button>
        <span className={styles.note}>{t('settings.mcpCodexOneClickUnavailable')}</span>
      </div>
    );
  }

  const label = installed
    ? t('settings.mcpCodexOneClickUninstall')
    : t('settings.mcpCodexOneClickInstall');
  const onClick = () => {
    if (installed) {
      void run('DELETE', 'settings.mcpCodexUninstallSuccess');
    } else {
      void run('POST', 'settings.mcpCodexInstallSuccess');
    }
  };

  return (
    <div className={styles.inlineAction}>
      <Button
        type="button"
        variant={installed ? 'secondary' : 'primary'}
        size="sm"
        disabled={busy}
        onClick={onClick}
      >
        {busy ? t('settings.mcpCodexBusy') : label}
      </Button>
      {message ? (
        <span className={styles.note} data-tone={message.kind === 'error' ? 'danger' : undefined}>
          {message.text}
        </span>
      ) : null}
    </div>
  );
}

export function FantayMcpConnector({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Set by hand: React 18 drops a boolean `inert` prop, and a closed panel must not take focus.
  useEffect(() => {
    panelRef.current?.toggleAttribute('inert', !open);
  }, [open]);

  const MCP_CLIENTS: McpClient[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      buildMethod: () => t('settings.mcpMethodCli'),
      buildInstruction: () => t('settings.mcpInstructionCli'),
      buildSnippet: (info) => {
        const inner = JSON.stringify(buildMcpStdioServerConfig(info));
        return `claude mcp add-json --scope user open-design '${inner}'`;
      },
      buildSnippetLang: () => 'bash',
    },
    {
      id: 'codex',
      label: 'Codex',
      buildMethod: () => t('settings.mcpMethodToml'),
      buildInstruction: (info) => {
        const path = homeConfigPath(
          info.platform,
          '~/.codex/config.toml',
          '%USERPROFILE%\\.codex\\config.toml',
        );
        return t('settings.mcpInstructionCodex', { path });
      },
      buildSnippet: (info) => `[mcp_servers.open-design]\ncommand = ${JSON.stringify(info.command)}\nargs = ${JSON.stringify(info.args)}${buildCodexEnvToml(info)}`,
      buildSnippetLang: () => 'toml',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      buildMethod: () => t('settings.mcpMethodOneClick'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionCursor', {
          path: homeConfigPath(info.platform, '~/.cursor/mcp.json', '%USERPROFILE%\\.cursor\\mcp.json'),
        }),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
      buildDeeplink: (info) => {
        const inner = buildMcpStdioServerConfig(info);
        const encoded = utf8Btoa(JSON.stringify(inner));
        return `cursor://anysphere.cursor-deeplink/mcp/install?name=open-design&config=${encoded}`;
      },
      deeplinkLabel: () => t('settings.mcpDeeplinkInstallCursor'),
    },
    {
      id: 'kiro',
      label: 'Kiro CLI',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionKiro', {
          path: homeConfigPath(info.platform, '~/.kiro/settings/mcp.json', '%USERPROFILE%\\.kiro\\settings\\mcp.json'),
        }),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'vscode',
      label: 'VS Code',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionCopilot', {
          shortcut: commandPaletteShortcut(info.platform),
        }),
      buildSnippet: (info) => `{\n  "servers": {\n    "open-design": {\n      "type": "stdio",\n      "command": ${JSON.stringify(info.command)},\n      "args": ${JSON.stringify(info.args)}${info.env && Object.keys(info.env).length > 0 ? `,\n      "env": ${JSON.stringify(info.env)}` : ''}\n    }\n  }\n}`,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: () => t('settings.mcpInstructionAntigravity'),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'zed',
      label: 'Zed',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionZed', {
          shortcut: settingsShortcut(info.platform),
        }),
      buildSnippet: (info) => `{\n  "context_servers": {\n    "open-design": {\n      "source": "custom",\n      "command": ${JSON.stringify(info.command)},\n      "args": ${JSON.stringify(info.args)}${info.env && Object.keys(info.env).length > 0 ? `,\n      "env": ${JSON.stringify(info.env)}` : ''}\n    }\n  }\n}`,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionWindsurf', {
          path: homeConfigPath(info.platform, '~/.codeium/windsurf/mcp_config.json', '%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json'),
        }),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
    },
  ];

  const [clientId, setClientId] = useState<McpClientId>('claude');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [info, setInfo] = useState<McpInstallInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // The reset is wired through a ref-driven timer rather than effect
  // cleanup so re-clicks during the 2s window restart the countdown.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Close the dropdown on outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // Pull the absolute paths to node + cli.js from the running daemon
  // so snippets work even when `od` isn't on PATH (the realistic
  // case for source clones, plus macOS/Linux ship a /usr/bin/od that
  // shadows any global install). Fetched on mount; if the daemon is
  // unreachable we surface a clear error instead of a half-built
  // snippet that would silently fail when pasted.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    fetch('/api/mcp/install-info')
      .then(async (res) => {
        if (!res.ok) throw new Error(`daemon ${res.status}`);
        return (await res.json()) as McpInstallInfo;
      })
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setInfoError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setInfoError(String(err && err.message ? err.message : err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const client = MCP_CLIENTS.find((c) => c.id === clientId) ?? MCP_CLIENTS[0]!;
  const snippet = info ? client.buildSnippet(info) : '';
  const snippetLang: 'bash' | 'json' | 'toml' = info
    ? client.buildSnippetLang(info)
    : 'json';

  // Reset the "Copied" badge when the user flips to a different
  // client; otherwise the green check sits there next to a snippet
  // they haven't actually copied.
  useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [clientId]);

  const onCopy = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail under non-secure contexts; the snippet
      // is selectable so the user can still copy manually.
      setCopied(false);
    }
  };

  return (
    <section
      className={styles.root}
      aria-labelledby={`${id}-title`}
      data-open={open ? '' : undefined}
      data-testid="fantay-mcp-connector"
    >
      <div className={styles.head}>
        <span className={styles.mark} aria-hidden>
          <FantayMascot size={32} />
        </span>
        <div className={styles.copy}>
          <h3 id={`${id}-title`} className={styles.title}>{t('settings.mcpServerTitle')}</h3>
          <p className={styles.hint}>{t('settings.mcpServerHint')}</p>
        </div>
        <Button
          type="button"
          variant={open ? 'secondary' : 'primary'}
          size="sm"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          data-testid="fantay-mcp-toggle"
          onClick={() => setOpen((current) => !current)}
        >
          {t('connectors.connect')}
          <Icon name="chevron-down" size={13} className={styles.chevron} />
        </Button>
      </div>
      <div id={`${id}-panel`} ref={panelRef} className={styles.collapse}>
        <div className={styles.collapseInner}>
          <div className={styles.panel}>
            {infoError ? (
              <div className="empty-card" style={{ color: 'var(--danger)' }}>
                {t('settings.mcpDaemonError', { error: infoError })}
              </div>
            ) : null}

            <div className={styles.block}>
              <p className={styles.label}>{t('settings.mcpCapabilitiesTitle')}</p>
              <ul className={styles.capabilities}>
                {([
                  'settings.mcpCapabilityRead',
                  'settings.mcpCapabilityPull',
                  'settings.mcpCapabilityDefault',
                ] as const).map((key) => (
                  <li key={key}>
                    <Icon name="check" size={13} />
                    <span>{t(key)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className={styles.block}>
              <h4 className={styles.label}>{t('settings.mcpTitle')}</h4>
              <div className="ds-picker" ref={pickerRef}>
                <button
                  type="button"
                  className={`ds-picker-trigger${pickerOpen ? ' open' : ''}`}
                  onClick={() => setPickerOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                >
                  <span className="ds-picker-meta">
                    <span className="ds-picker-title">{client.label}</span>
                    <span className="ds-picker-sub">{info ? client.buildMethod(info) : ''}</span>
                  </span>
                  <Icon
                    name="chevron-down"
                    size={14}
                    className="ds-picker-chevron"
                    style={{ transform: pickerOpen ? 'rotate(180deg)' : undefined }}
                  />
                </button>
                {pickerOpen ? (
                  <div className="ds-picker-popover" role="listbox">
                    <div className="ds-picker-list">
                      {MCP_CLIENTS.map((c) => {
                        const active = c.id === clientId;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`ds-picker-item${active ? ' active' : ''}`}
                            onClick={() => {
                              setClientId(c.id);
                              setPickerOpen(false);
                            }}
                          >
                            <span className="ds-picker-item-text">
                              <span className="ds-picker-item-title">{c.label}</span>
                              <span className="ds-picker-sub">{info ? c.buildMethod(info) : ''}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>

              {info && client.id !== 'claude' ? <p className={styles.note}>{client.buildInstruction(info)}</p> : null}

              {client.id === 'codex' ? <CodexInstallToggle /> : null}

              {client.buildDeeplink && info ? (
                <div className={styles.inlineAction}>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      // Use a hidden anchor so the cursor:// scheme is
                      // handled the same way as a normal link click; some
                      // browsers block window.location assignments to
                      // unknown schemes from button handlers.
                      const url = client.buildDeeplink!(info);
                      const a = document.createElement('a');
                      a.href = url;
                      a.rel = 'noopener noreferrer';
                      a.click();
                    }}
                    disabled={!info.cliExists || !info.nodeExists}
                  >
                    <Icon name="link" size={14} />
                    <span>{client.deeplinkLabel ? client.deeplinkLabel() : ''}</span>
                  </Button>
                  <span className={styles.note}>{t('settings.mcpCursorApproval')}</span>
                </div>
              ) : null}

              {/* The copy action owns a header bar, so it can never sit on top of the
                  snippet text (issue #632). */}
              <div className={styles.snippet}>
                <div className={styles.snippetBar}>
                  <span className={styles.snippetLang}>{snippetLang}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCopy}
                    disabled={!snippet}
                    aria-label={t('settings.mcpCopyAria')}
                  >
                    <Icon name={copied ? 'check' : 'copy'} size={13} />
                    <span>{copied ? t('settings.mcpCopied') : t('settings.mcpCopy')}</span>
                  </Button>
                </div>
                <pre data-lang={snippetLang}>
                  <code>
                    {snippet ||
                      (infoError ? t('settings.mcpResolvingFailed') : t('settings.mcpLoadingPaths'))}
                  </code>
                </pre>
              </div>

              {/* "Build the daemon first" lives here, next to the code block it
                  explains, rather than reading as a fault before anything is picked. */}
              {info && (!info.cliExists || !info.nodeExists) ? (
                <p className={styles.warning}>
                  <strong>{!info.cliExists ? t('settings.mcpBuildDaemon') : t('settings.mcpNodeMissing')}</strong>{' '}
                  {info.buildHint ?? t('settings.mcpBuildHint')}
                </p>
              ) : null}

              <p className={styles.note}>{t('settings.mcpRunningNote')}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
