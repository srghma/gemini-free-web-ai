import { CONFIG } from "../config";
import type { CommandLanguage, ParsedCommand } from "../types";

const toCommandLanguage = (rawType: string): CommandLanguage =>
  rawType.toLowerCase().replace("execute_next_", "") as CommandLanguage;

export const extractBridgeCommand = (turnEl: HTMLElement): ParsedCommand | null => {
  const allPres = Array.from(turnEl.querySelectorAll("pre"));
  const fullText = turnEl.innerText || "";

  // Strategy 1: Pair each <pre> with its preceding EXECUTE_NEXT_* trigger
  for (const pre of allPres) {
    try {
      const range = document.createRange();
      range.setStart(turnEl, 0);
      range.setEndBefore(pre);
      const textBefore = range.toString();

      // Uses standard dotAll (/s) flag instead of [^]*
      const match = textBefore.match(
        /(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?(?:s|m|h|d)?)\))?.*$/is
      );

      const rawType = match?.[1];
      if (rawType) {
        const timeout = match?.[2] ?? CONFIG.defaultTimeout;
        const type = toCommandLanguage(rawType);
        const code = pre.innerText.trim();
        if (code) return { type, timeout, code, rawType };
      }
    } catch {
      // Fall through to fallback strategies
    }
  }

  // Strategy 2: Single command in turn with code block
  const fallbackMatch = fullText.match(
    /(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?(?:s|m|h|d)?)\))?/i
  );

  const fallbackRawType = fallbackMatch?.[1];
  if (fallbackRawType) {
    const timeout = fallbackMatch?.[2] ?? CONFIG.defaultTimeout;
    const type = toCommandLanguage(fallbackRawType);

    const firstPre = allPres[0];
    if (firstPre) {
      const code = firstPre.innerText.trim();
      if (code) return { type, timeout, code, rawType: fallbackRawType };
    }

    // Strategy 3: Markdown fence fallback (must have closing fence)
    const bm = fullText.match(/```(?:py|python|bash|sh|zsh|bun|js|ts)?\s*\n([\s\S]*?)```/i);
    const fencedCode = bm?.[1]?.trim();
    if (fencedCode) {
      return { type, timeout, code: fencedCode, rawType: fallbackRawType };
    }
  }

  return null;
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
