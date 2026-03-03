"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { SidebarProvider } from "./sidebar-context";
import { MobileNav } from "./mobile-nav";
import { AnimatePresence, motion } from "motion/react";
import { authClient } from "@/lib/auth-client";

export function AppLayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();

  // Public landing page never shows sidebar
  if (pathname === "/") {
    return (
      <AnimatePresence mode="wait">
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.3, ease: "easeInOut" }}
          className="min-h-screen bg-[#0a0a0b]"
        >
          <main>{children}</main>
        </motion.div>
      </AnimatePresence>
    );
  }

  // While session is loading or user is unauthenticated, render content without sidebar
  if (!session && !isPending) {
    return (
      <AnimatePresence mode="wait">
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.3, ease: "easeInOut" }}
          className="min-h-screen bg-[#0a0a0b]"
        >
          <main>{children}</main>
        </motion.div>
      </AnimatePresence>
    );
  }

  // Authenticated shell: sidebar + main area
  return (
    <SidebarProvider>
      <div className="flex h-[100dvh] bg-[#0a0a0b] overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <MobileNav />
          <AnimatePresence mode="wait">
            <motion.main
              key={pathname}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="flex-1 overflow-hidden relative pt-14 lg:pt-0"
            >
              {children}
            </motion.main>
          </AnimatePresence>
        </div>
      </div>
    </SidebarProvider>
  );
}

