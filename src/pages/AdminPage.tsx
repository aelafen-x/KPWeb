import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import {
  SheetsClient,
  loadAliases,
  loadAllowlistEmails,
  loadBosses,
  loadConfig,
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

export function AdminPage(): JSX.Element {
  const { auth, setup } = useAppContext();
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [bosses, setBosses] = useState<BossRow[]>([]);
  const [bossAliases, setBossAliases] = useState<AliasRow[]>([]);
  const [nameAliases, setNameAliases] = useState<AliasRow[]>([]);
  const [configRows, setConfigRows] = useState<ConfigRow[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadAdminData(): Promise<void> {
    if (!auth || !setup?.dataSpreadsheetId) {
      return;
    }
    const client = new SheetsClient(auth.accessToken);
    await client.ensureSchema(setup.dataSpreadsheetId);
    const [allow, loadedBosses, loadedBossAliases, loadedNameAliases, loadedConfig] = await Promise.all([
      loadAllowlistEmails(client, setup.dataSpreadsheetId),
      loadBosses(client, setup.dataSpreadsheetId),
      loadAliases(client, setup.dataSpreadsheetId, "BossAliases"),
      loadAliases(client, setup.dataSpreadsheetId, "NameAliases"),
      loadConfig(client, setup.dataSpreadsheetId)
    ]);
    setAllowlist(allow);
    setBosses(loadedBosses.map((row) => ({ boss: row.boss, points: String(row.points) })));
    setBossAliases(loadedBossAliases);
    setNameAliases(loadedNameAliases);
    setConfigRows(Object.entries(loadedConfig).map(([key, value]) => ({ key, value })));
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
      <section className="card">
        <h2>Admin Settings</h2>
        <p>Data Sheet: {setup.dataSpreadsheetId}</p>
        <form onSubmit={saveAll} className="stack">
          <h3>Allowlist Emails</h3>
          {allowlist.map((email, idx) => (
            <input
              key={`allow-${idx}`}
              value={email}
              onChange={(event) =>
                setAllowlist((prev) => prev.map((item, i) => (i === idx ? event.target.value : item)))
              }
              placeholder="user@example.com"
            />
          ))}
          <button type="button" onClick={() => setAllowlist((prev) => [...prev, ""])}>
            Add Email
          </button>

          <h3>Bosses</h3>
          {bosses.map((row, idx) => (
            <div className="actions-row" key={`boss-${idx}`}>
              <input
                value={row.boss}
                onChange={(event) =>
                  setBosses((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, boss: event.target.value } : item))
                  )
                }
                placeholder="Boss name"
              />
              <input
                type="number"
                value={row.points}
                onChange={(event) =>
                  setBosses((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, points: event.target.value } : item))
                  )
                }
              />
            </div>
          ))}
          <button type="button" onClick={() => setBosses((prev) => [...prev, { boss: "", points: "1" }])}>
            Add Boss
          </button>

          <h3>Boss Aliases</h3>
          {bossAliases.map((row, idx) => (
            <div className="actions-row" key={`ba-${idx}`}>
              <input
                value={row.alias}
                onChange={(event) =>
                  setBossAliases((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, alias: event.target.value } : item))
                  )
                }
                placeholder="Alias token"
              />
              <input
                value={row.canonical}
                onChange={(event) =>
                  setBossAliases((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, canonical: event.target.value } : item))
                  )
                }
                placeholder="Canonical boss"
              />
            </div>
          ))}
          <button type="button" onClick={() => setBossAliases((prev) => [...prev, { alias: "", canonical: "" }])}>
            Add Boss Alias
          </button>

          <h3>Name Aliases</h3>
          {nameAliases.map((row, idx) => (
            <div className="actions-row" key={`na-${idx}`}>
              <input
                value={row.alias}
                onChange={(event) =>
                  setNameAliases((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, alias: event.target.value } : item))
                  )
                }
                placeholder="Alias token"
              />
              <input
                value={row.canonical}
                onChange={(event) =>
                  setNameAliases((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, canonical: event.target.value } : item))
                  )
                }
                placeholder="Canonical user"
              />
            </div>
          ))}
          <button type="button" onClick={() => setNameAliases((prev) => [...prev, { alias: "", canonical: "" }])}>
            Add Name Alias
          </button>

          <h3>Config</h3>
          {configRows.map((row, idx) => (
            <div className="actions-row" key={`cfg-${idx}`}>
              <input
                value={row.key}
                onChange={(event) =>
                  setConfigRows((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, key: event.target.value } : item))
                  )
                }
                placeholder="Key"
              />
              <input
                value={row.value}
                onChange={(event) =>
                  setConfigRows((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, value: event.target.value } : item))
                  )
                }
                placeholder="Value"
              />
            </div>
          ))}
          <button type="button" onClick={() => setConfigRows((prev) => [...prev, { key: "", value: "" }])}>
            Add Config Row
          </button>

          <button type="submit" disabled={busy}>
            Save All
          </button>
        </form>
        {status ? <p className="status">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}

