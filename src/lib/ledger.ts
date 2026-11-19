import { CLASS_ORDER } from "../constants";
import type {
  AdminBonusRow,
  AuctionWin,
  LedgerEntry,
  OwnerActivity,
  OwnerWeekActivity,
  RosterToon
} from "../types";
import { normalizeKey } from "./normalize";

export type Balance = {
  earned: number;
  spent: number;
  available: number;
};

export type ActivityThresholds = {
  /** Lowest weekly DKP on any of the owner's toons that counts as "A". */
  aMin: number;
  /** Weekly DKP on any of the owner's toons that earns "A+". */
  aPlusMin: number;
};

export function ownerKey(owner: string): string {
  return normalizeKey(owner);
}

export function toonKey(toon: string): string {
  return normalizeKey(toon);
}

/**
 * Mirrors the old ActCalc tab: per owner, take the best weekly DKP of any Active toon.
 * A when it reaches aMin, UA when they earned something but below aMin, A+ when it reaches aPlusMin.
 */
export function computeOwnerActivity(
  weekId: string,
  roster: RosterToon[],
  newDkpByToon: Map<string, number>,
  thresholds: ActivityThresholds
): OwnerWeekActivity[] {
  const bestByOwner = new Map<string, { owner: string; best: number }>();
  for (const row of roster) {
    if (row.status !== "Active" || !row.owner.trim()) {
      continue;
    }
    const key = ownerKey(row.owner);
    const dkp = newDkpByToon.get(toonKey(row.toon)) || 0;
    const current = bestByOwner.get(key);
    if (!current) {
      bestByOwner.set(key, { owner: row.owner.trim(), best: dkp });
    } else if (dkp > current.best) {
      current.best = dkp;
    }
  }
  const output: OwnerWeekActivity[] = [];
  for (const { owner, best } of bestByOwner.values()) {
    let activity: OwnerActivity = "";
    if (best >= thresholds.aMin && best >= 1) {
      activity = "A";
    } else if (best >= 1) {
      activity = "UA";
    }
    output.push({ weekId, owner, activity, aPlus: best >= thresholds.aPlusMin });
  }
  output.sort((a, b) => a.owner.localeCompare(b.owner));
  return output;
}

/** Lead/admin bonus goes to the named toon only when its owner is "A" this week. */
export function computeBonuses(adminBonus: AdminBonusRow[], activity: OwnerWeekActivity[]): Map<string, number> {
  const activeOwners = new Set(activity.filter((row) => row.activity === "A").map((row) => ownerKey(row.owner)));
  const bonusByToon = new Map<string, number>();
  for (const row of adminBonus) {
    if (!activeOwners.has(ownerKey(row.owner))) {
      continue;
    }
    const amount = (row.leadDkp || 0) + (row.adminDkp || 0);
    if (amount === 0) {
      continue;
    }
    const key = toonKey(row.toon);
    bonusByToon.set(key, (bonusByToon.get(key) || 0) + amount);
  }
  return bonusByToon;
}

/** One ledger row per roster toon that earned, got a bonus, or spent this week. */
export function buildWeekEntries(
  weekId: string,
  roster: RosterToon[],
  newDkpByToon: Map<string, number>,
  bonusByToon: Map<string, number>,
  spentByToon: Map<string, number>
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const row of roster) {
    const key = toonKey(row.toon);
    const earnsDkp = row.status === "Active";
    const newDkp = earnsDkp ? newDkpByToon.get(key) || 0 : 0;
    const bonus = bonusByToon.get(key) || 0;
    const spent = spentByToon.get(key) || 0;
    if (newDkp === 0 && bonus === 0 && spent === 0) {
      continue;
    }
    entries.push({ weekId, toon: row.toon, owner: row.owner, newDkp, bonus, spent });
  }
  return entries;
}

/**
 * Balances are the imported opening balance plus every closed week up to (and including, unless
 * `exclusive`) the given week. Because nothing is stored as a running total, re-closing an earlier
 * week automatically flows into every later week.
 */
export function balancesAsOf(
  roster: RosterToon[],
  entries: LedgerEntry[],
  weekId: string,
  exclusive = false
): Map<string, Balance> {
  const balances = new Map<string, Balance>();
  for (const row of roster) {
    balances.set(toonKey(row.toon), {
      earned: row.openingEarned,
      spent: row.openingSpent,
      available: row.openingEarned - row.openingSpent
    });
  }
  for (const entry of entries) {
    if (exclusive ? entry.weekId >= weekId : entry.weekId > weekId) {
      continue;
    }
    const key = toonKey(entry.toon);
    const balance = balances.get(key) || { earned: 0, spent: 0, available: 0 };
    balance.earned += entry.newDkp + entry.bonus;
    balance.spent += entry.spent;
    balance.available = balance.earned - balance.spent;
    balances.set(key, balance);
  }
  return balances;
}

/** Owner activity on the last posted update before `weekId` (falls back to the imported spreadsheet values). */
export function previousOwnerActivity(
  weekId: string,
  roster: RosterToon[],
  activityRows: OwnerWeekActivity[]
): Map<string, OwnerActivity> {
  const earlierWeeks = [...new Set(activityRows.map((row) => row.weekId).filter((id) => id < weekId))].sort();
  const lastWeek = earlierWeeks[earlierWeeks.length - 1];
  const output = new Map<string, OwnerActivity>();
  if (lastWeek) {
    for (const row of activityRows) {
      if (row.weekId === lastWeek) {
        output.set(ownerKey(row.owner), row.activity);
      }
    }
    return output;
  }
  for (const row of roster) {
    if (!row.owner.trim()) {
      continue;
    }
    const value = row.openingActivity.trim().toUpperCase();
    const key = ownerKey(row.owner);
    if (value === "A" || (value === "UA" && output.get(key) !== "A")) {
      output.set(key, value as OwnerActivity);
    } else if (!output.has(key)) {
      output.set(key, "");
    }
  }
  return output;
}

/**
 * Warnings for each auction win, checked in posting order against the last posted balance:
 * overspend (including earlier wins the same week), Not4Gearing winner, inactive owner.
 */
export function checkWins(
  wins: AuctionWin[],
  roster: RosterToon[],
  balancesBefore: Map<string, Balance>,
  prevActivity: Map<string, OwnerActivity>
): Map<number, string[]> {
  const rosterByToon = new Map(roster.map((row) => [toonKey(row.toon), row]));
  const spentSoFar = new Map<string, number>();
  const warnings = new Map<number, string[]>();
  const ordered = [...wins].sort(
    (a, b) => (a.timestampUtcMillis || 0) - (b.timestampUtcMillis || 0) || a.lineNumber - b.lineNumber
  );
  for (const win of ordered) {
    if (!win.toon) {
      continue;
    }
    const key = toonKey(win.toon);
    const list: string[] = [];
    const toon = rosterByToon.get(key);
    if (toon?.status === "Not4Gearing") {
      list.push(`${win.toon} is Not4Gearing and can't win bids.`);
    }
    if (toon && toon.status === "Active") {
      const ownerActivity = toon.owner.trim() ? prevActivity.get(ownerKey(toon.owner)) || "" : "";
      if (ownerActivity !== "A") {
        list.push(`Owner ${toon.owner || "(none)"} wasn't active (A) on the last update.`);
      }
    }
    const available = balancesBefore.get(key)?.available || 0;
    const spent = (spentSoFar.get(key) || 0) + win.amount;
    spentSoFar.set(key, spent);
    if (spent > available) {
      list.push(`Overspend: ${spent} won this week vs ${available} available on the last update.`);
    }
    if (list.length > 0) {
      warnings.set(win.lineNumber, list);
    }
  }
  return warnings;
}

export type ReportRow = {
  owner: string;
  toon: string;
  mainAlt: string;
  gear: string[];
  pures: string;
  className: string;
  level: string;
  activity: OwnerActivity;
  aPlus: boolean;
  newDkp: number;
  totalEarned: number;
  totalSpent: number;
  available: number;
};

function classRank(className: string): number {
  const index = CLASS_ORDER.findIndex((name) => name.toLowerCase() === className.trim().toLowerCase());
  return index === -1 ? CLASS_ORDER.length : index;
}

/**
 * The weekly DKP update: every Active toon whose owner is "A" this week, grouped by class
 * (Druid, Mage, Ranger, Rogue, Warrior) and sorted by Total Earned, highest first.
 */
export function buildReport(
  weekId: string,
  roster: RosterToon[],
  entries: LedgerEntry[],
  activityRows: OwnerWeekActivity[]
): ReportRow[] {
  const activityByOwner = new Map(
    activityRows.filter((row) => row.weekId === weekId).map((row) => [ownerKey(row.owner), row])
  );
  const balances = balancesAsOf(roster, entries, weekId);
  const newDkpByToon = new Map<string, number>();
  for (const entry of entries) {
    if (entry.weekId === weekId) {
      newDkpByToon.set(toonKey(entry.toon), (newDkpByToon.get(toonKey(entry.toon)) || 0) + entry.newDkp);
    }
  }
  const rows: ReportRow[] = [];
  for (const toon of roster) {
    if (toon.status !== "Active" || !toon.owner.trim()) {
      continue;
    }
    const activity = activityByOwner.get(ownerKey(toon.owner));
    if (activity?.activity !== "A") {
      continue;
    }
    const balance = balances.get(toonKey(toon.toon)) || { earned: 0, spent: 0, available: 0 };
    rows.push({
      owner: toon.owner,
      toon: toon.toon,
      mainAlt: toon.mainAlt,
      gear: toon.gear,
      pures: toon.pures,
      className: toon.className,
      level: toon.level,
      activity: activity.activity,
      aPlus: activity.aPlus,
      newDkp: newDkpByToon.get(toonKey(toon.toon)) || 0,
      totalEarned: balance.earned,
      totalSpent: balance.spent,
      available: balance.available
    });
  }
  rows.sort(
    (a, b) =>
      classRank(a.className) - classRank(b.className) ||
      a.className.localeCompare(b.className) ||
      b.totalEarned - a.totalEarned ||
      a.toon.localeCompare(b.toon)
  );
  return rows;
}
