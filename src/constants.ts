import type { TabSchema } from "./types";

export const SHEET_SCHEMAS: TabSchema[] = [
  { name: "Allowlist", headers: ["Email"] },
  { name: "Config", headers: ["Key", "Value"] },
  { name: "Bosses", headers: ["Boss", "Points"] },
  { name: "BossAliases", headers: ["Alias", "Boss"] },
  { name: "NameAliases", headers: ["Alias", "Name"] },
  {
    name: "Weeks",
    headers: [
      "WeekId",
      "StartUTC",
      "EndUTC",
      "Timezone",
      "SourceFileName",
      "CreatedUTC",
      "Notes"
    ]
  },
  {
    name: "WeekUserTotals",
    headers: ["WeekId", "Name", "TotalPoints", "ActivityLevel", "Streak"]
  },
  {
    name: "WeekBossBreakdown",
    headers: ["WeekId", "Name", "Boss", "Points", "Count"]
  }
];

export const DEFAULT_CONFIG: Record<string, string> = {
  week_start: "SUN",
  activity_low_max: "4",
  activity_medium_max: "9",
  timezone_default: "America/New_York"
};

