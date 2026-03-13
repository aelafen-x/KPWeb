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

function buildMinimalTxt(
  rows: WeekSummaryRow[],
  cromCounter: number,
  cromResetWeekId: string
): string {
  const header = `CromCounter: ${cromCounter} (ResetWeek: ${cromResetWeekId || "N/A"})`;
  const columns = "Name,TotalPoints,SinceResetTotal,Reached30k";
  const body = rows.map(
    (row) =>
      `${row.name},${row.totalPoints},${row.sinceCromResetTotal},${row.reached30k ? "Y" : ""}`
  );
  return [header, columns, ...body].join("\n");
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  return ok;
}

export function exportMinimalCsv(
  rows: WeekSummaryRow[],
  weekId: string,
  cromCounter: number,
  cromResetWeekId: string
): void {
  const header = `CromCounter,${cromCounter},ResetWeek,${escapeCsvCell(cromResetWeekId || "")}`;
  const columns = ["Name", "TotalPoints", "SinceResetTotal", "Reached30k"];
  const lines = [header, columns.join(",")];
  for (const row of rows) {
    const reached = row.reached30k ? "Y" : "";
    lines.push(
      [row.name, row.totalPoints, row.sinceCromResetTotal, reached].map(escapeCsvCell).join(",")
    );
  }
  triggerDownload(lines.join("\n"), `weekly_points_${weekId}.csv`, "text/csv");
}

export function exportMinimalTxt(
  rows: WeekSummaryRow[],
  weekId: string,
  cromCounter: number,
  cromResetWeekId: string
): void {
  const txt = buildMinimalTxt(rows, cromCounter, cromResetWeekId);
  triggerDownload(txt, `weekly_points_${weekId}.txt`, "text/plain");
}

export async function copyMinimalTxt(
  rows: WeekSummaryRow[],
  cromCounter: number,
  cromResetWeekId: string
): Promise<boolean> {
  const txt = buildMinimalTxt(rows, cromCounter, cromResetWeekId);
  return copyToClipboard(txt);
}

export function exportFullCsv(rows: WeekSummaryRow[], weekId: string, bosses: string[]): void {
  const columns = ["Name", "TotalPoints", "ActivityLevel", "Streak", "SinceResetTotal", "Reached30k", ...bosses];
  const lines = [columns.join(",")];
  for (const row of rows) {
    const values: Array<string | number> = [
      row.name,
      row.totalPoints,
      row.activityLevel,
      row.streak,
      row.sinceCromResetTotal,
      row.reached30k ? "Y" : ""
    ];
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
