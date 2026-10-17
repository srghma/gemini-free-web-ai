import { CONFIG } from "./config";
import { ensurePresetSelected } from "./dom/preset";
import { getPromptBoxStatus } from "./dom/promptBox";
import { TurnSettler, extractBridgeCommand } from "./execution/parser";
import { StatusBadgeManager } from "./ui/statusBadge";
import { BridgeWebSocket } from "./ws/client";

(() => {
  const statusBadge = new StatusBadgeManager();
  const wsClient = new BridgeWebSocket(statusBadge);
  const turnSettler = new TurnSettler();

  let lastHandledKey = "";

  const getLatestModelTurn = (turns: HTMLElement[]): HTMLElement | null => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (!turn) continue;
      const isUser = turn.querySelector('.chat-turn-container.user, [data-turn-role="User"]');
      if (!isUser) return turn;
    }
    return turns[turns.length - 1] ?? null;
  };

  const startTurnScanner = (): void => {
    setInterval(() => {
      const turns = Array.from(document.querySelectorAll<HTMLElement>("ms-chat-turn"));
      const targetTurn = getLatestModelTurn(turns);

      const { isPrinting, isSettled } = turnSettler.check(targetTurn);

      const promptBoxStatus = getPromptBoxStatus();
      promptBoxStatus.isAiPrinting = isPrinting;
      statusBadge.render(promptBoxStatus);

      if (isPrinting || !isSettled || !targetTurn) {
        return;
      }

      const parsed = extractBridgeCommand(targetTurn);
      if (!parsed) return;

      const currentKey = `${parsed.type}:${parsed.code}`;
      if (currentKey === lastHandledKey) return;
      lastHandledKey = currentKey;

      console.log(`[Bridge] Turn settled. Dispatched ${parsed.rawType}:`, parsed);
      statusBadge.setRunning(parsed.type);
      wsClient.sendTask(parsed.type, parsed.code, parsed.timeout);
    }, CONFIG.pollIntervalMs);
  };

  (async () => {
    try {
      await ensurePresetSelected();
    } catch (err) {
      console.warn("[Bridge] Preset sync deferred:", err);
    }
    startTurnScanner();
  })();
})();
