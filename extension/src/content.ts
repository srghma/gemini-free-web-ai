import { CONFIG } from "./config";
import { extractAllChatTurns } from "./dom/chatExtractor";
import { buildExportJson } from "./dom/jsonExporter";
import { ensurePresetSelected } from "./dom/preset";
import { getPromptBoxStatus, submitPrompt } from "./dom/promptBox";
import { clickVariantChoice, detectPreferenceVote } from "./dom/variantDetector";
import { StatusBadgeManager } from "./ui/statusBadge";
import { BridgeWebSocket } from "./ws/client";

(() => {
  const tabId = `tab_${Math.random().toString(36).substring(2, 7)}`;
  const statusBadge = new StatusBadgeManager();
  const wsClient = new BridgeWebSocket(statusBadge, tabId);

  let isNetworkStreaming = false;
  let lastNetworkReqPayload: unknown = null;
  let currentModel = "models/gemini-3.8-flash";
  let lastDigest = "";

  // 1. Listen for deterministic XHR events from injected.ts (world: MAIN)
  window.addEventListener("gemini_generation_start", ((e: Event) => {
    const ce = e as CustomEvent<{ model?: string; payload?: unknown }>;
    isNetworkStreaming = true;
    currentModel = ce.detail?.model || currentModel;
    lastNetworkReqPayload = ce.detail?.payload || lastNetworkReqPayload;
    statusBadge.setReady("AI Generating (Stream Active)...");
    syncState();
  }) as EventListener);

  window.addEventListener("gemini_generation_end", ((e: Event) => {
    const ce = e as CustomEvent<{ model?: string; requestPayload?: unknown }>;
    isNetworkStreaming = false;
    currentModel = ce.detail?.model || currentModel;
    lastNetworkReqPayload = ce.detail?.requestPayload || lastNetworkReqPayload;
    statusBadge.setReady("Daemon Ready");
    setTimeout(syncState, 50);
  }) as EventListener);

  window.addEventListener("gemini_generation_error", () => {
    isNetworkStreaming = false;
    syncState();
  });

  // 2. Export chat handler
  statusBadge.onExport(() => {
    const turns = extractAllChatTurns(false);
    const exportJson = buildExportJson(turns, currentModel, lastNetworkReqPayload);
    const jsonStr = JSON.stringify(exportJson, null, 2);

    navigator.clipboard
      .writeText(jsonStr)
      .then(() => {
        alert("✅ Chat exported to clipboard as Google AI Studio JSON!");
      })
      .catch(() => {
        console.log("[Bridge Export JSON]:", jsonStr);
      });

    wsClient.send({
      event: "export_chat_json",
      tabId,
      exportJson,
    });
  });

  wsClient.setInitialDataProvider(() => {
    const promptStatus = getPromptBoxStatus();
    return {
      turns: extractAllChatTurns(false).slice(-20),
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

  wsClient.onCommand("trigger_export", () => {
    const turns = extractAllChatTurns(false);
    const exportJson = buildExportJson(turns, currentModel, lastNetworkReqPayload);
    wsClient.send({
      event: "export_chat_json",
      tabId,
      exportJson,
    });
  });

  const syncState = (): void => {
    if (statusBadge.isDisabled) return;

    statusBadge.render();
    const promptStatus = getPromptBoxStatus();
    const isGlobalPrinting = isNetworkStreaming || promptStatus.isAiPrinting;
    const preferenceVote = detectPreferenceVote();
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
        isNetworkStreaming,
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
