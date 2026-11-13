import type { PaControl, PaControlPatch } from '@open-design/contracts';

export interface PaBackgroundActions { show(): void; togglePause(): void; quit(): void }
export interface PaTrayHandle { update(control: PaControl | null): void; dispose(): void }
/** Main-process controller. Hidden renderers are never responsible for daemon lifecycle. */
export class PaBackgroundController {
  private current: PaControl | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private refreshing = false;
  private pendingPower: 'suspend' | 'resume' | null = null;
  private tray: PaTrayHandle | null = null;
  constructor(private deps: { daemonUrl: () => Promise<string>; fetch?: typeof fetch; show: () => void; quit: () => void; platform?: string; createTray?: (actions: PaBackgroundActions) => Promise<PaTrayHandle> }) {}
  keepRunningOnClose(): boolean {
    const platform = this.deps.platform ?? process.platform;
    return !this.disposed && (this.current?.backgroundEnabled ?? platform === 'darwin') && (platform === 'darwin' || this.tray !== null);
  }
  async start(): Promise<void> {
    if (this.disposed || this.timer) return;
    if (this.deps.createTray) {
      try { this.tray = await this.deps.createTray({ show: this.deps.show, quit: this.deps.quit, togglePause: () => { void this.patch({ paused: !this.current?.paused }).catch(() => this.deps.show()); } }); }
      catch { /* macOS retains its Dock entry; other platforms keep the window-close quit behavior */ }
    }
    if (this.disposed) { this.tray?.dispose(); this.tray = null; return; }
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2000);
    this.timer.unref();
  }
  private async request(path: string, body?: unknown): Promise<PaControl> {
    const url = await this.deps.daemonUrl();
    const response = await (this.deps.fetch ?? fetch)(`${url.replace(/\/$/, '')}/api/pa/control${path}`, { method: body === undefined ? 'GET' : path === '/power' ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('PA background control is unavailable');
    return response.json() as Promise<PaControl>;
  }
  async patch(patch: PaControlPatch): Promise<void> { this.current = await this.request('', patch); this.tray?.update(this.current); }
  async power(state: 'suspend' | 'resume'): Promise<void> {
    this.pendingPower = state;
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.refreshing) return;
    this.refreshing = true;
    try {
      const state = this.pendingPower;
      this.current = state ? await this.request('/power', { state }) : await this.request('');
      if (state === this.pendingPower) this.pendingPower = null;
      if (!this.disposed) this.tray?.update(this.current);
    } catch { if (!this.disposed) this.tray?.update(null); }
    finally { this.refreshing = false; }
  }
  dispose(): void { this.disposed = true; clearInterval(this.timer); this.tray?.dispose(); this.tray = null; }
}

export async function createPaTray(iconPath: string, locale: string, actions: PaBackgroundActions): Promise<PaTrayHandle> {
  const { Tray, Menu, nativeImage } = await import('electron');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  if (icon.isEmpty()) throw new Error('PA tray image is unavailable');
  const tray = new Tray(icon);
  const zh = locale.startsWith('zh');
  tray.setToolTip('Fantay');
  tray.on('click', actions.show);
  let lastKey = '';
  const update = (control: PaControl | null) => {
    const key = control ? `1:${control.activeCount}:${control.paused ? 1 : 0}` : '0';
    if (key === lastKey) return;
    lastKey = key;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: control ? `${zh ? '进行中' : 'Active'}: ${control.activeCount}${control.paused ? (zh ? ' · 已暂停' : ' · Paused') : ''}` : zh ? '正在连接本地服务' : 'Connecting to local service', enabled: false },
      { label: zh ? '显示 Fantay' : 'Show Fantay', click: actions.show },
      { label: control?.paused ? (zh ? '恢复 Fantay' : 'Resume Fantay') : (zh ? '暂停 Fantay' : 'Pause Fantay'), enabled: control !== null, click: actions.togglePause },
      { type: 'separator' },
      { label: zh ? '退出 Fantay 与后台' : 'Quit Fantay and background service', click: actions.quit },
    ]));
  };
  update(null);
  return { update, dispose: () => tray.destroy() };
}
