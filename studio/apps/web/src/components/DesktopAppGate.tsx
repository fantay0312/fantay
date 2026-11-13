'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { getOpenDesignHost } from '@open-design/host';
import { ArrowUpRight } from 'lucide-react';
import { Button, FX, Icon } from '../fantay/ui';
import { useI18n } from '../i18n';
import { BrandName } from './BrandName';
import styles from './DesktopAppGate.module.css';

/** Fantay's renderer belongs to the desktop host, not a standalone web app. */
export function DesktopAppGate({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [entry, setEntry] = useState<'checking' | 'desktop' | 'browser'>('checking');
  useEffect(() => {
    // Browser-based component/e2e checks are an explicit development tool,
    // never an alternative product entry in a production build.
    const rendererDev = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_FANTAY_RENDERER_DEV === '1';
    setEntry(rendererDev || getOpenDesignHost()?.client.type === 'desktop' ? 'desktop' : 'browser');
  }, []);
  if (entry === 'checking') return null;
  if (entry === 'desktop') return <>{children}</>;
  const zh = locale.startsWith('zh');
  return <main className={`${FX} ${styles.page}`} data-testid="desktop-app-required">
    <div className={styles.content}>
      <img src="/app-icon.svg" alt="" width="64" height="64" />
      <h1>{zh ? <>请在桌面端使用 <BrandName /></> : <>Use <BrandName /> on your desktop</>}</h1>
      <p>{zh ? '视频、设计和作品管理都已整合到桌面应用。' : 'Video editing, design and your projects are all in the desktop app.'}</p>
      <Button asChild variant="primary"><a href="opendesign://workspace/open">{zh ? '打开' : 'Open'} <BrandName /><Icon icon={ArrowUpRight} size="sm" /></a></Button>
      <small>{zh ? '如未自动打开，请从应用列表启动 Fantay。' : 'If it does not open, launch Fantay from your applications.'}</small>
    </div>
  </main>;
}
