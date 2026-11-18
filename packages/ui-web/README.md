# @ebalangay/ui-web

Shared Next.js components: shadcn/ui-style primitives on Radix, `AppShell`, `DataTable` (TanStack Table v8, cursor pagination), charts (Recharts), `DateRangePicker`, `FileUpload` (R2 presigned PUT), Zod form helpers, `ConfirmDialog`, `StatusPill`, `MoneyInput`, `MapZoneEditor` (placeholder).

## App setup (Tailwind CSS v4)

```css
/* app/globals.css */
@import 'tailwindcss';
@import '@ebalangay/ui-web/styles.css';
@source '../../../packages/ui-web/dist';
```

Dark mode: toggle the `dark` class on `<html>`. Tokens come from `@ebalangay/shared/design`; `styles.css` mirrors them and a test fails if they drift. Every user-facing string is a prop (`labels`, `title`, …) — pass `t(...)`.

Files using hooks start with `'use client'`, so they can be imported from Server Components.
