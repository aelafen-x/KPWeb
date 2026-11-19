import { GEAR_COLUMNS } from "../constants";
import type { AdminBonusRow, RosterToon, ToonStatus } from "../types";
import { normalizeKey } from "./normalize";

const GEAR_COUNT = GEAR_COLUMNS.length;

export function parseNumber(value: string | number | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const cleaned = (value || "").toString().replace(/,/g, "").trim();
  if (!cleaned) {
    return 0;
  }
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : 0;
}

function cell(row: string[], index: number): string {
  return (row[index] ?? "").toString().trim();
}

/** Normalises the "M" column (Main/Alt/Locker) so stray spaces and casing don't matter. */
export function normalizeMainAlt(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function normalizeStatus(value: string): ToonStatus {
  return value.trim().toLowerCase().replace(/\s+/g, "") === "not4gearing" ? "Not4Gearing" : "Active";
}

export function emptyToon(status: ToonStatus = "Active"): RosterToon {
  return {
    owner: "",
    toon: "",
    mainAlt: "",
    gear: Array.from({ length: GEAR_COUNT }, () => ""),
    pures: "",
    className: "",
    level: "",
    status,
    openingEarned: 0,
    openingSpent: 0,
    openingActivity: "",
    dateAdded: "",
    notes: ""
  };
}

/** Roster tab layout: Owner, Toon, M, 9 gear columns, Pures, Class, Level, Status, Opening Earned/Spent/Activity, Date Added, Notes. */
export function parseRosterRows(rows: string[][]): RosterToon[] {
  const output: RosterToon[] = [];
  for (const row of rows) {
    const toon = cell(row, 1);
    if (!toon) {
      continue;
    }
    const base = 3 + GEAR_COUNT;
    output.push({
      owner: cell(row, 0),
      toon,
      mainAlt: normalizeMainAlt(cell(row, 2)),
      gear: Array.from({ length: GEAR_COUNT }, (_, index) => cell(row, 3 + index)),
      pures: cell(row, base),
      className: cell(row, base + 1),
      level: cell(row, base + 2),
      status: normalizeStatus(cell(row, base + 3)),
      openingEarned: parseNumber(cell(row, base + 4)),
      openingSpent: parseNumber(cell(row, base + 5)),
      openingActivity: cell(row, base + 6),
      dateAdded: cell(row, base + 7),
      notes: cell(row, base + 8)
    });
  }
  return output;
}

export function serializeRoster(rows: RosterToon[]): string[][] {
  return rows
    .filter((row) => row.toon.trim())
    .map((row) => [
      row.owner.trim(),
      row.toon.trim(),
      row.mainAlt,
      ...Array.from({ length: GEAR_COUNT }, (_, index) => row.gear[index] || ""),
      row.pures,
      row.className,
      row.level,
      row.status,
      String(row.openingEarned || 0),
      String(row.openingSpent || 0),
      row.openingActivity,
      row.dateAdded,
      row.notes
    ]);
}

export function parseAdminBonusRows(rows: string[][]): AdminBonusRow[] {
  return rows
    .filter((row) => cell(row, 0) && cell(row, 1))
    .map((row) => ({
      owner: cell(row, 0),
      toon: cell(row, 1),
      leadDkp: parseNumber(cell(row, 2)),
      adminDkp: parseNumber(cell(row, 3)),
      role: cell(row, 4)
    }));
}

export function serializeAdminBonus(rows: AdminBonusRow[]): string[][] {
  return rows
    .filter((row) => row.owner.trim() && row.toon.trim())
    .map((row) => [row.owner.trim(), row.toon.trim(), String(row.leadDkp || 0), String(row.adminDkp || 0), row.role]);
}

export type ImportResult = {
  roster: RosterToon[];
  adminBonus: AdminBonusRow[];
  activeCount: number;
  not4GearingCount: number;
  /** DKP Sheet toons listed more than once (only the first is kept). */
  skippedDuplicates: string[];
  /** Repeat Not4Gearing log rows folded into an existing entry's notes. */
  mergedNot4GearingRows: number;
};

/**
 * Reads the old DKP spreadsheet once.
 * - "DKP Sheet" from row 3: A Owner, B Toon, C M, D-L gear, M Pures, N Class, O Level, P A, Q A+, R New, S Earned, T Spent, U Available.
 * - "Not4Gearing" from row 3: A Name, B M, C-J gear (no T5 Valley), K Class, L Lvl, M Date Added, N Notes.
 * - "Admin" from row 2: A Owner, B Leads 4 DKP (toon), D Lead dkp, E Admin dkp, H Role.
 */
export function buildImport(dkpRows: string[][], not4GearingRows: string[][], adminRows: string[][]): ImportResult {
  const roster: RosterToon[] = [];
  const seen = new Set<string>();
  const skippedDuplicates: string[] = [];

  for (const row of dkpRows) {
    const toon = cell(row, 1);
    if (!toon) {
      continue;
    }
    const key = normalizeKey(toon);
    if (seen.has(key)) {
      skippedDuplicates.push(toon);
      continue;
    }
    seen.add(key);
    roster.push({
      owner: cell(row, 0),
      toon,
      mainAlt: normalizeMainAlt(cell(row, 2)),
      gear: Array.from({ length: GEAR_COUNT }, (_, index) => cell(row, 3 + index)),
      pures: cell(row, 12),
      className: cell(row, 13),
      level: cell(row, 14),
      status: "Active",
      openingEarned: parseNumber(cell(row, 18)),
      openingSpent: parseNumber(cell(row, 19)),
      openingActivity: cell(row, 15),
      dateAdded: "",
      notes: ""
    });
  }
  const activeCount = roster.length;
  const activeByKey = new Map(roster.map((row) => [normalizeKey(row.toon), row]));
  const not4GearingByKey = new Map<string, RosterToon>();
  let mergedNot4GearingRows = 0;

  // The Not4Gearing tab is a running log: it repeats its header row between sections and lists a
  // toon again each time it is sold or leaves. Keep one entry per toon with every note joined, and
  // keep toons that are back on the DKP Sheet Active, carrying their old notes along.
  for (const row of not4GearingRows) {
    const toon = cell(row, 0);
    if (!toon || (toon.toLowerCase() === "name" && cell(row, 1).toUpperCase() === "M")) {
      continue;
    }
    const key = normalizeKey(toon);
    const notes = [cell(row, 12), cell(row, 13)].filter(Boolean).join(" ");
    const active = activeByKey.get(key);
    if (active) {
      if (notes) {
        active.notes = active.notes ? `${active.notes} | ${notes}` : `Not4Gearing history: ${notes}`;
      }
      continue;
    }
    const existing = not4GearingByKey.get(key);
    if (existing) {
      mergedNot4GearingRows += 1;
      if (notes) {
        existing.notes = existing.notes ? `${existing.notes} | ${notes}` : notes;
      }
      existing.className = existing.className || cell(row, 10);
      existing.level = existing.level || cell(row, 11);
      existing.mainAlt = existing.mainAlt || normalizeMainAlt(cell(row, 1));
      continue;
    }
    const gear = Array.from({ length: GEAR_COUNT }, () => "");
    for (let index = 0; index < 8; index += 1) {
      gear[index] = cell(row, 2 + index);
    }
    const entry: RosterToon = {
      owner: "",
      toon,
      mainAlt: normalizeMainAlt(cell(row, 1)),
      gear,
      pures: "",
      className: cell(row, 10),
      level: cell(row, 11),
      status: "Not4Gearing",
      openingEarned: 0,
      openingSpent: 0,
      openingActivity: "",
      dateAdded: cell(row, 12),
      notes: cell(row, 13)
    };
    not4GearingByKey.set(key, entry);
    roster.push(entry);
  }

  const adminBonus: AdminBonusRow[] = [];
  for (const row of adminRows) {
    const owner = cell(row, 0);
    const toon = cell(row, 1);
    const leadDkp = parseNumber(cell(row, 3));
    const adminDkp = parseNumber(cell(row, 4));
    if (!owner || !toon || (leadDkp === 0 && adminDkp === 0)) {
      continue;
    }
    adminBonus.push({ owner, toon, leadDkp, adminDkp, role: cell(row, 7) });
  }

  return {
    roster,
    adminBonus,
    activeCount,
    not4GearingCount: roster.length - activeCount,
    skippedDuplicates,
    mergedNot4GearingRows
  };
}
