import { DateTime } from "luxon";
import type { ParsedLine, ParseIssue } from "../types";
import { dedupePreserveOrder, normalizeBossKey, normalizeKey, splitWords } from "./normalize";

type ParserLookup = {
  usersByKey: Map<string, string>;
  bossesByKey: Map<string, { boss: string; points: number }>;
  nameAliasByKey: Map<string, string>;
  bossAliasByKey: Map<string, string>;
};

const OLD_FORMAT_REGEX = /^\s*([A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} (?:AM|PM|am|pm)):\s*(.+)$/;
const NEW_FORMAT_REGEX = /^\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+at\s+\d{1,2}:\d{2}(?:\s*(?:AM|PM|am|pm))?)\s+(.+?)\s*$/i;
const OLD_TIMESTAMP_FORMATS = ["LLLL d, yyyy h:mm a", "LLL d, yyyy h:mm a"];
const NEW_TIMESTAMP_FORMATS = [
  "d LLL yyyy 'at' H:mm",
  "d LLL yyyy 'at' HH:mm",
  "d LLL yyyy 'at' h:mm a",
  "d LLLL yyyy 'at' H:mm",
  "d LLLL yyyy 'at' HH:mm",
  "d LLLL yyyy 'at' h:mm a"
];
const MODIFIER_SYNONYMS: Record<string, "bonus5" | "half" | "double"> = {
  brucy: "bonus5",
  brucybonus: "bonus5",
  fail: "half",
  comp: "half",
  double: "double",
  doublepoints: "double"
};

export function isTimestampLineStart(rawText: string): boolean {
  return OLD_FORMAT_REGEX.test(rawText) || NEW_FORMAT_REGEX.test(rawText);
}

export function createParserLookup(
  canonicalUsers: string[],
  bosses: Array<{ boss: string; points: number }>,
  nameAliases: Array<{ alias: string; canonical: string }>,
  bossAliases: Array<{ alias: string; canonical: string }>
): ParserLookup {
  const usersByKey = new Map<string, string>();
  for (const user of canonicalUsers) {
    usersByKey.set(normalizeKey(user), user);
  }

  const bossesByKey = new Map<string, { boss: string; points: number }>();
  for (const boss of bosses) {
    bossesByKey.set(normalizeBossKey(boss.boss), boss);
  }

  const nameAliasByKey = new Map<string, string>();
  for (const row of nameAliases) {
    nameAliasByKey.set(normalizeKey(row.alias), row.canonical);
  }

  const bossAliasByKey = new Map<string, string>();
  for (const row of bossAliases) {
    bossAliasByKey.set(normalizeBossKey(row.alias), row.canonical);
  }

  return {
    usersByKey,
    bossesByKey,
    nameAliasByKey,
    bossAliasByKey
  };
}

function parseTimestampToUtcMillis(
  timestampRaw: string,
  timezone: string,
  formats: string[]
): number | undefined {
  for (const format of formats) {
    const parsed = DateTime.fromFormat(timestampRaw, format, {
      zone: timezone,
      locale: "en"
    });
    if (parsed.isValid) {
      return parsed.toUTC().toMillis();
    }
  }
  return undefined;
}

function resolveName(token: string, lookup: ParserLookup): { canonical?: string; issue?: ParseIssue } {
  const key = normalizeKey(token);
  if (!key) {
    return { issue: { type: "UnknownName", token, message: "Empty name token" } };
  }
  const aliasResolved = lookup.nameAliasByKey.get(key) || token;
  const canonical = lookup.usersByKey.get(normalizeKey(aliasResolved));
  if (!canonical) {
    return {
      issue: {
        type: "UnknownName",
        token,
        message: `Unknown name: ${token}`
      }
    };
  }
  return { canonical };
}

function resolveBoss(
  token: string,
  lookup: ParserLookup
): { canonical?: string; points?: number; issue?: ParseIssue } {
  const key = normalizeBossKey(token);
  if (!key) {
    return { issue: { type: "UnknownBoss", token, message: "Empty boss token" } };
  }
  const aliasResolved = lookup.bossAliasByKey.get(key) || token;
  const boss = lookup.bossesByKey.get(normalizeBossKey(aliasResolved));
  if (!boss) {
    return {
      issue: {
        type: "UnknownBoss",
        token,
        message: `Unknown boss token: ${token}`
      }
    };
  }
  return { canonical: boss.boss, points: boss.points };
}

function looksBossLikeToken(token: string): boolean {
  const key = normalizeBossKey(token);
  if (!key) {
    return false;
  }
  if (key.startsWith("/")) {
    return true;
  }
  return /^\d+(?:\.\d+)?$/.test(key);
}

function stripBossToken(token: string): string {
  return token.replace(/\([^)]*\)/g, "").trim();
}

function applyBossModifiers(
  rawBossToken: string,
  parsed: ParsedLine,
  issues: ParseIssue[]
): string {
  const modifierMatches = Array.from(rawBossToken.matchAll(/\(([^)]*)\)/g));
  const bossToken = stripBossToken(rawBossToken);
  if (modifierMatches.length === 0) {
    return bossToken;
  }

  const canonicalModifiers = new Set<"bonus5" | "half" | "double">();
  for (const match of modifierMatches) {
    const content = (match[1] || "").trim().toLowerCase();
    const tokens = content
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const token of tokens) {
      const canonical = MODIFIER_SYNONYMS[token];
      if (!canonical) {
        issues.push({
          type: "UnknownModifier",
          token,
          message: `Unknown boss modifier: ${token}`
        });
        continue;
      }
      canonicalModifiers.add(canonical);
    }
  }

  if (canonicalModifiers.has("bonus5")) {
    parsed.pointsBonus += 5;
  }
  if (canonicalModifiers.has("half")) {
    parsed.pointsMultiplier *= 0.5;
  }
  if (canonicalModifiers.has("double")) {
    parsed.pointsMultiplier *= 2;
  }

  return bossToken;
}

function applyNamesWithNotRule(
  nameTokens: string[],
  lookup: ParserLookup,
  issues: ParseIssue[]
): { addNames: string[]; subtractNames: string[] } {
  const notIndexes = nameTokens
    .map((token, index) => ({ token, index }))
    .filter((entry) => entry.token.toLowerCase() === "not")
    .map((entry) => entry.index);

  if (notIndexes.length > 1) {
    issues.push({
      type: "MultipleNotTokens",
      message: "More than one NOT token found in a single line."
    });
  }

  const splitAt = notIndexes.length === 1 ? notIndexes[0] : -1;
  const addTokens = splitAt === -1 ? nameTokens : nameTokens.slice(0, splitAt);
  const subtractTokens = splitAt === -1 ? [] : nameTokens.slice(splitAt + 1);

  const addNames: string[] = [];
  for (const token of addTokens) {
    const resolved = resolveName(token, lookup);
    if (resolved.issue) {
      issues.push(resolved.issue);
      continue;
    }
    addNames.push(resolved.canonical!);
  }

  const subtractNames: string[] = [];
  for (const token of subtractTokens) {
    const resolved = resolveName(token, lookup);
    if (resolved.issue) {
      issues.push(resolved.issue);
      continue;
    }
    subtractNames.push(resolved.canonical!);
  }

  const dedupedAdd = dedupePreserveOrder(addNames);
  const dedupedSubtract = dedupePreserveOrder(subtractNames);
  const addSet = new Set(dedupedAdd.map((name) => normalizeKey(name)));
  const subtractSet = new Set(dedupedSubtract.map((name) => normalizeKey(name)));
  const overlap = new Set<string>();
  for (const key of addSet) {
    if (subtractSet.has(key)) {
      overlap.add(key);
    }
  }
  return {
    addNames: dedupedAdd.filter((name) => !overlap.has(normalizeKey(name))),
    subtractNames: dedupedSubtract.filter((name) => !overlap.has(normalizeKey(name)))
  };
}

function applyBossAndNames(
  parsed: ParsedLine,
  bossTokenRaw: string,
  nameTokens: string[],
  lookup: ParserLookup,
  issues: ParseIssue[]
): void {
  const bossToken = applyBossModifiers(bossTokenRaw, parsed, issues);
  parsed.bossRaw = bossToken;

  const bossResolved = resolveBoss(bossToken, lookup);
  if (bossResolved.issue) {
    issues.push(bossResolved.issue);
  } else {
    parsed.bossCanonical = bossResolved.canonical;
  }

  const { addNames, subtractNames } = applyNamesWithNotRule(nameTokens, lookup, issues);
  parsed.addNames = addNames;
  parsed.subtractNames = subtractNames;
}

function parseOldFormatLine(
  parsed: ParsedLine,
  timezone: string,
  lookup: ParserLookup,
  issues: ParseIssue[],
  match: RegExpMatchArray
): ParsedLine {
  const timestampRaw = match[1];
  const remainder = match[2];
  parsed.timestampRaw = timestampRaw;

  const timestampUtcMillis = parseTimestampToUtcMillis(timestampRaw, timezone, OLD_TIMESTAMP_FORMATS);
  if (timestampUtcMillis === undefined) {
    issues.push({
      type: "InvalidTimestamp",
      message: `Unable to parse timestamp with timezone ${timezone}.`
    });
  } else {
    parsed.timestampUtcMillis = timestampUtcMillis;
  }

  const splitIndex = remainder.indexOf(":");
  if (splitIndex === -1) {
    issues.push({
      type: "UnsupportedFormat",
      message: "Missing second ':' separator for author and payload."
    });
    return parsed;
  }

  parsed.author = remainder.slice(0, splitIndex).trim();
  const payload = remainder.slice(splitIndex + 1).trim();
  const words = splitWords(payload);
  if (words.length === 0) {
    issues.push({
      type: "UnsupportedFormat",
      message: "Payload is empty."
    });
    return parsed;
  }

  applyBossAndNames(parsed, words[0], words.slice(1), lookup, issues);
  return parsed;
}

function isLikelyNameTailToken(token: string, lookup: ParserLookup): boolean {
  if (token.toLowerCase() === "not") {
    return true;
  }
  if (resolveName(token, lookup).canonical) {
    return true;
  }
  return !looksBossLikeToken(stripBossToken(token));
}

function isBossCandidateToken(token: string, lookup: ParserLookup): boolean {
  const cleanToken = stripBossToken(token);
  const key = normalizeBossKey(cleanToken);
  if (!key) {
    return false;
  }
  if (lookup.bossAliasByKey.has(key) || lookup.bossesByKey.has(key)) {
    return true;
  }
  return looksBossLikeToken(cleanToken);
}

function chooseBossIndexForNewFormat(tokens: string[], lookup: ParserLookup): number {
  const candidates: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (isBossCandidateToken(tokens[index], lookup)) {
      candidates.push(index);
    }
  }
  if (candidates.length === 0) {
    return -1;
  }

  let tailStart = tokens.length;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (isLikelyNameTailToken(tokens[index], lookup)) {
      tailStart = index;
      continue;
    }
    break;
  }

  const beforeTail = candidates.filter((index) => index < tailStart);
  if (beforeTail.length > 0) {
    return beforeTail[beforeTail.length - 1];
  }
  return candidates[candidates.length - 1];
}

function parseNewFormatLine(
  parsed: ParsedLine,
  timezone: string,
  lookup: ParserLookup,
  issues: ParseIssue[],
  match: RegExpMatchArray
): ParsedLine {
  const timestampRaw = match[1].trim();
  const tail = match[2].trim();
  parsed.timestampRaw = timestampRaw;

  const timestampUtcMillis = parseTimestampToUtcMillis(timestampRaw, timezone, NEW_TIMESTAMP_FORMATS);
  if (timestampUtcMillis === undefined) {
    issues.push({
      type: "InvalidTimestamp",
      message: `Unable to parse timestamp with timezone ${timezone}.`
    });
  } else {
    parsed.timestampUtcMillis = timestampUtcMillis;
  }

  const words = splitWords(tail);
  if (words.length === 0) {
    issues.push({
      type: "UnsupportedFormat",
      message: "Payload is empty."
    });
    return parsed;
  }

  const bossIndex = chooseBossIndexForNewFormat(words, lookup);
  if (bossIndex === -1) {
    issues.push({
      type: "UnsupportedFormat",
      message: "Unable to determine boss token in alternate format."
    });
    return parsed;
  }

  parsed.author = words.slice(0, bossIndex).join(" ").trim();
  applyBossAndNames(parsed, words[bossIndex], words.slice(bossIndex + 1), lookup, issues);
  return parsed;
}

export function parseLine(
  rawText: string,
  lineNumber: number,
  timezone: string,
  lookup: ParserLookup
): ParsedLine {
  const issues: ParseIssue[] = [];
  const parsed: ParsedLine = {
    lineNumber,
    rawText,
    pointsBonus: 0,
    pointsMultiplier: 1,
    addNames: [],
    subtractNames: [],
    issues
  };

  const oldMatch = rawText.match(OLD_FORMAT_REGEX);
  if (oldMatch) {
    return parseOldFormatLine(parsed, timezone, lookup, issues, oldMatch);
  }

  const newMatch = rawText.match(NEW_FORMAT_REGEX);
  if (newMatch) {
    return parseNewFormatLine(parsed, timezone, lookup, issues, newMatch);
  }

  issues.push({
    type: "UnsupportedFormat",
    message: "Line does not match supported old or alternate BAND export formats."
  });

  return parsed;
}
