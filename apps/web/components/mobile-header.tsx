"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { List } from "@phosphor-icons/react";
import { Logo } from "@/components/logo";
import { UserNav } from "@/components/user-nav";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { SidebarContent, type SidebarProps } from "@/components/sidebar";

export function MobileHeader(props: SidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Safety net: close on any route change (covers back/forward navigation)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation"
            className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <List size={20} />
          </button>
        </SheetTrigger>
        <SheetContent>
          <SidebarContent {...props} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <Link href="/dashboard" className="flex items-center" aria-label="ClipClap home">
        <Logo className="h-6" />
      </Link>
      <div className="ml-auto pr-1">
        <UserNav
          name={props.user.name}
          email={props.user.email}
          avatarUrl={props.user.avatarUrl}
        />
      </div>
    </header>
  );
}
