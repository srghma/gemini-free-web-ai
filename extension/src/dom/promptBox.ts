import type { PromptBoxStatus } from "../types";
import { setAngularValue, sleep, waitFor, waitForEl } from "./angular";

export const getPromptTextarea = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(
    'ms-prompt-box textarea[formcontrolname="promptText"], ms-prompt-box textarea.textarea, textarea[aria-label*="prompt" i]'
  );

export const getSubmitButton = (): HTMLButtonElement | null => {
  const promptBox = document.querySelector("ms-prompt-box");
  if (promptBox) {
    const ctrlEnterBtn = promptBox.querySelector<HTMLButtonElement>(
      "button.ctrl-enter-submits:not(.rerun-button)"
    );
    if (ctrlEnterBtn) return ctrlEnterBtn;

    const primaryBtn = promptBox.querySelector<HTMLButtonElement>(
      "button.ms-button-primary:not(.rerun-button)"
    );
    if (primaryBtn) return primaryBtn;
  }
  return document.querySelector<HTMLButtonElement>("button.ctrl-enter-submits:not(.rerun-button)");
};

export const getPromptBoxStatus = (): PromptBoxStatus => {
  const textarea = getPromptTextarea();
  const runBtn = getSubmitButton();

  const labelEl = runBtn?.querySelector<HTMLElement>(".run-button-label");
  const rawLabel = (labelEl?.textContent || runBtn?.textContent || "").trim();
  const ariaLabel = (runBtn?.getAttribute("aria-label") || "").toLowerCase();

  const hasStop = rawLabel.toLowerCase().includes("stop") || ariaLabel.includes("stop");
  const hasSpinner = !!document.querySelector(
    "mat-progress-spinner, mat-spinner, .mat-mdc-progress-spinner, ms-run-button .spinner"
  );
  const isAiPrinting = hasStop || hasSpinner;
  const promptText = textarea?.value ?? "";
  const charCount = promptText.length;
  const isButtonDisabled = runBtn?.getAttribute("aria-disabled") === "true" || !!runBtn?.disabled;

  return {
    hasText: charCount > 0,
    charCount,
    promptText,
    buttonLabel: isAiPrinting ? "Stop" : rawLabel.split("\n")[0] || "Run",
    isButtonDisabled,
    isAiPrinting,
  };
};

export const submitPrompt = async (text: string): Promise<boolean> => {
  const promptInput = await waitForEl<HTMLTextAreaElement>(
    'ms-prompt-box textarea[formcontrolname="promptText"], ms-prompt-box textarea.textarea, textarea[aria-label*="prompt" i]',
    4000
  );
  if (!promptInput) return false;

  setAngularValue(promptInput, text);

  const runBtn =
    (await waitFor(
      () => {
        const btn = getSubmitButton();
        if (btn && btn.getAttribute("aria-disabled") !== "true" && !btn.disabled) return btn;
        return null;
      },
      400,
      40
    )) || getSubmitButton();

  const isDisabled = runBtn?.getAttribute("aria-disabled") === "true" || !!runBtn?.disabled;

  if (runBtn && !isDisabled) {
    runBtn.click();
    await sleep(150);
    if (!promptInput.value || promptInput.value !== text) return true;
  }

  promptInput.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
  return true;
};
