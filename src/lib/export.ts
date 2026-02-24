import type { WeekSummaryRow } from "../types";

function escapeCsvCell(value: string | number): string {
  const text = String(value ?? "");
  if (/[,"\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function triggerDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportMinimalCsv(rows: WeekSummaryRow[], weekId: string): void {
  const csv = ["Name,TotalPoints", ...rows.map((row) => `${escapeCsvCell(row.name)},${row.totalPoints}`)].join(
    "\n"
  );
  triggerDownload(csv, `weekly_points_${weekId}.csv`, "text/csv");
}

export function exportMinimalTxt(rows: WeekSummaryRow[], weekId: string): void {
  const txt = rows.map((row) => `${row.name},${row.totalPoints}`).join("\n");
  triggerDownload(txt, `weekly_points_${weekId}.txt`, "text/plain");
}

export function exportFullCsv(rows: WeekSummaryRow[], weekId: string, bosses: string[]): void {
  const columns = ["Name", "TotalPoints", "ActivityLevel", "Streak", ...bosses];
  const lines = [columns.join(",")];
  for (const row of rows) {
    const values: Array<string | number> = [row.name, row.totalPoints, row.activityLevel, row.streak];
    for (const boss of bosses) {
      values.push(row.bossCounts[boss] || 0);
    }
    lines.push(values.map(escapeCsvCell).join(","));
  }
  triggerDownload(lines.join("\n"), `weekly_full_${weekId}.csv`, "text/csv");
}

export function exportCorrectedFile(lines: string[], weekId: string): void {
  triggerDownload(lines.join("\n"), `corrected_${weekId}.txt`, "text/plain");
}

