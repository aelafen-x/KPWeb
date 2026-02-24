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

