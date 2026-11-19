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

export type ToonStatus = "Active" | "Not4Gearing";

export type RosterToon = {
  owner: string;
  toon: string;
  mainAlt: string;
  /** Free-text gear columns, in GEAR_COLUMNS order. */
  gear: string[];
  pures: string;
  className: string;
  level: string;
  status: ToonStatus;
  /** Total earned before the first week the app closed (imported from the old spreadsheet). */
  openingEarned: number;
  /** Total spent before the first week the app closed. */
  openingSpent: number;
  /** Owner activity ("A", "UA" or "") on the last spreadsheet update before the app took over. */
  openingActivity: string;
  dateAdded: string;
  notes: string;
};

export type AdminBonusRow = {
  owner: string;
  toon: string;
  leadDkp: number;
  adminDkp: number;
  role: string;
};

export type OwnerActivity = "A" | "UA" | "";

export type LedgerEntry = {
  weekId: string;
  toon: string;
  owner: string;
  newDkp: number;
  bonus: number;
  spent: number;
};

export type OwnerWeekActivity = {
  weekId: string;
  owner: string;
  activity: OwnerActivity;
  aPlus: boolean;
};

export type LedgerWeek = {
  weekId: string;
  closedUtc: string;
  auctionFile: string;
};

export type AuctionWin = {
  lineNumber: number;
  rawText: string;
  timestampRaw: string;
  timestampUtcMillis?: number;
  poster: string;
  toonRaw: string;
  toon?: string;
  amount: number;
  issues: ParseIssue[];
};

export type SpendRecord = {
  weekId: string;
  toon: string;
  amount: number;
  timestamp: string;
  poster: string;
  rawLine: string;
};
