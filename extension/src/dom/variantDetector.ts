import type { ProposedVariant } from "../types";

export interface VariantDetectionResult {
  hasVariants: boolean;
  variants: ProposedVariant[];
}

export const detectProposedVariants = (): VariantDetectionResult => {
  const fullText = document.body.innerText || "";
  const isPreferencePrompt = /which response do you prefer|which answer do you prefer/i.test(
    fullText
  );

  const allButtons = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"));

  const r1Btn = allButtons.find((b) =>
    /^(?:response|candidate|option|variant|draft)\s*1\b/i.test(
      (b.innerText || b.getAttribute("aria-label") || "").trim()
    )
  );
  const r2Btn = allButtons.find((b) =>
    /^(?:response|candidate|option|variant|draft)\s*2\b/i.test(
      (b.innerText || b.getAttribute("aria-label") || "").trim()
    )
  );

  if (isPreferencePrompt || (r1Btn && r2Btn)) {
    const textChunks = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".model-prompt-container, .turn-content, ms-prompt-chunk"
      )
    ).filter((c) => (c.innerText || "").length > 20);

    const v1Text =
      (r1Btn?.closest(".turn-content, .model-prompt-container") as HTMLElement)?.innerText ||
      textChunks[0]?.innerText ||
      "Variant 1";
    const v2Text =
      (r2Btn?.closest(".turn-content, .model-prompt-container") as HTMLElement)?.innerText ||
      textChunks[1]?.innerText ||
      "Variant 2";

    return {
      hasVariants: true,
      variants: [
        { index: 0, label: "Response 1", textSnippet: v1Text.slice(0, 300) },
        { index: 1, label: "Response 2", textSnippet: v2Text.slice(0, 300) },
      ],
    };
  }

  return { hasVariants: false, variants: [] };
};

export const clickVariantChoice = (index: number): boolean => {
  const allButtons = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"));

  const targetRegex =
    index === 0
      ? /^(?:response|candidate|option|variant|draft)\s*1\b/i
      : /^(?:response|candidate|option|variant|draft)\s*2\b/i;

  const btn = allButtons.find((b) =>
    targetRegex.test((b.innerText || b.getAttribute("aria-label") || "").trim())
  );

  if (btn) {
    btn.click();
    return true;
  }

  const skipBtn = allButtons.find((b) =>
    /^skip$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())
  );
  if (skipBtn) {
    skipBtn.click();
    return true;
  }

  return false;
};
