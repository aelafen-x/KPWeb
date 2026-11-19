import { DateTime } from "luxon";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { StatusBanner } from "../components/StatusBanner";
import { CLASS_ORDER, GEAR_COLUMNS } from "../constants";
import { balancesAsOf, toonKey } from "../lib/ledger";
import type { LedgerBundle } from "../lib/ledgerStore";
import { loadLedgerBundle, readOldSpreadsheet, saveAdminBonus, saveRoster } from "../lib/ledgerStore";
import { normalizeKey } from "../lib/normalize";
import { emptyToon, parseNumber } from "../lib/roster";
import { SheetsClient, loadConfig, replaceTabRows } from "../lib/sheets";
import { toSunday } from "../lib/week";
import { useAppContext } from "../store/AppContext";
import type { AdminBonusRow, RosterToon, ToonStatus } from "../types";

type Tab = "Active" | "Not4Gearing" | "Admin";

const MAIN_ALT_OPTIONS = ["Main", "Alt", "Locker"];

function nextSunday(): string {
  return toSunday(DateTime.utc().plus({ days: 7 }).toISODate() || "");
}

export function RosterPage(): JSX.Element {
  const { auth, setup } = useAppContext();
  const dataSpreadsheetId = setup?.dataSpreadsheetId || "";
  const [bundle, setBundle] = useState<LedgerBundle | null>(null);
  const [roster, setRoster] = useState<RosterToon[]>([]);
  const [adminBonus, setAdminBonus] = useState<AdminBonusRow[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [adminDirty, setAdminDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("Active");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ index: number; draft: RosterToon } | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [startWeek, setStartWeek] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    if (!auth || !dataSpreadsheetId) {
      return;
    }
    const client = new SheetsClient(auth.accessToken);
    await client.ensureSchema(dataSpreadsheetId);
    const [loaded, loadedConfig] = await Promise.all([
      loadLedgerBundle(client, dataSpreadsheetId),
      loadConfig(client, dataSpreadsheetId)
    ]);
    setBundle(loaded);
    setRoster(loaded.roster);
    setAdminBonus(loaded.adminBonus);
    setConfig(loadedConfig);
    setSourceId(loadedConfig.dkp_source_spreadsheet_id || "");
    setStartWeek(loadedConfig.ledger_start_weekid || nextSunday());
    setDirty(false);
    setAdminDirty(false);
  }

  useEffect(() => {
    setBusy(true);
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load roster."))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.accessToken, dataSpreadsheetId]);

  const balances = useMemo(
    () => balancesAsOf(roster, bundle?.entries || [], "9999-12-31"),
    [roster, bundle?.entries]
  );
  const toonsWithHistory = useMemo(
    () => new Set([...(bundle?.entries || []), ...(bundle?.spends || [])].map((row) => toonKey(row.toon))),
    [bundle?.entries, bundle?.spends]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.status === tab)
      .filter(
        ({ row }) => !q || row.toon.toLowerCase().includes(q) || row.owner.toLowerCase().includes(q)
      )
      .sort((a, b) => a.row.owner.localeCompare(b.row.owner) || a.row.toon.localeCompare(b.row.toon));
  }, [roster, tab, query]);

  const activeCount = roster.filter((row) => row.status === "Active").length;
  const n4gCount = roster.length - activeCount;
  const owners = useMemo(
    () => [...new Set(roster.map((row) => row.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [roster]
  );

  async function saveConfigKeys(client: SheetsClient, updates: Record<string, string>): Promise<void> {
    const merged = { ...config, ...updates };
    await replaceTabRows(
      client,
      dataSpreadsheetId,
      "Config",
      ["Key", "Value"],
      Object.entries(merged)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, value]) => [key, value]),
      "RAW"
    );
    setConfig(merged);
  }

  async function runImport(): Promise<void> {
    if (!auth) {
      return;
    }
    const id = sourceId.trim();
    const weekId = toSunday(startWeek);
    if (!id || !weekId) {
      setError("Enter the DKP spreadsheet ID and the first week the app will close.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const client = new SheetsClient(auth.accessToken);
      const result = await readOldSpreadsheet(client, id);
      if (result.roster.length === 0) {
        throw new Error('No toons found. Check the spreadsheet ID and that it has "DKP Sheet" and "Not4Gearing" tabs.');
      }
      const closedWeeks = bundle?.ledgerWeeks.length || 0;
      const lines = [
        `Import ${result.activeCount} active toons, ${result.not4GearingCount} Not4Gearing toons and ${result.adminBonus.length} admin bonus rows?`,
        `Their current Total Earned/Spent become the opening balances, and the app takes over from the week of ${weekId}.`
      ];
      if (roster.length > 0) {
        lines.push(`This replaces the current roster of ${roster.length} toons.`);
      }
      if (closedWeeks > 0) {
        lines.push(
          `Warning: ${closedWeeks} week(s) are already closed in the app. Re-importing resets the opening balances, so those weeks will count twice unless the spreadsheet was taken from before them.`
        );
      }
      if (result.skippedDuplicates.length > 0) {
        lines.push(`Skipped duplicate toons: ${result.skippedDuplicates.join(", ")}`);
      }
      if (result.mergedNot4GearingRows > 0) {
        lines.push(
          `${result.mergedNot4GearingRows} repeat Not4Gearing rows were merged into one entry per toon (their notes are kept).`
        );
      }
      if (!window.confirm(lines.join("\n\n"))) {
        return;
      }
      await Promise.all([
        saveRoster(client, dataSpreadsheetId, result.roster),
        saveAdminBonus(client, dataSpreadsheetId, result.adminBonus)
      ]);
      await saveConfigKeys(client, { dkp_source_spreadsheet_id: id, ledger_start_weekid: weekId });
      await load();
      setStatus(`Imported ${result.roster.length} toons. The app now holds the DKP balances.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRosterChanges(): Promise<void> {
    if (!auth) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = new SheetsClient(auth.accessToken);
      await saveRoster(client, dataSpreadsheetId, roster);
      setDirty(false);
      setStatus("Roster saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save roster.");
    } finally {
      setBusy(false);
    }
  }

  async function saveAdminChanges(): Promise<void> {
    if (!auth) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = new SheetsClient(auth.accessToken);
      await saveAdminBonus(client, dataSpreadsheetId, adminBonus);
      setAdminDirty(false);
      setStatus("Admin bonus saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save admin bonus.");
    } finally {
      setBusy(false);
    }
  }

  function startAdd(): void {
    const draft = emptyToon(tab === "Not4Gearing" ? "Not4Gearing" : "Active");
    if (draft.status === "Not4Gearing") {
      draft.dateAdded = DateTime.local().toISODate() || "";
    }
    setEditing({ index: -1, draft });
  }

  function applyEdit(): void {
    if (!editing) {
      return;
    }
    const draft = { ...editing.draft, toon: editing.draft.toon.trim(), owner: editing.draft.owner.trim() };
    if (!draft.toon) {
      setError("Toon name is required.");
      return;
    }
    const clash = roster.findIndex(
      (row, index) => index !== editing.index && normalizeKey(row.toon) === normalizeKey(draft.toon)
    );
    if (clash !== -1) {
      setError(`${draft.toon} is already in the roster.`);
      return;
    }
    if (editing.index >= 0) {
      const original = roster[editing.index];
      if (normalizeKey(original.toon) !== normalizeKey(draft.toon) && toonsWithHistory.has(toonKey(original.toon))) {
        setError(
          `${original.toon} already has DKP history in closed weeks, so it can't be renamed. Add a name alias on the Admin page instead.`
        );
        return;
      }
    }
    setError("");
    setRoster((previous) => {
      const next = [...previous];
      if (editing.index >= 0) {
        next[editing.index] = draft;
      } else {
        next.push(draft);
      }
      return next;
    });
    setDirty(true);
    setEditing(null);
  }

  function moveToon(index: number, status: ToonStatus): void {
    setRoster((previous) => {
      const next = [...previous];
      const row = { ...next[index], status };
      if (status === "Not4Gearing" && !row.dateAdded) {
        row.dateAdded = DateTime.local().toISODate() || "";
      }
      next[index] = row;
      return next;
    });
    setDirty(true);
  }

  function deleteToon(index: number): void {
    const row = roster[index];
    if (toonsWithHistory.has(toonKey(row.toon))) {
      setError(`${row.toon} has DKP history in closed weeks. Move it to Not4Gearing instead of deleting it.`);
      return;
    }
    if (!window.confirm(`Remove ${row.toon} from the roster?`)) {
      return;
    }
    setRoster((previous) => previous.filter((_, candidate) => candidate !== index));
    setDirty(true);
  }

  function updateDraft(patch: Partial<RosterToon>): void {
    setEditing((previous) => (previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous));
  }

  function updateAdmin(index: number, patch: Partial<AdminBonusRow>): void {
    setAdminBonus((previous) => {
      const next = [...previous];
      next[index] = { ...next[index], ...patch };
      return next;
    });
    setAdminDirty(true);
  }

  if (!dataSpreadsheetId) {
    return (
      <main className="page">
        <AppHeader />
        <section className="card">
          <p>Data Spreadsheet ID is not configured. Return to the wizard setup first.</p>
          <Link to="/wizard">Go to Wizard</Link>
        </section>
      </main>
    );
  }

  const draft = editing?.draft;

  return (
    <main className="page">
      <AppHeader />
      <StatusBanner status={status} error={error} onClearStatus={() => setStatus("")} />

      <section className="card">
        <h2>Roster</h2>
        <p className="hint">
          The roster replaces the DKP Sheet, Not4Gearing and Admin tabs of the old spreadsheet. Balances shown are
          the opening balance plus every week closed in the app.
        </p>
        <details className="admin-section" open={roster.length === 0}>
          <summary>Import from the DKP spreadsheet</summary>
          <p className="hint">
            Reads the "DKP Sheet", "Not4Gearing" and "Admin" tabs once. Nothing is written to that spreadsheet. Import it
            right after the last week was posted from the spreadsheet, and pick the first week the app will close.
          </p>
          <div className="form-grid">
            <label>
              DKP spreadsheet ID
              <input value={sourceId} onChange={(event) => setSourceId(event.target.value)} />
            </label>
            <label>
              First week the app closes (Sunday)
              <input type="date" value={startWeek} onChange={(event) => setStartWeek(toSunday(event.target.value))} />
            </label>
            <button type="button" className="form-primary-action" onClick={runImport} disabled={busy}>
              Import roster and balances
            </button>
          </div>
          {config.ledger_start_weekid && (
            <p className="hint">App took over from the week of {config.ledger_start_weekid}.</p>
          )}
        </details>
      </section>

      <section className="card">
        <div className="tab-row">
          <button type="button" className={tab === "Active" ? "tab active" : "tab"} onClick={() => setTab("Active")}>
            Active ({activeCount})
          </button>
          <button
            type="button"
            className={tab === "Not4Gearing" ? "tab active" : "tab"}
            onClick={() => setTab("Not4Gearing")}
          >
            Not4Gearing ({n4gCount})
          </button>
          <button type="button" className={tab === "Admin" ? "tab active" : "tab"} onClick={() => setTab("Admin")}>
            Admin bonus ({adminBonus.length})
          </button>
        </div>

        {tab !== "Admin" ? (
          <>
            <div className="actions-row">
              <input placeholder="Filter by toon or owner..." value={query} onChange={(event) => setQuery(event.target.value)} />
              <button type="button" onClick={startAdd} disabled={busy}>
                Add toon
              </button>
              <button type="button" onClick={saveRosterChanges} disabled={busy || !dirty}>
                {dirty ? "Save roster changes" : "Roster saved"}
              </button>
            </div>

            {editing && draft && (
              <div className="edit-panel">
                <h3>{editing.index >= 0 ? `Edit ${roster[editing.index].toon}` : "Add toon"}</h3>
                <div className="form-grid">
                  <label>
                    Owner
                    <input list="roster-owners" value={draft.owner} onChange={(event) => updateDraft({ owner: event.target.value })} />
                  </label>
                  <label>
                    Toon
                    <input value={draft.toon} onChange={(event) => updateDraft({ toon: event.target.value })} />
                  </label>
                  <label>
                    M
                    <select value={draft.mainAlt} onChange={(event) => updateDraft({ mainAlt: event.target.value })}>
                      <option value="" />
                      {[...new Set([...MAIN_ALT_OPTIONS, draft.mainAlt].filter(Boolean))].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Class
                    <select value={draft.className} onChange={(event) => updateDraft({ className: event.target.value })}>
                      <option value="" />
                      {[...new Set([...CLASS_ORDER, draft.className].filter(Boolean))].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Level
                    <input value={draft.level} onChange={(event) => updateDraft({ level: event.target.value })} />
                  </label>
                  <label>
                    Status
                    <select
                      value={draft.status}
                      onChange={(event) => updateDraft({ status: event.target.value as ToonStatus })}
                    >
                      <option value="Active">Active</option>
                      <option value="Not4Gearing">Not4Gearing</option>
                    </select>
                  </label>
                  {GEAR_COLUMNS.map((column, index) => (
                    <label key={column}>
                      {column}
                      <input
                        value={draft.gear[index] || ""}
                        onChange={(event) => {
                          const gear = [...draft.gear];
                          gear[index] = event.target.value;
                          updateDraft({ gear });
                        }}
                      />
                    </label>
                  ))}
                  <label>
                    Pures Earned
                    <input value={draft.pures} onChange={(event) => updateDraft({ pures: event.target.value })} />
                  </label>
                  <label>
                    Opening earned
                    <input
                      type="number"
                      value={draft.openingEarned}
                      onChange={(event) => updateDraft({ openingEarned: parseNumber(event.target.value) })}
                    />
                  </label>
                  <label>
                    Opening spent
                    <input
                      type="number"
                      value={draft.openingSpent}
                      onChange={(event) => updateDraft({ openingSpent: parseNumber(event.target.value) })}
                    />
                  </label>
                  <label>
                    Date added
                    <input value={draft.dateAdded} onChange={(event) => updateDraft({ dateAdded: event.target.value })} />
                  </label>
                  <label className="wide">
                    Notes
                    <input value={draft.notes} onChange={(event) => updateDraft({ notes: event.target.value })} />
                  </label>
                </div>
                <p className="hint">
                  Opening earned/spent is the balance before the app took over. Changing it changes every week since.
                </p>
                <div className="actions-row">
                  <button type="button" onClick={applyEdit}>
                    Apply
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <datalist id="roster-owners">
              {owners.map((owner) => (
                <option key={owner} value={owner} />
              ))}
            </datalist>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>Toon</th>
                    <th>M</th>
                    <th>Class</th>
                    <th>Level</th>
                    {tab === "Active" ? (
                      <>
                        <th>Total Earned</th>
                        <th>Total Spent</th>
                        <th>Available</th>
                      </>
                    ) : (
                      <>
                        <th>Date Added</th>
                        <th>Notes</th>
                      </>
                    )}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={9}>{busy ? "Loading..." : "No toons."}</td>
                    </tr>
                  ) : (
                    visible.map(({ row, index }) => {
                      const balance = balances.get(toonKey(row.toon));
                      return (
                        <tr key={`${row.toon}-${index}`}>
                          <td>{row.owner}</td>
                          <td>{row.toon}</td>
                          <td>{row.mainAlt}</td>
                          <td>{row.className}</td>
                          <td>{row.level}</td>
                          {tab === "Active" ? (
                            <>
                              <td>{balance?.earned ?? 0}</td>
                              <td>{balance?.spent ?? 0}</td>
                              <td>{balance?.available ?? 0}</td>
                            </>
                          ) : (
                            <>
                              <td>{row.dateAdded}</td>
                              <td>{row.notes}</td>
                            </>
                          )}
                          <td className="row-actions">
                            <button type="button" onClick={() => setEditing({ index, draft: { ...row, gear: [...row.gear] } })}>
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => moveToon(index, row.status === "Active" ? "Not4Gearing" : "Active")}
                            >
                              {row.status === "Active" ? "To Not4Gearing" : "To Active"}
                            </button>
                            <button type="button" onClick={() => deleteToon(index)}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              Each week, the toon gets Lead DKP + Admin DKP added to Total Earned, but only if its owner is "A" that week.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>Toon that gets the DKP</th>
                    <th>Lead DKP</th>
                    <th>Admin DKP</th>
                    <th>Role</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {adminBonus.map((row, index) => (
                    <tr key={index}>
                      <td>
                        <input list="roster-owners" value={row.owner} onChange={(event) => updateAdmin(index, { owner: event.target.value })} />
                      </td>
                      <td>
                        <input list="roster-toons" value={row.toon} onChange={(event) => updateAdmin(index, { toon: event.target.value })} />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={row.leadDkp}
                          onChange={(event) => updateAdmin(index, { leadDkp: parseNumber(event.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={row.adminDkp}
                          onChange={(event) => updateAdmin(index, { adminDkp: parseNumber(event.target.value) })}
                        />
                      </td>
                      <td>
                        <input value={row.role} onChange={(event) => updateAdmin(index, { role: event.target.value })} />
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            setAdminBonus((previous) => previous.filter((_, candidate) => candidate !== index));
                            setAdminDirty(true);
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <datalist id="roster-owners">
              {owners.map((owner) => (
                <option key={owner} value={owner} />
              ))}
            </datalist>
            <datalist id="roster-toons">
              {roster.map((row) => (
                <option key={row.toon} value={row.toon} />
              ))}
            </datalist>
            <div className="actions-row">
              <button
                type="button"
                onClick={() => {
                  setAdminBonus((previous) => [...previous, { owner: "", toon: "", leadDkp: 0, adminDkp: 0, role: "" }]);
                  setAdminDirty(true);
                }}
              >
                Add row
              </button>
              <button type="button" onClick={saveAdminChanges} disabled={busy || !adminDirty}>
                {adminDirty ? "Save admin bonus" : "Admin bonus saved"}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
