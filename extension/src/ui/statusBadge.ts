import type { AutomationMode, BridgeConnectionStatus, PromptBoxStatus } from "../types";

const getSavedAutomationMode = (): AutomationMode => {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem("gemini_bridge_automation_mode");
    if (saved === "auto" || saved === "manual") return saved;
  }
  return "auto";
};

const saveAutomationMode = (mode: AutomationMode): void => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("gemini_bridge_automation_mode", mode);
  }
};

const ensureBadgeButton = (
  badge: HTMLElement,
  id: string,
  onClick: (e: MouseEvent) => void,
  extraCss = "",
  insertBefore?: HTMLElement | null
): HTMLButtonElement => {
  let btn = badge.querySelector<HTMLButtonElement>(`#${id}`);
  if (!btn) {
    btn = document.createElement("button");
    btn.id = id;
    btn.style.cssText = `margin-left:4px;padding:2px 6px;border-radius:6px;font-size:10px;font-family:inherit;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.1);color:inherit;transition:all 0.2s;${extraCss}`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(e);
    });
    if (insertBefore) {
      badge.insertBefore(btn, insertBefore);
    } else {
      badge.appendChild(btn);
    }
  }
  return btn;
};

export class StatusBadgeManager {
  private state = {
    status: "offline" as BridgeConnectionStatus,
    label: "Connecting...",
  };

  private currentMode: AutomationMode = getSavedAutomationMode();
  private lastPromptStatus: PromptBoxStatus | undefined;
  private isUserDisabled = false;
  private isSendPending = false;

  private onToggleCallback: ((enabled: boolean) => void) | null = null;
  private onExportCallback: (() => void) | null = null;
  private onModeChangeCallback: ((mode: AutomationMode) => void) | null = null;
  private onSendCallback: (() => void) | null = null;

  constructor() {
    this.render();
  }

  public get mode(): AutomationMode {
    return this.currentMode;
  }

  public onToggle(cb: (enabled: boolean) => void): void {
    this.onToggleCallback = cb;
  }

  public onExport(cb: () => void): void {
    this.onExportCallback = cb;
  }

  public onModeChange(cb: (mode: AutomationMode) => void): void {
    this.onModeChangeCallback = cb;
  }

  public onSend(cb: () => void): void {
    this.onSendCallback = cb;
  }

  public setPendingSend(pending: boolean): void {
    this.isSendPending = pending;
    this.render();
  }

  public get isDisabled(): boolean {
    return this.isUserDisabled;
  }

  public setRunning(type: string, _timeout?: string): void {
    if (this.isUserDisabled) return;
    this.state.status = "running";
    this.state.label =
      type.startsWith("Executing") || type.startsWith("AI") || type.startsWith("Submitting")
        ? type
        : `Executing ${type.toUpperCase()}...`;
    this.render();
  }

  public setReady(msg = "Daemon Ready"): void {
    if (this.isUserDisabled) return;
    this.state.status = "ready";
    this.state.label = msg;
    this.render();
  }

  public setWaiting(msg = "Waiting for UI to settle..."): void {
    if (this.isUserDisabled) return;
    this.state.status = "waiting";
    this.state.label = msg;
    this.render();
  }

  public setReview(msg = "Review Commands"): void {
    if (this.isUserDisabled) return;
    this.state.status = "review";
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
    if (typeof document === "undefined") return;
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
      waiting: {
        bg: "rgba(33, 150, 243, 0.15)",
        fg: "#64b5f6",
        border: "rgba(100, 181, 246, 0.3)",
        icon: "⏳",
      },
      review: {
        bg: "rgba(171, 71, 188, 0.15)",
        fg: "#ce93d8",
        border: "rgba(206, 147, 216, 0.3)",
        icon: "⏸",
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
      labelText += ps.isAiPrinting ? " | ✍️ Printing" : " | ⏸ Idle";
    }

    let textSpan = badge.querySelector<HTMLSpanElement>("#gemini-bridge-text");
    if (!textSpan) {
      textSpan = document.createElement("span");
      textSpan.id = "gemini-bridge-text";
      badge.appendChild(textSpan);
    }
    textSpan.innerText = labelText;

    // Mode Switch Button (Auto vs Manual)
    const modeBtn = ensureBadgeButton(badge, "gemini-bridge-mode-btn", () => {
      this.currentMode = this.currentMode === "auto" ? "manual" : "auto";
      saveAutomationMode(this.currentMode);
      this.render();
      this.onModeChangeCallback?.(this.currentMode);
    });
    modeBtn.innerText = this.currentMode === "auto" ? "🤖 Auto" : "🖐️ Manual";
    modeBtn.title =
      this.currentMode === "auto"
        ? "Mode: Automatic (Commands sent to daemon immediately). Click to switch to Manual."
        : "Mode: Manual (Review commands before clicking Send). Click to switch to Automatic.";

    // Export JSON Button
    const exportBtn = ensureBadgeButton(badge, "gemini-bridge-export-btn", () => {
      this.onExportCallback?.();
    });
    exportBtn.innerText = "📥 JSON";
    exportBtn.title = "Export current chat history as Google AI Studio JSON to clipboard";

    // Manual Review Send Button
    const sendBtn = badge.querySelector<HTMLButtonElement>("#gemini-bridge-send-btn");
    if (this.isSendPending) {
      const activeSendBtn =
        sendBtn ||
        ensureBadgeButton(
          badge,
          "gemini-bridge-send-btn",
          () => this.onSendCallback?.(),
          "border:1px solid #81c784;background:#2e7d32;color:#ffffff;box-shadow:0 0 6px rgba(76,175,80,0.5);",
          exportBtn
        );
      activeSendBtn.innerText = "▶ Send";
      activeSendBtn.title = "Approve and send commands to daemon for execution";
    } else if (sendBtn) {
      sendBtn.remove();
    }

    // Toggle Disconnect/Connect Button
    const toggleBtn = ensureBadgeButton(badge, "gemini-bridge-toggle-btn", () => {
      this.isUserDisabled = !this.isUserDisabled;
      this.render();
      this.onToggleCallback?.(!this.isUserDisabled);
    });
    toggleBtn.innerText = this.isUserDisabled ? "🔌 Connect" : "✕";
  }
}
