import { CONFIG } from "./config";
import { extractAllChatTurns } from "./dom/chatExtractor";
import { ensurePresetSelected } from "./dom/preset";
import { getPromptBoxStatus, submitPrompt } from "./dom/promptBox";
import { clickVariantChoice, detectPreferenceVote } from "./dom/variantDetector";
import { StatusBadgeManager } from "./ui/statusBadge";
import { BridgeWebSocket } from "./ws/client";

(() => {
  const tabId = `tab_${Math.random().toString(36).substring(2, 7)}`;
  const statusBadge = new StatusBadgeManager();
  const wsClient = new BridgeWebSocket(statusBadge, tabId);

  let lastDigest = "";

  wsClient.setInitialDataProvider(() => {
    const promptStatus = getPromptBoxStatus();
    return {
      turns: extractAllChatTurns(false).slice(-15),
      prompt: promptStatus,
      preferenceVote: detectPreferenceVote(),
    };
  });

  statusBadge.onToggle((enabled) => {
    if (enabled) wsClient.enable();
    else wsClient.disable();
  });

  // Server commands
  wsClient.onCommand("submit_prompt", async (payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (text) {
      statusBadge.setReady("Submitting Reply...");
      await submitPrompt(text);
      statusBadge.setReady("Daemon Ready");
    }
  });

  wsClient.onCommand("select_variant", async (payload) => {
    const idx = typeof payload.variantIndex === "number" ? payload.variantIndex : 0;
    statusBadge.setReady(`Selecting Variant #${idx + 1}...`);
    await clickVariantChoice(idx);
    statusBadge.setReady("Daemon Ready");
  });

  const syncState = (): void => {
    if (statusBadge.isDisabled) return;

    statusBadge.render();
    const promptStatus = getPromptBoxStatus();
    const preferenceVote = detectPreferenceVote();
    const isGlobalPrinting = promptStatus.isAiPrinting;
    const extractedTurns = extractAllChatTurns(isGlobalPrinting);

    const currentDigest = JSON.stringify({
      isGlobalPrinting,
      btn: promptStatus.buttonLabel,
      promptText: promptStatus.promptText,
      hasVote: !!preferenceVote,
      voteCount: preferenceVote?.options.length ?? 0,
      turns: extractedTurns.map((t) => [
        t.id,
        t.status,
        t.chatContent?.length,
        t.codeBlocks.length,
      ]),
    });

    if (currentDigest !== lastDigest) {
      lastDigest = currentDigest;
      wsClient.send({
        event: "tab_chat_update",
        tabId,
        isPrinting: isGlobalPrinting,
        buttonLabel: promptStatus.buttonLabel,
        promptText: promptStatus.promptText,
        turns: extractedTurns,
        preferenceVote,
      });
    }

    statusBadge.render(promptStatus);
  };

  document.addEventListener(
    "input",
    (e) => {
      const target = e.target as HTMLElement;
      if (
        target?.tagName === "TEXTAREA" ||
        target?.getAttribute("formcontrolname") === "promptText"
      ) {
        syncState();
      }
    },
    { passive: true }
  );

  setInterval(syncState, CONFIG.pollIntervalMs);
  statusBadge.render();

  ensurePresetSelected().catch((err) => {
    console.warn("[Bridge] Preset sync deferred:", err);
  });
})();
