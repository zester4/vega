"use client";

import { MenuIcon, BotIcon } from "lucide-react";
import { useSidebar } from "./sidebar-context";

export function MobileNav() {
    const { toggle } = useSidebar();

    return (
        <div className="lg:hidden fixed top-0 left-0 right-0 h-14 border-b border-[#1e1e22] bg-[#0a0a0b]/80 backdrop-blur-md z-30 flex items-center justify-between px-4">
            <div className="flex items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-sm bg-[#00e5cc]">
                    <BotIcon className="size-3.5 text-[#0a0a0b]" />
                </div>
                <span className="text-sm font-bold uppercase tracking-widest text-[#e8e8ea]">
                    VEGA
                </span>
            </div>

            <button
                onClick={toggle}
                className="p-2 rounded-md hover:bg-[#1e1e22] transition-colors"
                aria-label="Open sidebar"
            >
                <MenuIcon className="size-5 text-[#e8e8ea]" />
            </button>
        </div>
    );
}
