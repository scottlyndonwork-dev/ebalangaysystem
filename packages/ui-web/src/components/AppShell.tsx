'use client';
import { Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { type ComponentType, type ReactNode, useEffect, useState } from 'react';
import { cn, readPreference, writePreference } from '../lib/utils.js';
import { Button } from './primitives.js';

export interface NavItem {
  href: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  active?: boolean;
  badge?: ReactNode;
}

export interface AppShellLabels {
  openMenu: string;
  closeMenu: string;
  collapseSidebar: string;
  expandSidebar: string;
  /** aria-label of the <nav>. */
  navigation: string;
}

export interface AppShellProps {
  brand: ReactNode;
  /** Shown when the sidebar is collapsed. */
  brandCompact?: ReactNode;
  nav: readonly NavItem[];
  title?: ReactNode;
  topbarActions?: ReactNode;
  /** Bottom of the sidebar, e.g. user menu. */
  sidebarFooter?: ReactNode;
  labels: AppShellLabels;
  /** Pass next/link for client-side navigation. */
  linkComponent?: ComponentType<{
    href: string;
    className?: string;
    children: ReactNode;
    'aria-current'?: 'page';
  }>;
  children: ReactNode;
}

const STORAGE_KEY = 'ebalangay.sidebar.collapsed';

/** Collapsible sidebar on desktop, slide-over drawer on mobile, sticky topbar. */
export function AppShell({
  brand,
  brandCompact,
  nav,
  title,
  topbarActions,
  sidebarFooter,
  labels,
  linkComponent,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const Link = linkComponent ?? DefaultLink;

  useEffect(() => {
    setCollapsed(readPreference(STORAGE_KEY) === '1');
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const toggle = () => {
    setCollapsed((c) => {
      writePreference(STORAGE_KEY, c ? '0' : '1');
      return !c;
    });
  };

  const navList = (compact: boolean) => (
    <nav aria-label={labels.navigation} className="flex-1 overflow-y-auto p-2">
      <ul className="flex flex-col gap-1">
        {nav.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={item.active ? 'page' : undefined}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
                  item.active
                    ? 'bg-primary-soft text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  compact && 'justify-center px-0',
                )}
              >
                {Icon ? <Icon className="size-5 shrink-0" /> : null}
                {compact ? (
                  <span className="sr-only">{item.label}</span>
                ) : (
                  <span className="flex-1 truncate">{item.label}</span>
                )}
                {!compact && item.badge ? item.badge : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  return (
    <div className="flex min-h-dvh bg-surface">
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col border-r bg-background transition-[width] duration-200 md:flex',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex h-14 items-center border-b px-3',
            collapsed ? 'justify-center' : 'justify-between',
          )}
        >
          {collapsed ? (brandCompact ?? null) : brand}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={collapsed ? labels.expandSidebar : labels.collapseSidebar}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </div>
        {navList(collapsed)}
        {sidebarFooter && !collapsed ? <div className="border-t p-3">{sidebarFooter}</div> : null}
      </aside>

      {mobileOpen ? (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={labels.navigation}
        >
          <button
            type="button"
            aria-label={labels.closeMenu}
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-background shadow-xl">
            <div className="flex h-14 items-center justify-between border-b px-3">
              {brand}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileOpen(false)}
                aria-label={labels.closeMenu}
              >
                <X />
              </Button>
            </div>
            {navList(false)}
            {sidebarFooter ? <div className="border-t p-3">{sidebarFooter}</div> : null}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label={labels.openMenu}
          >
            <Menu />
          </Button>
          <div className="min-w-0 flex-1 truncate text-base font-semibold">{title}</div>
          {topbarActions ? <div className="flex items-center gap-2">{topbarActions}</div> : null}
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

function DefaultLink(props: {
  href: string;
  className?: string;
  children: ReactNode;
  'aria-current'?: 'page';
}) {
  return <a {...props} />;
}
