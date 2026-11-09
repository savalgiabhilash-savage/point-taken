import type { Metadata, Viewport } from "next";
import { Inter, Barlow_Condensed, Geist_Mono } from "next/font/google";
import { Sidebar, MobileTop, MobileTabs } from "@/components/nav";
import { Toaster } from "@/components/toast";
import { SectionPills } from "@/components/shell";
import "./globals.css";

// Body text Inter; headings and big numbers Barlow Condensed in caps (TV-graphics style) via font-display.
const inter = Inter({ variable: "--font-sans", subsets: ["latin"] });
const barlow = Barlow_Condensed({ variable: "--font-barlow", subsets: ["latin"], weight: ["600", "700"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// cover: lets the floating tab bar pad for the iPhone home indicator (env(safe-area-inset-bottom)).
export const viewport: Viewport = { viewportFit: "cover", themeColor: "#0a1024" };

export const metadata: Metadata = {
  title: "FPL Selector",
  description: "Fantasy Premier League decision tool — projected xPts, fixtures, and squad optimizer.",
  // iPhone home-screen app: full screen, black status bar (matches the dark theme). The manifest is app/manifest.ts.
  appleWebApp: { capable: true, title: "FPL Selector", statusBarStyle: "black" },
};

// Runs before the page paints, so there is no flash of the wrong theme. Saved choice: dark (default), light or
// system (follows the device, and updates live when the device switches).
const THEME_SCRIPT = `(function(){var d=document.documentElement,q=matchMedia('(prefers-color-scheme: light)');function a(){var t='dark';try{t=localStorage.getItem('theme')||'dark'}catch(e){}var l=t==='light'||(t==='system'&&q.matches);if(l)d.setAttribute('data-mode','light');else d.removeAttribute('data-mode');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',l?'#eef2f9':'#0a1024')}window.applyTheme=a;a();q.addEventListener('change',a)})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${barlow.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full bg-background font-sans text-foreground">
        <div className="flex min-h-dvh">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <MobileTop />
            <SectionPills />
            {/* Phones: room for the floating tab bar. */}
            <div className="flex-1 pb-[calc(7.5rem+env(safe-area-inset-bottom))] md:pb-0">{children}</div>
          </div>
        </div>
        <MobileTabs />
        <Toaster />
      </body>
    </html>
  );
}
