import { CONFIG } from "../config";
import { submitPrompt } from "../dom/promptBox";
import { formatExecutionReply } from "../execution/formatter";
import type { DaemonExecutionResponse } from "../types";
import type { StatusBadgeManager } from "../ui/statusBadge";

export class BridgeWebSocket {
  private socket: WebSocket | null = null;
  private isReconnecting = false;

  constructor(private statusBadge: StatusBadgeManager) {
    this.connect();
  }

  private connect(): void {
    this.socket = new WebSocket(CONFIG.wsUrl);

    this.socket.onopen = () => {
      console.log("[Bridge] Connected to daemon.");
      this.isReconnecting = false;
      this.statusBadge.setReady("Daemon Ready");
    };

    this.socket.onmessage = async (event: MessageEvent) => {
      try {
        const data: DaemonExecutionResponse = JSON.parse(event.data);
        if (data.status === "running") {
          this.statusBadge.setRunning(data.type, data.timeout);
          return;
        }

        this.statusBadge.setFinished(data.type, data.exitCode ?? 0, data.output || "");
        await submitPrompt(formatExecutionReply(data));
      } catch (err) {
        console.error("[Bridge] Failed parsing daemon message:", err);
      }
    };

    this.socket.onclose = () => {
      this.statusBadge.setOffline("Daemon Offline");
      this.reconnect();
    };

    this.socket.onerror = () => {
      this.socket?.close();
    };
  }

  private reconnect(): void {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    setTimeout(() => this.connect(), 2000);
  }

  public sendTask(type: string, code: string, timeout: string): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          command: `execute-${type}-and-send-output-to`,
          type,
          timeout,
          code,
        })
      );
      return true;
    }
    return false;
  }
}
