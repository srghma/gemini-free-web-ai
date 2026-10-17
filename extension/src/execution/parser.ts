import { CONFIG } from "../config";
import type { CommandLanguage, ParsedCommand } from "../types";

const toCommandLanguage = (rawType: string): CommandLanguage =>
  rawType.toLowerCase().replace("execute_next_", "") as CommandLanguage;

const cleanExtractedCode = (code: string): string =>
  code
    .replace(/^```[a-z0-9_-]*\r?\n/i, "")
    .replace(/\r?\n```$/g, "")
    .trim();

export const extractBridgeCommands = (turnEl: HTMLElement): ParsedCommand[] => {
  const allPres = Array.from(turnEl.querySelectorAll("pre"));
  const fullText = turnEl.innerText || "";
  const results: ParsedCommand[] = [];

  // Strategy 1: Pair each <pre> with its closest preceding EXECUTE_NEXT_* trigger
  for (const pre of allPres) {
    try {
      const range = document.createRange();
      range.setStart(turnEl, 0);
      range.setEndBefore(pre);
      const textBefore = range.toString();

      const triggerRegex =
        /(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?(?:s|m|h|d)?)\))?/gi;
      const matches = Array.from(textBefore.matchAll(triggerRegex));
      const lastMatch = matches[matches.length - 1];

      if (lastMatch) {
        const rawType = lastMatch[1];
        if (!rawType) throw new Error("no rawType");
        const timeout = lastMatch[2] ?? CONFIG.defaultTimeout;
        const type = toCommandLanguage(rawType);
        const code = cleanExtractedCode(pre.innerText);
        if (code) {
          results.push({ type, timeout, code, rawType });
        }
      }
    } catch {
      // Fall through to fallback strategies
    }
  }

  if (results.length > 0) {
    return results;
  }

  // Strategy 2: Single command fallback if range failed but pre exists
  const fallbackMatch = fullText.match(
    /(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?(?:s|m|h|d)?)\))?/i
  );

  const fallbackRawType = fallbackMatch?.[1];
  if (fallbackRawType) {
    const timeout = fallbackMatch?.[2] ?? CONFIG.defaultTimeout;
    const type = toCommandLanguage(fallbackRawType);

    const firstPre = allPres[0];
    if (firstPre) {
      const code = cleanExtractedCode(firstPre.innerText);
      if (code) return [{ type, timeout, code, rawType: fallbackRawType }];
    }

    // Strategy 3: Markdown fence fallback with strict line boundaries
    const bm = fullText.match(
      /(?:EXECUTE_NEXT_[A-Z]+(?:\([^\)]*\))?)\s*[\r\n]+```(?:py|python|bash|sh|zsh|bun|js|ts)?\s*\n([\s\S]*?)\n```/i
    );
    const fencedCode = bm?.[1] ? cleanExtractedCode(bm[1]) : null;
    if (fencedCode) {
      return [{ type, timeout, code: fencedCode, rawType: fallbackRawType }];
    }
  }

  return [];
};

export const extractBridgeCommand = (turnEl: HTMLElement): ParsedCommand | null => {
  const commands = extractBridgeCommands(turnEl);
  return commands[0] ?? null;
};

/**
 * Tracks whether the model is actively streaming tokens.
 */
export class TurnSettler {
  private lastText = "";
  private lastChangeTime = 0;

  public check(turnEl: HTMLElement | null): { isPrinting: boolean; isSettled: boolean } {
    if (!turnEl) {
      return { isPrinting: false, isSettled: false };
    }

    const currentText = turnEl.innerText || "";
    const now = Date.now();

    if (currentText !== this.lastText) {
      this.lastText = currentText;
      this.lastChangeTime = now;
      return { isPrinting: true, isSettled: false };
    }

    const elapsed = now - this.lastChangeTime;
    const isPrinting = elapsed < 1500;
    const isSettled = elapsed >= CONFIG.turnSettledMs;

    return { isPrinting, isSettled };
  }

  public reset(): void {
    this.lastText = "";
    this.lastChangeTime = 0;
  }
}
