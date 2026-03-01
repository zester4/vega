import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { AppLayoutWrapper } from "@/components/layout/app-layout-wrapper";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VEGA · Mission Control",
  description: "Autonomous tool-calling AI agent on the edge",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased dark bg-[#0a0a0b]`}
      >
        <TooltipProvider>
          <AppLayoutWrapper>{children}</AppLayoutWrapper>
        </TooltipProvider>
      </body>
    </html>
  );
}
