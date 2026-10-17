import { CONFIG } from "./config";
import { extractAllChatTurns } from "./dom/chatExtractor";
import { ensurePresetSelected } from "./dom/preset";
import { getPromptBoxStatus } from "./dom/promptBox";
import { TurnSettler, extractBridgeCommand } from "./execution/parser";
import { StatusBadgeManager } from "./ui/statusBadge";
import { BridgeWebSocket } from "./ws/client";

(() => {
  const tabId = `tab_${Math.random().toString(36).substring(2, 7)}`;
  const statusBadge = new StatusBadgeManager();
  const wsClient = new BridgeWebSocket(statusBadge, tabId);
  const turnSettler = new TurnSettler();

  const handledTurnIds = new Set<string>();
  let lastDigest = "";

  const startTurnScanner = (): void => {
    setInterval(() => {
      const promptStatus = getPromptBoxStatus();
      const turns = Array.from(document.querySelectorAll<HTMLElement>("ms-chat-turn"));
      const latestTurn = turns[turns.length - 1] ?? null;

      const { isPrinting: settlerPrinting, isSettled } = turnSettler.check(latestTurn);
      const isGlobalPrinting = promptStatus.isAiPrinting || settlerPrinting;

      const extractedTurns = extractAllChatTurns(isGlobalPrinting);

      const currentDigest = JSON.stringify({
        isGlobalPrinting,
        btn: promptStatus.buttonLabel,
        turns: extractedTurns.map((t) => [
          t.id,
          t.status,
          t.chatContent?.length,
          t.thinkingContent?.length,
        ]),
      });

      if (currentDigest !== lastDigest) {
        lastDigest = currentDigest;
        wsClient.send({
          event: "tab_chat_update",
          tabId,
          isPrinting: isGlobalPrinting,
          buttonLabel: promptStatus.buttonLabel,
          turns: extractedTurns,
        });
      }

      statusBadge.render(promptStatus);

      if (!latestTurn || isGlobalPrinting || !isSettled) return;

      const isModelTurn = !latestTurn.querySelector(
        '.chat-turn-container.user, [data-turn-role="User"]'
      );
      if (!isModelTurn) return;

      const turnId = latestTurn.id || latestTurn.getAttribute("id") || "";
      if (turnId && handledTurnIds.has(turnId)) return;

      const parsed = extractBridgeCommand(latestTurn);
      if (!parsed) {
        if (turnId) handledTurnIds.add(turnId);
        return;
      }

      if (turnId) handledTurnIds.add(turnId);
      console.log(`[Bridge] Dispatched execution for turn ${turnId}:`, parsed);
      statusBadge.setRunning(parsed.type);
      wsClient.sendTask(parsed.type, parsed.code, parsed.timeout);
    }, CONFIG.pollIntervalMs);
  };

  statusBadge.render();
  startTurnScanner();

  ensurePresetSelected().catch((err) => {
    console.warn("[Bridge] Preset sync deferred:", err);
  });
})();
