import { CONFIG } from "../config";
import type { PromptBoxStatus } from "../types";
import { setAngularValue, sleep, waitFor } from "./angular";

const PROMPT_TEXTAREA_SELECTORS =
  'ms-prompt-box textarea[formcontrolname="promptText"], ms-prompt-box textarea.textarea, textarea[aria-label*="prompt" i]';

const SPINNER_SELECTORS = "mat-progress-spinner, mat-spinner, .mat-mdc-progress-spinner, .spinner";

export const closeAnyPaidApiKeyDialog = (): boolean => {
  const dialog = document.querySelector<HTMLElement>("mat-dialog-container ms-paid-usage-dialog");
  if (dialog) {
    const closeBtn =
      dialog.querySelector<HTMLButtonElement>('button[aria-label="close"], .close-button') ||
      dialog.querySelector<HTMLButtonElement>("button");
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
  }
  return false;
};

export const getPromptTextarea = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(PROMPT_TEXTAREA_SELECTORS);

export const getSubmitButton = (): HTMLButtonElement | null => {
  const promptBox = document.querySelector<HTMLElement>("ms-prompt-box");
  if (!promptBox) return null;

  // Search inside ms-prompt-box, strictly excluding paid-api-key and dialog buttons
  const candidates = Array.from(
    promptBox.querySelectorAll<HTMLButtonElement>(
      "button.run-button, button.ctrl-enter-submits, button.ms-button-primary"
    )
  );

  for (const btn of candidates) {
    if (
      btn.closest("ms-paid-api-key-button") ||
      btn.classList.contains("paid-api-key-button") ||
      btn.classList.contains("xap-inline-dialog") ||
      btn.classList.contains("rerun-button") ||
      btn.getAttribute("aria-label")?.toLowerCase().includes("api key") ||
      btn.getAttribute("dialoglabel")
    ) {
      continue;
    }
    return btn;
  }

  return null;
};

export const isRunButtonLoading = (btn?: HTMLButtonElement | null): boolean => {
  const targetBtn = btn ?? getSubmitButton();
  if (!targetBtn) return false;

  const labelEl = targetBtn.querySelector<HTMLElement>(".run-button-label");
  const rawLabel = (labelEl?.textContent || targetBtn.textContent || "").trim().toLowerCase();
  const ariaLabel = (targetBtn.getAttribute("aria-label") || "").toLowerCase();

  const hasStop = rawLabel.includes("stop") || ariaLabel.includes("stop");
  const hasSpinner = !!(
    targetBtn.querySelector(SPINNER_SELECTORS) ||
    document.querySelector(`ms-prompt-box ${SPINNER_SELECTORS}`) ||
    document.querySelector("ms-chat-turn mat-progress-spinner")
  );

  return hasStop || hasSpinner;
};

export const isPromptBoxReadyForSubmission = (): boolean => {
  const textarea = getPromptTextarea();
  if (!textarea || textarea.value.trim().length > 0) return false;

  const btn = getSubmitButton();
  if (!btn || isRunButtonLoading(btn)) return false;

  return true;
};

export const waitForReadyToSubmit = (
  minQuietMs = CONFIG.turnSettledMs,
  maxWaitMs = 30000,
  onProgress?: (msg: string) => void
): Promise<boolean> =>
  new Promise((resolve) => {
    closeAnyPaidApiKeyDialog();
    let lastMutation = Date.now();
    const start = Date.now();

    const observer = new MutationObserver((mutations) => {
      const isExternal = mutations.some((m) => {
        const target = m.target as HTMLElement | null;
        return !(target?.closest ? target : target?.parentElement)?.closest(
          "#gemini-bridge-status"
        );
      });
      if (isExternal) {
        lastMutation = Date.now();
      }
    });

    // Observe child additions, class/disabled attributes, and characterData (typewriter text streaming)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "disabled", "aria-disabled"],
    });

    const interval = setInterval(() => {
      closeAnyPaidApiKeyDialog();
      const now = Date.now();
      const quiet = now - lastMutation >= minQuietMs;
      const ready = isPromptBoxReadyForSubmission();

      if (quiet && ready) {
        clearInterval(interval);
        observer.disconnect();
        resolve(true);
        return;
      }

      if (now - start >= maxWaitMs) {
        clearInterval(interval);
        observer.disconnect();
        console.warn("[Bridge] waitForReadyToSubmit timeout exceeded", { quiet, ready });
        resolve(false);
        return;
      }

      if (!quiet) {
        onProgress?.("Waiting for AI animation / rendering to settle...");
      } else if (!ready) {
        const textarea = getPromptTextarea();
        if (textarea && textarea.value.trim().length > 0) {
          onProgress?.("Waiting for textarea to clear...");
        } else {
          onProgress?.("Waiting for Run button to become idle...");
        }
      }
    }, 100);
  });

export const getPromptBoxStatus = (): PromptBoxStatus => {
  const textarea = getPromptTextarea();
  const runBtn = getSubmitButton();

  const labelEl = runBtn?.querySelector<HTMLElement>(".run-button-label");
  const rawLabel = (labelEl?.textContent || runBtn?.textContent || "").trim();
  const isAiPrinting = isRunButtonLoading(runBtn);
  const promptText = textarea?.value ?? "";
  const charCount = promptText.length;
  const isButtonDisabled =
    !runBtn || runBtn.getAttribute("aria-disabled") === "true" || !!runBtn.disabled;

  return {
    hasText: charCount > 0,
    charCount,
    promptText,
    buttonLabel: isAiPrinting ? "Stop" : rawLabel.split("\n")[0] || "Run",
    isButtonDisabled,
    isAiPrinting,
  };
};

export const submitPrompt = async (
  text: string,
  onProgress?: (msg: string) => void,
  timeoutMs = 30000
): Promise<boolean> => {
  const isReady = await waitForReadyToSubmit(CONFIG.turnSettledMs, timeoutMs, onProgress);
  if (!isReady) {
    console.warn(
      "[Bridge] submitPrompt aborted: Prompt box was not ready (UI mutating, textarea non-empty, or button loading)"
    );
    return false;
  }

  const promptInput = getPromptTextarea();
  if (!promptInput) return false;

  setAngularValue(promptInput, text);

  const runBtn =
    (await waitFor(
      () => {
        const btn = getSubmitButton();
        if (
          btn &&
          !btn.disabled &&
          btn.getAttribute("aria-disabled") !== "true" &&
          !isRunButtonLoading(btn)
        ) {
          return btn;
        }
        return null;
      },
      1200,
      50
    )) || getSubmitButton();

  if (
    runBtn &&
    !runBtn.disabled &&
    runBtn.getAttribute("aria-disabled") !== "true" &&
    !isRunButtonLoading(runBtn)
  ) {
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
