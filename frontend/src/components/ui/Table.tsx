import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";

export interface Column<T> {
  key: string;
  header: string;
  /** Cell renderer. */
  render: (row: T) => ComponentChildren;
  /** Value used for sorting; enables a sortable header when provided. */
  sortValue?: (row: T) => string | number;
  className?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  initialSort?: string;
}

export function Table<T>({ columns, rows, rowKey, onRowClick, initialSort }: TableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(initialSort ?? null);
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return asc ? -1 : 1;
      if (av > bv) return asc ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, columns, sortKey, asc]);

  const toggleSort = (col: Column<T>) => {
    if (!col.sortValue) return;
    if (sortKey === col.key) setAsc((v) => !v);
    else {
      setSortKey(col.key);
      setAsc(true);
    }
  };

  return (
    <div class="table-container">
      <table class="table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                class={`${col.sortValue ? "is-sortable" : ""} ${col.className ?? ""}`}
                onClick={() => toggleSort(col)}
              >
                {col.header}
                {sortKey === col.key ? (asc ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              class={onRowClick ? "table__row--clickable" : ""}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} class={col.className}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
