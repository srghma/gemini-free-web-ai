// src/dom/angular.ts
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async <T>(
  predicate: () => T | null | undefined,
  timeout = 7000,
  step = 40
): Promise<T | null> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = predicate();
    if (result) return result;
    await sleep(step);
  }
  return null;
};

export const waitForEl = <T extends HTMLElement = HTMLElement>(
  selector: string,
  timeout = 7000
): Promise<T | null> =>
  waitFor(() => {
    const el = document.querySelector<T>(selector);
    return el &&
      (el.offsetParent !== null || selector.includes("option") || selector.includes("status"))
      ? el
      : null;
  }, timeout);

/**
 * Invokes Angular Ivy's native value setter pipeline to ensure two-way bindings update.
 */
export const setAngularValue = (el: HTMLInputElement | HTMLTextAreaElement, val: string): void => {
  el.focus();
  el.select?.();
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;

  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(el, val);
  } else {
    el.value = val;
  }

  el.dispatchEvent(new Event("focus", { bubbles: true }));
  el.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      inputType: "insertText",
      data: val,
    })
  );
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: val,
    })
  );
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  el.blur();
};
