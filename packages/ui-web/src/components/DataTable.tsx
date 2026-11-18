'use client';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  type OnChangeFn,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3, Download, Search } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { type ReactNode, useEffect, useState } from 'react';
import { cn, type CsvColumn, downloadCsv, toCsv } from '../lib/utils.js';
import { Button, Input, Skeleton } from './primitives.js';

export interface DataTableLabels {
  search: string;
  columns: string;
  exportCsv: string;
  previous: string;
  next: string;
  noResults: string;
  /** e.g. "Sort by {column}" is built by the caller; this labels the sort button suffix. */
  sortBy: (column: string) => string;
}

export interface DataTableFilter {
  id: string;
  label: string;
  options: readonly { label: string; value: string }[];
  value: string | null;
  onChange: (value: string | null) => void;
  /** Label for "no filter", e.g. "All". */
  allLabel: string;
}

export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  /** Current page from the server. */
  data: readonly T[];
  getRowId: (row: T) => string;
  loading?: boolean;
  /** Cursor pagination: the parent owns cursors and refetches. */
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNextPage: () => void;
  onPreviousPage: () => void;
  /** Server-side sort (controlled). */
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  /** Debounced server-side search; omit to hide the box. */
  search?: string;
  onSearchChange?: (value: string) => void;
  filters?: readonly DataTableFilter[];
  /** CSV export. Defaults to the current page; pass `onExport` to export everything server-side. */
  csvColumns?: readonly CsvColumn<T>[];
  csvFilename?: string;
  onExport?: () => void | Promise<void>;
  initialColumnVisibility?: VisibilityState;
  onRowClick?: (row: T) => void;
  toolbar?: ReactNode;
  labels: DataTableLabels;
  /** Accessible table name. */
  caption: string;
}

export function DataTable<T>({
  columns,
  data,
  getRowId,
  loading,
  hasNextPage,
  hasPreviousPage,
  onNextPage,
  onPreviousPage,
  sorting = [],
  onSortingChange,
  search,
  onSearchChange,
  filters = [],
  csvColumns,
  csvFilename = 'export',
  onExport,
  initialColumnVisibility = {},
  onRowClick,
  toolbar,
  labels,
  caption,
}: DataTableProps<T>) {
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(initialColumnVisibility);
  const [searchDraft, setSearchDraft] = useState(search ?? '');

  useEffect(() => {
    if (!onSearchChange || searchDraft === (search ?? '')) return;
    const t = setTimeout(() => onSearchChange(searchDraft), 300);
    return () => clearTimeout(t);
  }, [searchDraft, search, onSearchChange]);

  const table = useReactTable({
    data: data as T[],
    columns,
    getRowId,
    state: { sorting, columnVisibility },
    onSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
    enableSortingRemoval: true,
  });

  const exportCsv = async () => {
    if (onExport) return onExport();
    if (csvColumns) downloadCsv(csvFilename, toCsv(data, csvColumns));
  };

  const visibleColumns = table.getVisibleLeafColumns().length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {onSearchChange ? (
          <div className="relative w-full sm:w-64">
            <Search
              aria-hidden
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label={labels.search}
              placeholder={labels.search}
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              className="pl-9"
            />
          </div>
        ) : null}
        {filters.map((f) => (
          <select
            key={f.id}
            aria-label={f.label}
            value={f.value ?? ''}
            onChange={(e) => f.onChange(e.target.value || null)}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{f.allLabel}</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {toolbar}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 /> {labels.columns}
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 min-w-44 rounded-lg border bg-popover p-1 shadow-md"
              >
                {table
                  .getAllLeafColumns()
                  .filter((c) => c.getCanHide())
                  .map((c) => (
                    <DropdownMenu.CheckboxItem
                      key={c.id}
                      checked={c.getIsVisible()}
                      onCheckedChange={(v) => c.toggleVisibility(Boolean(v))}
                      onSelect={(e) => e.preventDefault()}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted"
                    >
                      <span
                        className={cn(
                          'size-4 rounded-sm border',
                          c.getIsVisible() && 'border-primary bg-primary',
                        )}
                        aria-hidden
                      />
                      {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                    </DropdownMenu.CheckboxItem>
                  ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {csvColumns || onExport ? (
            <Button variant="outline" size="sm" onClick={() => void exportCsv()}>
              <Download /> {labels.exportCsv}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-background">
        <table className="w-full caption-bottom text-sm" aria-busy={loading}>
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b bg-surface">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  const canSort = h.column.getCanSort() && Boolean(onSortingChange);
                  const content = h.isPlaceholder
                    ? null
                    : flexRender(h.column.columnDef.header, h.getContext());
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : undefined
                      }
                      className="h-10 whitespace-nowrap px-3 text-left font-medium text-muted-foreground"
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          aria-label={labels.sortBy(
                            typeof h.column.columnDef.header === 'string'
                              ? h.column.columnDef.header
                              : h.column.id,
                          )}
                        >
                          {content}
                          {sorted === 'asc' ? (
                            <ArrowUp className="size-3.5" />
                          ) : sorted === 'desc' ? (
                            <ArrowDown className="size-3.5" />
                          ) : (
                            <ChevronsUpDown className="size-3.5 opacity-50" />
                          )}
                        </button>
                      ) : (
                        content
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td colSpan={visibleColumns} className="px-3 py-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn(
                      'border-b last:border-0',
                      onRowClick && 'cursor-pointer hover:bg-surface',
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2.5 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
            {!loading && data.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleColumns}
                  className="px-3 py-10 text-center text-muted-foreground"
                >
                  {labels.noResults}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onPreviousPage}
          disabled={!hasPreviousPage || loading}
        >
          {labels.previous}
        </Button>
        <Button variant="outline" size="sm" onClick={onNextPage} disabled={!hasNextPage || loading}>
          {labels.next}
        </Button>
      </div>
    </div>
  );
}

/** Keeps a cursor stack so DataTable can go back with cursor-only APIs. */
export function useCursorPagination() {
  const [stack, setStack] = useState<(string | null)[]>([null]);
  const cursor = stack[stack.length - 1] ?? null;
  return {
    cursor,
    hasPreviousPage: stack.length > 1,
    next: (nextCursor: string | null) => {
      if (nextCursor) setStack((s) => [...s, nextCursor]);
    },
    previous: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    reset: () => setStack([null]),
  };
}
