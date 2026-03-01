"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";

export function AppLayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    // If we are on the homepage, don't show the sidebar and allow scrolling
    if (pathname === "/") {
        return (
            <div className="min-h-screen bg-[#0a0a0b]">
                <main>{children}</main>
            </div>
        );
    }

    // For all other pages (chat, history, etc.), show the sidebar
    // and keep the overflow-hidden for the chat interface
    return (
        <div className="flex h-[100dvh] bg-[#0a0a0b]">
            <Sidebar />
            <main className="flex-1 overflow-hidden">
                {children}
            </main>
        </div>
    );
}
