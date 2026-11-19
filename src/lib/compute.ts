import { DateTime } from "luxon";
import type { ParsedLine, WeekSummaryRow } from "../types";

type ActivityThresholds = {
  lowMax: number;
  mediumMax: number;
};

type HistoricalRow = {
  weekId: string;
  name: string;
  totalPoints: number;
  activityLevel: string;
  streak: number;
};

export function activityLevel(points: number, thresholds: ActivityThresholds): string {
  if (points <= thresholds.lowMax) {
    return "Low";
  }
  if (points <= thresholds.mediumMax) {
    return "Medium";
  }
  return "High";
}

export function computeWeeklySummary(
  lines: ParsedLine[],
  bossPointsByName: Map<string, number>,
  users: string[],
  thresholds: ActivityThresholds
): WeekSummaryRow[] {
  const map = new Map<string, WeekSummaryRow>();
  for (const user of users) {
    map.set(user, {
      name: user,
      totalPoints: 0,
      activityLevel: "Low",
      streak: 1,
      last3WeeksTotal: 0,
      bossPoints: {},
      bossCounts: {}
    });
  }

  for (const line of lines) {
    if (line.issues.length > 0 || !line.bossCanonical) {
      continue;
    }
    const boss = line.bossCanonical;
    const basePoints = bossPointsByName.get(boss) ?? 0;
    const rawPoints = (basePoints + line.pointsBonus) * line.pointsMultiplier;
    const points = Number.isInteger(rawPoints) ? rawPoints : Math.ceil(rawPoints);

    for (const name of line.addNames) {
      const row = map.get(name);
      if (!row) {
        continue;
      }
      row.totalPoints += points;
      row.bossPoints[boss] = (row.bossPoints[boss] || 0) + points;
      row.bossCounts[boss] = (row.bossCounts[boss] || 0) + 1;
    }

    for (const name of line.subtractNames) {
      const row = map.get(name);
      if (!row) {
        continue;
      }
      row.totalPoints -= points;
      row.bossPoints[boss] = (row.bossPoints[boss] || 0) - points;
      row.bossCounts[boss] = (row.bossCounts[boss] || 0) - 1;
    }
  }

  const output = Array.from(map.values());
  for (const row of output) {
    row.activityLevel = activityLevel(row.totalPoints, thresholds);
  }

  output.sort((a, b) => b.totalPoints - a.totalPoints || a.name.localeCompare(b.name));
  return output;
}

export function recomputeStreaks(allTotals: HistoricalRow[], weeksOrder: string[]): HistoricalRow[] {
  const byName = new Map<string, HistoricalRow[]>();
  for (const row of allTotals) {
    if (!byName.has(row.name)) {
      byName.set(row.name, []);
    }
    byName.get(row.name)!.push(row);
  }

  for (const rows of byName.values()) {
    rows.sort(
      (a, b) => weeksOrder.indexOf(a.weekId) - weeksOrder.indexOf(b.weekId) || a.weekId.localeCompare(b.weekId)
    );
    let streak = 0;
    let prevLevel = "";
    for (const row of rows) {
      if (row.activityLevel === prevLevel) {
        streak += 1;
      } else {
        streak = 1;
      }
      row.streak = streak;
      prevLevel = row.activityLevel;
    }
  }
  return allTotals;
}

export function buildWeekRangeText(weekId: string): { startUtc: string; endUtc: string } {
  const start = DateTime.fromISO(weekId, { zone: "utc" }).startOf("day");
  const end = start.plus({ days: 6 }).endOf("day");
  return {
    startUtc: start.toISO() || "",
    endUtc: end.toISO() || ""
  };
}
