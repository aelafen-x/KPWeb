import { DateTime } from "luxon";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toPng } from "html-to-image";
import { DkpReport } from "../DkpReport";
import { StatusBanner } from "../StatusBanner";
import { GEAR_COLUMNS } from "../../constants";
import { parseAuctionFile } from "../../lib/auction";
import { escapeCsvCell, triggerDownload } from "../../lib/export";
import {
  balancesAsOf,
  buildReport,
  buildWeekEntries,
  checkWins,
  computeBonuses,
  computeOwnerActivity,
  previousOwnerActivity,
  toonKey
} from "../../lib/ledger";
import type { LedgerBundle } from "../../lib/ledgerStore";
import { loadLedgerBundle, saveClosedWeek } from "../../lib/ledgerStore";
import { createParserLookup } from "../../lib/parser";
import { parseNumber } from "../../lib/roster";
import type { SetupBundle } from "../../lib/sheets";
import { SheetsClient, appendRows, loadSetupBundle, loadWeekStorageBundle } from "../../lib/sheets";
import { getNameSuggestions } from "../../lib/suggest";
import { reportFileName, reportTitle, toSunday, toWeekId, weekBoundsFromUtcSunday } from "../../lib/week";
import { useAppContext } from "../../store/AppContext";
import type { AuctionWin, SpendRecord } from "../../types";

function winToSpend(weekId: string, win: AuctionWin): SpendRecord {
  return {
    weekId,
    toon: win.toon || win.toonRaw,
    amount: win.amount,
    timestamp: win.timestampUtcMillis ? DateTime.fromMillis(win.timestampUtcMillis).toUTC().toISO() || "" : "",
    poster: win.poster,
    rawLine: win.rawText
  };
}

export type StepProgress = {
  timersSaved: boolean;
  auctionsReady: boolean;
  auctionProblems: boolean;
  closed: boolean;
  closeStale: boolean;
  reportReady: boolean;
};

export type LedgerStepsProps = {
  weekStart: string;
  timezone: string;
  dataSpreadsheetId: string;
  /** Bumped by the page after the timers step saves, so the week's points are reloaded. */
  refreshKey: number;
  onWeekStartChange: (weekStart: string) => void;
  onProgress: (progress: StepProgress) => void;
};

/** Steps 2-4: auction wins, closing the week, and the DKP update report. */
export function LedgerSteps({
  weekStart,
  timezone,
  dataSpreadsheetId,
  refreshKey,
  onWeekStartChange,
  onProgress
}: LedgerStepsProps): JSX.Element {
  const { auth } = useAppContext();
  const accessToken = auth?.accessToken || "";
  const [setupData, setSetupData] = useState<SetupBundle | null>(null);
  const [ledger, setLedger] = useState<LedgerBundle | null>(null);
  const [weekTotals, setWeekTotals] = useState<string[][]>([]);
  const [auctionFileName, setAuctionFileName] = useState("");
  const [auctionLines, setAuctionLines] = useState<string[]>([]);
  const [discarded, setDiscarded] = useState<Set<number>>(new Set());
  const [aliasChoice, setAliasChoice] = useState<Record<number, string>>({});
  /** Edited auction lines that have been checked (re-parsed). */
  const [lineDrafts, setLineDrafts] = useState<Record<number, string>>({});
  /** Text being typed into a problem line, applied only on Check line / Enter. */
  const [typing, setTyping] = useState<Record<number, string>>({});
  const [reportWeek, setReportWeek] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const weekId = weekStart ? toWeekId(weekStart) : "";

  async function load(): Promise<void> {
    if (!accessToken || !dataSpreadsheetId) {
      return;
    }
    const client = new SheetsClient(accessToken);
    await client.ensureSchema(dataSpreadsheetId);
    const [loadedSetup, loadedLedger, storage] = await Promise.all([
      loadSetupBundle(client, dataSpreadsheetId),
      loadLedgerBundle(client, dataSpreadsheetId),
      loadWeekStorageBundle(client, dataSpreadsheetId)
    ]);
    if (loadedSetup.allowlist.length > 0 && !loadedSetup.allowlist.includes((auth?.email || "").toLowerCase())) {
      throw new Error("Your account is not in the Allowlist tab for this data sheet.");
    }
    setSetupData(loadedSetup);
    setLedger(loadedLedger);
    setWeekTotals(storage.totalsRaw);
    // A week remembered from before the app took over can't be closed; jump to the first week it can.
    const start = loadedSetup.config.ledger_start_weekid || "";
    if (start && (!weekStart || weekStart < start)) {
      onWeekStartChange(start);
    }
  }

  useEffect(() => {
    setBusy(true);
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, dataSpreadsheetId, refreshKey]);

  const roster = setupData?.roster || [];
  const startWeekId = setupData?.config.ledger_start_weekid || "";
  const timersWeek = setupData?.weeks.find((week) => week.weekId === weekId);
  const closedWeek = ledger?.ledgerWeeks.find((week) => week.weekId === weekId);
  const timersChangedSinceClose =
    !!timersWeek && !!closedWeek && timersWeek.createdUtc > closedWeek.closedUtc;
  const laterClosedWeeks = (ledger?.ledgerWeeks || []).filter((week) => week.weekId > weekId);

  const lookup = useMemo(
    () => createParserLookup(setupData?.users || [], [], setupData?.nameAliases || [], []),
    [setupData?.users, setupData?.nameAliases]
  );

  const wins = useMemo(() => {
    if (!weekId || auctionLines.length === 0) {
      return [];
    }
    const lines = auctionLines.map((line, index) => lineDrafts[index + 1] ?? line);
    return parseAuctionFile(lines, timezone, lookup, weekBoundsFromUtcSunday(weekId)).filter(
      (win) => !discarded.has(win.lineNumber)
    );
  }, [auctionLines, lineDrafts, discarded, timezone, lookup, weekId]);

  const winsInOtherWeeks = useMemo(() => {
    if (auctionLines.length === 0 || wins.length > 0) {
      return [];
    }
    const all = parseAuctionFile(auctionLines, timezone, lookup, {
      startUtcMillis: Number.NEGATIVE_INFINITY,
      endUtcMillis: Number.POSITIVE_INFINITY
    });
    return [
      ...new Set(
        all
          .filter((win) => win.timestampUtcMillis !== undefined)
          .map((win) => toSunday(DateTime.fromMillis(win.timestampUtcMillis!).toUTC().toISODate() || ""))
      )
    ].sort();
  }, [auctionLines, wins.length, timezone, lookup]);

  const problems = wins.filter((win) => win.issues.length > 0);
  const goodWins = wins.filter((win) => win.issues.length === 0);
  const savedSpends = (ledger?.spends || []).filter((row) => row.weekId === weekId);
  const usingFile = auctionLines.length > 0;

  const balancesBefore = useMemo(
    () => balancesAsOf(roster, ledger?.entries || [], weekId, true),
    [roster, ledger?.entries, weekId]
  );
  const prevActivity = useMemo(
    () => previousOwnerActivity(weekId, roster, ledger?.activity || []),
    [weekId, roster, ledger?.activity]
  );
  const warnings = useMemo(
    () => checkWins(goodWins, roster, balancesBefore, prevActivity),
    [goodWins, roster, balancesBefore, prevActivity]
  );

  const closedWeekIds = useMemo(
    () => (ledger?.ledgerWeeks || []).map((week) => week.weekId).sort((a, b) => b.localeCompare(a)),
    [ledger?.ledgerWeeks]
  );
  useEffect(() => {
    setReportWeek("");
  }, [weekId]);
  const shownReportWeek = reportWeek || (closedWeek ? weekId : "");
  const reportRows = useMemo(
    () =>
      shownReportWeek && ledger
        ? buildReport(shownReportWeek, roster, ledger.entries, ledger.activity)
        : [],
    [shownReportWeek, roster, ledger]
  );

  async function onAuctionFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    setAuctionFileName(file.name);
    setAuctionLines(text.split(/\r?\n/));
    setDiscarded(new Set());
    setAliasChoice({});
    setLineDrafts({});
    setTyping({});
    setError("");
    setStatus(`Loaded ${file.name}.`);
  }

  async function addAlias(win: AuctionWin): Promise<void> {
    const canonical = aliasChoice[win.lineNumber];
    if (!canonical || !setupData) {
      return;
    }
    setBusy(true);
    try {
      const client = new SheetsClient(accessToken);
      await appendRows(client, dataSpreadsheetId, "NameAliases", [[win.toonRaw, canonical]]);
      setSetupData({
        ...setupData,
        nameAliases: [...setupData.nameAliases, { alias: win.toonRaw, canonical }]
      });
      setStatus(`Added name alias: ${win.toonRaw} -> ${canonical}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add alias.");
    } finally {
      setBusy(false);
    }
  }

  async function closeWeek(): Promise<void> {
    if (!setupData || !ledger || !weekId) {
      return;
    }
    setError("");
    if (startWeekId && weekId < startWeekId) {
      setError(`The app took over from ${startWeekId}. Earlier weeks are already in the imported opening balances.`);
      return;
    }
    if (!timersWeek) {
      setError("Save this week's timers first (step 1).");
      return;
    }
    if (problems.length > 0) {
      setError("Fix or discard the auction lines with problems first.");
      return;
    }
    const prompts: string[] = [];
    if (!usingFile) {
      prompts.push(
        savedSpends.length > 0
          ? `No auction file loaded. Keep the ${savedSpends.length} saved win(s) for this week?`
          : "No auction file loaded. Close the week with no auction wins?"
      );
    }
    if (closedWeek) {
      prompts.push(`Week ${weekId} is already closed. Close it again?`);
    }
    if (laterClosedWeeks.length > 0) {
      prompts.push(`Balances for ${laterClosedWeeks.length} later closed week(s) will update too.`);
    }
    if (prompts.length > 0 && !window.confirm(prompts.join("\n\n"))) {
      return;
    }

    setBusy(true);
    try {
      const newDkpByToon = new Map<string, number>();
      for (const row of weekTotals) {
        if (row[0] === weekId && row[1]) {
          newDkpByToon.set(toonKey(row[1]), parseNumber(row[2]));
        }
      }
      const thresholds = {
        aMin: parseNumber(setupData.config.owner_a_min || "1") || 1,
        aPlusMin: parseNumber(setupData.config.owner_aplus_min || "300") || 300
      };
      const activity = computeOwnerActivity(weekId, roster, newDkpByToon, thresholds);
      const bonuses = computeBonuses(ledger.adminBonus, activity);
      const spends = usingFile ? goodWins.map((win) => winToSpend(weekId, win)) : savedSpends;
      const spentByToon = new Map<string, number>();
      for (const spend of spends) {
        spentByToon.set(toonKey(spend.toon), (spentByToon.get(toonKey(spend.toon)) || 0) + spend.amount);
      }
      const entries = buildWeekEntries(weekId, roster, newDkpByToon, bonuses, spentByToon);
      const client = new SheetsClient(accessToken);
      const next = await saveClosedWeek(
        client,
        dataSpreadsheetId,
        ledger,
        {
          weekId,
          closedUtc: DateTime.utc().toISO() || "",
          auctionFile: usingFile ? auctionFileName : closedWeek?.auctionFile || ""
        },
        entries,
        activity,
        spends
      );
      setLedger(next);
      setReportWeek(weekId);
      const activeOwners = activity.filter((row) => row.activity === "A").length;
      setStatus(`Week ${weekId} closed: ${activeOwners} active owners, ${spends.length} auction win(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to close week.");
    } finally {
      setBusy(false);
    }
  }

  function downloadPdf(): void {
    const previousTitle = document.title;
    document.title = reportFileName(shownReportWeek);
    document.body.classList.add("printing-report");
    const cleanup = () => {
      document.title = previousTitle;
      document.body.classList.remove("printing-report");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }

  async function downloadPng(): Promise<void> {
    if (!reportRef.current) {
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await toPng(reportRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      const blob = await (await fetch(dataUrl)).blob();
      triggerDownload(blob, `${reportFileName(shownReportWeek)}.png`, "image/png");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create image.");
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv(): void {
    const header = [
      "Owner",
      "Toon",
      "M",
      ...GEAR_COLUMNS,
      "Pures Earned",
      "Class",
      "Level",
      "A",
      "New Activity DKP",
      "Total Earned DKP",
      "Total Spent DKP",
      "Available DKP"
    ];
    const lines = [header.map(escapeCsvCell).join(",")];
    for (const row of reportRows) {
      lines.push(
        [
          row.owner,
          row.toon,
          row.mainAlt,
          ...GEAR_COLUMNS.map((_, index) => row.gear[index] || ""),
          row.pures,
          row.className,
          row.level,
          row.activity,
          row.newDkp,
          row.totalEarned,
          row.totalSpent,
          row.available
        ]
          .map(escapeCsvCell)
          .join(",")
      );
    }
    triggerDownload(lines.join("\n"), `${reportFileName(shownReportWeek)}.csv`, "text/csv");
  }

  const nameOptions = (token: string): string[] => {
    const all = setupData?.users || [];
    const suggested = getNameSuggestions(token, all);
    const rest = all.filter((name) => !suggested.includes(name)).sort((a, b) => a.localeCompare(b));
    return [...suggested, ...rest];
  };

  const auctionsReady = usingFile ? wins.length > 0 && problems.length === 0 : savedSpends.length > 0 || !!closedWeek;
  const progress: StepProgress = {
    timersSaved: !!timersWeek,
    auctionsReady,
    auctionProblems: problems.length > 0,
    closed: !!closedWeek,
    closeStale: timersChangedSinceClose,
    reportReady: !!closedWeek && reportRows.length > 0
  };
  const progressKey = JSON.stringify(progress);
  useEffect(() => {
    onProgress(progress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressKey]);

  const spendTotal = (usingFile ? goodWins : savedSpends).reduce((sum, row) => sum + row.amount, 0);

  return (
    <>
      <section className="card step-card no-print" id="step-auctions">
        <div className="step-head">
          <h3>2. Auction wins</h3>
          <span className={`step-badge ${problems.length > 0 ? "attention" : auctionsReady ? "done" : ""}`}>
            {problems.length > 0 ? "Needs attention" : auctionsReady ? "Ready" : "Optional"}
          </span>
        </div>
        <StatusBanner status={status} error={error} onClearStatus={() => setStatus("")} />
        <div className="actions-row">
          <label className="file-pick">
            Auction file
            <input type="file" accept=".txt,text/plain" onChange={onAuctionFile} />
          </label>
        </div>
        {!usingFile && (
          <p className="hint">
            {savedSpends.length > 0
              ? `Showing the ${savedSpends.length} win(s) saved when this week was closed. Load a file to replace them.`
              : "Load the auction chat export for this week. Lines with the word Winner are read; everything else is ignored."}
          </p>
        )}

        {usingFile && wins.length === 0 && (
          <p className="warning-inline">
            {winsInOtherWeeks.length > 0
              ? `No Winner lines in the week of ${weekId}. The file has wins in the week(s) of ${winsInOtherWeeks.join(", ")}; change the week at the top.`
              : "No Winner lines found in this file."}
          </p>
        )}

        {problems.length > 0 && (
          <div className="stack">
            <p className="error">{problems.length} line(s) need fixing before the week can be closed.</p>
            {problems.map((win) => {
              const issue = win.issues[0];
              const draft =
                typing[win.lineNumber] ?? lineDrafts[win.lineNumber] ?? auctionLines[win.lineNumber - 1] ?? win.rawText;
              const checkLine = () => {
                setLineDrafts({ ...lineDrafts, [win.lineNumber]: draft });
                setTyping((previous) => {
                  const next = { ...previous };
                  delete next[win.lineNumber];
                  return next;
                });
              };
              return (
                <div className="problem-line" key={win.lineNumber}>
                  <div className="line-row current">
                    <span className="ln">{win.lineNumber}</span>
                    <span>{win.rawText}</span>
                  </div>
                  <p className="error">{issue.message}</p>
                  {issue.type === "UnknownName" && (
                    <div className="actions-row">
                      <select
                        value={aliasChoice[win.lineNumber] || ""}
                        onChange={(event) => setAliasChoice({ ...aliasChoice, [win.lineNumber]: event.target.value })}
                      >
                        <option value="">Map "{win.toonRaw}" to toon...</option>
                        {nameOptions(win.toonRaw).map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <button type="button" disabled={!aliasChoice[win.lineNumber] || busy} onClick={() => addAlias(win)}>
                        Add Name Alias
                      </button>
                    </div>
                  )}
                  <div className="actions-row">
                    <input
                      className="grow"
                      value={draft}
                      onChange={(event) => setTyping({ ...typing, [win.lineNumber]: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          checkLine();
                        }
                      }}
                    />
                    <button type="button" onClick={checkLine} disabled={typing[win.lineNumber] === undefined}>
                      Check line
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiscarded((previous) => new Set(previous).add(win.lineNumber))}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {(usingFile ? goodWins.length : savedSpends.length) > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Time</th>
                  <th>Toon</th>
                  <th>Amount</th>
                  <th>Available on last update</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody>
                {usingFile
                  ? goodWins.map((win) => (
                      <tr key={win.lineNumber} className={warnings.has(win.lineNumber) ? "warn-row" : ""}>
                        <td>{win.lineNumber}</td>
                        <td>{win.timestampRaw}</td>
                        <td>{win.toon}</td>
                        <td>{win.amount}</td>
                        <td>{balancesBefore.get(toonKey(win.toon || ""))?.available ?? 0}</td>
                        <td>{(warnings.get(win.lineNumber) || []).join(" ")}</td>
                      </tr>
                    ))
                  : savedSpends.map((spend, index) => (
                      <tr key={index}>
                        <td />
                        <td>{spend.timestamp ? DateTime.fromISO(spend.timestamp).toLocaleString(DateTime.DATETIME_MED) : ""}</td>
                        <td>{spend.toon}</td>
                        <td>{spend.amount}</td>
                        <td>{balancesBefore.get(toonKey(spend.toon))?.available ?? 0}</td>
                        <td />
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
        {(usingFile || savedSpends.length > 0) && (
          <p className="hint">
            {usingFile ? goodWins.length : savedSpends.length} win(s), {spendTotal} DKP total.
            {usingFile && warnings.size > 0 ? ` ${warnings.size} with warnings (they are still recorded).` : ""}
          </p>
        )}
      </section>

      <section className="card step-card no-print" id="step-close">
        <div className="step-head">
          <h3>3. Close the week</h3>
          <span className={`step-badge ${closedWeek && !timersChangedSinceClose ? "done" : timersChangedSinceClose ? "attention" : ""}`}>
            {closedWeek && !timersChangedSinceClose ? "Closed" : timersChangedSinceClose ? "Close again" : "To do"}
          </span>
        </div>
        <p className="hint">
          Works out who was active (A), adds this week's DKP and admin bonuses, takes off the auction wins, and updates
          every balance.
        </p>
        <div className="actions-row">
          <button
            type="button"
            className="form-primary-action"
            onClick={closeWeek}
            disabled={busy || !setupData || !timersWeek || problems.length > 0 || roster.length === 0}
          >
            {busy ? "Working..." : closedWeek ? "Close week again" : "Close week"}
          </button>
          <span className="hint-inline">
            {closedWeek
              ? `Closed ${DateTime.fromISO(closedWeek.closedUtc).toLocaleString(DateTime.DATETIME_MED)}.`
              : !timersWeek
                ? "Save this week's timers first (step 1)."
                : problems.length > 0
                  ? "Fix the auction lines first (step 2)."
                  : "Ready to close."}
          </span>
        </div>
        {roster.length === 0 && setupData && (
          <p className="warning-inline">
            The roster is empty. <Link to="/roster">Import it</Link> before closing a week.
          </p>
        )}
        {timersChangedSinceClose && (
          <p className="warning-inline">The timers for this week were saved again after it was closed. Close it again.</p>
        )}
        {startWeekId && weekId && weekId < startWeekId && (
          <p className="warning-inline">This week is before the app took over ({startWeekId}), so it can't be closed here.</p>
        )}
      </section>

      <section className="card step-card" id="step-report">
        <div className="step-head no-print">
          <h3>4. DKP update</h3>
          <span className={`step-badge ${reportRows.length > 0 && closedWeek ? "done" : ""}`}>
            {reportRows.length > 0 && closedWeek ? "Ready to post" : "After closing"}
          </span>
        </div>
        <div className="actions-row no-print">
          <button type="button" onClick={downloadPdf} disabled={!shownReportWeek}>
            Download PDF
          </button>
          <button type="button" onClick={downloadPng} disabled={!shownReportWeek || busy}>
            Download PNG
          </button>
          <button type="button" onClick={downloadCsv} disabled={!shownReportWeek}>
            Download CSV
          </button>
          {closedWeekIds.length > 0 && (
            <select value={reportWeek} onChange={(event) => setReportWeek(event.target.value)}>
              <option value="">{closedWeek ? "This week" : "Show an earlier week..."}</option>
              {closedWeekIds
                .filter((id) => id !== weekId)
                .map((id) => (
                  <option key={id} value={id}>
                    {reportTitle(id)}
                  </option>
                ))}
            </select>
          )}
        </div>
        <p className="hint no-print">
          Every toon of each owner who was active (A) that week. For the PDF, choose "Save as PDF" in the print dialog.
        </p>
        {shownReportWeek ? (
          <div className="report-scroll">
            <DkpReport ref={reportRef} title={reportTitle(shownReportWeek)} rows={reportRows} />
          </div>
        ) : (
          <p className="hint">Close this week to see its DKP update.</p>
        )}
      </section>
    </>
  );
}
