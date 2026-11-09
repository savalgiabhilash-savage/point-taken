import type { Metadata, Viewport } from "next";
import { Google_Sans_Flex, Google_Sans_Code } from "next/font/google";
import { Sidebar, MobileTop, MobileTabs } from "@/components/nav";
import { Toaster } from "@/components/toast";
import { SectionPills } from "@/components/shell";
import "./globals.css";

// Google Sans everywhere. Flex is variable in width (wdth) and slant (slnt): body text at normal width, and
// font-display narrows the same family to a condensed caps style for headings and numbers (TV-graphics look).
const gsans = Google_Sans_Flex({ variable: "--font-sans", subsets: ["latin"], axes: ["wdth", "slnt"] });
const gcode = Google_Sans_Code({ variable: "--font-code", subsets: ["latin"] });

// cover: lets the floating tab bar pad for the iPhone home indicator (env(safe-area-inset-bottom)).
export const viewport: Viewport = { viewportFit: "cover", themeColor: "#0a1024" };

// App name: "Point Taken". The brand is short and witty; the keyword-rich subtitle in the default title and the
// description is what search engines match ("FPL captain picks", "transfer planner", "live rank").
const DESCRIPTION =
  "Point Taken is an independent Fantasy Premier League (FPL) assistant: captain picks, a multi-week transfer planner, " +
  "chip timing, projected points (xPts) for every player, live points and mini-league ranks.";

export const metadata: Metadata = {
  metadataBase: new URL("https://point-taken-fpl.vercel.app"),
  title: { default: "Point Taken: FPL Captain Picks, Transfer Planner & Live Rank", template: "%s · Point Taken" },
  description: DESCRIPTION,
  applicationName: "Point Taken",
  keywords: ["FPL", "Fantasy Premier League", "FPL captain picks", "FPL transfer planner", "FPL live rank", "xPts", "FPL chips", "Best XI"],
  openGraph: {
    type: "website",
    siteName: "Point Taken",
    title: "Point Taken: FPL Captain Picks, Transfer Planner & Live Rank",
    description: DESCRIPTION,
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "Point Taken logo" }],
  },
  twitter: { card: "summary", title: "Point Taken: FPL Captain Picks, Transfer Planner & Live Rank", description: DESCRIPTION },
  // iPhone home-screen app: full screen, black status bar (matches the dark theme). The manifest is app/manifest.ts.
  appleWebApp: { capable: true, title: "Point Taken", statusBarStyle: "black" },
};

// Runs before the page paints, so there is no flash of the wrong theme. Saved choice: dark (default), light or
// system (follows the device, and updates live when the device switches).
const THEME_SCRIPT = `(function(){var d=document.documentElement,q=matchMedia('(prefers-color-scheme: light)');function a(){var t='dark';try{t=localStorage.getItem('theme')||'dark'}catch(e){}var l=t==='light'||(t==='system'&&q.matches);if(l)d.setAttribute('data-mode','light');else d.removeAttribute('data-mode');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',l?'#eef2f9':'#0a1024')}window.applyTheme=a;a();q.addEventListener('change',a)})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${gsans.variable} ${gcode.variable} h-full antialiased`}>
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
