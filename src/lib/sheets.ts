import { DEFAULT_CONFIG, SHEET_SCHEMAS } from "../constants";
import type { AliasRow, BossConfig, StoredWeek } from "../types";

type SpreadsheetMetadata = {
  sheets?: Array<{
    properties?: {
      title?: string;
      sheetId?: number;
    };
  }>;
};

type ValueRange = {
  range?: string;
  values?: string[][];
};

function encodeA1Part(value: string): string {
  return value.replace(/'/g, "''");
}

function a1(sheetName: string, range = "A:Z"): string {
  return `'${encodeA1Part(sheetName)}'!${range}`;
}

const DATA_SETUP_RANGES = {
  allowlist: a1("Allowlist", "A2:A"),
  bosses: a1("Bosses", "A2:B"),
  bossAliases: a1("BossAliases", "A2:B"),
  nameAliases: a1("NameAliases", "A2:B"),
  config: a1("Config", "A2:B"),
  weeks: a1("Weeks", "A2:G")
};

const WEEK_STORAGE_RANGES = {
  weeks: a1("Weeks", "A2:G"),
  totals: a1("WeekUserTotals", "A2:E"),
  breakdown: a1("WeekBossBreakdown", "A2:E")
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return null;
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503;
}

export class SheetsClient {
  constructor(private readonly accessToken: string) {}

  private async request<T>(url: string, init?: RequestInit, attempt = 0): Promise<T> {
    const method = (init?.method || "GET").toUpperCase();
    const canRetry = method === "GET";
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        ...(init?.headers || {})
      }
    });

    if (!response.ok && canRetry && shouldRetryStatus(response.status) && attempt < 4) {
      const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
      await response.text();
      const backoffMs =
        retryAfter !== null
          ? retryAfter * 1000
          : 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(backoffMs);
      return this.request<T>(url, init, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Sheets API error ${response.status}: ${text}`);
    }
    if (response.status === 204) {
      return {} as T;
    }
    return (await response.json()) as T;
  }

  async getSpreadsheetMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata> {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
    return this.request<SpreadsheetMetadata>(url);
  }

  async readRange(spreadsheetId: string, range: string): Promise<string[][]> {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    const payload = await this.request<{ values?: string[][] }>(url);
    return payload.values || [];
  }

  async batchReadRanges(spreadsheetId: string, ranges: string[]): Promise<Record<string, string[][]>> {
    if (ranges.length === 0) {
      return {};
    }
    const query = ranges.map((range) => `ranges=${encodeURIComponent(range)}`).join("&");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${query}`;
    const payload = await this.request<{ valueRanges?: ValueRange[] }>(url);
    const byRequestedRange: Record<string, string[][]> = {};
    const returned = payload.valueRanges || [];

    // Google may return expanded range strings (e.g. A2:A50), so map by request order first.
    for (let index = 0; index < ranges.length; index += 1) {
      byRequestedRange[ranges[index]] = returned[index]?.values || [];
    }

    return byRequestedRange;
  }

  async updateRange(spreadsheetId: string, range: string, values: string[][]): Promise<void> {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    await this.request(url, {
      method: "PUT",
      body: JSON.stringify({ range, values })
    });
  }

  async appendRange(spreadsheetId: string, range: string, values: string[][]): Promise<void> {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
    await this.request(url, {
      method: "POST",
      body: JSON.stringify({ values })
    });
  }

  async clearRange(spreadsheetId: string, range: string): Promise<void> {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`;
    await this.request(url, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async batchUpdate(spreadsheetId: string, body: unknown): Promise<void> {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    await this.request(url, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async batchUpdateValues(
    spreadsheetId: string,
    data: Array<{
      range: string;
      values: string[][];
    }>
  ): Promise<void> {
    if (data.length === 0) {
      return;
    }
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
    await this.request(url, {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data
      })
    });
  }

  async ensureSchema(spreadsheetId: string): Promise<void> {
    const metadata = await this.getSpreadsheetMetadata(spreadsheetId);
    const existing = new Set((metadata.sheets || []).map((sheet) => sheet.properties?.title || ""));

    const addRequests = SHEET_SCHEMAS.filter((schema) => !existing.has(schema.name)).map((schema) => ({
      addSheet: {
        properties: {
          title: schema.name
        }
      }
    }));

    if (addRequests.length > 0) {
      await this.batchUpdate(spreadsheetId, { requests: addRequests });
    }

    const headerRanges = SHEET_SCHEMAS.map((schema) => a1(schema.name, "1:1"));
    const allReads = await this.batchReadRanges(spreadsheetId, [...headerRanges, DATA_SETUP_RANGES.config]);
    const headerUpdates: Array<{ range: string; values: string[][] }> = [];

    for (const schema of SHEET_SCHEMAS) {
      const headerValues = allReads[a1(schema.name, "1:1")] || [];
      const firstRow = headerValues[0] || [];
      const hasValues = firstRow.some((cell) => cell.trim() !== "");
      if (!hasValues) {
        headerUpdates.push({
          range: a1(schema.name, "A1"),
          values: [schema.headers]
        });
      }
    }
    await this.batchUpdateValues(spreadsheetId, headerUpdates);

    const existingConfig = allReads[DATA_SETUP_RANGES.config] || [];
    const keys = new Set(existingConfig.map((row) => row[0]).filter(Boolean));
    const missingEntries = Object.entries(DEFAULT_CONFIG).filter(([key]) => !keys.has(key));
    if (missingEntries.length > 0) {
      await this.appendRange(
        spreadsheetId,
        a1("Config", "A2"),
        missingEntries.map(([key, value]) => [key, value])
      );
    }
  }
}

function parseAllowlistRows(rows: string[][]): string[] {
  return rows
    .map((row) => (row[0] || "").trim().toLowerCase())
    .filter(Boolean);
}

function parseUsersRows(rows: string[][]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const cell of row) {
      const value = (cell || "").trim();
      if (value) {
        out.push(value);
      }
    }
  }
  return out;
}

function parseBossRows(rows: string[][]): BossConfig[] {
  return rows
    .filter((row) => row[0])
    .map((row) => ({ boss: row[0].trim(), points: Number(row[1] || 0) }));
}

function parseAliasRows(rows: string[][]): AliasRow[] {
  return rows
    .filter((row) => row[0] && row[1])
    .map((row) => ({ alias: row[0].trim(), canonical: row[1].trim() }));
}

function parseConfigRows(rows: string[][]): Record<string, string> {
  const config = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    if (!row[0]) {
      continue;
    }
    config[row[0].trim()] = (row[1] || "").trim();
  }
  return config;
}

function parseWeeksRows(rows: string[][]): StoredWeek[] {
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      weekId: row[0] || "",
      startUtc: row[1] || "",
      endUtc: row[2] || "",
      timezone: row[3] || "",
      sourceFileName: row[4] || "",
      createdUtc: row[5] || "",
      notes: row[6] || ""
    }));
}

export type DataSheetSetupBundle = {
  allowlist: string[];
  bosses: BossConfig[];
  bossAliases: AliasRow[];
  nameAliases: AliasRow[];
  config: Record<string, string>;
  weeks: StoredWeek[];
};

export type SetupBundle = DataSheetSetupBundle & {
  users: string[];
};

export async function loadDataSheetSetupBundle(
  client: SheetsClient,
  dataSpreadsheetId: string
): Promise<DataSheetSetupBundle> {
  const ranges = Object.values(DATA_SETUP_RANGES);
  const byRange = await client.batchReadRanges(dataSpreadsheetId, ranges);
  return {
    allowlist: parseAllowlistRows(byRange[DATA_SETUP_RANGES.allowlist] || []),
    bosses: parseBossRows(byRange[DATA_SETUP_RANGES.bosses] || []),
    bossAliases: parseAliasRows(byRange[DATA_SETUP_RANGES.bossAliases] || []),
    nameAliases: parseAliasRows(byRange[DATA_SETUP_RANGES.nameAliases] || []),
    config: parseConfigRows(byRange[DATA_SETUP_RANGES.config] || []),
    weeks: parseWeeksRows(byRange[DATA_SETUP_RANGES.weeks] || [])
  };
}

export async function loadSetupBundle(
  client: SheetsClient,
  usersSpreadsheetId: string,
  usersRange: string,
  dataSpreadsheetId: string
): Promise<SetupBundle> {
  const [usersRows, dataBundle] = await Promise.all([
    client.readRange(usersSpreadsheetId, usersRange),
    loadDataSheetSetupBundle(client, dataSpreadsheetId)
  ]);
  return {
    ...dataBundle,
    users: parseUsersRows(usersRows)
  };
}

export async function loadWeekStorageBundle(
  client: SheetsClient,
  dataSpreadsheetId: string
): Promise<{
  weeks: StoredWeek[];
  totalsRaw: string[][];
  breakdownRaw: string[][];
}> {
  const ranges = Object.values(WEEK_STORAGE_RANGES);
  const byRange = await client.batchReadRanges(dataSpreadsheetId, ranges);
  return {
    weeks: parseWeeksRows(byRange[WEEK_STORAGE_RANGES.weeks] || []),
    totalsRaw: byRange[WEEK_STORAGE_RANGES.totals] || [],
    breakdownRaw: byRange[WEEK_STORAGE_RANGES.breakdown] || []
  };
}

export async function loadAllowlistEmails(client: SheetsClient, dataSpreadsheetId: string): Promise<string[]> {
  const rows = await client.readRange(dataSpreadsheetId, a1("Allowlist", "A2:A"));
  return parseAllowlistRows(rows);
}

export async function loadUsersFromRange(
  client: SheetsClient,
  usersSpreadsheetId: string,
  usersRange: string
): Promise<string[]> {
  const rows = await client.readRange(usersSpreadsheetId, usersRange);
  return parseUsersRows(rows);
}

export async function loadBosses(client: SheetsClient, dataSpreadsheetId: string): Promise<BossConfig[]> {
  const rows = await client.readRange(dataSpreadsheetId, a1("Bosses", "A2:B"));
  return parseBossRows(rows);
}

export async function loadAliases(
  client: SheetsClient,
  dataSpreadsheetId: string,
  tab: "BossAliases" | "NameAliases"
): Promise<AliasRow[]> {
  const rows = await client.readRange(dataSpreadsheetId, a1(tab, "A2:B"));
  return parseAliasRows(rows);
}

export async function loadConfig(client: SheetsClient, dataSpreadsheetId: string): Promise<Record<string, string>> {
  const rows = await client.readRange(dataSpreadsheetId, a1("Config", "A2:B"));
  return parseConfigRows(rows);
}

export async function loadWeeks(client: SheetsClient, dataSpreadsheetId: string): Promise<StoredWeek[]> {
  const rows = await client.readRange(dataSpreadsheetId, a1("Weeks", "A2:G"));
  return parseWeeksRows(rows);
}

export async function loadWeekUserTotalsRaw(
  client: SheetsClient,
  dataSpreadsheetId: string
): Promise<string[][]> {
  return client.readRange(dataSpreadsheetId, a1("WeekUserTotals", "A2:E"));
}

export async function loadWeekBossBreakdownRaw(
  client: SheetsClient,
  dataSpreadsheetId: string
): Promise<string[][]> {
  return client.readRange(dataSpreadsheetId, a1("WeekBossBreakdown", "A2:E"));
}

export async function replaceTabRows(
  client: SheetsClient,
  dataSpreadsheetId: string,
  tabName: string,
  headers: string[],
  rows: string[][]
): Promise<void> {
  await client.clearRange(dataSpreadsheetId, a1(tabName, "A:Z"));
  await client.updateRange(dataSpreadsheetId, a1(tabName, "A1"), [headers, ...rows]);
}

export async function appendRows(
  client: SheetsClient,
  dataSpreadsheetId: string,
  tabName: string,
  rows: string[][]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await client.appendRange(dataSpreadsheetId, a1(tabName, "A2"), rows);
}
