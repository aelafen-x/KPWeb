import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { StatusBanner } from "../components/StatusBanner";
import {
  SheetsClient,
  loadDataSheetSetupBundle,
  replaceTabRows
} from "../lib/sheets";
import { useAppContext } from "../store/AppContext";

type BossRow = {
  boss: string;
  points: string;
};

type AliasRow = {
  alias: string;
  canonical: string;
};

type ConfigRow = {
  key: string;
  value: string;
};

type AliasGroup = {
  canonical: string;
  entries: Array<{ index: number; row: AliasRow }>;
};

function sortBossRows(rows: BossRow[]): BossRow[] {
  return [...rows].sort((a, b) => a.boss.localeCompare(b.boss));
}

function sortAliasRows(rows: AliasRow[]): AliasRow[] {
  return [...rows].sort(
    (a, b) => a.canonical.localeCompare(b.canonical) || a.alias.localeCompare(b.alias)
  );
}

function sortConfigRows(rows: ConfigRow[]): ConfigRow[] {
  return [...rows].sort((a, b) => a.key.localeCompare(b.key));
}

function groupAliases(rows: AliasRow[]): AliasGroup[] {
  const groups = new Map<string, Array<{ index: number; row: AliasRow }>>();
  rows.forEach((row, index) => {
    const key = row.canonical || "(Unassigned)";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push({ index, row });
  });
  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([canonical, entries]) => ({
      canonical,
      entries: [...entries].sort((x, y) => x.row.alias.localeCompare(y.row.alias))
    }));
}

export function AdminPage(): JSX.Element {
  const { auth, setup } = useAppContext();
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [bosses, setBosses] = useState<BossRow[]>([]);
  const [bossAliases, setBossAliases] = useState<AliasRow[]>([]);
  const [nameAliases, setNameAliases] = useState<AliasRow[]>([]);
  const [configRows, setConfigRows] = useState<ConfigRow[]>([]);
  const [newBossAlias, setNewBossAlias] = useState<AliasRow>({ alias: "", canonical: "" });
  const [newNameAlias, setNewNameAlias] = useState<AliasRow>({ alias: "", canonical: "" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ensuredSheetsRef = useRef<Set<string>>(new Set());

  const groupedBossAliases = useMemo(() => groupAliases(bossAliases), [bossAliases]);
  const groupedNameAliases = useMemo(() => groupAliases(nameAliases), [nameAliases]);

  async function loadAdminData(): Promise<void> {
    if (!auth || !setup?.dataSpreadsheetId) {
      return;
    }
    const client = new SheetsClient(auth.accessToken);
    if (!ensuredSheetsRef.current.has(setup.dataSpreadsheetId)) {
      await client.ensureSchema(setup.dataSpreadsheetId);
      ensuredSheetsRef.current.add(setup.dataSpreadsheetId);
    }
    const loaded = await loadDataSheetSetupBundle(client, setup.dataSpreadsheetId);
    setAllowlist([...loaded.allowlist].sort((a, b) => a.localeCompare(b)));
    setBosses(sortBossRows(loaded.bosses.map((row) => ({ boss: row.boss, points: String(row.points) }))));
    setBossAliases(sortAliasRows(loaded.bossAliases));
    setNameAliases(sortAliasRows(loaded.nameAliases));
    setConfigRows(sortConfigRows(Object.entries(loaded.config).map(([key, value]) => ({ key, value }))));
  }

  useEffect(() => {
    loadAdminData().catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load admin data.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup?.dataSpreadsheetId, auth?.accessToken]);

  async function saveAll(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!auth || !setup?.dataSpreadsheetId) {
      setError("Missing auth or Data Spreadsheet ID.");
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const client = new SheetsClient(auth.accessToken);
      await Promise.all([
        replaceTabRows(
          client,
          setup.dataSpreadsheetId,
          "Allowlist",
          ["Email"],
          allowlist.filter(Boolean).map((email) => [email.trim().toLowerCase()])
        ),
        replaceTabRows(
          client,
          setup.dataSpreadsheetId,
          "Bosses",
          ["Boss", "Points"],
          bosses.filter((row) => row.boss.trim()).map((row) => [row.boss.trim(), row.points || "0"])
        ),
        replaceTabRows(
          client,
          setup.dataSpreadsheetId,
          "BossAliases",
          ["Alias", "Boss"],
          bossAliases
            .filter((row) => row.alias.trim() && row.canonical.trim())
            .map((row) => [row.alias.trim(), row.canonical.trim()])
        ),
        replaceTabRows(
          client,
          setup.dataSpreadsheetId,
          "NameAliases",
          ["Alias", "Name"],
          nameAliases
            .filter((row) => row.alias.trim() && row.canonical.trim())
            .map((row) => [row.alias.trim(), row.canonical.trim()])
        ),
        replaceTabRows(
          client,
          setup.dataSpreadsheetId,
          "Config",
          ["Key", "Value"],
          configRows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value.trim()])
        )
      ]);
      setStatus("Admin settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setBusy(false);
    }
  }

  if (!setup?.dataSpreadsheetId) {
    return (
      <main className="page">
        <AppHeader />
        <section className="card">
          <p>Data Spreadsheet ID is not configured. Return to the wizard setup first.</p>
          <Link to="/wizard">Back to Wizard</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <AppHeader />
      <StatusBanner status={status} error={error} onClearStatus={() => setStatus("")} />
      <section className="card">
        <h2>Admin Settings</h2>
        <p>Data Sheet: {setup.dataSpreadsheetId}</p>
        <form onSubmit={saveAll} className="admin-form">
          <details className="admin-section" open>
            <summary>Boss Points</summary>
            <div className="admin-table-head">
              <span>Boss</span>
              <span>Points</span>
              <span />
            </div>
            {bosses.map((row, idx) => (
              <div className="admin-table-row" key={`boss-${idx}`}>
                <input
                  value={row.boss}
                  onChange={(event) =>
                    setBosses((prev) => {
                      const next = [...prev];
                      next[idx] = { ...next[idx], boss: event.target.value };
                      return sortBossRows(next);
                    })
                  }
                  placeholder="Boss"
                />
                <input
                  type="number"
                  value={row.points}
                  onChange={(event) =>
                    setBosses((prev) => {
                      const next = [...prev];
                      next[idx] = { ...next[idx], points: event.target.value };
                      return sortBossRows(next);
                    })
                  }
                  placeholder="Points"
                />
                <button
                  type="button"
                  onClick={() =>
                    setBosses((prev) => sortBossRows(prev.filter((_, candidate) => candidate !== idx)))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setBosses((prev) => sortBossRows([...prev, { boss: "", points: "1" }]))}
            >
              Add Boss
            </button>
          </details>

          <details className="admin-section">
            <summary>Boss Aliases</summary>
            <div className="admin-table-row">
              <input
                value={newBossAlias.canonical}
                onChange={(event) => setNewBossAlias((prev) => ({ ...prev, canonical: event.target.value }))}
                placeholder="Boss (canonical)"
              />
              <input
                value={newBossAlias.alias}
                onChange={(event) => setNewBossAlias((prev) => ({ ...prev, alias: event.target.value }))}
                placeholder="Alias"
              />
              <button
                type="button"
                onClick={() => {
                  if (!newBossAlias.alias.trim() || !newBossAlias.canonical.trim()) {
                    return;
                  }
                  setBossAliases((prev) => sortAliasRows([...prev, newBossAlias]));
                  setNewBossAlias({ alias: "", canonical: "" });
                }}
              >
                Add Alias
              </button>
            </div>
            {groupedBossAliases.map((group) => (
              <details className="admin-subsection" key={`boss-group-${group.canonical}`}>
                <summary>
                  {group.canonical} ({group.entries.length})
                </summary>
                {group.entries.map(({ index, row }) => (
                  <div className="admin-table-row" key={`boss-alias-${group.canonical}-${index}`}>
                    <input
                      value={row.alias}
                      onChange={(event) =>
                        setBossAliases((prev) => {
                          const next = [...prev];
                          next[index] = { ...next[index], alias: event.target.value };
                          return sortAliasRows(next);
                        })
                      }
                      placeholder="Alias"
                    />
                    <input
                      value={row.canonical}
                      onChange={(event) =>
                        setBossAliases((prev) => {
                          const next = [...prev];
                          next[index] = { ...next[index], canonical: event.target.value };
                          return sortAliasRows(next);
                        })
                      }
                      placeholder="Canonical boss"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setBossAliases((prev) => sortAliasRows(prev.filter((_, candidate) => candidate !== index)))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setBossAliases((prev) =>
                      sortAliasRows([...prev, { alias: "", canonical: group.canonical }])
                    )
                  }
                >
                  Add Alias Under {group.canonical}
                </button>
              </details>
            ))}
          </details>

          <details className="admin-section">
            <summary>Name Aliases</summary>
            <div className="admin-table-row">
              <input
                value={newNameAlias.canonical}
                onChange={(event) => setNewNameAlias((prev) => ({ ...prev, canonical: event.target.value }))}
                placeholder="Name (canonical)"
              />
              <input
                value={newNameAlias.alias}
                onChange={(event) => setNewNameAlias((prev) => ({ ...prev, alias: event.target.value }))}
                placeholder="Alias"
              />
              <button
                type="button"
                onClick={() => {
                  if (!newNameAlias.alias.trim() || !newNameAlias.canonical.trim()) {
                    return;
                  }
                  setNameAliases((prev) => sortAliasRows([...prev, newNameAlias]));
                  setNewNameAlias({ alias: "", canonical: "" });
                }}
              >
                Add Alias
              </button>
            </div>
            {groupedNameAliases.map((group) => (
              <details className="admin-subsection" key={`name-group-${group.canonical}`}>
                <summary>
                  {group.canonical} ({group.entries.length})
                </summary>
                {group.entries.map(({ index, row }) => (
                  <div className="admin-table-row" key={`name-alias-${group.canonical}-${index}`}>
                    <input
                      value={row.alias}
                      onChange={(event) =>
                        setNameAliases((prev) => {
                          const next = [...prev];
                          next[index] = { ...next[index], alias: event.target.value };
                          return sortAliasRows(next);
                        })
                      }
                      placeholder="Alias"
                    />
                    <input
                      value={row.canonical}
                      onChange={(event) =>
                        setNameAliases((prev) => {
                          const next = [...prev];
                          next[index] = { ...next[index], canonical: event.target.value };
                          return sortAliasRows(next);
                        })
                      }
                      placeholder="Canonical name"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setNameAliases((prev) => sortAliasRows(prev.filter((_, candidate) => candidate !== index)))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setNameAliases((prev) =>
                      sortAliasRows([...prev, { alias: "", canonical: group.canonical }])
                    )
                  }
                >
                  Add Alias Under {group.canonical}
                </button>
              </details>
            ))}
          </details>

          <details className="admin-section">
            <summary>Allowlist Emails</summary>
            {allowlist.map((email, idx) => (
              <div className="admin-table-row" key={`allow-${idx}`}>
                <input
                  value={email}
                  onChange={(event) =>
                    setAllowlist((prev) => {
                      const next = [...prev];
                      next[idx] = event.target.value;
                      return [...next].sort((a, b) => a.localeCompare(b));
                    })
                  }
                  placeholder="user@example.com"
                />
                <span />
                <button
                  type="button"
                  onClick={() => setAllowlist((prev) => prev.filter((_, candidate) => candidate !== idx))}
                >
                  Remove
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setAllowlist((prev) => [...prev, ""])}>
              Add Email
            </button>
          </details>

          <details className="admin-section">
            <summary>Config</summary>
            <div className="admin-table-head">
              <span>Key</span>
              <span>Value</span>
              <span />
            </div>
            {configRows.map((row, idx) => (
              <div className="admin-table-row" key={`cfg-${idx}`}>
                <input
                  value={row.key}
                  onChange={(event) =>
                    setConfigRows((prev) => {
                      const next = [...prev];
                      next[idx] = { ...next[idx], key: event.target.value };
                      return sortConfigRows(next);
                    })
                  }
                  placeholder="Key"
                />
                <input
                  value={row.value}
                  onChange={(event) =>
                    setConfigRows((prev) => {
                      const next = [...prev];
                      next[idx] = { ...next[idx], value: event.target.value };
                      return sortConfigRows(next);
                    })
                  }
                  placeholder="Value"
                />
                <button
                  type="button"
                  onClick={() =>
                    setConfigRows((prev) => sortConfigRows(prev.filter((_, candidate) => candidate !== idx)))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setConfigRows((prev) => sortConfigRows([...prev, { key: "", value: "" }]))}
            >
              Add Config Row
            </button>
          </details>

          <button type="submit" disabled={busy}>
            Save All
          </button>
        </form>
      </section>
    </main>
  );
}
