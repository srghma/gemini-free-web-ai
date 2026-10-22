import { hasExecutableCommands } from "./dom/commandDetector";
import { detectActiveFunctionCall, submitFunctionResponse } from "./dom/functionCall";
import { buildExportJson } from "./dom/jsonExporter";
import { extractCandidatesFromClosureResponse, parseTurnsFromRequest } from "./dom/networkParser";
import { ensurePresetSelected } from "./dom/preset";
import { getPromptBoxStatus, submitPrompt } from "./dom/promptBox";
import { clickVariantChoice, detectPreferenceVote } from "./dom/variantDetector";
import type {
  ActiveFunctionCall,
  AutomationMode,
  ExtractedTurn,
  PreferenceVoteData,
} from "./types";
import { StatusBadgeManager } from "./ui/statusBadge";
import { BridgeWebSocket } from "./ws/client";

(() => {
  const tabId = `tab_${Math.random().toString(36).substring(2, 7)}`;
  const statusBadge = new StatusBadgeManager();
  const wsClient = new BridgeWebSocket(statusBadge, tabId);

  let currentModel = "models/gemini-3.8-flash";
  let lastNetworkReqPayload: unknown = null;
  let turnsHistory: ExtractedTurn[] = [];
  let pendingManualPayload: Record<string, unknown> | null = null;
  let lastHandledCallSignature = "";

  const updateBadgeUI = (): void => {
    if (statusBadge.isDisabled) return;
    statusBadge.render(getPromptBoxStatus());
  };

  const createAiTurn = (text: string): ExtractedTurn => ({
    id: `net_turn_${turnsHistory.length}`,
    type: "ai_chat",
    status: "completed",
    chatContent: text,
    codeBlocks: [],
  });

  const sendChatUpdate = (opts: {
    isPrinting: boolean;
    isStreaming?: boolean;
    preferenceVote?: PreferenceVoteData | null;
    activeFunctionCall?: ActiveFunctionCall | null;
  }): void => {
    const promptStatus = getPromptBoxStatus();
    wsClient.send({
      event: "tab_chat_update",
      tabId,
      isPrinting: opts.isPrinting,
      isNetworkStreaming: opts.isStreaming ?? opts.isPrinting,
      buttonLabel: promptStatus.buttonLabel,
      promptText: promptStatus.promptText,
      turns: turnsHistory,
      preferenceVote: opts.preferenceVote ?? null,
      activeFunctionCall: opts.activeFunctionCall ?? null,
    });
  };

  const dispatchFunctionCallPayload = (call: ActiveFunctionCall): void => {
    lastHandledCallSignature = `${call.name}_${call.rawCode}`;
    statusBadge.setRunning(`Running Tool: ${call.name}`);

    wsClient.send({
      event: "function_call",
      tabId,
      name: call.name,
      args: call.args,
      callId: call.callId,
    });
  };

  const checkAndDispatchFunctionCall = (): boolean => {
    const activeCall = detectActiveFunctionCall();
    if (!activeCall) return false;

    const signature = `${activeCall.name}_${activeCall.rawCode}`;
    if (signature === lastHandledCallSignature) return true;

    if (statusBadge.mode === "manual") {
      pendingManualPayload = {
        _isFunctionCall: true,
        call: activeCall,
      };
      statusBadge.setReview(`⏸ Review ${activeCall.name} (Click Send)`);
      statusBadge.setPendingSend(true);
      return true;
    }

    dispatchFunctionCallPayload(activeCall);
    return true;
  };

  const createPreferenceVote = (candidates: string[]): PreferenceVoteData => ({
    question: "Which response do you prefer?",
    options: candidates.map((text, idx) => ({
      index: idx,
      side: idx === 1 ? ("right" as const) : ("left" as const),
      text,
    })),
    hasSubmitButton: true,
    isSubmitDisabled: false,
  });

  const commitCandidates = (candidates: string[]): PreferenceVoteData | null => {
    if (candidates.length > 1) {
      statusBadge.setReady("⚖️ Preference Vote Pending...");
      return createPreferenceVote(candidates);
    }

    const first = candidates[0];
    if (first) {
      turnsHistory.push(createAiTurn(first));
    }

    statusBadge.setReady("Daemon Ready");
    return first ? null : detectPreferenceVote();
  };

  const finalizeGeneration = (candidates: string[]): void => {
    const preferenceVote = commitCandidates(candidates);
    updateBadgeUI();

    const isFnCall = checkAndDispatchFunctionCall();
    if (isFnCall) return;

    const promptStatus = getPromptBoxStatus();
    const updatePayload = {
      event: "tab_chat_update",
      tabId,
      isPrinting: false,
      isNetworkStreaming: false,
      buttonLabel: promptStatus.buttonLabel,
      promptText: promptStatus.promptText,
      turns: turnsHistory,
      preferenceVote,
      activeFunctionCall: null,
    };

    const lastTurn = turnsHistory[turnsHistory.length - 1];
    const latestText = lastTurn?.chatContent || candidates.join("\n");
    const containsCommands = hasExecutableCommands(latestText);

    if (containsCommands && statusBadge.mode === "manual") {
      pendingManualPayload = updatePayload;
      statusBadge.setReview("⏸ Review Commands (Click Send)");
      statusBadge.setPendingSend(true);
      return;
    }

    pendingManualPayload = null;
    statusBadge.setPendingSend(false);
    wsClient.send(updatePayload);
  };

  const dispatchPendingManual = (): void => {
    if (pendingManualPayload) {
      if (pendingManualPayload._isFunctionCall && pendingManualPayload.call) {
        dispatchFunctionCallPayload(pendingManualPayload.call as ActiveFunctionCall);
      } else {
        wsClient.send(pendingManualPayload);
      }
      pendingManualPayload = null;
      statusBadge.setPendingSend(false);
      statusBadge.setReady("Commands Dispatched");
      updateBadgeUI();
    }
  };

  statusBadge.onSend(dispatchPendingManual);

  statusBadge.onModeChange((newMode: AutomationMode) => {
    if (newMode === "auto") dispatchPendingManual();
  });

  window.addEventListener("gemini_generation_start", ((e: Event) => {
    const ce = e as CustomEvent<{ model?: string; payload?: unknown }>;
    currentModel = ce.detail?.model || currentModel;
    lastNetworkReqPayload = ce.detail?.payload || lastNetworkReqPayload;

    if (lastNetworkReqPayload) {
      const priorTurns = parseTurnsFromRequest(lastNetworkReqPayload);
      if (priorTurns.length > 0) turnsHistory = priorTurns;
    }

    pendingManualPayload = null;
    statusBadge.setPendingSend(false);
    statusBadge.setRunning("AI Generating...");
    updateBadgeUI();

    sendChatUpdate({ isPrinting: true, isStreaming: true });
  }) as EventListener);

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

    setTimeout(() => {
      finalizeGeneration(candidates);
    }, 150);
  }) as EventListener);

  window.addEventListener("gemini_generation_error", () => {
    statusBadge.setReady("Generation Error");
    updateBadgeUI();
    sendChatUpdate({ isPrinting: false, isStreaming: false });
  });

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

  wsClient.setInitialDataProvider(() => ({
    turns: turnsHistory,
    prompt: getPromptBoxStatus(),
    preferenceVote: detectPreferenceVote(),
  }));

  statusBadge.onToggle((enabled) => {
    if (enabled) wsClient.enable();
    else wsClient.disable();
  });

  wsClient.onCommand("submit_prompt", async (payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (text) {
      statusBadge.setWaiting("AI Rendering (Waiting to submit...)");
      await submitPrompt(text, (msg) => {
        statusBadge.setWaiting(msg);
      });
      statusBadge.setReady("Daemon Ready");
      updateBadgeUI();
    }
  });

  wsClient.onCommand("submit_function_response", async (payload) => {
    const responseText =
      typeof payload.response === "string"
        ? payload.response
        : JSON.stringify(payload.response || {});

    statusBadge.setWaiting("Injecting tool output...");
    await submitFunctionResponse(responseText, (msg) => {
      statusBadge.setWaiting(msg);
    });
    statusBadge.setReady("Daemon Ready");
    updateBadgeUI();
  });

  wsClient.onCommand("select_variant", async (payload) => {
    const idx = typeof payload.variantIndex === "number" ? payload.variantIndex : 0;
    const selectedText = typeof payload.selectedText === "string" ? payload.selectedText : "";

    statusBadge.setReady(`Selecting Variant #${idx + 1}...`);
    await clickVariantChoice(idx);

    if (selectedText) {
      turnsHistory.push(createAiTurn(selectedText));
    }

    statusBadge.setReady("Daemon Ready");
    updateBadgeUI();
    sendChatUpdate({ isPrinting: false, preferenceVote: null });
  });

  wsClient.onCommand("trigger_export", () => {
    const exportJson = buildExportJson(turnsHistory, currentModel, lastNetworkReqPayload);
    wsClient.send({
      event: "export_chat_json",
      tabId,
      exportJson,
    });
  });

  const observer = new MutationObserver(() => {
    if (detectActiveFunctionCall()) {
      checkAndDispatchFunctionCall();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  updateBadgeUI();

  ensurePresetSelected().catch((err) => {
    console.warn("[Bridge] Preset sync deferred:", err);
  });
})();
