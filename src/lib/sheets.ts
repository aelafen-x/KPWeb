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

function encodeA1Part(value: string): string {
  return value.replace(/'/g, "''");
}

function a1(sheetName: string, range = "A:Z"): string {
  return `'${encodeA1Part(sheetName)}'!${range}`;
}

export class SheetsClient {
  constructor(private readonly accessToken: string) {}

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        ...(init?.headers || {})
      }
    });
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

    for (const schema of SHEET_SCHEMAS) {
      const headerValues = await this.readRange(spreadsheetId, a1(schema.name, "1:1"));
      const firstRow = headerValues[0] || [];
      const hasValues = firstRow.some((cell) => cell.trim() !== "");
      if (!hasValues) {
        await this.updateRange(spreadsheetId, a1(schema.name, "A1"), [schema.headers]);
      }
    }

    const existingConfig = await this.readRange(spreadsheetId, a1("Config", "A2:B"));
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

export async function loadAllowlistEmails(client: SheetsClient, dataSpreadsheetId: string): Promise<string[]> {
  const rows = await client.readRange(dataSpreadsheetId, a1("Allowlist", "A2:A"));
  return rows
    .map((row) => (row[0] || "").trim().toLowerCase())
    .filter(Boolean);
}

export async function loadUsersFromRange(
  client: SheetsClient,
  usersSpreadsheetId: string,
  usersRange: string
): Promise<string[]> {
  const rows = await client.readRange(usersSpreadsheetId, usersRange);
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

export async function loadBosses(client: SheetsClient, dataSpreadsheetId: string): Promise<BossConfig[]> {
  const rows = await client.readRange(dataSpreadsheetId, a1("Bosses", "A2:B"));
  return rows
    .filter((row) => row[0])
    .map((row) => ({ boss: row[0].trim(), points: Number(row[1] || 0) }));
}

export async function loadAliases(
  client: SheetsClient,
  dataSpreadsheetId: string,
  tab: "BossAliases" | "NameAliases"
): Promise<AliasRow[]> {
  const rows = await client.readRange(dataSpreadsheetId, a1(tab, "A2:B"));
  return rows
    .filter((row) => row[0] && row[1])
    .map((row) => ({ alias: row[0].trim(), canonical: row[1].trim() }));
}

export async function loadConfig(client: SheetsClient, dataSpreadsheetId: string): Promise<Record<string, string>> {
  const rows = await client.readRange(dataSpreadsheetId, a1("Config", "A2:B"));
  const config = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    if (!row[0]) {
      continue;
    }
    config[row[0].trim()] = (row[1] || "").trim();
  }
  return config;
}

export async function loadWeeks(client: SheetsClient, dataSpreadsheetId: string): Promise<StoredWeek[]> {
  const rows = await client.readRange(dataSpreadsheetId, a1("Weeks", "A2:G"));
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
