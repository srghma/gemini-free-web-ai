import { CONFIG, TARGET_CONTENT } from "../config";
import { setAngularValue, sleep, waitForEl } from "./angular";

/**
 * Preserves the exact, working system instruction injection implementation.
 */
export const ensurePresetSelected = async (): Promise<void> => {
  let card = document.querySelector<HTMLElement>(
    'button[aria-label="System instructions"], .system-instructions-card'
  );
  if (!card || card.offsetParent === null) {
    const tuneBtn = await waitForEl<HTMLElement>(
      'button[aria-label="Toggle run settings panel"], .runsettings-toggle-button'
    );
    if (tuneBtn) {
      tuneBtn.click();
      await sleep(500);
    }
  }

  card = await waitForEl<HTMLElement>(
    'button[aria-label="System instructions"], .system-instructions-card'
  );
  if (!card) return;
  card.click();
  await sleep(400);

  const presetSelect = Array.from(document.querySelectorAll<HTMLElement>("mat-select")).find(
    (s) => !/medium|low|high/i.test(s.innerText) && !/gemini/i.test(s.innerText)
  );
  if (!presetSelect) return;

  presetSelect.click();
  await waitForEl("mat-option", 4000);

  const options = Array.from(document.querySelectorAll<HTMLElement>("mat-option"));
  const existingOpt = options.find((opt) => opt.innerText.includes(CONFIG.presetName));
  const createOpt = options.find((opt) => /create new instruction/i.test(opt.innerText));

  if (existingOpt) {
    existingOpt.click();
    await sleep(400);
  } else {
    if (createOpt) createOpt.click();
    else document.body.click();
    await sleep(500);
  }

  const titleInput = await waitForEl<HTMLInputElement>('input[placeholder="Title"]', 4000);
  const textarea = await waitForEl<HTMLTextAreaElement>(
    'textarea[aria-label="System instructions"], textarea.in-run-settings',
    4000
  );

  let needsSave = false;
  if (titleInput && titleInput.value.trim() !== CONFIG.presetName) {
    setAngularValue(titleInput, CONFIG.presetName);
    needsSave = true;
    await sleep(300);
  }

  if (textarea && textarea.value.trim() !== TARGET_CONTENT.trim()) {
    setAngularValue(textarea, TARGET_CONTENT);
    needsSave = true;
    await sleep(300);
  }

  if (needsSave) {
    await waitForEl(".saving-status.visible, [header].saving-status.visible", 4000);
    await sleep(400);
  }

  document.querySelector<HTMLButtonElement>('button[aria-label="Close panel"]')?.click();
  await sleep(300);
  if (window.innerWidth < 800) {
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Close run settings panel"]')
      ?.click();
  }
};
