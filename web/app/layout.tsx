import type { Metadata } from "next";
import { DM_Sans, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Nav } from "@/components/nav";
import "./globals.css";

// "Google Sans" is proprietary and not on Google Fonts; DM Sans is the closest openly-licensed,
// Google-commissioned geometric sans and maps onto the --font-sans token the theme expects.
const dmSans = DM_Sans({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FPL Selector",
  description: "Fantasy Premier League decision tool — projected xPts, fixtures, and squad optimizer.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${dmSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground flex flex-col font-sans">
        <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
            <Link href="/players" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="text-lg">⚽</span>
              <span>FPL Selector</span>
            </Link>
            <Nav />
          </div>
        </header>
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
