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
import { connection } from 'next/server';

export const metadata = {
  title: 'TokenProxy',
  description: 'Operator surface for the TokenProxy gateway',
};

export default async function RootLayout({ children }) {
  // Operator pages render per request, independently of display preferences.
  await connection();
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <ColorSchemeScript defaultColorScheme="light" />
        <link rel="preload" href="/fonts/manrope-variable.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
      </head>
      <body>
        <UiProvider>{children}</UiProvider>
      </body>
    </html>
  );
}
