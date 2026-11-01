import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  weight: "400 600",
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://larpusage.vercel.app"),
  title: "larpusage — token profile",
  description:
    "Your AI token usage, as a personality. Reads real local coding-agent logs, or composes the rest.",
  robots: process.env.VERCEL
    ? { index: true, follow: true }
    : { index: false, follow: false },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "larpusage",
    title: "larpusage — token profile",
    description: "Your AI token usage, as a personality.",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "larpusage — token profile",
    description: "Your AI token usage, as a personality.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
