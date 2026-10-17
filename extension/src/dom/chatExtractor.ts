export interface ExtractedTurn {
  id: string;
  type: "user" | "ai_thinking" | "ai_chat" | "ai_both";
  status: "streaming" | "completed";
  userContent?: string;
  thinkingContent?: string;
  chatContent?: string;
  codeBlocks: string[];
}

export const extractAllChatTurns = (isGlobalPrinting: boolean): ExtractedTurn[] => {
  const turns = Array.from(document.querySelectorAll<HTMLElement>("ms-chat-turn"));

  return turns.map((turn, idx) => {
    const id = turn.id || turn.getAttribute("id") || `turn_${idx}`;
    const isUser = !!turn.querySelector('.chat-turn-container.user, [data-turn-role="User"]');

    if (isUser) {
      // AI Studio scrollbar item IDs strip the 'turn-' prefix
      const cleanId = id.replace(/^turn-/, "");
      const scrollBtn =
        document.getElementById(`scrollbar-item-${cleanId}`) ||
        document.getElementById(`scrollbar-item-${id}`);
      const scrollText = scrollBtn?.getAttribute("aria-label")?.trim();

      let userText = scrollText;
      if (!userText) {
        const cmarkNodes = Array.from(turn.querySelectorAll("ms-cmark-node"));
        userText = cmarkNodes
          .map((n) => n.textContent?.trim())
          .filter(Boolean)
          .join("\n\n");
      }
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

      return {
        id,
        type: "user",
        status: "completed",
        userContent: userText,
        codeBlocks: [],
      };
    }

    // Model Thinking
    const thoughtNode = turn.querySelector(
      "ms-thought-chunk ms-cmark-node, .thought-panel ms-cmark-node, ms-thought-chunk ms-text-chunk, ms-thought-chunk"
    );
    let thinkingContent = thoughtNode?.textContent?.trim() || undefined;
    if (thinkingContent) {
      thinkingContent =
        thinkingContent.replace(/^Thoughts\s+(?:Expand to view model thoughts\s+)?/i, "").trim() ||
        undefined;
    }

    // Model Response - Pure clean chat text without code block toolbar buttons or duplicated code
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
        chatContent.replace(/^Model\s+[0-9]{1,2}:[0-9]{2}.*?(?:\n+|$)/i, "").trim() || undefined;
    }

    // Clean code blocks
    const codeBlocks = Array.from(turn.querySelectorAll<HTMLElement>("ms-code-block pre, pre"))
      .map((p) => p.innerText.trim())
      .filter(Boolean);

    const hasPill = !!turn.querySelector(".model-run-time-pill, .response-feedback-button");
    const isLastTurn = idx === turns.length - 1;
    const status = hasPill
      ? "completed"
      : isLastTurn && isGlobalPrinting
        ? "streaming"
        : "completed";

    let type: ExtractedTurn["type"] = "ai_chat";
    if (thinkingContent && !chatContent) type = "ai_thinking";
    else if (thinkingContent && chatContent) type = "ai_both";

    return {
      id,
      type,
      status,
      thinkingContent,
      chatContent,
      codeBlocks,
    };
  });
};
