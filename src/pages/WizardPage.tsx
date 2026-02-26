import { DateTime } from "luxon";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { LineResolver } from "../components/LineResolver";
import { StatusBanner } from "../components/StatusBanner";
import { WeekTable } from "../components/WeekTable";
import { computeWeeklySummary, recomputeStreaks } from "../lib/compute";
import { exportCorrectedFile, exportFullCsv, exportMinimalCsv, exportMinimalTxt } from "../lib/export";
import { createParserLookup, isTimestampLineStart, parseLine } from "../lib/parser";
import {
  SheetsClient,
  appendRows,
  loadSetupBundle,
  loadWeekStorageBundle,
  replaceTabRows
} from "../lib/sheets";
import { getBrowserTimezone, toWeekId, weekBoundsFromUtcSunday } from "../lib/week";
import { useAppContext } from "../store/AppContext";
import type { BossConfig, ParsedLine, WeekSummaryRow } from "../types";
import type { SetupBundle } from "../lib/sheets";

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

function makeTimezoneOptions(): string[] {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof supportedValuesOf === "function") {
    return supportedValuesOf("timeZone");
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
}

export function WizardPage(): JSX.Element {
  const { setup, setSetup, auth } = useAppContext();
  const accessToken = auth?.accessToken || "";
  const authEmail = auth?.email?.toLowerCase() || "";
  const [weekStartUtcDate, setWeekStartUtcDate] = useState(
    setup?.weekStartUtcDate || DateTime.utc().startOf("week").minus({ days: 1 }).toISODate() || ""
  );
  const [timezone, setTimezone] = useState(setup?.timezone || getBrowserTimezone());
  const [usersSpreadsheetId, setUsersSpreadsheetId] = useState(setup?.usersSpreadsheetId || "");
  const [usersRange, setUsersRange] = useState(setup?.usersRange || "A:A");
  const [dataSpreadsheetId, setDataSpreadsheetId] = useState(setup?.dataSpreadsheetId || "");
  const [fileName, setFileName] = useState("");
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [parsedLines, setParsedLines] = useState<ParsedLine[]>([]);
  const [parseVersion, setParseVersion] = useState(0);
  const [hasParsed, setHasParsed] = useState(false);
  const [discardedLines, setDiscardedLines] = useState<Set<number>>(new Set());
  const [issueCursor, setIssueCursor] = useState(0);
  const [canonicalUsers, setCanonicalUsers] = useState<string[]>([]);
  const [bosses, setBosses] = useState<BossConfig[]>([]);
  const [bossAliases, setBossAliases] = useState<Array<{ alias: string; canonical: string }>>([]);
  const [nameAliases, setNameAliases] = useState<Array<{ alias: string; canonical: string }>>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultRows, setResultRows] = useState<WeekSummaryRow[]>([]);
  const [bossColumns, setBossColumns] = useState<string[]>([]);
  const [storedWeeks, setStoredWeeks] = useState<string[]>([]);
  const [selectedStoredWeek, setSelectedStoredWeek] = useState("");
  const [autoLoadAttempted, setAutoLoadAttempted] = useState(false);
  const ensuredSheetsRef = useRef<Set<string>>(new Set());
  const setupCacheRef = useRef<{
    key: string;
    loadedAt: number;
    data: SetupBundle;
  } | null>(null);
  const lastAutoCalcRef = useRef<string | null>(null);

  const timezoneOptions = useMemo(() => makeTimezoneOptions(), []);

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
    setBosses(loaded.bosses);
    setBossAliases(loaded.bossAliases);
    setNameAliases(loaded.nameAliases);
    setConfig(loaded.config);
    setStoredWeeks(loaded.weeks.map((week) => week.weekId).sort((a, b) => b.localeCompare(a)));
  }

  async function loadSetupData(forceRefresh = false): Promise<SetupBundle> {
    if (!usersSpreadsheetId.trim() || !usersRange.trim() || !dataSpreadsheetId.trim()) {
      throw new Error("Users Spreadsheet ID, Users Range, and Data Spreadsheet ID are required.");
    }
    const cacheKey = `${usersSpreadsheetId.trim()}|${usersRange.trim()}|${dataSpreadsheetId.trim()}`;
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
    const loaded = await loadSetupBundle(
      client,
      usersSpreadsheetId.trim(),
      usersRange.trim(),
      normalizedDataSheetId
    );
    if (loaded.allowlist.length > 0 && !loaded.allowlist.includes(authEmail)) {
      throw new Error("Your account is not in the Allowlist tab for this data sheet.");
    }
    applySetupBundle(loaded);
    if (rawLines.length > 0) {
      setParsedLines(parseCurrentFile(rawLines, loaded.users, loaded.bosses, loaded.nameAliases, loaded.bossAliases));
      setParseVersion((previous) => previous + 1);
      setHasParsed(true);
    }
    setSetup({
      weekStartUtcDate,
      timezone,
      usersSpreadsheetId,
      usersRange,
      dataSpreadsheetId
    });
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
    setFileName(file.name);
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    setRawLines(lines);
    setParsedLines([]);
    setDiscardedLines(new Set());
    setIssueCursor(0);
    setResultRows([]);
    setBossColumns([]);
    setParseVersion((previous) => previous + 1);
    setHasParsed(false);
    setStatus(`Loaded ${lines.length} lines. Click Run DKP Flow to process.`);
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
    if (!usersSpreadsheetId.trim() || !usersRange.trim() || !dataSpreadsheetId.trim()) {
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
  }, [accessToken, autoLoadAttempted, busy, usersSpreadsheetId, usersRange, dataSpreadsheetId]);

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
    return hasParsed && unresolved.length === 0 && canonicalUsers.length > 0 && !!weekStartUtcDate;
  }

  const hasSetupLoaded =
    canonicalUsers.length > 0 && !!usersSpreadsheetId.trim() && !!usersRange.trim() && !!dataSpreadsheetId.trim();

  async function saveWeeklyData(weekId: string, rows: WeekSummaryRow[]): Promise<WeekSummaryRow[]> {
    const client = new SheetsClient(accessToken);
    const { weeks, totalsRaw, breakdownRaw } = await loadWeekStorageBundle(client, dataSpreadsheetId);
    const weekExists = weeks.some((week) => week.weekId === weekId);
    if (weekExists) {
      const shouldOverwrite = window.confirm(`Week ${weekId} already exists. Overwrite?`);
      if (!shouldOverwrite) {
        throw new Error("Save cancelled by user.");
      }
    }

    const bounds = weekBoundsFromUtcSunday(weekStartUtcDate);
    const createdUtc = DateTime.utc().toISO() || "";
    const updatedWeeks = weeks.filter((week) => week.weekId !== weekId);
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
    for (const row of rows) {
      historical.push({
        weekId,
        name: row.name,
        totalPoints: row.totalPoints,
        activityLevel: row.activityLevel,
        streak: 1
      });
    }
    recomputeStreaks(historical, updatedWeeks.map((week) => week.weekId));

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

    await Promise.all([
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
    ]);

    setStoredWeeks(updatedWeeks.map((week) => week.weekId).sort((a, b) => b.localeCompare(a)));
    setupCacheRef.current = null;

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
      updatedWeeks.map((week) => week.weekId),
      weekId
    );
    return rows.map((row) => ({
      ...row,
      streak: streakMap.get(row.name) || 1,
      last3WeeksTotal: last3Totals.get(row.name) || row.totalPoints
    }));
  }

  async function calculateAndSaveFromParsed(linesToUse: ParsedLine[]): Promise<void> {
    const inScope = linesToUse.filter((line) => !discardedLines.has(line.lineNumber) && line.issues.length === 0);
    const bossPointsMap = new Map(bosses.map((boss) => [boss.boss, boss.points]));
    const lowMax = Number(config.activity_low_max ?? "4");
    const mediumMax = Number(config.activity_medium_max ?? "9");
    const summary = computeWeeklySummary(inScope, bossPointsMap, canonicalUsers, {
      lowMax,
      mediumMax
    });
    const weekId = toWeekId(weekStartUtcDate);
    const withStreak = await saveWeeklyData(weekId, summary);
    const dynamicBosses = [...new Set(bosses.map((boss) => boss.boss))].sort((a, b) => a.localeCompare(b));
    setBossColumns(dynamicBosses);
    setResultRows(withStreak);
    setStatus(`Week ${weekId} calculated and saved.`);
    setSelectedStoredWeek(weekId);
  }

  async function runWeekFlow(): Promise<void> {
    setError("");
    setStatus("");
    lastAutoCalcRef.current = null;
    if (rawLines.length === 0) {
      setError("Upload a Timers File first.");
      return;
    }
    try {
      setBusy(true);
      setStatus("Loading setup and parsing file...");
      const loaded = await loadSetupData();
      const reparsed = parseCurrentFile(rawLines, loaded.users, loaded.bosses, loaded.nameAliases, loaded.bossAliases);
      setParsedLines(reparsed);
      setParseVersion((previous) => previous + 1);
      setHasParsed(true);
      setDiscardedLines(new Set());
      setIssueCursor(0);
      const localUnresolved = unresolvedIndexes(reparsed, new Set());
      if (localUnresolved.length > 0) {
        setStatus(`Resolver required: ${localUnresolved.length} line(s) need attention.`);
        return;
      }
      setStatus("All lines resolved. Auto-calculating...");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run DKP Flow failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadStoredWeekView(weekId: string): Promise<void> {
    if (!weekId) {
      return;
    }
    setError("");
    try {
      setBusy(true);
      const client = new SheetsClient(accessToken);
      const { totalsRaw, breakdownRaw } = await loadWeekStorageBundle(client, dataSpreadsheetId);
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
      const weeksAscending = Array.from(
        new Set(totalsRaw.map((row) => row[0]).filter((candidate): candidate is string => Boolean(candidate)))
      ).sort((a, b) => a.localeCompare(b));
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
      setStatus(`Loaded stored week ${weekId}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load week.");
    } finally {
      setBusy(false);
    }
  }

  const weekId = weekStartUtcDate ? toWeekId(weekStartUtcDate) : "";
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
        if (message === "Save cancelled by user.") {
          setStatus("Auto-save cancelled. Use Run DKP Flow to retry.");
        }
      })
      .finally(() => {
        setBusy(false);
      });
  }, [autoCalcKey, busy, parsedLines, hasParsed, unresolved.length, canonicalUsers.length, weekStartUtcDate]);

  function statusLine(): string {
    if (busy) {
      return "Working...";
    }
    if (!hasSetupLoaded) {
      return "Next: load setup details.";
    }
    if (rawLines.length === 0) {
      return "Next: upload Timers file.";
    }
    if (!hasParsed) {
      return "Next: run DKP flow to parse file.";
    }
    if (unresolved.length > 0) {
      return `Resolver: ${unresolved.length} line(s) need attention.`;
    }
    if (resultRows.length > 0) {
      return "Week saved. You can export or review history.";
    }
    return "Ready to auto-save week.";
  }

  function primaryCtaLabel(): string {
    if (busy) {
      return "Working...";
    }
    if (rawLines.length === 0) {
      return "Upload Timers File to Continue";
    }
    if (!hasParsed) {
      return "Start Resolver";
    }
    if (unresolved.length > 0) {
      return "Continue Resolver";
    }
    if (resultRows.length > 0) {
      return "Run DKP Flow";
    }
    return "Run DKP Flow";
  }

  return (
    <main className="page">
      <AppHeader />
      <StatusBanner status={status} error={error} onClearStatus={() => setStatus("")} />

      <section className="card">
        <h2>Wizard Setup</h2>
        <div className="flow-steps">
          <span className={`flow-step ${hasSetupLoaded ? "done" : ""}`}>1. Setup</span>
          <span className={`flow-step ${rawLines.length > 0 ? "done" : ""}`}>2. File</span>
          <span className={`flow-step ${parsedLines.length > 0 && unresolved.length === 0 ? "done" : ""}`}>
            3. Resolver
          </span>
          <span className={`flow-step ${resultRows.length > 0 ? "done" : ""}`}>4. Saved</span>
        </div>
        <p className="status-inline">{statusLine()}</p>
        <div className="form-grid">
          <label>
            Week Start (UTC Sunday)
            <input type="date" value={weekStartUtcDate} onChange={(event) => setWeekStartUtcDate(event.target.value)} />
          </label>
          <label>
            Input Timestamp Timezone
            <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              {timezoneOptions.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <label>
            Users Spreadsheet ID
            <input value={usersSpreadsheetId} onChange={(event) => setUsersSpreadsheetId(event.target.value)} />
          </label>
          <label>
            Users Range
            <input value={usersRange} onChange={(event) => setUsersRange(event.target.value)} />
          </label>
          <label>
            Data Spreadsheet ID
            <input value={dataSpreadsheetId} onChange={(event) => setDataSpreadsheetId(event.target.value)} />
          </label>
          <label>
            Timers File
            <input type="file" accept=".txt,text/plain" onChange={onFileChange} />
          </label>
          <button
            type="button"
            className="form-primary-action"
            onClick={runWeekFlow}
            disabled={busy || rawLines.length === 0}
          >
            {primaryCtaLabel()}
          </button>
        </div>
        <p className="hint">Run DKP Flow loads setup, parses file, then either opens resolver or auto-saves.</p>
        <p className="hint">Current week ID: {weekId || "N/A"}.</p>
        <p className="hint">
          Loaded users: {canonicalUsers.length}. In-scope lines: {parsedLines.length}. Unresolved lines: {unresolved.length}
          . File: {fileName || "None"}.
        </p>
      </section>

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

      <section className="card">
        <h3>Exports</h3>
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
            onClick={() => exportFullCsv(resultRows, weekId, bossColumns)}
          >
            Export Full CSV (Counts)
          </button>
          <button type="button" disabled={rawLines.length === 0} onClick={() => exportCorrectedFile(rawLines, weekId)}>
            Export Corrected TXT
          </button>
        </div>
        <p className="hint">Auto-calculates when all issues are resolved (or discarded).</p>
      </section>

      <section className="card">
        <h3>Week History</h3>
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
            Load Week
          </button>
          <Link to="/admin">Open Admin</Link>
        </div>
      </section>

      <section className="card">
        <h3>Weekly Chart</h3>
        <WeekTable rows={resultRows} bossColumns={bossColumns} />
      </section>

    </main>
  );
}
