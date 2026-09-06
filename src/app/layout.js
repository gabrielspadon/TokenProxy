import "@/lib/network/initOutboundProxy";
import "@/shared/services/bootstrap";
import "./globals.css";
import "./operator.css";
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { getServerLocale } from "@/i18n/server";
import { getLocaleDirection } from "@/i18n/config";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";

initConsoleLogCapture();

export const metadata = { title: "TokenProxy", description: "Operator surface for the TokenProxy gateway" };

export default async function RootLayout({ children }) {
  const locale = await getServerLocale();
  return (
    <html lang={locale} dir={getLocaleDirection(locale)}>
      <body>
        <RuntimeI18nProvider>{children}</RuntimeI18nProvider>
      </body>
    </html>
  );
}
