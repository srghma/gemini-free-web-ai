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
      let userText = turn
        .querySelector(".turn-content ms-cmark-node, .user-prompt-container .turn-content")
        ?.textContent?.trim();

      // Virtual scroll fallback
      if (!userText || userText === "edit\nmore_vert") {
        const scrollBtn = document.getElementById(`scrollbar-item-${id}`);
        userText = scrollBtn?.getAttribute("aria-label")?.trim() || userText || "";
      }

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
      "ms-thought-chunk ms-cmark-node, .thought-panel ms-cmark-node, ms-thought-chunk ms-text-chunk"
    );
    const thinkingContent = thoughtNode?.textContent?.trim() || undefined;

    // Model Response
    const textNodes = Array.from(
      turn.querySelectorAll(
        "ms-prompt-chunk > ms-text-chunk:not(ms-thought-chunk ms-text-chunk), ms-code-block pre, pre"
      )
    );
    const chatContent =
      textNodes
        .map((n) => n.textContent?.trim())
        .filter(Boolean)
        .join("\n\n") || undefined;

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
