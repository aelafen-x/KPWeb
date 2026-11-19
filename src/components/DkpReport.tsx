import { forwardRef } from "react";
import { CLASS_COLORS, GEAR_COLUMNS } from "../constants";
import type { ReportRow } from "../lib/ledger";

type DkpReportProps = {
  title: string;
  rows: ReportRow[];
};

function classColor(className: string): string {
  const match = Object.keys(CLASS_COLORS).find((name) => name.toLowerCase() === className.trim().toLowerCase());
  return match ? CLASS_COLORS[match] : "#d9d9d9";
}

/** The weekly DKP update table, laid out like the old "Latest DKP Update" PDF. */
export const DkpReport = forwardRef<HTMLDivElement, DkpReportProps>(function DkpReport({ title, rows }, ref) {
  return (
    <div className="report-sheet" ref={ref}>
      <table className="report-table">
        <thead>
          <tr>
            <th className="report-owner" />
            <th className="report-title" colSpan={2}>
              {title}
            </th>
            <th colSpan={GEAR_COLUMNS.length + 8} />
            <th className="report-available-head" />
          </tr>
          <tr>
            <th className="report-owner">Owner</th>
            <th>Toon</th>
            <th>M</th>
            {GEAR_COLUMNS.map((column) => (
              <th key={column}>{column}</th>
            ))}
            <th>Pures Earned</th>
            <th>Class</th>
            <th>Level</th>
            <th className="report-a">A</th>
            <th>New Activity DKP</th>
            <th>Total Earned DKP</th>
            <th>Total Spent DKP</th>
            <th className="report-available-head">Available DKP</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={GEAR_COLUMNS.length + 12}>No active owners this week.</td>
            </tr>
          ) : (
            rows.map((row) => {
              const color = classColor(row.className);
              return (
                <tr key={row.toon}>
                  <td className="report-owner">{row.owner}</td>
                  <td className="report-toon" style={{ background: color }}>
                    {row.toon}
                  </td>
                  <td style={{ background: color }}>{row.mainAlt}</td>
                  {GEAR_COLUMNS.map((column, index) => (
                    <td key={column} style={{ background: color }}>
                      {row.gear[index]}
                    </td>
                  ))}
                  <td style={{ background: color }}>{row.pures}</td>
                  <td style={{ background: color }}>{row.className}</td>
                  <td style={{ background: color }}>{row.level}</td>
                  <td className="report-a">{row.activity}</td>
                  <td>{row.newDkp}</td>
                  <td>{row.totalEarned}</td>
                  <td>{row.totalSpent}</td>
                  <td className="report-available">{row.available}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
});
