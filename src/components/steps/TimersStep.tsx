import { DateTime } from "luxon";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { LineResolver } from "../LineResolver";
import { StatusBanner } from "../StatusBanner";
import { WeekTable } from "../WeekTable";
import { computeWeeklySummary, recomputeStreaks } from "../../lib/compute";
import { copyMinimalTxt, exportCorrectedFile, exportFullCsv, exportMinimalCsv, exportMinimalTxt } from "../../lib/export";
import { normalizeKey } from "../../lib/normalize";
import { createParserLookup, isTimestampLineStart, parseLine, splitChatTimestamp } from "../../lib/parser";
import {
  SheetsClient,
  appendRows,
  loadSetupBundle,
  loadWeekStorageBundle,
  replaceTabRows
} from "../../lib/sheets";
import { toSunday, toWeekId, weekBoundsFromUtcSunday } from "../../lib/week";
import { useAppContext } from "../../store/AppContext";
import type { BossConfig, ParsedLine, WeekSummaryRow } from "../../types";
import type { SetupBundle } from "../../lib/sheets";

type HistoricalTotal = {
  weekId: string;
  name: string;
  totalPoints: number;
  activityLevel: string;
  streak: number;
};

type Last3Input = {
  weekId: string;
  name: string;
  totalPoints: number;
};

function computeLast3WeekTotals(
  allRows: Last3Input[],
  weeksAscending: string[],
  targetWeekId: string
): Map<string, number> {
  const targetIndex = weeksAscending.indexOf(targetWeekId);
  if (targetIndex === -1) {
    return new Map<string, number>();
  }
  const includedWeeks = new Set(weeksAscending.slice(Math.max(0, targetIndex - 2), targetIndex + 1));
  const totalsByName = new Map<string, number>();
  for (const row of allRows) {
    if (!includedWeeks.has(row.weekId)) {
      continue;
    }
    totalsByName.set(row.name, (totalsByName.get(row.name) || 0) + row.totalPoints);
  }
  return totalsByName;
}

async function readFileLines(file: File): Promise<string[]> {
  const text = await file.text();
  return text.split(/\r?\n/);
}

export type TimersStepProps = {
  weekStartUtcDate: string;
  timezone: string;
  dataSpreadsheetId: string;
  /** Asks the page to move the shared week (e.g. when it is before the app took over). */
  onWeekStartChange: (weekStartUtcDate: string) => void;
  /** Called after a week's timers are saved or deleted, so later steps reload. */
  onSaved: (weekId: string) => void;
};

/** Step 1: parse the boss timers chat export, resolve problem lines and save the week's points. */
export function TimersStep({
  weekStartUtcDate,
  timezone,
  dataSpreadsheetId,
  onWeekStartChange,
  onSaved
}: TimersStepProps): JSX.Element {
  const { auth } = useAppContext();
  const accessToken = auth?.accessToken || "";
  const authEmail = auth?.email?.toLowerCase() || "";
  const [fileName, setFileName] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [parsedLines, setParsedLines] = useState<ParsedLine[]>([]);
  const [parseVersion, setParseVersion] = useState(0);
  const [hasParsed, setHasParsed] = useState(false);
  const [discardedLines, setDiscardedLines] = useState<Set<number>>(new Set());
  const [issueCursor, setIssueCursor] = useState(0);
  const [canonicalUsers, setCanonicalUsers] = useState<string[]>([]);
  const [activeUsers, setActiveUsers] = useState<string[]>([]);
  const [not4GearingSeen, setNot4GearingSeen] = useState<string[]>([]);
  const [bosses, setBosses] = useState<BossConfig[]>([]);
  const [bossAliases, setBossAliases] = useState<Array<{ alias: string; canonical: string }>>([]);
  const [nameAliases, setNameAliases] = useState<Array<{ alias: string; canonical: string }>>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultRows, setResultRows] = useState<WeekSummaryRow[]>([]);
  const [bossColumns, setBossColumns] = useState<string[]>([]);
  const [copyFeedback, setCopyFeedback] = useState<"" | "ok" | "fail">("");
  const [storedWeeks, setStoredWeeks] = useState<string[]>([]);
  const [selectedStoredWeek, setSelectedStoredWeek] = useState("");
  const [autoLoadAttempted, setAutoLoadAttempted] = useState(false);
  const [flowReady, setFlowReady] = useState(false);
  const ensuredSheetsRef = useRef<Set<string>>(new Set());
  const setupCacheRef = useRef<{
    key: string;
    loadedAt: number;
    data: SetupBundle;
  } | null>(null);
  const lastAutoCalcRef = useRef<string | null>(null);

  if (!accessToken) {
    return <p>Not signed in.</p>;
  }

  function buildLookup(
    usersInput = canonicalUsers,
    bossesInput = bosses,
    nameAliasesInput = nameAliases,
    bossAliasesInput = bossAliases
  ) {
    return createParserLookup(usersInput, bossesInput, nameAliasesInput, bossAliasesInput);
  }

  function parseCurrentFile(
    lines: string[],
    usersInput = canonicalUsers,
    bossesInput = bosses,
    nameAliasesInput = nameAliases,
    bossAliasesInput = bossAliases
  ): ParsedLine[] {
    if (!weekStartUtcDate) {
      return [];
    }
    const lookup = buildLookup(usersInput, bossesInput, nameAliasesInput, bossAliasesInput);
    const bounds = weekBoundsFromUtcSunday(weekStartUtcDate);
    const mergedLines: Array<{ lineNumber: number; text: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? "";
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      if (isTimestampLineStart(raw) || mergedLines.length === 0) {
        mergedLines.push({ lineNumber: index + 1, text: trimmed });
      } else {
        const previous = mergedLines[mergedLines.length - 1];
        previous.text = `${previous.text} ${trimmed}`;
      }
    }

    const output: ParsedLine[] = [];
    for (const entry of mergedLines) {
      const parsed = parseLine(entry.text, entry.lineNumber, timezone, lookup);
      if (parsed.timestampUtcMillis === undefined) {
        if (parsed.issues.length > 0) {
          output.push(parsed);
        }
        continue;
      }
      if (parsed.timestampUtcMillis < bounds.startUtcMillis || parsed.timestampUtcMillis > bounds.endUtcMillis) {
        continue;
      }
      output.push(parsed);
    }
    return output;
  }

  function unresolvedIndexes(items: ParsedLine[], discarded: Set<number>): number[] {
    const indexes: number[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (discarded.has(items[i].lineNumber)) {
        continue;
      }
      if (items[i].issues.length > 0) {
        indexes.push(i);
      }
    }
    return indexes;
  }

  function applySetupBundle(loaded: SetupBundle): void {
    setCanonicalUsers(loaded.users);
    setActiveUsers(loaded.activeUsers);
    setBosses(loaded.bosses);
    setBossAliases(loaded.bossAliases);
    setNameAliases(loaded.nameAliases);
    setConfig(loaded.config);
    setStoredWeeks(loaded.weeks.map((week) => week.weekId).sort((a, b) => b.localeCompare(a)));
    // A week remembered from before the app took over the DKP balances is almost certainly stale.
    const start = loaded.config.ledger_start_weekid || "";
    if (start && (!weekStartUtcDate || weekStartUtcDate < start)) {
      onWeekStartChange(start);
      setFlowReady(false);
    }
  }

  /** Sunday week IDs that the file's timestamped lines fall in, ignoring the selected week. */
  function weeksInFile(lines: string[]): string[] {
    const weeks = new Set<string>();
    for (const line of lines) {
      if (!isTimestampLineStart(line)) {
        continue;
      }
      const millis = splitChatTimestamp(line.trim(), timezone)?.timestampUtcMillis;
      if (millis !== undefined) {
        weeks.add(toSunday(DateTime.fromMillis(millis).toUTC().toISODate() || ""));
      }
    }
    return Array.from(weeks).sort();
  }

  async function loadSetupData(forceRefresh = false): Promise<SetupBundle> {
    if (!dataSpreadsheetId.trim()) {
      throw new Error("Data Spreadsheet ID is required.");
    }
    const cacheKey = dataSpreadsheetId.trim();
    const cached = setupCacheRef.current;
    if (
      !forceRefresh &&
      cached &&
      cached.key === cacheKey &&
      Date.now() - cached.loadedAt < 180000
    ) {
      applySetupBundle(cached.data);
      if (rawLines.length > 0) {
        setParsedLines(
          parseCurrentFile(
            rawLines,
            cached.data.users,
            cached.data.bosses,
            cached.data.nameAliases,
            cached.data.bossAliases
          )
        );
        setParseVersion((previous) => previous + 1);
        setHasParsed(true);
      }
      return cached.data;
    }

    const client = new SheetsClient(accessToken);
    const normalizedDataSheetId = dataSpreadsheetId.trim();
    if (!ensuredSheetsRef.current.has(normalizedDataSheetId)) {
      await client.ensureSchema(normalizedDataSheetId);
      ensuredSheetsRef.current.add(normalizedDataSheetId);
    }
    const loaded = await loadSetupBundle(client, normalizedDataSheetId);
    if (loaded.allowlist.length > 0 && !loaded.allowlist.includes(authEmail)) {
      throw new Error("Your account is not in the Allowlist tab for this data sheet.");
    }
    if (loaded.roster.length === 0) {
      throw new Error("The roster is empty. Open the Roster page and import it from the DKP spreadsheet first.");
    }
    applySetupBundle(loaded);
    if (rawLines.length > 0) {
      setParsedLines(parseCurrentFile(rawLines, loaded.users, loaded.bosses, loaded.nameAliases, loaded.bossAliases));
      setParseVersion((previous) => previous + 1);
      setHasParsed(true);
    }
    setupCacheRef.current = {
      key: cacheKey,
      loadedAt: Date.now(),
      data: loaded
    };
    return loaded;
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setError("");
    setStatus("");
    setFlowReady(false);
    setFileName(file.name);
    setUploadedFile(file);
    const lines = await readFileLines(file);
    setRawLines(lines);
    setParsedLines([]);
    setDiscardedLines(new Set());
    setIssueCursor(0);
    setResultRows([]);
    setBossColumns([]);
    setParseVersion((previous) => previous + 1);
    setHasParsed(false);
    setStatus(`Loaded ${lines.length} lines. Click Process timers.`);
  }

  function reparseAll(
    nextLines: string[],
    usersInput = canonicalUsers,
    bossesInput = bosses,
    nameAliasesInput = nameAliases,
    bossAliasesInput = bossAliases
  ): void {
    const reparsed = parseCurrentFile(nextLines, usersInput, bossesInput, nameAliasesInput, bossAliasesInput);
    setParsedLines(reparsed);
    setParseVersion((previous) => previous + 1);
    setHasParsed(true);
  }

  const unresolved = unresolvedIndexes(parsedLines, discardedLines);
  const currentIssueIndex = unresolved[issueCursor] ?? -1;

  useEffect(() => {
    if (issueCursor >= unresolved.length) {
      setIssueCursor(0);
    }
  }, [issueCursor, unresolved.length]);

  useEffect(() => {
    if (!accessToken || autoLoadAttempted || busy) {
      return;
    }
    if (!dataSpreadsheetId.trim()) {
      return;
    }
    setAutoLoadAttempted(true);
    setError("");
    setStatus("Loading saved setup...");
    setBusy(true);
    loadSetupData()
      .then(() => {
        setStatus("Saved setup loaded.");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to auto-load saved setup");
      })
      .finally(() => {
        setBusy(false);
      });
  }, [accessToken, autoLoadAttempted, busy, dataSpreadsheetId]);

  async function persistAlias(tab: "BossAliases" | "NameAliases", alias: string, canonical: string): Promise<void> {
    const client = new SheetsClient(accessToken);
    await appendRows(client, dataSpreadsheetId, tab, [[alias, canonical]]);
    setupCacheRef.current = null;
  }

  async function persistBoss(boss: string, points: number): Promise<void> {
    const client = new SheetsClient(accessToken);
    await appendRows(client, dataSpreadsheetId, "Bosses", [[boss, String(points)]]);
    setupCacheRef.current = null;
  }

  async function handleAddNameAlias(aliasToken: string, canonicalName: string): Promise<void> {
    setError("");
    try {
      setBusy(true);
      await persistAlias("NameAliases", aliasToken, canonicalName);
      const next = [...nameAliases, { alias: aliasToken, canonical: canonicalName }];
      setNameAliases(next);
      reparseAll(rawLines, canonicalUsers, bosses, next, bossAliases);
      setStatus(`Added name alias: ${aliasToken} -> ${canonicalName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add name alias.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddBossAlias(aliasToken: string, canonicalBoss: string): Promise<void> {
    setError("");
    try {
      setBusy(true);
      await persistAlias("BossAliases", aliasToken, canonicalBoss);
      const next = [...bossAliases, { alias: aliasToken, canonical: canonicalBoss }];
      setBossAliases(next);
      reparseAll(rawLines, canonicalUsers, bosses, nameAliases, next);
      setStatus(`Added boss alias: ${aliasToken} -> ${canonicalBoss}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add boss alias.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddBoss(aliasToken: string, canonicalBoss: string, points: number): Promise<void> {
    setError("");
    try {
      setBusy(true);
      await persistBoss(canonicalBoss, points);
      await persistAlias("BossAliases", aliasToken, canonicalBoss);
      const nextBosses = [...bosses, { boss: canonicalBoss, points }];
      const nextBossAliases = [...bossAliases, { alias: aliasToken, canonical: canonicalBoss }];
      setBosses(nextBosses);
      setBossAliases(nextBossAliases);
      reparseAll(rawLines, canonicalUsers, nextBosses, nameAliases, nextBossAliases);
      setStatus(`Added boss ${canonicalBoss} (${points} points) and alias ${aliasToken}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add boss.");
    } finally {
      setBusy(false);
    }
  }

  function handleEditLine(lineNumber: number, value: string): void {
    setRawLines((previous) => {
      const next = [...previous];
      next[lineNumber - 1] = value;
      return next;
    });
  }

  function handleCheckLine(lineNumber: number, value: string): void {
    setRawLines((previous) => {
      const next = [...previous];
      next[lineNumber - 1] = value;
      reparseAll(next);
      return next;
    });
    setStatus(`Rechecked line ${lineNumber}.`);
  }

  function handleDiscardLine(lineNumber: number): void {
    setDiscardedLines((previous) => {
      const next = new Set(previous);
      next.add(lineNumber);
      return next;
    });
    setParseVersion((previous) => previous + 1);
  }

  function handleNextIssue(): void {
    if (unresolved.length <= 1) {
      return;
    }
    setIssueCursor((previous) => (previous + 1) % unresolved.length);
  }

  function canRunCalculation(): boolean {
    return (
      flowReady &&
      hasParsed &&
      unresolved.length === 0 &&
      canonicalUsers.length > 0 &&
      !!weekStartUtcDate
    );
  }

  const hasSetupLoaded = canonicalUsers.length > 0 && !!dataSpreadsheetId.trim();

  async function saveWeeklyData(
    weekId: string,
    rows: WeekSummaryRow[],
    persist = true
  ): Promise<{
    rows: WeekSummaryRow[];
    purgedCount: number;
  }> {
    const client = new SheetsClient(accessToken);
    const { weeks, totalsRaw, breakdownRaw } = await loadWeekStorageBundle(client, dataSpreadsheetId);
    const weekExists = weeks.some((week) => week.weekId === weekId);
    if (persist && weekExists) {
      const shouldOverwrite = window.confirm(`Week ${weekId} already exists. Overwrite?`);
      if (!shouldOverwrite) {
        throw new Error("Save cancelled by user.");
      }
    }

    const bounds = weekBoundsFromUtcSunday(weekStartUtcDate);
    const createdUtc = DateTime.utc().toISO() || "";
    let updatedWeeks = weeks.filter((week) => week.weekId !== weekId);
    updatedWeeks.push({
      weekId,
      startUtc: DateTime.fromMillis(bounds.startUtcMillis).toISO() || "",
      endUtc: DateTime.fromMillis(bounds.endUtcMillis).toISO() || "",
      timezone,
      sourceFileName: fileName || "manual",
      createdUtc,
      notes: ""
    });
    updatedWeeks.sort((a, b) => a.weekId.localeCompare(b.weekId));

    let purgedCount = 0;
    if (updatedWeeks.length > 20) {
      purgedCount = updatedWeeks.length - 20;
      updatedWeeks = updatedWeeks.slice(-20);
    }
    const keepSet = new Set(updatedWeeks.map((week) => week.weekId));

    const historical: HistoricalTotal[] = totalsRaw
      .filter((row) => row[0] && row[1] && row[2] && row[3])
      .map((row) => ({
        weekId: row[0],
        name: row[1],
        totalPoints: Number(row[2]),
        activityLevel: row[3],
        streak: Number(row[4] || 1)
      }))
      .filter((row) => row.weekId !== weekId && keepSet.has(row.weekId));
    for (const row of rows) {
      historical.push({
        weekId,
        name: row.name,
        totalPoints: row.totalPoints,
        activityLevel: row.activityLevel,
        streak: 1
      });
    }
    const weeksAscending = updatedWeeks.map((week) => week.weekId);
    recomputeStreaks(historical, weeksAscending);

    const totalsRows = historical
      .sort((a, b) => a.weekId.localeCompare(b.weekId) || a.name.localeCompare(b.name))
      .map((row) => [
        row.weekId,
        row.name,
        String(row.totalPoints),
        row.activityLevel,
        String(row.streak)
      ]);

    const updatedBreakdown = breakdownRaw.filter((row) => row[0] !== weekId && keepSet.has(row[0]));
    for (const row of rows) {
      const bossesSet = new Set([...Object.keys(row.bossCounts), ...Object.keys(row.bossPoints)]);
      for (const boss of bossesSet) {
        updatedBreakdown.push([
          weekId,
          row.name,
          boss,
          String(row.bossPoints[boss] || 0),
          String(row.bossCounts[boss] || 0)
        ]);
      }
    }

    const weekRows = updatedWeeks.map((row) => [
      row.weekId,
      row.startUtc,
      row.endUtc,
      row.timezone,
      row.sourceFileName,
      row.createdUtc,
      row.notes
    ]);

    if (persist) {
      const writeTasks: Promise<void>[] = [
        replaceTabRows(
          client,
          dataSpreadsheetId,
          "Weeks",
          ["WeekId", "StartUTC", "EndUTC", "Timezone", "SourceFileName", "CreatedUTC", "Notes"],
          weekRows
        ),
        replaceTabRows(
          client,
          dataSpreadsheetId,
          "WeekUserTotals",
          ["WeekId", "Name", "TotalPoints", "ActivityLevel", "Streak"],
          totalsRows
        ),
        replaceTabRows(
          client,
          dataSpreadsheetId,
          "WeekBossBreakdown",
          ["WeekId", "Name", "Boss", "Points", "Count"],
          updatedBreakdown
        )
      ];

      await Promise.all(writeTasks);

      setStoredWeeks(updatedWeeks.map((week) => week.weekId).sort((a, b) => b.localeCompare(a)));
      setupCacheRef.current = null;
    }

    const streakMap = new Map<string, number>();
    for (const row of historical) {
      if (row.weekId === weekId) {
        streakMap.set(row.name, row.streak);
      }
    }
    const last3Totals = computeLast3WeekTotals(
      historical.map((row) => ({
        weekId: row.weekId,
        name: row.name,
        totalPoints: row.totalPoints
      })),
      weeksAscending,
      weekId
    );
    const updatedRows = rows.map((row) => ({
      ...row,
      streak: streakMap.get(row.name) || 1,
      last3WeeksTotal: last3Totals.get(row.name) || row.totalPoints
    }));
    return {
      rows: updatedRows,
      purgedCount
    };
  }

  async function calculateAndSaveFromParsed(linesToUse: ParsedLine[]): Promise<void> {
    const inScope = linesToUse.filter((line) => !discardedLines.has(line.lineNumber) && line.issues.length === 0);
    const bossPointsMap = new Map(bosses.map((boss) => [boss.boss, boss.points]));
    const lowMax = Number(config.activity_low_max ?? "4");
    const mediumMax = Number(config.activity_medium_max ?? "9");
    // Not4Gearing toons resolve as names (so they aren't flagged as unknown) but don't earn points.
    const summary = computeWeeklySummary(inScope, bossPointsMap, activeUsers, {
      lowMax,
      mediumMax
    });
    const activeKeys = new Set(activeUsers.map((name) => normalizeKey(name)));
    const skippedNot4Gearing = new Set<string>();
    for (const line of inScope) {
      for (const name of line.addNames) {
        if (!activeKeys.has(normalizeKey(name))) {
          skippedNot4Gearing.add(name);
        }
      }
    }
    setNot4GearingSeen(Array.from(skippedNot4Gearing).sort((a, b) => a.localeCompare(b)));
    const weekId = toWeekId(weekStartUtcDate);
    const { rows: withStreak, purgedCount } = await saveWeeklyData(weekId, summary, true);
    const dynamicBosses = [...new Set(bosses.map((boss) => boss.boss))].sort((a, b) => a.localeCompare(b));
    setBossColumns(dynamicBosses);
    setResultRows(withStreak);
    if (purgedCount > 0) {
      setStatus(`Week ${weekId} calculated and saved. Purged ${purgedCount} old week(s).`);
    } else {
      setStatus(`Week ${weekId} calculated and saved.`);
    }
    setSelectedStoredWeek(weekId);
    onSaved(weekId);
  }

  async function runWeekFlow(): Promise<void> {
    setError("");
    setStatus("");
    lastAutoCalcRef.current = null;
    setFlowReady(false);
    let linesToUse = rawLines;
    if (linesToUse.length === 0 && uploadedFile) {
      linesToUse = await readFileLines(uploadedFile);
      setRawLines(linesToUse);
    }
    if (linesToUse.length === 0) {
      setError("Upload a Timers File first.");
      return;
    }
    try {
      setBusy(true);
      setStatus("Loading setup and parsing file...");
      const loaded = await loadSetupData();
      const start = loaded.config.ledger_start_weekid || "";
      if (start && weekStartUtcDate < start) {
        onWeekStartChange(start);
        setStatus("");
        setError(`Week Start was before the app took over (${start}), so it has been moved to ${start}. Check the week at the top and click Process timers again.`);
        return;
      }
      const reparsed = parseCurrentFile(
        linesToUse,
        loaded.users,
        loaded.bosses,
        loaded.nameAliases,
        loaded.bossAliases
      );
      if (reparsed.length === 0) {
        // Never auto-save an empty week: it would overwrite that week's stored totals with zeros.
        const fileWeeks = weeksInFile(linesToUse);
        setParsedLines([]);
        setHasParsed(false);
        setStatus("");
        setError(
          fileWeeks.length > 0
            ? `No lines in this file fall in the week of ${toWeekId(weekStartUtcDate)}. The file covers the week(s) of ${fileWeeks.join(", ")}. Change the week at the top and process again.`
            : "No timer lines found in this file."
        );
        return;
      }
      setParsedLines(reparsed);
      setParseVersion((previous) => previous + 1);
      setHasParsed(true);
      setFlowReady(true);
      setDiscardedLines(new Set());
      setIssueCursor(0);
      const localUnresolved = unresolvedIndexes(reparsed, new Set());
      if (localUnresolved.length > 0) {
        setStatus(`Resolver required: ${localUnresolved.length} line(s) need attention.`);
        return;
      }
      setStatus("All lines resolved. Auto-calculating...");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing the timers failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadStoredWeekView(weekId: string, quiet = false): Promise<void> {
    if (!weekId) {
      return;
    }
    setError("");
    try {
      setBusy(true);
      const client = new SheetsClient(accessToken);
      const { weeks, totalsRaw, breakdownRaw } = await loadWeekStorageBundle(client, dataSpreadsheetId);
      const totals = totalsRaw.filter((row) => row[0] === weekId);
      const breakdown = breakdownRaw.filter((row) => row[0] === weekId);
      const bossSet = new Set<string>();
      const rowMap = new Map<string, WeekSummaryRow>();
      for (const row of totals) {
        const name = row[1];
        rowMap.set(name, {
          name,
          totalPoints: Number(row[2] || 0),
          activityLevel: row[3] || "Low",
          streak: Number(row[4] || 1),
          last3WeeksTotal: 0,
          bossPoints: {},
          bossCounts: {}
        });
      }
      for (const row of breakdown) {
        const name = row[1];
        const boss = row[2];
        bossSet.add(boss);
        if (!rowMap.has(name)) {
          rowMap.set(name, {
            name,
            totalPoints: 0,
            activityLevel: "Low",
            streak: 1,
            last3WeeksTotal: 0,
            bossPoints: {},
            bossCounts: {}
          });
        }
        const item = rowMap.get(name)!;
        item.bossPoints[boss] = Number(row[3] || 0);
        item.bossCounts[boss] = Number(row[4] || 0);
      }
      const rows = Array.from(rowMap.values()).sort(
        (a, b) => b.totalPoints - a.totalPoints || a.name.localeCompare(b.name)
      );
      const weeksAscending = weeks.map((week) => week.weekId).sort((a, b) => a.localeCompare(b));
      const last3Totals = computeLast3WeekTotals(
        totalsRaw
          .filter((row) => row[0] && row[1] && row[2])
          .map((row) => ({
            weekId: row[0],
            name: row[1],
            totalPoints: Number(row[2] || 0)
          })),
        weeksAscending,
        weekId
      );
      for (const row of rows) {
        row.last3WeeksTotal = last3Totals.get(row.name) || row.totalPoints;
      }
      setResultRows(rows);
      setBossColumns(Array.from(bossSet).sort((a, b) => a.localeCompare(b)));
      if (!quiet) {
        setStatus(`Loaded stored week ${weekId}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load week.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteStoredWeek(weekId: string): Promise<void> {
    if (!weekId) {
      return;
    }
    const shouldDelete = window.confirm(`Delete week ${weekId}? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }
    setError("");
    try {
      setBusy(true);
      const client = new SheetsClient(accessToken);
      const { weeks, totalsRaw, breakdownRaw } = await loadWeekStorageBundle(client, dataSpreadsheetId);
      if (!weeks.some((week) => week.weekId === weekId)) {
        throw new Error(`Week ${weekId} not found.`);
      }

      const updatedWeeks = weeks.filter((week) => week.weekId !== weekId);
      updatedWeeks.sort((a, b) => a.weekId.localeCompare(b.weekId));

      const historical: HistoricalTotal[] = totalsRaw
        .filter((row) => row[0] && row[1] && row[2] && row[3])
        .map((row) => ({
          weekId: row[0],
          name: row[1],
          totalPoints: Number(row[2]),
          activityLevel: row[3],
          streak: Number(row[4] || 1)
        }))
        .filter((row) => row.weekId !== weekId);

      const weeksAscending = updatedWeeks.map((week) => week.weekId);
      recomputeStreaks(historical, weeksAscending);

      const totalsRows = historical
        .sort((a, b) => a.weekId.localeCompare(b.weekId) || a.name.localeCompare(b.name))
        .map((row) => [
          row.weekId,
          row.name,
          String(row.totalPoints),
          row.activityLevel,
          String(row.streak)
        ]);

      const updatedBreakdown = breakdownRaw.filter((row) => row[0] !== weekId);
      const weekRows = updatedWeeks.map((row) => [
        row.weekId,
        row.startUtc,
        row.endUtc,
        row.timezone,
        row.sourceFileName,
        row.createdUtc,
        row.notes
      ]);

      const writeTasks: Promise<void>[] = [
        replaceTabRows(
          client,
          dataSpreadsheetId,
          "Weeks",
          ["WeekId", "StartUTC", "EndUTC", "Timezone", "SourceFileName", "CreatedUTC", "Notes"],
          weekRows
        ),
        replaceTabRows(
          client,
          dataSpreadsheetId,
          "WeekUserTotals",
          ["WeekId", "Name", "TotalPoints", "ActivityLevel", "Streak"],
          totalsRows
        ),
        replaceTabRows(
          client,
          dataSpreadsheetId,
          "WeekBossBreakdown",
          ["WeekId", "Name", "Boss", "Points", "Count"],
          updatedBreakdown
        )
      ];
      await Promise.all(writeTasks);

      setStoredWeeks(updatedWeeks.map((week) => week.weekId).sort((a, b) => b.localeCompare(a)));
      setupCacheRef.current = null;

      if (selectedStoredWeek === weekId) {
        setSelectedStoredWeek("");
        setResultRows([]);
        setBossColumns([]);
      }
      setStatus(`Deleted week ${weekId}.`);
      onSaved(weekId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete week.");
    } finally {
      setBusy(false);
    }
  }

  const weekId = weekStartUtcDate ? toWeekId(weekStartUtcDate) : "";

  useEffect(() => {
    lastAutoCalcRef.current = null;
    setFlowReady(false);
    setParsedLines([]);
    setHasParsed(false);
    setDiscardedLines(new Set());
    setResultRows([]);
    setBossColumns([]);
    setNot4GearingSeen([]);
    setSelectedStoredWeek("");
  }, [weekStartUtcDate, timezone]);

  const weekIsStored = !!weekId && storedWeeks.includes(weekId);
  useEffect(() => {
    if (weekIsStored && resultRows.length === 0 && !busy && !hasParsed) {
      loadStoredWeekView(weekId, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekId, weekIsStored]);

  const autoCalcKey = `${weekId}|${parseVersion}|${discardedLines.size}`;

  useEffect(() => {
    if (busy) {
      return;
    }
    if (!canRunCalculation()) {
      return;
    }
    if (lastAutoCalcRef.current === autoCalcKey) {
      return;
    }
    lastAutoCalcRef.current = autoCalcKey;
    setError("");
    setStatus("Auto-calculating and saving week...");
    setBusy(true);
    calculateAndSaveFromParsed(parsedLines)
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Auto-calculation failed.";
        setError(message);
      })
      .finally(() => {
        setBusy(false);
      });
  }, [autoCalcKey, busy, parsedLines, hasParsed, unresolved.length, canonicalUsers.length, weekStartUtcDate]);

  const pointsEarned = resultRows.filter((row) => row.totalPoints > 0);

  function statusLine(): string {
    if (busy) {
      return "Working...";
    }
    if (!hasSetupLoaded) {
      return error ? "Couldn't load the data sheet (see the message above)." : "Loading the roster...";
    }
    if (unresolved.length > 0) {
      return `${unresolved.length} line(s) need attention below.`;
    }
    if (hasParsed && resultRows.length === 0) {
      return "All lines resolved. Saving...";
    }
    if (resultRows.length > 0) {
      return weekIsStored
        ? `Saved: ${pointsEarned.length} toons earned points this week.`
        : `${pointsEarned.length} toons earned points.`;
    }
    if (rawLines.length > 0) {
      return "File loaded. Click Process timers.";
    }
    return weekIsStored ? "Timers already saved for this week. Load a file to redo them." : "Load this week's timers chat export.";
  }

  return (
    <section className="card step-card" id="step-timers">
      <div className="step-head">
        <h3>1. Boss timers</h3>
        <span className={`step-badge ${weekIsStored && unresolved.length === 0 ? "done" : unresolved.length > 0 ? "attention" : ""}`}>
          {weekIsStored && unresolved.length === 0 ? "Saved" : unresolved.length > 0 ? "Needs attention" : "To do"}
        </span>
      </div>
      <StatusBanner status={status} error={error} onClearStatus={() => setStatus("")} />
      <div className="actions-row">
        <label className="file-pick">
          Timers file
          <input type="file" accept=".txt,text/plain" onChange={onFileChange} />
        </label>
        <button
          type="button"
          className="form-primary-action"
          onClick={runWeekFlow}
          disabled={busy || rawLines.length === 0 || !hasSetupLoaded}
        >
          {busy ? "Working..." : hasParsed ? "Process again" : "Process timers"}
        </button>
      </div>
      <p className="status-inline">{statusLine()}</p>
      <p className="hint">
        {fileName ? `File: ${fileName}. ` : ""}
        {hasParsed ? `${parsedLines.length} line(s) in this week. ` : ""}
        Roster: {activeUsers.length} active, {canonicalUsers.length - activeUsers.length} Not4Gearing.
      </p>
      {not4GearingSeen.length > 0 && (
        <p className="warning-inline">Not4Gearing toons in this file got no points: {not4GearingSeen.join(", ")}</p>
      )}

      {unresolved.length > 0 && (
        <LineResolver
          allRawLines={rawLines}
          parsedLines={parsedLines}
          currentIssueIndex={currentIssueIndex}
          canonicalNames={canonicalUsers}
          canonicalBosses={bosses.map((boss) => boss.boss)}
          onEditLine={handleEditLine}
          onCheckLine={handleCheckLine}
          onDiscardLine={handleDiscardLine}
          onAddBoss={handleAddBoss}
          onAddBossAlias={handleAddBossAlias}
          onAddNameAlias={handleAddNameAlias}
          onNextIssue={handleNextIssue}
        />
      )}

      <details className="admin-section">
        <summary>Points table and exports</summary>
        <div className="actions-row">
          <button type="button" disabled={resultRows.length === 0} onClick={() => exportMinimalCsv(resultRows, weekId)}>
            Export Minimal CSV
          </button>
          <button type="button" disabled={resultRows.length === 0} onClick={() => exportMinimalTxt(resultRows, weekId)}>
            Export Minimal TXT
          </button>
          <button
            type="button"
            disabled={resultRows.length === 0}
            onClick={() => {
              setError("");
              copyMinimalTxt(resultRows)
                .then((ok) => {
                  setCopyFeedback(ok ? "ok" : "fail");
                  window.setTimeout(() => setCopyFeedback(""), 1800);
                })
                .catch(() => {
                  setCopyFeedback("fail");
                  window.setTimeout(() => setCopyFeedback(""), 1800);
                });
            }}
          >
            Copy Minimal TXT
          </button>
          {copyFeedback && (
            <span className={`copy-feedback ${copyFeedback}`}>{copyFeedback === "ok" ? "Copied" : "Copy failed"}</span>
          )}
          <button
            type="button"
            disabled={resultRows.length === 0}
            onClick={() => exportFullCsv(resultRows, weekId, bossColumns)}
          >
            Export Full CSV (Counts)
          </button>
          <button type="button" disabled={rawLines.length === 0} onClick={() => exportCorrectedFile(rawLines, weekId)}>
            Export Corrected TXT
          </button>
        </div>
        <WeekTable rows={resultRows} bossColumns={bossColumns} />
      </details>

      <details className="admin-section">
        <summary>Saved timer weeks</summary>
        <div className="actions-row">
          <select value={selectedStoredWeek} onChange={(event) => setSelectedStoredWeek(event.target.value)}>
            <option value="">Select stored week</option>
            {storedWeeks.map((storedWeekId) => (
              <option key={storedWeekId} value={storedWeekId}>
                {storedWeekId}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => loadStoredWeekView(selectedStoredWeek)} disabled={!selectedStoredWeek}>
            Show points
          </button>
          <button type="button" onClick={() => deleteStoredWeek(selectedStoredWeek)} disabled={!selectedStoredWeek}>
            Delete week
          </button>
        </div>
        <p className="hint">Only the last 20 weeks of timer points are kept. DKP balances are not affected by this.</p>
      </details>
    </section>
  );
}
