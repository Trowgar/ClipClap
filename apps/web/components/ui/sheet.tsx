"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

const SheetContent = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
    title?: string;
  }
>(({ className, children, title = "Navigation", ...props }, ref) => (
  <SheetPrimitive.Portal>
    <SheetPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/60",
        "data-[state=open]:animate-[sheet-fade-in_200ms_ease-out]",
        "data-[state=closed]:animate-[sheet-fade-out_150ms_ease-in]"
      )}
    />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-background shadow-xl outline-none",
        "data-[state=open]:animate-[sheet-slide-in-left_200ms_ease-out]",
        "data-[state=closed]:animate-[sheet-slide-out-left_150ms_ease-in]",
        className
      )}
      {...props}
    >
      <SheetPrimitive.Title className="sr-only">{title}</SheetPrimitive.Title>
      {children}
      <SheetPrimitive.Close
        className="absolute right-3 top-3.5 flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Close navigation"
      >
        <X size={18} />
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";

export { Sheet, SheetTrigger, SheetClose, SheetContent };
