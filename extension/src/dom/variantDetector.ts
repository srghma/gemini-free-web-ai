import type { PreferenceOption, PreferenceVoteData } from "../types";
import { sleep, waitFor } from "./angular";

export const detectPreferenceVote = (): PreferenceVoteData | null => {
  const voteEl = document.querySelector<HTMLElement>("ms-inline-preference-vote");
  if (!voteEl) return null;

  const header =
    voteEl.querySelector(".inline-preference-header")?.textContent?.trim() ||
    "Which response do you prefer?";

  const optionButtons = Array.from(
    voteEl.querySelectorAll<HTMLElement>("button.inline-preference-option, [data-test-side]")
  );
  if (optionButtons.length === 0) return null;

  const options: PreferenceOption[] = optionButtons.map((btn, idx) => {
    const sideAttr = btn.getAttribute("data-test-side");
    const side: "left" | "right" = sideAttr === "right" || idx === 1 ? "right" : "left";
    const text = btn.innerText?.trim() || "";
    return { index: idx, side, text };
  });

  const submitBtn = voteEl.querySelector<HTMLButtonElement>('button[data-test-id="submit-button"]');
  const isSubmitDisabled =
    !submitBtn || submitBtn.disabled || submitBtn.getAttribute("aria-disabled") === "true";

  return {
    question: header,
    options,
    hasSubmitButton: !!submitBtn,
    isSubmitDisabled,
  };
};

export const clickVariantChoice = async (index: number): Promise<boolean> => {
  const voteEl = document.querySelector<HTMLElement>("ms-inline-preference-vote");
  if (!voteEl) return false;

  const targetSelector = index === 0 ? '[data-test-side="left"]' : '[data-test-side="right"]';
  let targetBtn = voteEl.querySelector<HTMLElement>(targetSelector);
  if (!targetBtn) {
    const optionButtons = Array.from(
      voteEl.querySelectorAll<HTMLElement>("button.inline-preference-option")
    );
    targetBtn = optionButtons[index] ?? null;
  }

  if (targetBtn) {
    targetBtn.click();
    await sleep(250);
  }

  // Submit button becomes enabled once choice is selected
  const submitBtn = await waitFor(
    () => {
      const btn = voteEl.querySelector<HTMLButtonElement>('button[data-test-id="submit-button"]');
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") return btn;
      return null;
    },
    2000,
    50
  );

  if (submitBtn) {
    submitBtn.click();
    await sleep(200);
    return true;
  }

  // Fallback to skip button if submit is not clickable
  const skipBtn = voteEl.querySelector<HTMLButtonElement>('button[data-test-id="skip-button"]');
  if (skipBtn) {
    skipBtn.click();
    return true;
  }

  return false;
};
