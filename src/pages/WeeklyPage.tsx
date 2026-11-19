import { DateTime } from "luxon";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { LedgerSteps } from "../components/steps/LedgerSteps";
import type { StepProgress } from "../components/steps/LedgerSteps";
import { TimersStep } from "../components/steps/TimersStep";
import { getBrowserTimezone, reportTitle, toSunday, toWeekId } from "../lib/week";
import { useAppContext } from "../store/AppContext";

function makeTimezoneOptions(): string[] {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supportedValuesOf === "function") {
    return supportedValuesOf("timeZone");
  }
  return ["UTC", "Europe/London", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
}

/** The last full week (Sunday to Saturday) before today. */
function lastFullWeek(): string {
  return toSunday(DateTime.utc().minus({ days: 7 }).toISODate() || "");
}

function shiftWeek(weekStart: string, weeks: number): string {
  return toSunday(DateTime.fromISO(weekStart, { zone: "utc" }).plus({ weeks }).toISODate() || "");
}

const EMPTY_PROGRESS: StepProgress = {
  timersSaved: false,
  auctionsReady: false,
  auctionProblems: false,
  closed: false,
  closeStale: false,
  reportReady: false
};

type Step = { id: string; label: string; state: "done" | "attention" | "" };

/** One page for the whole weekly job: pick the week once, then timers, auction wins, close, report. */
export function WeeklyPage(): JSX.Element {
  const { setup, setSetup } = useAppContext();
  const [weekStart, setWeekStart] = useState(toSunday(setup?.weekStartUtcDate || "") || lastFullWeek());
  const [timezone, setTimezone] = useState(setup?.timezone || getBrowserTimezone());
  const [dataSpreadsheetId, setDataSpreadsheetId] = useState(setup?.dataSpreadsheetId || "");
  const [sheetDraft, setSheetDraft] = useState(setup?.dataSpreadsheetId || "");
  const [refreshKey, setRefreshKey] = useState(0);
  const [progress, setProgress] = useState<StepProgress>(EMPTY_PROGRESS);
  const timezoneOptions = useMemo(() => makeTimezoneOptions(), []);

  useEffect(() => {
    setSetup({ weekStartUtcDate: weekStart, timezone, dataSpreadsheetId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, timezone, dataSpreadsheetId]);

  const weekId = weekStart ? toWeekId(weekStart) : "";
  const weekLabel = weekId ? reportTitle(weekId).replace(/^Activity /, "") : "";

  const steps: Step[] = [
    { id: "step-timers", label: "1. Timers", state: progress.timersSaved ? "done" : "" },
    {
      id: "step-auctions",
      label: "2. Auction wins",
      state: progress.auctionProblems ? "attention" : progress.auctionsReady ? "done" : ""
    },
    {
      id: "step-close",
      label: "3. Close week",
      state: progress.closeStale ? "attention" : progress.closed ? "done" : ""
    },
    { id: "step-report", label: "4. DKP update", state: progress.reportReady ? "done" : "" }
  ];

  function changeWeek(next: string): void {
    if (next && next !== weekStart) {
      setWeekStart(next);
      setProgress(EMPTY_PROGRESS);
    }
  }

  return (
    <main className="page">
      <AppHeader />

      <section className="card week-bar no-print">
        <div className="week-bar-row">
          <div>
            <span className="week-eyebrow">Week</span>
            <h2 className="week-title">{weekLabel || "Pick a week"}</h2>
          </div>
          <div className="week-picker">
            <button type="button" onClick={() => changeWeek(shiftWeek(weekStart, -1))} aria-label="Previous week">
              ◀
            </button>
            <input
              type="date"
              value={weekStart}
              onChange={(event) => changeWeek(toSunday(event.target.value))}
              aria-label="Week start (Sunday)"
            />
            <button type="button" onClick={() => changeWeek(shiftWeek(weekStart, 1))} aria-label="Next week">
              ▶
            </button>
          </div>
        </div>
        <nav className="stepper">
          {steps.map((step) => (
            <button
              key={step.id}
              type="button"
              className={`flow-step ${step.state}`}
              onClick={() => document.getElementById(step.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              {step.state === "done" ? "✓ " : step.state === "attention" ? "! " : ""}
              {step.label}
            </button>
          ))}
        </nav>
        <details className="settings" open={!dataSpreadsheetId}>
          <summary>Settings</summary>
          <div className="form-grid">
            <label>
              Chat timestamp timezone
              <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                {timezoneOptions.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Data spreadsheet ID
              <input value={sheetDraft} onChange={(event) => setSheetDraft(event.target.value)} />
            </label>
            <button
              type="button"
              className="form-primary-action"
              disabled={!sheetDraft.trim() || sheetDraft.trim() === dataSpreadsheetId}
              onClick={() => {
                setDataSpreadsheetId(sheetDraft.trim());
                setProgress(EMPTY_PROGRESS);
              }}
            >
              Use this sheet
            </button>
          </div>
          <p className="hint">
            Weeks run Sunday to Saturday in UTC. Toons, Not4Gearing and admin bonuses are on the{" "}
            <Link to="/roster">Roster</Link> page; bosses, aliases and thresholds on <Link to="/admin">Admin</Link>.
          </p>
        </details>
      </section>

      {dataSpreadsheetId ? (
        <div key={dataSpreadsheetId} className="steps">
          <TimersStep
            weekStartUtcDate={weekStart}
            timezone={timezone}
            dataSpreadsheetId={dataSpreadsheetId}
            onWeekStartChange={changeWeek}
            onSaved={() => setRefreshKey((key) => key + 1)}
          />
          <LedgerSteps
            weekStart={weekStart}
            timezone={timezone}
            dataSpreadsheetId={dataSpreadsheetId}
            refreshKey={refreshKey}
            onWeekStartChange={changeWeek}
            onProgress={setProgress}
          />
        </div>
      ) : (
        <section className="card">
          <p>Enter the data spreadsheet ID in Settings above to get started.</p>
        </section>
      )}
    </main>
  );
}
