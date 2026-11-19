import type { AuctionWin, WeekBounds } from "../types";
import { isTimestampLineStart, resolveName, splitChatTimestamp } from "./parser";
import type { ParserLookup } from "./parser";

/**
 * After the timestamp: "<poster> Winner <toon> <amount> @<who mails it>".
 * The toon may contain spaces ("Sage Fire"); the @tag is optional and ignored.
 */
const WIN_REGEX = /^(?:(.*?)\s+)?winner\s*:?\s+(.+?)\s+(\d+)\s*(?:@.*)?$/i;
const HAS_WINNER = /(^|\s)winner(\s|:|$)/i;

export function parseAuctionLine(
  rawText: string,
  lineNumber: number,
  timezone: string,
  lookup: ParserLookup
): AuctionWin | null {
  const split = splitChatTimestamp(rawText, timezone);
  const body = split ? split.rest : rawText.trim();
  if (!HAS_WINNER.test(body)) {
    return null;
  }
  const win: AuctionWin = {
    lineNumber,
    rawText,
    timestampRaw: split?.timestampRaw || "",
    timestampUtcMillis: split?.timestampUtcMillis,
    poster: "",
    toonRaw: "",
    amount: 0,
    issues: []
  };
  if (!split) {
    win.issues.push({ type: "UnsupportedFormat", message: "Line has no timestamp at the start." });
    return win;
  }
  if (split.timestampUtcMillis === undefined) {
    win.issues.push({ type: "InvalidTimestamp", message: `Unable to read timestamp "${split.timestampRaw}".` });
  }
  const match = body.match(WIN_REGEX);
  if (!match) {
    win.issues.push({
      type: "UnsupportedFormat",
      message: 'Expected "<poster> Winner <toon> <amount> @<tag>".'
    });
    return win;
  }
  win.poster = (match[1] || "").replace(/:\s*$/, "").trim();
  win.toonRaw = match[2].trim();
  win.amount = Number(match[3]);
  const resolved = resolveName(win.toonRaw, lookup);
  if (resolved.issue) {
    win.issues.push({ ...resolved.issue, message: `Unknown toon: ${win.toonRaw}` });
  } else {
    win.toon = resolved.canonical;
  }
  return win;
}

/** Parses an exported auction chat and keeps winner lines inside the selected week. */
export function parseAuctionFile(
  lines: string[],
  timezone: string,
  lookup: ParserLookup,
  bounds: WeekBounds
): AuctionWin[] {
  const merged: Array<{ lineNumber: number; text: string }> = [];
  lines.forEach((raw, index) => {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) {
      return;
    }
    if (isTimestampLineStart(raw) || merged.length === 0) {
      merged.push({ lineNumber: index + 1, text: trimmed });
    } else {
      merged[merged.length - 1].text = `${merged[merged.length - 1].text} ${trimmed}`;
    }
  });

  const output: AuctionWin[] = [];
  for (const entry of merged) {
    const win = parseAuctionLine(entry.text, entry.lineNumber, timezone, lookup);
    if (!win) {
      continue;
    }
    if (win.timestampUtcMillis === undefined) {
      output.push(win);
      continue;
    }
    if (win.timestampUtcMillis < bounds.startUtcMillis || win.timestampUtcMillis > bounds.endUtcMillis) {
      continue;
    }
    output.push(win);
  }
  return output;
}
