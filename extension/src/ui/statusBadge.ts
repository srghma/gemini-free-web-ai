import type { BridgeConnectionStatus, PromptBoxStatus } from "../types";

export class StatusBadgeManager {
  private state = {
    status: "offline" as BridgeConnectionStatus,
    label: "Connecting...",
    lastCmd: null as string | null,
    lastExit: null as number | null,
    lastElapsed: null as string | null,
    lastOutput: "",
  };

  private startTime = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  private readonly STYLES = {
    ready: {
      bg: "rgba(46, 125, 50, 0.15)",
      fg: "#81c784",
      border: "rgba(129, 199, 132, 0.3)",
      icon: "🟢",
    },
    running: {
      bg: "rgba(245, 124, 0, 0.15)",
      fg: "#ffb74d",
      border: "rgba(255, 183, 77, 0.3)",
      icon: "🟡",
    },
    error: {
      bg: "rgba(211, 47, 47, 0.15)",
      fg: "#e57373",
      border: "rgba(229, 115, 115, 0.3)",
      icon: "🔴",
    },
    offline: {
      bg: "rgba(120, 120, 120, 0.15)",
      fg: "#aaa",
      border: "rgba(120, 120, 120, 0.3)",
      icon: "⚪",
    },
  };

  public setRunning(type: string, _timeout?: string): void {
    this.state.status = "running";
    this.startTime = Date.now();
    this.state.label = `Executing ${type.toUpperCase()}...`;

    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      const sec = Math.round((Date.now() - this.startTime) / 1000);
      this.state.label = `Executing ${type.toUpperCase()} (${sec}s)...`;
    }, 1000);
  }

  public setFinished(type: string, exitCode: number, output = ""): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    const elapsed = `${((Date.now() - this.startTime) / 1000).toFixed(1)}s`;
    this.state.status = exitCode === 0 ? "ready" : "error";
    this.state.label = "Ready";
    this.state.lastCmd = (type || "").toUpperCase();
    this.state.lastExit = exitCode;
    this.state.lastElapsed = elapsed;
    this.state.lastOutput = output;
  }

  public setReady(msg = "Ready"): void {
    this.state.status = "ready";
    this.state.label = msg;
  }

  public setOffline(msg = "Daemon Offline"): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.state.status = "offline";
    this.state.label = msg;
  }

  public render(promptStatus?: PromptBoxStatus): void {
    const headerRight = document.querySelector("ms-header .toolbar-right");
    if (!headerRight) return;

    let badge = document.getElementById("gemini-bridge-status");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "gemini-bridge-status";
      badge.style.cssText =
        "display:inline-flex;align-items:center;gap:6px;padding:4px 10px;margin-right:8px;border-radius:12px;font-size:11px;font-family:monospace;font-weight:600;user-select:none;cursor:default;";
      headerRight.prepend(badge);
    }

    const style = this.STYLES[this.state.status] || this.STYLES.offline;
    badge.style.background = style.bg;
    badge.style.color = style.fg;
    badge.style.border = `1px solid ${style.border}`;

    let text = `${style.icon} ${this.state.label}`;
    if (this.state.lastCmd && this.state.status !== "running") {
      const exitIcon = this.state.lastExit === 0 ? "✓" : `✗(${this.state.lastExit})`;
      text += ` [${exitIcon} ${this.state.lastCmd} ${this.state.lastElapsed}]`;
    }

    if (promptStatus) {
      const aiTag = promptStatus.isAiPrinting ? " | ✍️ Printing" : " | ⏸ Idle";
      const btnState = promptStatus.isButtonDisabled ? "dis" : "act";
      const btnTag = ` | ${promptStatus.buttonLabel}(${btnState})`;
      const inputTag = promptStatus.hasText ? ` | ${promptStatus.charCount}c` : " | (empty)";
      text += `${aiTag}${btnTag}${inputTag}`;
    }

    badge.innerText = text;
    badge.title = this.state.lastOutput
      ? `Last Output (${this.state.lastCmd}):\n${this.state.lastOutput.slice(0, 400)}`
      : "Gemini Local Bridge";
  }
}
