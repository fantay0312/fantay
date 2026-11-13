import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n';
import { AnalyticsProvider } from '../src/analytics/provider';
import '../src/fantay/styles/app.css';
import { FANTAY_THEME_INIT_SCRIPT } from '../src/fantay/theme/init-script';
// These hosts render from the client-only App entry. Keep their layout CSS in
// the root route stylesheet so Turbopack does not leave the lazy chunk as a
// preload-only resource after the host mounts.
import '../src/components/OnboardingWelcome.module.css';

export const metadata: Metadata = {
  title: 'Fantay',
  icons: {
    icon: [
      { url: '/app-icon-small.svg', type: 'image/svg+xml', sizes: '16x16 24x24 32x32' },
      { url: '/app-icon.svg', type: 'image/svg+xml', sizes: '48x48 64x64 128x128 256x256 512x512 1024x1024' },
      { url: '/app-icon.png', type: 'image/png', sizes: '1024x1024' },
    ],
    apple: '/app-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
};

/** Fantay: paints data-theme (light default, `fantay:theme` preference) and a custom accent before hydration. Source: src/fantay/theme/init-script.ts. */
const themeInitScript = FANTAY_THEME_INIT_SCRIPT;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang='en' data-theme='light' suppressHydrationWarning>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: intentional theme-init inline script to prevent FOUC */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body suppressHydrationWarning>
        <I18nProvider>
          <AnalyticsProvider>{children}</AnalyticsProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
