import '@/lib/network/initOutboundProxy';
import '@/shared/services/bootstrap';
import './globals.css';
import './operator.css';
import '@mantine/core/styles.layer.css';
import '@mantine/dates/styles.layer.css';
import '@mantine/notifications/styles.layer.css';
import './workspace.css';
import { UiProvider } from '@/shared/workspace/UiProvider';
import { ColorSchemeScript } from '@mantine/core';
import { initConsoleLogCapture } from '@/lib/consoleLogBuffer';
import { getServerLocale } from '@/i18n/server';
import { getLocaleDirection } from '@/i18n/config';
import { RuntimeI18nProvider } from '@/i18n/RuntimeI18nProvider';

initConsoleLogCapture();

export const metadata = {
  title: 'TokenProxy',
  description: 'Operator surface for the TokenProxy gateway',
};

export default async function RootLayout({ children }) {
  const locale = await getServerLocale();
  return (
    <html lang={locale} dir={getLocaleDirection(locale)} suppressHydrationWarning>
      <head>
        <ColorSchemeScript defaultColorScheme="light" />
        <link rel="preload" href="/fonts/manrope-variable.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
      </head>
      <body>
        <UiProvider>
          <RuntimeI18nProvider>{children}</RuntimeI18nProvider>
        </UiProvider>
      </body>
    </html>
  );
}
