export type TabSchema = {
  name: string;
  headers: string[];
};

export type AuthState = {
  email: string;
  accessToken: string;
};

export type WizardSetup = {
  weekStartUtcDate: string;
  timezone: string;
  usersSpreadsheetId: string;
  usersRange: string;
  dataSpreadsheetId: string;
};

export type BossConfig = {
  boss: string;
  points: number;
};

export type AliasRow = {
  alias: string;
  canonical: string;
};

export type ParseIssueType =
  | "UnsupportedFormat"
  | "UnknownBoss"
  | "UnknownName"
  | "MultipleNotTokens"
  | "InvalidTimestamp"
  | "UnknownModifier";

export type ParseIssue = {
  type: ParseIssueType;
  token?: string;
  message: string;
};

export type ParsedLine = {
  lineNumber: number;
  rawText: string;
  timestampRaw?: string;
  timestampUtcMillis?: number;
  author?: string;
  bossRaw?: string;
  bossCanonical?: string;
  pointsBonus: number;
  pointsMultiplier: number;
  addNames: string[];
  subtractNames: string[];
  issues: ParseIssue[];
};

export type WeekSummaryRow = {
  name: string;
  totalPoints: number;
  activityLevel: string;
  streak: number;
  last3WeeksTotal: number;
  bossPoints: Record<string, number>;
  bossCounts: Record<string, number>;
};

export type WeekBounds = {
  startUtcMillis: number;
  endUtcMillis: number;
};

export type StoredWeek = {
  weekId: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
  sourceFileName: string;
  createdUtc: string;
  notes: string;
};
