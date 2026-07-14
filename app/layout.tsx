import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { DemoBanner } from "@/app/components/DemoBanner";
import { SwRegister } from "@/app/components/SwRegister";
import { PushPrompt } from "@/app/components/PushPrompt";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display face for headings, the wordmark, and big money numbers.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pereira Lope$",
  description:
    "The family fortune, live — watch it grow wings and fly away in real time.",
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    title: "Lope$",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f8f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0f0c" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* Per-device theme (Manage › Appearance). Resolves the stored choice
            (light/dark/system) to data-theme on <html> before first paint, and
            follows OS changes live while in "system" mode. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=matchMedia('(prefers-color-scheme: dark)');function a(){var t=localStorage.getItem('theme');var d=t==='dark'||(t!=='light'&&m.matches);document.documentElement.dataset.theme=d?'dark':'light'}a();m.addEventListener('change',a);window.addEventListener('storage',a)}catch(e){}})()`,
          }}
        />
        <SwRegister />
        <PushPrompt />
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
