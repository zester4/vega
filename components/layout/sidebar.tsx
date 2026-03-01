"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { BotIcon, MenuIcon, XIcon, MessageSquareIcon, SettingsIcon, DatabaseIcon, WrenchIcon, HistoryIcon, ChevronLeftIcon } from "lucide-react";
import { NavItem } from "./nav-item";
import { cn } from "@/lib/utils";

interface ChatSession {
  id: string;
  sessionId: string;
  title: string;
  messageCount: number;
  lastMessage?: string;
  updatedAt: string;
}

export function Sidebar() {
  const [isOpen, setIsOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [recentChats, setRecentChats] = useState<ChatSession[]>([]);
  const [mounted, setMounted] = useState(false);

  // Load collapsed state and recent chats from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("vega-sidebar-collapsed");
    if (saved) setIsCollapsed(JSON.parse(saved));

    const saved_chats = localStorage.getItem("vega-sessions");
    if (saved_chats) {
      try {
        const chats: ChatSession[] = JSON.parse(saved_chats);
        setRecentChats(chats.slice(0, 5).sort((a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        ));
      } catch (err) {
        console.error("Failed to load recent chats:", err);
      }
    }
    setMounted(true);
  }, []);

  const handleCollapse = () => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    localStorage.setItem("vega-sidebar-collapsed", JSON.stringify(newState));
  };

  if (!mounted) return null;

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed top-4 left-4 z-40 lg:hidden p-2 rounded-md border border-[#1e1e22] bg-[#0a0a0b] hover:bg-[#1e1e22]"
        aria-label="Toggle sidebar"
      >
        {isOpen ? (
          <XIcon className="size-5 text-[#e8e8ea]" />
        ) : (
          <MenuIcon className="size-5 text-[#e8e8ea]" />
        )}
      </button>

      {/* Backdrop for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 border-r border-[#1e1e22] bg-[#0a0a0b]/95 backdrop-blur-sm flex flex-col z-30 transition-all duration-300 lg:z-20 lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          isCollapsed ? "w-20" : "w-64"
        )}
      >
        {/* Header */}
        <div className="h-14 border-b border-[#1e1e22] flex items-center justify-between px-4 shrink-0 sticky top-0">
          {!isCollapsed && (
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex size-6 items-center justify-center rounded-sm bg-[#00e5cc]">
                <BotIcon className="size-3.5 text-[#0a0a0b]" />
              </div>
              <span className="text-sm font-bold uppercase tracking-widest text-[#e8e8ea] truncate">
                VEGA
              </span>
            </div>
          )}
          {isCollapsed && (
            <div className="flex size-6 items-center justify-center rounded-sm bg-[#00e5cc] mx-auto">
              <BotIcon className="size-3.5 text-[#0a0a0b]" />
            </div>
          )}
          <button
            onClick={handleCollapse}
            className="hidden lg:flex p-1 rounded-md hover:bg-[#1e1e22] transition-colors"
            aria-label="Toggle sidebar collapse"
          >
            <ChevronLeftIcon
              className={cn(
                "size-4 text-[#6b6b7a] transition-transform",
                isCollapsed && "rotate-180"
              )}
            />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-1 scrollbar-thin">
          <NavItem
            href="/chat"
            label={isCollapsed ? "" : "Chat"}
            icon={MessageSquareIcon}
          />
          <NavItem
            href="/agents"
            label={isCollapsed ? "" : "Agents"}
            icon={BotIcon}
          />
          <NavItem
            href="/memory"
            label={isCollapsed ? "" : "Memory"}
            icon={DatabaseIcon}
          />
          <NavItem
            href="/tools"
            label={isCollapsed ? "" : "Tools"}
            icon={WrenchIcon}
          />
          <NavItem
            href="/history"
            label={isCollapsed ? "" : "History"}
            icon={HistoryIcon}
          />
          <NavItem
            href="/settings"
            label={isCollapsed ? "" : "Settings"}
            icon={SettingsIcon}
          />
        </nav>

        {/* Session History */}
        {!isCollapsed && (
          <div className="border-t border-[#1e1e22] p-4 shrink-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b7a] mb-3">
              Recent Chats
            </h3>
            <div className="space-y-2 max-h-40 overflow-y-auto scrollbar-thin">
              {recentChats.length === 0 ? (
                <div className="text-xs text-[#6b6b7a] py-2 px-2 text-center">
                  No chats yet
                </div>
              ) : (
                recentChats.map((chat) => (
                  <Link
                    key={chat.id}
                    href={`/chat?session=${chat.sessionId}`}
                    className="block px-3 py-2 rounded-sm text-xs text-[#6b6b7a] hover:text-[#e8e8ea] hover:bg-[#1e1e22] transition-colors truncate"
                    title={chat.title}
                  >
                    {chat.title}
                  </Link>
                ))
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        {!isCollapsed && (
          <div className="border-t border-[#1e1e22] px-4 py-3 shrink-0 text-xs text-[#6b6b7a]">
            <p>v0.1.0 • Edge AI</p>
          </div>
        )}
      </aside>

      {/* Main content spacer */}
      <div
        className={cn(
          "hidden lg:block shrink-0 transition-all duration-300",
          isCollapsed ? "w-20" : "w-64"
        )}
      />
    </>
  );
}

