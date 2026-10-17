import { CONFIG } from "../config";
import type { ExtractedTurn } from "../dom/chatExtractor";
import { submitPrompt } from "../dom/promptBox";
import { formatExecutionReply } from "../execution/formatter";
import type { DaemonExecutionResponse, PromptBoxStatus } from "../types";
import type { StatusBadgeManager } from "../ui/statusBadge";

export interface QueuedTask {
  type: string;
  code: string;
  timeout: string;
}

export interface InitialDataPayload {
  turns: ExtractedTurn[];
  prompt: PromptBoxStatus;
}

export class BridgeWebSocket {
  private socket: WebSocket | null = null;
  private isReconnecting = false;
  private retryDelayMs = 2000;
  private pendingQueue: QueuedTask[] = [];
  private onSelectVariantHandler: ((variantIndex: number) => void) | null = null;
  private initialDataProvider: (() => InitialDataPayload) | null = null;
  private isManuallyDisabled = false;

  // Batch execution state
  private batchQueue: QueuedTask[][] = [];
  private activeBatch: QueuedTask[] = [];
  private activeBatchOutputs: string[] = [];
  private isBatchExecuting = false;

  constructor(
    private statusBadge: StatusBadgeManager,
    private tabId: string
  ) {
    this.connect();
  }

  public setInitialDataProvider(provider: () => InitialDataPayload): void {
    this.initialDataProvider = provider;
  }

  public onSelectVariant(handler: (variantIndex: number) => void): void {
    this.onSelectVariantHandler = handler;
  }

  public disable(): void {
    this.isManuallyDisabled = true;
    if (this.socket) {
      try {
        this.send({ event: "tab_disconnected", tabId: this.tabId });
        this.socket.close(1000, "User disabled tab");
      } catch {}
      this.socket = null;
    }
  }

  public enable(): void {
    this.isManuallyDisabled = false;
    this.connect();
  }

  private connect(): void {
    if (this.isManuallyDisabled) return;

    try {
      this.socket = new WebSocket(CONFIG.wsUrl);
    } catch {
      this.statusBadge.setOffline("Daemon Offline");
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      if (this.isManuallyDisabled) {
        this.socket?.close();
        return;
      }

      this.isReconnecting = false;
      this.retryDelayMs = 2000;
      this.statusBadge.setReady("Daemon Ready");

      const initData = this.initialDataProvider?.();
      this.send({
        event: "tab_connected",
        tabId: this.tabId,
        title: document.title.replace(" - Google AI Studio", "").trim() || "Chat Tab",
        turns: initData?.turns ?? [],
        promptText: initData?.prompt.promptText ?? "",
        buttonLabel: initData?.prompt.buttonLabel ?? "Run",
      });

      this.flushQueue();
    };

    this.socket.onmessage = async (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.command === "select_variant") {
          const idx = typeof data.variantIndex === "number" ? data.variantIndex : 0;
          this.onSelectVariantHandler?.(idx);
          return;
        }

        const execResp = data as DaemonExecutionResponse;
        if (execResp.status === "running") {
          this.statusBadge.setRunning(execResp.type, execResp.timeout);
          return;
        }

        this.statusBadge.setFinished(execResp.type, execResp.exitCode ?? 0, execResp.output || "");

        if (this.isBatchExecuting) {
          this.activeBatchOutputs.push(formatExecutionReply(execResp));
          this.advanceBatchExecution();
        } else {
          await submitPrompt(formatExecutionReply(execResp));
        }
      } catch (err) {
        console.error("[Bridge] Failed parsing daemon message:", err);
      }
    };

    this.socket.onclose = () => {
      if (!this.isManuallyDisabled) {
        this.statusBadge.setOffline("Daemon Offline");
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = () => {
      this.socket?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.isReconnecting || this.isManuallyDisabled) return;
    this.isReconnecting = true;
    setTimeout(() => {
      this.isReconnecting = false;
      this.connect();
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 15000);
  }

  public send(payload: Record<string, unknown>): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  public sendTaskBatch(tasks: QueuedTask[]): boolean {
    if (this.isManuallyDisabled || tasks.length === 0) return false;
    this.batchQueue.push(tasks);
    this.processNextBatch();
    return true;
  }

  public sendTask(type: string, code: string, timeout: string): boolean {
    return this.sendTaskBatch([{ type, code, timeout }]);
  }

  private processNextBatch(): void {
    if (this.isBatchExecuting || this.batchQueue.length === 0) return;
    const nextBatch = this.batchQueue.shift();
    if (!nextBatch) return;
    this.activeBatch = nextBatch;
    this.activeBatchOutputs = [];
    this.isBatchExecuting = true;
    this.advanceBatchExecution();
  }

  private advanceBatchExecution(): void {
    if (this.activeBatch.length > 0) {
      const nextTask = this.activeBatch.shift();
      if (!nextTask) throw new Error("nextTask empty");
      this.dispatchTask(nextTask);
    } else {
      const finalReply = this.activeBatchOutputs.join("\n\n");
      this.isBatchExecuting = false;
      if (finalReply) {
        submitPrompt(finalReply).catch((err) => {
          console.error("[Bridge] Failed submitting execution reply:", err);
        });
      }
      this.processNextBatch();
    }
  }

  private dispatchTask(task: QueuedTask): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.send({
        command: `execute-${task.type}-and-send-output-to`,
        tabId: this.tabId,
        type: task.type,
        timeout: task.timeout,
        code: task.code,
      });
    } else {
      this.pendingQueue.push(task);
    }
  }

  private flushQueue(): void {
    while (this.pendingQueue.length > 0) {
      const task = this.pendingQueue.shift();
      if (!task) break;
      this.dispatchTask(task);
    }
  }
}
