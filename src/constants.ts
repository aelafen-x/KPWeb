import type { TabSchema } from "./types";

/** Gear columns from the old "DKP Sheet" tab, in display order. */
export const GEAR_COLUMNS = [
  "DL",
  "DL Main",
  "DL Offy",
  "EDL",
  "EDL Main",
  "EDL Offy",
  "CG T10",
  "DG",
  "T5 Valley"
];

/** Class order and colours used by the weekly DKP report (matches the old PDF). */
export const CLASS_ORDER = ["Druid", "Mage", "Ranger", "Rogue", "Warrior"];
export const CLASS_COLORS: Record<string, string> = {
  Druid: "#93c47d",
  Mage: "#6d9eeb",
  Ranger: "#ffd966",
  Rogue: "#b4a7d6",
  Warrior: "#e06666"
};

export const ROSTER_HEADERS = [
  "Owner",
  "Toon",
  "M",
  ...GEAR_COLUMNS,
  "Pures Earned",
  "Class",
  "Level",
  "Status",
  "Opening Earned",
  "Opening Spent",
  "Opening Activity",
  "Date Added",
  "Notes"
];

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
  },
  { name: "Roster", headers: ROSTER_HEADERS },
  { name: "AdminBonus", headers: ["Owner", "Toon", "Lead DKP", "Admin DKP", "Role"] },
  { name: "LedgerWeeks", headers: ["WeekId", "ClosedUTC", "AuctionFile"] },
  { name: "WeekLedger", headers: ["WeekId", "Toon", "Owner", "NewDKP", "Bonus", "Spent"] },
  { name: "WeekOwnerActivity", headers: ["WeekId", "Owner", "Activity", "APlus"] },
  { name: "WeekSpends", headers: ["WeekId", "Toon", "Amount", "Timestamp", "Poster", "RawLine"] }
];

export const DEFAULT_CONFIG: Record<string, string> = {
  week_start: "SUN",
  activity_low_max: "4",
  activity_medium_max: "9",
  timezone_default: "America/New_York",
  owner_a_min: "1",
  owner_aplus_min: "300",
  ledger_start_weekid: "",
  dkp_source_spreadsheet_id: ""
};
