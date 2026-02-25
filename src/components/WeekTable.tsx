import { useMemo, useState } from "react";
import type { WeekSummaryRow } from "../types";

type WeekTableProps = {
  rows: WeekSummaryRow[];
  bossColumns: string[];
};

export function WeekTable({ rows, bossColumns }: WeekTableProps): JSX.Element {
  const [sortKey, setSortKey] = useState<string>("totalPoints");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  function onSort(nextKey: string): void {
    if (sortKey === nextKey) {
      setSortDirection((previous) => (previous === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    if (nextKey === "name" || nextKey === "activityLevel") {
      setSortDirection("asc");
    } else {
      setSortDirection("desc");
    }
  }

  const sortedRows = useMemo(() => {
    const factor = sortDirection === "asc" ? 1 : -1;
    const copy = rows.filter((row) => row.totalPoints > 0);
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = a.name.localeCompare(b.name);
      } else if (sortKey === "totalPoints") {
        cmp = a.totalPoints - b.totalPoints;
      } else if (sortKey === "activityLevel") {
        cmp = a.activityLevel.localeCompare(b.activityLevel);
      } else if (sortKey === "streak") {
        cmp = a.streak - b.streak;
      } else if (sortKey === "last3WeeksTotal") {
        cmp = a.last3WeeksTotal - b.last3WeeksTotal;
      } else if (sortKey.startsWith("boss:")) {
        const boss = sortKey.slice(5);
        cmp = (a.bossPoints[boss] || 0) - (b.bossPoints[boss] || 0);
      }
      if (cmp === 0) {
        cmp = a.name.localeCompare(b.name);
      }
      return cmp * factor;
    });
    return copy;
  }, [rows, sortDirection, sortKey]);

  function renderSortLabel(label: string, key: string): string {
    if (sortKey !== key) {
      return `${label}`;
    }
    return `${label} ${sortDirection === "asc" ? "▲" : "▼"}`;
  }

  function formatBossCell(count: number, points: number): string {
    const ptLabel = Math.abs(points) === 1 ? "pt" : "pts";
    return `${count} - ${points} ${ptLabel}`;
  }

  if (rows.length === 0) {
    return <p>No weekly results yet.</p>;
  }

  if (sortedRows.length === 0) {
    return <p>No players with &gt; 0 points this week.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>
              <button type="button" className="th-sort-btn" onClick={() => onSort("name")}>
                {renderSortLabel("Name", "name")}
              </button>
            </th>
            <th>
              <button type="button" className="th-sort-btn" onClick={() => onSort("totalPoints")}>
                {renderSortLabel("Total Points", "totalPoints")}
              </button>
            </th>
            <th>
              <button type="button" className="th-sort-btn" onClick={() => onSort("activityLevel")}>
                {renderSortLabel("Activity Level", "activityLevel")}
              </button>
            </th>
            <th>
              <button type="button" className="th-sort-btn" onClick={() => onSort("streak")}>
                {renderSortLabel("Consecutive Weeks at Activity Level", "streak")}
              </button>
            </th>
            <th>
              <button type="button" className="th-sort-btn" onClick={() => onSort("last3WeeksTotal")}>
                {renderSortLabel("Last 3 Weeks Total", "last3WeeksTotal")}
              </button>
            </th>
            {bossColumns.map((boss) => (
              <th key={boss}>
                <button type="button" className="th-sort-btn" onClick={() => onSort(`boss:${boss}`)}>
                  {renderSortLabel(`${boss} (Count - Pts)`, `boss:${boss}`)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{row.totalPoints}</td>
              <td>{row.activityLevel}</td>
              <td>{row.streak}</td>
              <td>{row.last3WeeksTotal}</td>
              {bossColumns.map((boss) => {
                const count = row.bossCounts[boss] || 0;
                const points = row.bossPoints[boss] || 0;
                return <td key={`${row.name}-${boss}`}>{formatBossCell(count, points)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
