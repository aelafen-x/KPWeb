import { DateTime } from "luxon";
import type { ParsedLine, ParseIssue } from "../types";
import { dedupePreserveOrder, normalizeBossKey, normalizeKey, splitWords } from "./normalize";

type ParserLookup = {
  usersByKey: Map<string, string>;
  bossesByKey: Map<string, { boss: string; points: number }>;
  nameAliasByKey: Map<string, string>;
  bossAliasByKey: Map<string, string>;
};

const TIMESTAMP_REGEX = /^\s*([A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} (?:AM|PM)):\s*(.+)$/;
const MODIFIER_SYNONYMS: Record<string, "bonus5" | "half" | "double"> = {
  brucy: "bonus5",
  brucybonus: "bonus5",
  fail: "half",
  comp: "half",
  double: "double",
  doublepoints: "double"
};

export function isTimestampLineStart(rawText: string): boolean {
  return TIMESTAMP_REGEX.test(rawText);
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

function parseTimestampToUtcMillis(timestampRaw: string, timezone: string): number | undefined {
  const parsed = DateTime.fromFormat(timestampRaw, "LLLL d, yyyy h:mm a", { zone: timezone });
  if (!parsed.isValid) {
    return undefined;
  }
  return parsed.toUTC().toMillis();
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

  const firstMatch = rawText.match(TIMESTAMP_REGEX);
  if (!firstMatch) {
    issues.push({
      type: "UnsupportedFormat",
      message: "Line does not match expected timestamp:author:payload format."
    });
    return parsed;
  }

  const timestampRaw = firstMatch[1];
  const remainder = firstMatch[2];
  parsed.timestampRaw = timestampRaw;

  const timestampUtcMillis = parseTimestampToUtcMillis(timestampRaw, timezone);
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

  const author = remainder.slice(0, splitIndex).trim();
  const payload = remainder.slice(splitIndex + 1).trim();
  parsed.author = author;

  const words = splitWords(payload);
  if (words.length === 0) {
    issues.push({
      type: "UnsupportedFormat",
      message: "Payload is empty."
    });
    return parsed;
  }

  const bossTokenRaw = words[0];
  const modifierMatches = Array.from(bossTokenRaw.matchAll(/\(([^)]*)\)/g));
  const bossToken = bossTokenRaw.replace(/\([^)]*\)/g, "").trim();
  parsed.bossRaw = bossToken;

  if (modifierMatches.length > 0) {
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
  }

  const bossResolved = resolveBoss(bossToken, lookup);
  if (bossResolved.issue) {
    issues.push(bossResolved.issue);
  } else {
    parsed.bossCanonical = bossResolved.canonical;
  }

  const nameTokens = words.slice(1);
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
  const subtractSet = new Set(dedupedSubtract.map((name) => normalizeKey(name)));
  parsed.addNames = dedupedAdd.filter((name) => !subtractSet.has(normalizeKey(name)));
  parsed.subtractNames = dedupedSubtract;

  return parsed;
}
