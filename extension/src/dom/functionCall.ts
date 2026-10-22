import type { ActiveFunctionCall } from "../types";
import { setAngularValue, sleep, waitFor } from "./angular";

export const getLatestFunctionCallChunk = (): HTMLElement | null => {
  const turns = Array.from(document.querySelectorAll<HTMLElement>("ms-chat-turn"));
  if (turns.length === 0) return null;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn) continue;
    const chunk = turn.querySelector<HTMLElement>("ms-function-call-chunk");
    if (chunk) return chunk;
  }
  return null;
};

export const detectActiveFunctionCall = (): ActiveFunctionCall | null => {
  const chunk = getLatestFunctionCallChunk();
  if (!chunk) return null;

  const form = chunk.querySelector<HTMLFormElement>("form");
  const input = chunk.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (!form || !input) return null;

  // Extract function name from panel title
  const titleEl = chunk.querySelector<HTMLElement>(".header-content, mat-panel-title");
  const rawTitle = titleEl?.innerText?.trim() || "";
  const name = rawTitle.replace(/^function\s*/i, "").trim() || "execute_bash";

  // Extract JSON arguments from code block
  const codeEl = chunk.querySelector<HTMLElement>("code");
  const rawCode = codeEl?.innerText?.trim() || "{}";

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawCode);
  } catch {
    args = { raw: rawCode };
  }

  const callId = chunk.getAttribute("id") || `fn_${Date.now()}`;

  return {
    callId,
    name,
    args,
    rawCode,
  };
};

export const submitFunctionResponse = async (
  responseText: string,
  onProgress?: (msg: string) => void
): Promise<boolean> => {
  const chunk = await waitFor(() => getLatestFunctionCallChunk(), 4000, 50);
  if (!chunk) {
    console.warn("[Bridge] Cannot submit function response: chunk not found");
    return false;
  }

  const form = chunk.querySelector<HTMLFormElement>("form");
  const input = chunk.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (!form || !input) {
    console.warn("[Bridge] Cannot submit function response: form or input missing");
    return false;
  }

  onProgress?.("Injecting function response into form...");

  // 1. Angular value setter
  setAngularValue(input, responseText);

  // 2. Dispatch event triggers for reactive forms & ngModel
  const events = [
    "input",
    "blur",
    "compositionstart",
    "compositionend",
    "ngModelChange",
    "keydown",
    "focus",
  ];
  for (const ev of events) {
    input.dispatchEvent(new Event(ev, { bubbles: true }));
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));

  await sleep(120);

  // 3. Submit form
  if (form.requestSubmit) {
    try {
      form.requestSubmit();
      return true;
    } catch {}
  }

  const submitBtn = chunk.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submitBtn && !submitBtn.disabled && submitBtn.getAttribute("aria-disabled") !== "true") {
    submitBtn.click();
    return true;
  }

  return false;
};
