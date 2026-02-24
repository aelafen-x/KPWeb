import levenshtein from "fast-levenshtein";
import { normalizeBossKey, normalizeKey } from "./normalize";

export function getNameSuggestions(token: string, candidates: string[], limit = 5): string[] {
  const tokenKey = normalizeKey(token);
  return candidates
    .map((candidate) => ({
      candidate,
      distance: levenshtein.get(tokenKey, normalizeKey(candidate))
    }))
    .filter((entry) => entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

export function getBossSuggestions(token: string, candidates: string[], limit = 5): string[] {
  const tokenKey = normalizeBossKey(token);
  return candidates
    .map((candidate) => ({
      candidate,
      distance: levenshtein.get(tokenKey, normalizeBossKey(candidate))
    }))
    .filter((entry) => entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

