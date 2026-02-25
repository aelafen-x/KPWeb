import { useEffect, useMemo, useState } from "react";
import type { ParsedLine } from "../types";
import { getBossSuggestions, getNameSuggestions } from "../lib/suggest";

type LineResolverProps = {
  allRawLines: string[];
  parsedLines: ParsedLine[];
  currentIssueIndex: number;
  canonicalNames: string[];
  canonicalBosses: string[];
  onEditLine: (lineNumber: number, value: string) => void;
  onCheckLine: (lineNumber: number, value: string) => void;
  onDiscardLine: (lineNumber: number) => void;
  onAddBoss: (aliasToken: string, canonicalBoss: string, points: number) => void;
  onAddBossAlias: (aliasToken: string, canonicalBoss: string) => void;
  onAddNameAlias: (aliasToken: string, canonicalName: string) => void;
  onNextIssue: () => void;
};

export function LineResolver({
  allRawLines,
  parsedLines,
  currentIssueIndex,
  canonicalNames,
  canonicalBosses,
  onEditLine,
  onCheckLine,
  onDiscardLine,
  onAddBoss,
  onAddBossAlias,
  onAddNameAlias,
  onNextIssue
}: LineResolverProps): JSX.Element {
  const currentParsed = parsedLines[currentIssueIndex];
  const [draft, setDraft] = useState(currentParsed?.rawText || "");
  const [selectedCanonical, setSelectedCanonical] = useState("");
  const [newBossName, setNewBossName] = useState("");
  const [newBossPoints, setNewBossPoints] = useState("1");

  useEffect(() => {
    if (!currentParsed) {
      return;
    }
    setDraft(currentParsed.rawText);
    setSelectedCanonical("");
    setNewBossName("");
    setNewBossPoints("1");
  }, [currentParsed]);

  const issue = currentParsed?.issues[0];
  const token = issue?.token || "";

  const suggestions = useMemo(() => {
    if (issue?.type === "UnknownName") {
      return getNameSuggestions(token, canonicalNames);
    }
    if (issue?.type === "UnknownBoss") {
      return getBossSuggestions(token, canonicalBosses);
    }
    return [];
  }, [issue?.type, token, canonicalNames, canonicalBosses]);

  const canonicalOptions = useMemo(() => {
    if (issue?.type === "UnknownName") {
      const suggested = new Set(suggestions);
      const remaining = [...canonicalNames]
        .filter((name) => !suggested.has(name))
        .sort((a, b) => a.localeCompare(b));
      return [...suggestions, ...remaining];
    }
    if (issue?.type === "UnknownBoss") {
      const suggested = new Set(suggestions);
      const remaining = [...canonicalBosses]
        .filter((boss) => !suggested.has(boss))
        .sort((a, b) => a.localeCompare(b));
      return [...suggestions, ...remaining];
    }
    return [];
  }, [issue?.type, suggestions, canonicalNames, canonicalBosses]);

  if (!currentParsed) {
    return (
      <section className="card">
        <h3>Issue Resolver</h3>
        <p>No unresolved lines in this week.</p>
      </section>
    );
  }

  const windowSize = Math.min(7, allRawLines.length);
  const halfWindow = Math.floor(windowSize / 2);
  let centeredFrom = Math.max(1, currentParsed.lineNumber - halfWindow);
  let centeredTo = Math.min(allRawLines.length, centeredFrom + windowSize - 1);
  centeredFrom = Math.max(1, centeredTo - windowSize + 1);

  return (
    <section className="card">
      <h3>Guided Issue Resolver</h3>
      <p>
        Reviewing line {currentParsed.lineNumber}. Resolve or discard each issue, then click Check Line before moving
        on.
      </p>
      <div className="line-window">
        {Array.from({ length: centeredTo - centeredFrom + 1 }).map((_, i) => {
          const lineNumber = centeredFrom + i;
          const isCurrent = lineNumber === currentParsed.lineNumber;
          return (
            <div key={lineNumber} className={`line-row ${isCurrent ? "current" : "dim"}`}>
              <span className="ln">{lineNumber}</span>
              <span>{allRawLines[lineNumber - 1]}</span>
            </div>
          );
        })}
      </div>

      <label>
        Edit Current Line
        <textarea
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            onEditLine(currentParsed.lineNumber, value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onCheckLine(currentParsed.lineNumber, draft);
            }
          }}
          rows={3}
        />
      </label>
      <p className="hint-inline">Press Enter to check line. Shift+Enter for a newline.</p>

      <div className="issue-list">
        {currentParsed.issues.map((currentIssue) => (
          <p className="error" key={`${currentIssue.type}-${currentIssue.message}`}>
            {currentIssue.type}: {currentIssue.message}
          </p>
        ))}
      </div>

      {issue && (issue.type === "UnknownName" || issue.type === "UnknownBoss") ? (
        <label>
          Map to canonical value
          <select value={selectedCanonical} onChange={(event) => setSelectedCanonical(event.target.value)}>
            <option value="">Select...</option>
            {canonicalOptions.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {issue?.type === "UnknownName" ? (
        <div className="actions-row">
          <button
            type="button"
            disabled={!selectedCanonical}
            onClick={() => onAddNameAlias(token, selectedCanonical)}
          >
            Add Name Alias
          </button>
        </div>
      ) : null}

      {issue?.type === "UnknownBoss" ? (
        <div className="stack">
          <div className="actions-row">
            <button
              type="button"
              disabled={!selectedCanonical}
              onClick={() => onAddBossAlias(token, selectedCanonical)}
            >
              Add Boss Alias
            </button>
          </div>
          <label>
            Add New Boss
            <input value={newBossName} onChange={(event) => setNewBossName(event.target.value)} placeholder="Dino" />
          </label>
          <label>
            Points
            <input
              type="number"
              value={newBossPoints}
              onChange={(event) => setNewBossPoints(event.target.value)}
              min={-999}
              max={999}
            />
          </label>
          <button
            type="button"
            disabled={!newBossName.trim()}
            onClick={() => onAddBoss(token, newBossName.trim(), Number(newBossPoints))}
          >
            Add Boss and Alias
          </button>
        </div>
      ) : null}

      <div className="actions-row">
        <button type="button" onClick={() => onCheckLine(currentParsed.lineNumber, draft)}>
          Check Line
        </button>
        <button type="button" onClick={() => onDiscardLine(currentParsed.lineNumber)}>
          Discard Line
        </button>
        <button type="button" onClick={onNextIssue}>
          Next Issue
        </button>
      </div>
    </section>
  );
}
