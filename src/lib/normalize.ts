export function normalizeKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[\s.,!?;:'"()[\]{}<>]+|[\s.,!?;:'"()[\]{}<>]+$/g, "")
    .replace(/\s+/g, " ");
}

export function normalizeBossKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

export function splitWords(input: string): string[] {
  return input
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function dedupePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalizeKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

