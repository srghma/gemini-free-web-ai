import type { ExtractedTurn } from "../types";

export function extractCandidatesFromClosureResponse(raw: string): string[] {
  if (!raw) return [];

  // Match: [null, "text"]], "model", ..., candidateIndex]
  // In Google Closure, Part is [null, "text"], Content is [[parts], "model"]
  const candidateTexts = new Map<number, string>();
  const chunkRegex =
    /\[(?:null|"[^"]*"),"((?:[^"\\]|\\.)*)"\]+\s*,\s*"model"(?:[^\]\n]*?,\s*(\d+))?/g;

  for (const match of raw.matchAll(chunkRegex)) {
    const rawMatched = match[1];
    if (!rawMatched) continue;
    let text = rawMatched;
    try {
      text = JSON.parse(`"${rawMatched}"`);
    } catch {
      text = rawMatched;
    }

    const cIdx = match[2] ? Number.parseInt(match[2], 10) : 0;
    candidateTexts.set(cIdx, (candidateTexts.get(cIdx) || "") + text);
  }

  if (candidateTexts.size > 0) {
    return Array.from(candidateTexts.values()).filter((t) => t.trim().length > 0);
  }

  // Fallback: match flat text fragments
  const allRegex = /\[null,"((?:[^"\\]|\\.)*)"/g;
  const parts: string[] = [];
  for (const match of raw.matchAll(allRegex)) {
    const m = match[1];
    if (m) {
      try {
        parts.push(JSON.parse(`"${m}"`));
      } catch {
        parts.push(m);
      }
    }
  }

  const combined = parts.join("");
  return combined.trim().length > 0 ? [combined] : [];
}

export function extractTextFromClosureResponse(raw: string): string {
  const candidates = extractCandidatesFromClosureResponse(raw);
  return candidates[0] || "";
}

export function parseTurnsFromRequest(rawRequest: unknown): ExtractedTurn[] {
  if (!Array.isArray(rawRequest)) return [];
  const rawContents = rawRequest[1];
  if (!Array.isArray(rawContents)) return [];

  const turns: ExtractedTurn[] = [];

  for (let i = 0; i < rawContents.length; i++) {
    const item = rawContents[i];
    if (!Array.isArray(item)) continue;
    const rawParts = item[0];
    const role = item[1] === "model" ? "ai_chat" : "user";

    let text = "";
    if (Array.isArray(rawParts)) {
      for (const p of rawParts) {
        if (Array.isArray(p) && typeof p[1] === "string") {
          text += p[1];
        }
      }
    }

    if (text) {
      turns.push({
        id: `net_turn_${i}`,
        type: role,
        status: "completed",
        userContent: role === "user" ? text : undefined,
        chatContent: role === "ai_chat" ? text : undefined,
        codeBlocks: [],
      });
    }
  }

  return turns;
}
