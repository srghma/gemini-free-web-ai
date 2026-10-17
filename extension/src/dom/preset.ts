import { CONFIG, TARGET_CONTENT } from "../config";
import { setAngularValue, sleep, waitFor, waitForEl } from "./angular";

export const ensurePresetSelected = async (): Promise<void> => {
  // 1. Wait reactively for either card or tuneBtn (resolves in ~200-500ms on new tab)
  const entry = await waitFor(
    () => {
      const card = document.querySelector<HTMLElement>(
        'button[aria-label="System instructions"], .system-instructions-card'
      );
      if (card && card.offsetParent !== null) return { type: "card" as const, el: card };

      const tuneBtn = document.querySelector<HTMLElement>(
        'button[aria-label="Toggle run settings panel"], .runsettings-toggle-button'
      );
      if (tuneBtn && tuneBtn.offsetParent !== null)
        return { type: "tuneBtn" as const, el: tuneBtn };

      if (card) return { type: "card" as const, el: card };
      return null;
    },
    7000,
    50
  );

  if (!entry) {
    console.warn("[Bridge] Neither card nor tuneBtn found within timeout.");
    return;
  }

  let card = entry.type === "card" ? entry.el : null;

  if (!card || card.offsetParent === null) {
    if (entry.type === "tuneBtn") {
      entry.el.click();
      await sleep(300);
    }
    card = await waitForEl<HTMLElement>(
      'button[aria-label="System instructions"], .system-instructions-card',
      4000
    );
  }

  if (!card) return;
  card.click();
  await sleep(350);

  // 2. Open preset dropdown
  const presetSelect = await waitFor(
    () => {
      const selects = Array.from(document.querySelectorAll<HTMLElement>("mat-select"));
      return selects.find(
        (s) => !/medium|low|high/i.test(s.innerText) && !/gemini/i.test(s.innerText)
      );
    },
    4000,
    50
  );

  if (!presetSelect) return;

  // If already set to REMOTE_AI_CONTROL, close and exit immediately
  if (presetSelect.innerText.includes(CONFIG.presetName)) {
    document.querySelector<HTMLButtonElement>('button[aria-label="Close panel"]')?.click();
    return;
  }

  presetSelect.click();
  await waitForEl("mat-option", 4000);

  const options = Array.from(document.querySelectorAll<HTMLElement>("mat-option"));
  const existingOpt = options.find((opt) => opt.innerText.includes(CONFIG.presetName));
  const createOpt = options.find((opt) => /create new instruction/i.test(opt.innerText));

  if (existingOpt) {
    existingOpt.click();
    await sleep(350);
  } else {
    if (createOpt) createOpt.click();
    else document.body.click();
    await sleep(400);
  }

  // 3. Upsert title & content if needed
  const titleInput = await waitForEl<HTMLInputElement>('input[placeholder="Title"]', 4000);
  const textarea = await waitForEl<HTMLTextAreaElement>(
    'textarea[aria-label="System instructions"], textarea.in-run-settings',
    4000
  );

  let needsSave = false;
  if (titleInput && titleInput.value.trim() !== CONFIG.presetName) {
    setAngularValue(titleInput, CONFIG.presetName);
    needsSave = true;
    await sleep(200);
  }

  if (textarea && textarea.value.trim() !== TARGET_CONTENT.trim()) {
    setAngularValue(textarea, TARGET_CONTENT);
    needsSave = true;
    await sleep(200);
  }

  if (needsSave) {
    await waitForEl(".saving-status.visible, [header].saving-status.visible", 4000);
    await sleep(300);
  }

  document.querySelector<HTMLButtonElement>('button[aria-label="Close panel"]')?.click();
  await sleep(200);
  if (window.innerWidth < 800) {
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Close run settings panel"]')
      ?.click();
  }
};
