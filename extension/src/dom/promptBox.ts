import type { PromptBoxStatus } from "../types";
import { setAngularValue, sleep, waitForEl } from "./angular";

export const getPromptBoxStatus = (): PromptBoxStatus => {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'ms-prompt-box textarea[formcontrolname="promptText"], ms-prompt-box textarea.textarea'
  );
  const runBtn = document.querySelector<HTMLButtonElement>(
    "ms-prompt-box ms-run-button button, ms-prompt-box button.run-button"
  );
  const labelEl = runBtn?.querySelector<HTMLElement>(".run-button-label");
  const iconEl = runBtn?.querySelector<HTMLElement>(".material-symbols-outlined");

  const rawLabel = (labelEl?.textContent || "").trim();
  const rawIcon = (iconEl?.textContent || "").trim().toLowerCase();
  const ariaLabel = (runBtn?.getAttribute("aria-label") || "").toLowerCase();

  const hasStopText =
    rawLabel.toLowerCase().includes("stop") || ariaLabel.includes("stop") || rawIcon === "stop";
  const hasSpinner = !!document.querySelector(
    "mat-progress-spinner, mat-spinner, .mat-mdc-progress-spinner, ms-run-button .spinner"
  );
  const hasCancelBtn = !!document.querySelector(
    'button[aria-label*="Stop" i], button[aria-label*="Cancel" i]'
  );

  const isAiPrinting = hasStopText || hasSpinner || hasCancelBtn;
  const charCount = textarea?.value?.length ?? 0;
  const isButtonDisabled = runBtn?.getAttribute("aria-disabled") === "true" || !!runBtn?.disabled;

  return {
    hasText: charCount > 0,
    charCount,
    buttonLabel: isAiPrinting ? "Stop" : rawLabel || "Run",
    isButtonDisabled,
    isAiPrinting,
  };
};

export const submitPrompt = async (text: string): Promise<boolean> => {
  const promptInput = await waitForEl<HTMLTextAreaElement>(
    'ms-prompt-box textarea[formcontrolname="promptText"], textarea[aria-label*="prompt" i], textarea.textarea'
  );
  if (!promptInput) {
    console.error("[Bridge] Prompt textarea not found");
    return false;
  }

  setAngularValue(promptInput, text);
  await sleep(350);

  const runBtn = document.querySelector<HTMLButtonElement>(
    'ms-run-button button, button.run-button, button[aria-label*="Run" i]'
  );

  const isDisabled = runBtn?.getAttribute("aria-disabled") === "true" || !!runBtn?.disabled;

  if (runBtn && !isDisabled) {
    runBtn.click();
    return true;
  }

  // Fallback to Ctrl+Enter
  promptInput.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
      bubbles: true,
    })
  );
  return true;
};
