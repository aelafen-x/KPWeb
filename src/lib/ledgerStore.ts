import { ROSTER_HEADERS, SHEET_SCHEMAS } from "../constants";
import type {
  AdminBonusRow,
  LedgerEntry,
  LedgerWeek,
  OwnerActivity,
  OwnerWeekActivity,
  RosterToon,
  SpendRecord
} from "../types";
import { buildImport, parseAdminBonusRows, parseNumber, parseRosterRows, serializeAdminBonus, serializeRoster } from "./roster";
import type { ImportResult } from "./roster";
import { ROSTER_RANGE, SheetsClient, a1, replaceTabRows } from "./sheets";

function headersFor(tab: string): string[] {
  return SHEET_SCHEMAS.find((schema) => schema.name === tab)?.headers || [];
}

const RANGES = {
  roster: ROSTER_RANGE,
  adminBonus: a1("AdminBonus", "A2:E"),
  ledgerWeeks: a1("LedgerWeeks", "A2:C"),
  weekLedger: a1("WeekLedger", "A2:F"),
  ownerActivity: a1("WeekOwnerActivity", "A2:D"),
  spends: a1("WeekSpends", "A2:F")
};

export type LedgerBundle = {
  roster: RosterToon[];
  adminBonus: AdminBonusRow[];
  ledgerWeeks: LedgerWeek[];
  entries: LedgerEntry[];
  activity: OwnerWeekActivity[];
  spends: SpendRecord[];
};

function parseActivity(value: string): OwnerActivity {
  const upper = value.trim().toUpperCase();
  return upper === "A" || upper === "UA" ? upper : "";
}

export async function loadLedgerBundle(client: SheetsClient, dataSpreadsheetId: string): Promise<LedgerBundle> {
  const byRange = await client.batchReadRanges(dataSpreadsheetId, Object.values(RANGES));
  return {
    roster: parseRosterRows(byRange[RANGES.roster] || []),
    adminBonus: parseAdminBonusRows(byRange[RANGES.adminBonus] || []),
    ledgerWeeks: (byRange[RANGES.ledgerWeeks] || [])
      .filter((row) => row[0])
      .map((row) => ({ weekId: row[0], closedUtc: row[1] || "", auctionFile: row[2] || "" })),
    entries: (byRange[RANGES.weekLedger] || [])
      .filter((row) => row[0] && row[1])
      .map((row) => ({
        weekId: row[0],
        toon: row[1],
        owner: row[2] || "",
        newDkp: parseNumber(row[3]),
        bonus: parseNumber(row[4]),
        spent: parseNumber(row[5])
      })),
    activity: (byRange[RANGES.ownerActivity] || [])
      .filter((row) => row[0] && row[1])
      .map((row) => ({
        weekId: row[0],
        owner: row[1],
        activity: parseActivity(row[2] || ""),
        aPlus: (row[3] || "").trim().toUpperCase() === "Y"
      })),
    spends: (byRange[RANGES.spends] || [])
      .filter((row) => row[0] && row[1])
      .map((row) => ({
        weekId: row[0],
        toon: row[1],
        amount: parseNumber(row[2]),
        timestamp: row[3] || "",
        poster: row[4] || "",
        rawLine: row[5] || ""
      }))
  };
}

export async function saveRoster(client: SheetsClient, dataSpreadsheetId: string, roster: RosterToon[]): Promise<void> {
  await replaceTabRows(client, dataSpreadsheetId, "Roster", ROSTER_HEADERS, serializeRoster(roster), "RAW");
}

export async function saveAdminBonus(
  client: SheetsClient,
  dataSpreadsheetId: string,
  rows: AdminBonusRow[]
): Promise<void> {
  await replaceTabRows(client, dataSpreadsheetId, "AdminBonus", headersFor("AdminBonus"), serializeAdminBonus(rows), "RAW");
}

/** Replaces one week's ledger rows, owner activity and spends, keeping every other week. */
export async function saveClosedWeek(
  client: SheetsClient,
  dataSpreadsheetId: string,
  current: LedgerBundle,
  week: LedgerWeek,
  entries: LedgerEntry[],
  activity: OwnerWeekActivity[],
  spends: SpendRecord[]
): Promise<LedgerBundle> {
  const weekId = week.weekId;
  const next: LedgerBundle = {
    ...current,
    ledgerWeeks: [...current.ledgerWeeks.filter((row) => row.weekId !== weekId), week].sort((a, b) =>
      a.weekId.localeCompare(b.weekId)
    ),
    entries: [...current.entries.filter((row) => row.weekId !== weekId), ...entries].sort(
      (a, b) => a.weekId.localeCompare(b.weekId) || a.toon.localeCompare(b.toon)
    ),
    activity: [...current.activity.filter((row) => row.weekId !== weekId), ...activity].sort(
      (a, b) => a.weekId.localeCompare(b.weekId) || a.owner.localeCompare(b.owner)
    ),
    spends: [...current.spends.filter((row) => row.weekId !== weekId), ...spends].sort(
      (a, b) => a.weekId.localeCompare(b.weekId) || a.timestamp.localeCompare(b.timestamp)
    )
  };
  await Promise.all([
    replaceTabRows(
      client,
      dataSpreadsheetId,
      "LedgerWeeks",
      headersFor("LedgerWeeks"),
      next.ledgerWeeks.map((row) => [row.weekId, row.closedUtc, row.auctionFile]),
      "RAW"
    ),
    replaceTabRows(
      client,
      dataSpreadsheetId,
      "WeekLedger",
      headersFor("WeekLedger"),
      next.entries.map((row) => [
        row.weekId,
        row.toon,
        row.owner,
        String(row.newDkp),
        String(row.bonus),
        String(row.spent)
      ]),
      "RAW"
    ),
    replaceTabRows(
      client,
      dataSpreadsheetId,
      "WeekOwnerActivity",
      headersFor("WeekOwnerActivity"),
      next.activity.map((row) => [row.weekId, row.owner, row.activity, row.aPlus ? "Y" : ""]),
      "RAW"
    ),
    replaceTabRows(
      client,
      dataSpreadsheetId,
      "WeekSpends",
      headersFor("WeekSpends"),
      next.spends.map((row) => [row.weekId, row.toon, String(row.amount), row.timestamp, row.poster, row.rawLine]),
      "RAW"
    )
  ]);
  return next;
}

/** Reads the old DKP spreadsheet (DKP Sheet, Not4Gearing and Admin tabs). Nothing is written to it. */
export async function readOldSpreadsheet(client: SheetsClient, sourceSpreadsheetId: string): Promise<ImportResult> {
  const ranges = [a1("DKP Sheet", "A3:U"), a1("Not4Gearing", "A3:N"), a1("Admin", "A2:H")];
  const byRange = await client.batchReadRanges(sourceSpreadsheetId, ranges);
  return buildImport(byRange[ranges[0]] || [], byRange[ranges[1]] || [], byRange[ranges[2]] || []);
}
