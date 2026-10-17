import { buildExportJson } from "./dom/jsonExporter";
import { extractCandidatesFromClosureResponse, parseTurnsFromRequest } from "./dom/networkParser";
import { ensurePresetSelected } from "./dom/preset";
import { getPromptBoxStatus, submitPrompt } from "./dom/promptBox";
import { clickVariantChoice, detectPreferenceVote } from "./dom/variantDetector";
import type { ExtractedTurn, PreferenceVoteData } from "./types";
import { StatusBadgeManager } from "./ui/statusBadge";
import { BridgeWebSocket } from "./ws/client";

(() => {
  const tabId = `tab_${Math.random().toString(36).substring(2, 7)}`;
  const statusBadge = new StatusBadgeManager();
  const wsClient = new BridgeWebSocket(statusBadge, tabId);

  let lastNetworkReqPayload: unknown = null;
  let currentModel = "models/gemini-3.8-flash";
  let turnsHistory: ExtractedTurn[] = [];

  const updateBadgeUI = (): void => {
    if (statusBadge.isDisabled) return;
    const promptStatus = getPromptBoxStatus();
    statusBadge.render(promptStatus);
  };

  // 1. Network generation started (pure XHR)
  window.addEventListener("gemini_generation_start", ((e: Event) => {
    const ce = e as CustomEvent<{ model?: string; payload?: unknown }>;
    currentModel = ce.detail?.model || currentModel;
    lastNetworkReqPayload = ce.detail?.payload || lastNetworkReqPayload;

    if (lastNetworkReqPayload) {
      const priorTurns = parseTurnsFromRequest(lastNetworkReqPayload);
      if (priorTurns.length > 0) {
        turnsHistory = priorTurns;
      }
    }

    statusBadge.setReady("AI Generating (Stream Active)...");
    updateBadgeUI();

    const promptStatus = getPromptBoxStatus();
    wsClient.send({
      event: "tab_chat_update",
      tabId,
      isPrinting: true,
      isNetworkStreaming: true,
      buttonLabel: promptStatus.buttonLabel,
      promptText: promptStatus.promptText,
      turns: turnsHistory,
    });
  }) as EventListener);

  // 2. Network generation completed (pure XHR)
  window.addEventListener("gemini_generation_end", ((e: Event) => {
    const ce = e as CustomEvent<{
      model?: string;
      fullResponse?: string;
      requestPayload?: unknown;
    }>;
    currentModel = ce.detail?.model || currentModel;
    lastNetworkReqPayload = ce.detail?.requestPayload || lastNetworkReqPayload;

    const rawResponse = ce.detail?.fullResponse || "";
    const candidates = extractCandidatesFromClosureResponse(rawResponse);

    let preferenceVote: PreferenceVoteData | null = null;

    if (candidates.length > 1) {
      preferenceVote = {
        question: "Which response do you prefer?",
        options: candidates.map((text, idx) => ({
          index: idx,
          side: idx === 1 ? ("right" as const) : ("left" as const),
          text,
        })),
        hasSubmitButton: true,
        isSubmitDisabled: false,
      };
      statusBadge.setReady("⚖️ Preference Vote Pending...");
    } else if (candidates.length === 1 && candidates[0]) {
      turnsHistory.push({
        id: `net_turn_${turnsHistory.length}`,
        type: "ai_chat",
        status: "completed",
        chatContent: candidates[0],
        codeBlocks: [],
      });
      statusBadge.setReady("Daemon Ready");
    } else {
      // Check DOM fallback for vote
      preferenceVote = detectPreferenceVote();
      statusBadge.setReady("Daemon Ready");
    }

    updateBadgeUI();

    const promptStatus = getPromptBoxStatus();
    wsClient.send({
      event: "tab_chat_update",
      tabId,
      isPrinting: false,
      isNetworkStreaming: false,
      buttonLabel: promptStatus.buttonLabel,
      promptText: promptStatus.promptText,
      turns: turnsHistory,
      preferenceVote,
    });
  }) as EventListener);

  window.addEventListener("gemini_generation_error", () => {
    statusBadge.setReady("Generation Error");
    updateBadgeUI();

    wsClient.send({
      event: "tab_chat_update",
      tabId,
      isPrinting: false,
      isNetworkStreaming: false,
    });
  });

  // Export JSON callback
  statusBadge.onExport(() => {
    const exportJson = buildExportJson(turnsHistory, currentModel, lastNetworkReqPayload);
    const jsonStr = JSON.stringify(exportJson, null, 2);

    navigator.clipboard
      .writeText(jsonStr)
      .then(() => alert("✅ Chat exported to clipboard as Google AI Studio JSON!"))
      .catch(() => console.log("[Bridge Export JSON]:", jsonStr));

    wsClient.send({
      event: "export_chat_json",
      tabId,
      exportJson,
    });
  });

  wsClient.setInitialDataProvider(() => {
    const promptStatus = getPromptBoxStatus();
    return {
      turns: turnsHistory,
      prompt: promptStatus,
      preferenceVote: detectPreferenceVote(),
    };
  });

  statusBadge.onToggle((enabled) => {
    if (enabled) wsClient.enable();
    else wsClient.disable();
  });

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
    const selectedText = typeof payload.selectedText === "string" ? payload.selectedText : "";

    statusBadge.setReady(`Selecting Variant #${idx + 1}...`);
    await clickVariantChoice(idx);

    if (selectedText) {
      turnsHistory.push({
        id: `net_turn_${turnsHistory.length}`,
        type: "ai_chat",
        status: "completed",
        chatContent: selectedText,
        codeBlocks: [],
      });
    }

    statusBadge.setReady("Daemon Ready");
    updateBadgeUI();

    const promptStatus = getPromptBoxStatus();
    wsClient.send({
      event: "tab_chat_update",
      tabId,
      isPrinting: false,
      isNetworkStreaming: false,
      buttonLabel: promptStatus.buttonLabel,
      promptText: promptStatus.promptText,
      turns: turnsHistory,
      preferenceVote: null,
    });
  });

  wsClient.onCommand("trigger_export", () => {
    const exportJson = buildExportJson(turnsHistory, currentModel, lastNetworkReqPayload);
    wsClient.send({
      event: "export_chat_json",
      tabId,
      exportJson,
    });
  });

  updateBadgeUI();

  ensurePresetSelected().catch((err) => {
    console.warn("[Bridge] Preset sync deferred:", err);
  });
})();
