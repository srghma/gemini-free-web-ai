import type { BridgeConnectionStatus, PromptBoxStatus } from "../types";

export class StatusBadgeManager {
  private state = {
    status: "offline" as BridgeConnectionStatus,
    label: "Connecting...",
  };

  private lastPromptStatus: PromptBoxStatus | undefined;
  private isUserDisabled = false;
  private onToggleCallback: ((enabled: boolean) => void) | null = null;
  private onExportCallback: (() => void) | null = null;

  constructor() {
    this.render();
  }

  public onToggle(cb: (enabled: boolean) => void): void {
    this.onToggleCallback = cb;
  }

  public onExport(cb: () => void): void {
    this.onExportCallback = cb;
  }

  public get isDisabled(): boolean {
    return this.isUserDisabled;
  }

  public setRunning(type: string, _timeout?: string): void {
    if (this.isUserDisabled) return;
    this.state.status = "running";
    this.state.label = `Executing ${type.toUpperCase()}...`;
    this.render();
  }

  public setReady(msg = "Daemon Ready"): void {
    if (this.isUserDisabled) return;
    this.state.status = "ready";
    this.state.label = msg;
    this.render();
  }

  public setOffline(msg = "Daemon Offline"): void {
    if (this.isUserDisabled) return;
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

    // Export JSON Button
    let exportBtn = badge.querySelector<HTMLButtonElement>("#gemini-bridge-export-btn");
    if (!exportBtn) {
      exportBtn = document.createElement("button");
      exportBtn.id = "gemini-bridge-export-btn";
      exportBtn.innerText = "📥 JSON";
      exportBtn.title = "Export current chat history as Google AI Studio JSON to clipboard";
      exportBtn.style.cssText =
        "margin-left:6px;padding:2px 6px;border-radius:6px;font-size:10px;font-family:inherit;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.1);color:inherit;transition:all 0.2s;";
      badge.appendChild(exportBtn);

      exportBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onExportCallback?.();
      });
    }

    // Toggle Disconnect/Connect Button
    let btn = badge.querySelector<HTMLButtonElement>("#gemini-bridge-toggle-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "gemini-bridge-toggle-btn";
      btn.style.cssText =
        "margin-left:4px;padding:2px 6px;border-radius:6px;font-size:10px;font-family:inherit;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.1);color:inherit;transition:all 0.2s;";
      badge.appendChild(btn);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.isUserDisabled = !this.isUserDisabled;
        this.render();
        this.onToggleCallback?.(!this.isUserDisabled);
      });
    }

    btn.innerText = this.isUserDisabled ? "🔌 Connect" : "✕";
  }
}
