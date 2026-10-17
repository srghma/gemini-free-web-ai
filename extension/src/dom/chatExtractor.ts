import type { ExtractedCodeBlock, ExtractedTurn } from "../types";

const turnCache = new Map<string, ExtractedTurn>();

const cleanExtractedCode = (code: string): string =>
  code
    .replace(/^```[a-z0-9_-]*\r?\n/i, "")
    .replace(/\r?\n```$/g, "")
    .trim();

const detectCodeLanguage = (cb: HTMLElement, precedingText = ""): string => {
  // 1. Check preceding EXECUTE_NEXT trigger
  if (/EXECUTE_NEXT_PYTHON/i.test(precedingText)) return "python";
  if (/EXECUTE_NEXT_BUN/i.test(precedingText)) return "typescript";
  if (/EXECUTE_NEXT_BASH/i.test(precedingText)) return "bash";

  // 2. Check header/button labels inside the code block
  const headerText =
    cb.querySelector(
      "mat-panel-title, mat-expansion-panel-header, .code-block-header, .header, .language-label"
    )?.textContent || "";

  if (/\b(?:py|python)\b/i.test(headerText)) return "python";
  if (/\b(?:bash|sh|zsh)\b/i.test(headerText)) return "bash";
  if (/\b(?:ts|typescript)\b/i.test(headerText)) return "typescript";
  if (/\b(?:js|javascript)\b/i.test(headerText)) return "javascript";
  if (/\b(?:json)\b/i.test(headerText)) return "json";

  // 3. Check language attributes
  const langAttr = cb.getAttribute("language") || cb.getAttribute("data-language");
  if (langAttr) return langAttr.toLowerCase();

  const preLang = cb.querySelector("pre")?.getAttribute("data-language");
  if (preLang) return preLang.toLowerCase();

  return "bash";
};

export const extractAllChatTurns = (isGlobalPrinting: boolean): ExtractedTurn[] => {
  const turns = Array.from(document.querySelectorAll<HTMLElement>("ms-chat-turn"));
  const currentTurnResults: ExtractedTurn[] = [];

  turns.forEach((turn, idx) => {
    const id = turn.id || turn.getAttribute("id") || `turn_${idx}`;
    const cleanId = id.replace(/^turn-/, "");
    const cachedTurn = turnCache.get(id);

    const isUser = !!turn.querySelector('.chat-turn-container.user, [data-turn-role="User"]');

    if (isUser) {
      // 1. Check scrollbar item aria-label
      const scrollBtn =
        document.getElementById(`scrollbar-item-${cleanId}`) ||
        document.getElementById(`scrollbar-item-${id}`);
      let userText = scrollBtn?.getAttribute("aria-label")?.trim();

      // 2. Check cmark nodes
      if (!userText) {
        const cmarkNodes = Array.from(turn.querySelectorAll("ms-cmark-node"));
        userText = cmarkNodes
          .map((n) => n.textContent?.trim())
          .filter(Boolean)
          .join("\n\n");
      }

      // 3. Fallback to innerText clone
      if (!userText) {
        const clone = turn.cloneNode(true) as HTMLElement;
        const junkEls = clone.querySelectorAll(
          ".turn-header, .author, .user-name, [data-turn-role], button, mat-icon, .chat-turn-header"
        );
        for (const el of junkEls) {
          el.remove();
        }
        userText = clone.innerText?.trim() || "";
      }

      userText = (userText || "")
        .replace(/^(?:edit\s+more_vert\s*)?/i, "")
        .replace(/^(?:User\s+[0-9]{1,2}:[0-9]{2}(?:\s*[AP]M)?\s*)/i, "")
        .trim();

      // If virtual scrolling emptied the DOM, recover from cache
      if (!userText && cachedTurn?.userContent) {
        userText = cachedTurn.userContent;
      }

      // Skip phantom empty turns without any text or scrollbar entry
      if (!userText) return;

      const extracted: ExtractedTurn = {
        id,
        type: "user",
        status: "completed",
        userContent: userText,
        codeBlocks: [],
      };
      turnCache.set(id, extracted);
      currentTurnResults.push(extracted);
      return;
    }

    // Model Thinking
    const isThoughtHost = turn.classList.contains("thought-activity-host");
    const thoughtNode =
      turn.querySelector(
        "ms-thought-chunk ms-cmark-node, .thought-panel ms-cmark-node, ms-thought-chunk ms-text-chunk, ms-thought-chunk"
      ) || (isThoughtHost ? turn : null);

    let thinkingContent = thoughtNode?.textContent?.trim() || undefined;
    if (thinkingContent) {
      thinkingContent =
        thinkingContent
          .replace(/^Thoughts\s+(?:Expand to view model thoughts\s+)?/i, "")
          .replace(/^(?:more_vert\s*)?(?:Model\s+[0-9]{1,2}:[0-9]{2}.*?(?:\n+|$))?/i, "")
          .replace(/^Thoughts\s+/i, "")
          .trim() || undefined;
    }
    if (!thinkingContent && cachedTurn?.thinkingContent) {
      thinkingContent = cachedTurn.thinkingContent;
    }

    // Code blocks with language detection
    const fullText = turn.innerText || "";
    const codeBlocks: ExtractedCodeBlock[] = Array.from(
      turn.querySelectorAll<HTMLElement>("ms-code-block")
    )
      .map((cb) => {
        const pre = cb.querySelector("pre");
        if (!pre) return null;
        const code = cleanExtractedCode(pre.innerText);
        if (!code) return null;
        const language = detectCodeLanguage(cb, fullText);
        return { language, code };
      })
      .filter((cb): cb is ExtractedCodeBlock => cb !== null);

    const effectiveCodeBlocks = codeBlocks.length > 0 ? codeBlocks : cachedTurn?.codeBlocks || [];

    // Model Response Chat Content
    const clone = turn.cloneNode(true) as HTMLElement;
    const modelJunkEls = clone.querySelectorAll(
      "ms-code-block, ms-thought-chunk, mat-icon, button, .model-prompt-footer"
    );
    for (const el of modelJunkEls) {
      el.remove();
    }

    let chatContent = clone.innerText?.trim() || undefined;
    if (chatContent) {
      chatContent =
        chatContent
          .replace(/^Model\s+[0-9]{1,2}:[0-9]{2}.*?(?:\n+|$)/i, "")
          .replace(/(?:EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\([^)]*\))?/gi, "")
          .trim() || undefined;
    }
    if (!chatContent && cachedTurn?.chatContent) {
      chatContent = cachedTurn.chatContent;
    }

    // Skip virtualized empty turns that have no content
    if (!thinkingContent && !chatContent && effectiveCodeBlocks.length === 0) {
      return;
    }

    const hasPill = !!turn.querySelector(".model-run-time-pill, .response-feedback-button");
    const isLastTurn = idx === turns.length - 1;
    const status = hasPill
      ? "completed"
      : isLastTurn && isGlobalPrinting
        ? "streaming"
        : "completed";

    let type: ExtractedTurn["type"] = "ai_chat";
    if (thinkingContent && !chatContent && effectiveCodeBlocks.length === 0) {
      type = "ai_thinking";
    } else if (thinkingContent && (chatContent || effectiveCodeBlocks.length > 0)) {
      type = "ai_both";
    }

    const extracted: ExtractedTurn = {
      id,
      type,
      status,
      thinkingContent,
      chatContent,
      codeBlocks: effectiveCodeBlocks,
    };

    turnCache.set(id, extracted);
    currentTurnResults.push(extracted);
  });

  return currentTurnResults;
};
