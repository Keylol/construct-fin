'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'inline-flex h-10 items-center gap-6 border-b border-border',
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'relative -mb-px inline-flex h-10 items-center whitespace-nowrap border-b-2 border-transparent',
        'px-1 text-sm font-medium text-muted-foreground transition-colors',
        'hover:text-foreground focus-visible:outline-none focus-visible:text-foreground',
        'data-[state=active]:border-primary data-[state=active]:text-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        // Cross-fade 150мс при смене вкладки (решение №34 блица).
        'mt-6 focus-visible:outline-none',
        'data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-150',
        'motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
});
