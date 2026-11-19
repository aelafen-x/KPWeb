import { DateTime } from "luxon";
import type { WeekBounds } from "../types";

export function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function weekBoundsFromUtcSunday(weekStartUtcDate: string): WeekBounds {
  const start = DateTime.fromISO(weekStartUtcDate, { zone: "utc" }).startOf("day");
  return {
    startUtcMillis: start.toMillis(),
    endUtcMillis: start.plus({ days: 6 }).endOf("day").toMillis()
  };
}

export function toWeekId(weekStartUtcDate: string): string {
  return DateTime.fromISO(weekStartUtcDate, { zone: "utc" }).toFormat("yyyy-MM-dd");
}


function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) {
    return `${day}th`;
  }
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th";
  return `${day}${suffix}`;
}

/** "Activity Nov 8th - Nov 14th 2026" for the week starting on the given Sunday. */
export function reportTitle(weekId: string): string {
  const start = DateTime.fromISO(weekId, { zone: "utc" });
  if (!start.isValid) {
    return "Activity";
  }
  const end = start.plus({ days: 6 });
  return `Activity ${start.toFormat("LLL")} ${ordinal(start.day)} - ${end.toFormat("LLL")} ${ordinal(end.day)} ${end.year}`;
}

/** "DKP 8th Nov - 14th Nov 2026", the file name the old PDFs used. */
export function reportFileName(weekId: string): string {
  const start = DateTime.fromISO(weekId, { zone: "utc" });
  if (!start.isValid) {
    return `DKP ${weekId}`;
  }
  const end = start.plus({ days: 6 });
  return `DKP ${ordinal(start.day)} ${start.toFormat("LLL")} - ${ordinal(end.day)} ${end.toFormat("LLL")} ${end.year}`;
}

/** Snaps any date to the Sunday that starts its week. */
export function toSunday(isoDate: string): string {
  const parsed = DateTime.fromISO(isoDate, { zone: "utc" });
  if (!parsed.isValid) {
    return "";
  }
  return parsed.minus({ days: parsed.weekday % 7 }).toISODate() || "";
}
