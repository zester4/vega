//components/layout/nav-item.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface NavItemProps {
  href: string;
  label: string;
  icon?: LucideIcon;
  className?: string;
}

export function NavItem({ href, label, icon: Icon, className }: NavItemProps) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-sm px-3 py-2 text-sm transition-colors",
        "text-[#6b6b7a] hover:text-[#e8e8ea] hover:bg-[#1e1e22]",
        isActive && "bg-[#00e5cc]/10 text-[#00e5cc] border-l-2 border-[#00e5cc]",
        className
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className="truncate">{label}</span>
    </Link>
  );
}
