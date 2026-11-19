import type { WeekSummaryRow } from "../types";

export function escapeCsvCell(value: string | number): string {
  const text = String(value ?? "");
  if (/[,"\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function triggerDownload(content: string | Blob, filename: string, mimeType: string): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function buildMinimalTxt(rows: WeekSummaryRow[]): string {
  return rows.map((row) => `${row.name},${row.totalPoints}`).join("\n");
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

export function exportMinimalCsv(rows: WeekSummaryRow[], weekId: string): void {
  const lines = ["Name,TotalPoints", ...rows.map((row) => `${escapeCsvCell(row.name)},${row.totalPoints}`)];
  triggerDownload(lines.join("\n"), `weekly_points_${weekId}.csv`, "text/csv");
}

export function exportMinimalTxt(rows: WeekSummaryRow[], weekId: string): void {
  triggerDownload(buildMinimalTxt(rows), `weekly_points_${weekId}.txt`, "text/plain");
}

export async function copyMinimalTxt(rows: WeekSummaryRow[]): Promise<boolean> {
  return copyToClipboard(buildMinimalTxt(rows));
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
