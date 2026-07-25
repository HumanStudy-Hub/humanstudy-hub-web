import type { Metadata } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";
import "highlight.js/styles/github.min.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "HumanStudy-Hub",
  description: "Open infrastructure for turning published human studies into reusable datasets, runnable experiments, and AI-agent evaluations.",
  icons: {
    icon: [{ url: "/favicon.svg?v=2", type: "image/svg+xml" }],
    shortcut: "/favicon.svg?v=2",
    apple: "/favicon.svg?v=2",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        className="font-sans antialiased min-h-screen flex flex-col bg-white text-black"
      >
        <Navbar />
        <main className="flex-grow">{children}</main>
        <Footer />
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
