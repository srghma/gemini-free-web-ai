import type { BridgeConnectionStatus, PromptBoxStatus } from "../types";

export class StatusBadgeManager {
  private state = {
    status: "offline" as BridgeConnectionStatus,
    label: "Connecting...",
    lastCmd: null as string | null,
    lastElapsed: null as string | null,
  };

  private startTime = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private lastPromptStatus: PromptBoxStatus | undefined;
  private isUserDisabled = false;
  private onToggleCallback: ((enabled: boolean) => void) | null = null;

  constructor() {
    this.render();
  }

  public onToggle(cb: (enabled: boolean) => void): void {
    this.onToggleCallback = cb;
  }

  public get isDisabled(): boolean {
    return this.isUserDisabled;
  }

  public setRunning(type: string, _timeout?: string): void {
    if (this.isUserDisabled) return;
    this.state.status = "running";
    this.startTime = Date.now();
    this.state.label = `Executing ${type.toUpperCase()}...`;

    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      const sec = Math.round((Date.now() - this.startTime) / 1000);
      this.state.label = `Executing ${type.toUpperCase()} (${sec}s)...`;
      this.render();
    }, 1000);
    this.render();
  }

  public setReady(msg = "Daemon Ready"): void {
    if (this.isUserDisabled) return;
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.state.status = "ready";
    this.state.label = msg;
    this.render();
  }

  public setOffline(msg = "Daemon Offline"): void {
    if (this.isUserDisabled) return;
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.state.status = "offline";
    this.state.label = msg;
    this.render();
  }

  public render(promptStatus?: PromptBoxStatus): void {
    if (promptStatus) this.lastPromptStatus = promptStatus;
    const container =
      document.querySelector("ms-header .toolbar-right") ||
      document.querySelector("ms-header") ||
      document.querySelector("ms-playground-toolbar");

    if (!container) return;

    let badge = document.getElementById("gemini-bridge-status");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "gemini-bridge-status";
      badge.style.cssText =
        "display:inline-flex;align-items:center;gap:6px;padding:3px 8px;margin-right:8px;border-radius:12px;font-size:11px;font-family:monospace;font-weight:600;user-select:none;z-index:9999;";
      container.prepend(badge);
    }

    const STYLES = {
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

    const style = this.isUserDisabled
      ? STYLES.offline
      : STYLES[this.state.status] || STYLES.offline;
    badge.style.background = style.bg;
    badge.style.color = style.fg;
    badge.style.border = `1px solid ${style.border}`;

    let labelText = `${style.icon} ${this.isUserDisabled ? "Bridge Disabled" : this.state.label}`;
    const ps = this.lastPromptStatus;
    if (ps && !this.isUserDisabled) {
      const aiTag = ps.isAiPrinting ? " | ✍️ Printing" : " | ⏸ Idle";
      labelText += aiTag;
    }

    let textSpan = badge.querySelector<HTMLSpanElement>("#gemini-bridge-text");
    if (!textSpan) {
      textSpan = document.createElement("span");
      textSpan.id = "gemini-bridge-text";
      badge.appendChild(textSpan);
    }
    textSpan.innerText = labelText;

    let btn = badge.querySelector<HTMLButtonElement>("#gemini-bridge-toggle-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "gemini-bridge-toggle-btn";
      btn.style.cssText =
        "margin-left:6px;padding:2px 6px;border-radius:6px;font-size:10px;font-family:inherit;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.1);color:inherit;transition:all 0.2s;";
      badge.appendChild(btn);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.isUserDisabled = !this.isUserDisabled;
        if (this.isUserDisabled && this.timerInterval) clearInterval(this.timerInterval);
        this.render();
        this.onToggleCallback?.(!this.isUserDisabled);
      });
    }

    btn.innerText = this.isUserDisabled ? "🔌 Connect" : "✕ Disconnect";
  }
}
