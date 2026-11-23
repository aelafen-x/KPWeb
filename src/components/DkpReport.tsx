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

/** How far banded rows move the class colour towards white (0 = same colour, 1 = white). */
const BAND_LIGHTEN = 0.35;
/**
 * Report colours, taken from the app's own theme (parchment, cream, gold and browns).
 * Class colours stay as they are because they carry meaning. Each pair is [darker row, lighter row].
 */
export const REPORT_THEME = {
  /** Behind the table, in the app and on the PDF page (dark brown instead of glaring white). */
  page: "#2b1d12",
  owner: ["#f2dfb8", "#faf0da"],
  numbers: ["#f8e4b7", "#fff6e2"],
  status: ["#e6b96b", "#f3d8a6"]
};
const TOTAL_COLUMNS = GEAR_COLUMNS.length + 11;

function lighten(hex: string, amount: number): string {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return `#${channels
    .map((channel) => Math.round(channel + (255 - channel) * amount).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The weekly DKP update table, laid out like the old "Latest DKP Update" PDF. */
export const DkpReport = forwardRef<HTMLDivElement, DkpReportProps>(function DkpReport({ title, rows }, ref) {
  return (
    <div className="report-sheet" ref={ref}>
      <table className="report-table">
        <thead>
          <tr>
            <th className="report-title" colSpan={TOTAL_COLUMNS}>
              {title}
            </th>
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
            <th className="report-split-before">Level</th>
            <th className="report-split">A</th>
            <th>New Activity DKP</th>
            <th>Total Earned DKP</th>
            <th>Total Spent DKP</th>
            <th>Available DKP</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={TOTAL_COLUMNS}>No active owners this week.</td>
            </tr>
          ) : (
            rows.map((row, index) => {
              // Rows alternate dark/light down the whole table, so a row is easy to follow across.
              const light = index % 2 === 1;
              const base = classColor(row.className);
              const color = light ? lighten(base, BAND_LIGHTEN) : base;
              const shade = light ? 1 : 0;
              const ownerStyle = { background: REPORT_THEME.owner[shade] };
              const numberStyle = { background: REPORT_THEME.numbers[shade] };
              const statusStyle = { background: REPORT_THEME.status[shade] };
              // Divider lines are set on the cells on BOTH sides of the line: the image export
              // (used for the PDF/PNG) only keeps a collapsed border when both sides agree.
              const classStart = index > 0 && rows[index - 1].className !== row.className;
              const classEnd = index < rows.length - 1 && rows[index + 1].className !== row.className;
              const rowClass = [classStart ? "class-start" : "", classEnd ? "class-end" : ""].join(" ").trim();
              return (
                <tr key={row.toon} className={rowClass || undefined}>
                  <td className="report-owner" style={ownerStyle}>
                    {row.owner}
                  </td>
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
                  <td className="report-split-before" style={{ background: color }}>
                    {row.level}
                  </td>
                  <td className="report-split" style={statusStyle}>
                    {row.activity}
                  </td>
                  <td style={numberStyle}>{row.newDkp}</td>
                  <td style={numberStyle}>{row.totalEarned}</td>
                  <td style={numberStyle}>{row.totalSpent}</td>
                  <td className="report-available" style={statusStyle}>
                    {row.available}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
});
