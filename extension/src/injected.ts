// Runs in page's MAIN world to intercept Google Closure XHR streaming RPCs
(() => {
  interface BridgeWindow extends Window {
    __gemini_bridge_injected?: boolean;
  }

  const win = window as unknown as BridgeWindow;
  if (win.__gemini_bridge_injected) return;
  win.__gemini_bridge_injected = true;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  let latestRequestModel = "";
  let latestRequestPayload: unknown = null;

  type XHRWithUrl = XMLHttpRequest & { _url?: string | URL };

  XMLHttpRequest.prototype.open = function (
    this: XHRWithUrl,
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null
  ): void {
    this._url = url;
    const fn = origOpen as (...args: unknown[]) => void;
    fn.apply(this, [method, url, async, username, password]);
  };

  XMLHttpRequest.prototype.send = function (
    this: XHRWithUrl,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const url = String(this._url || "");

    if (/MakerSuiteService\/GenerateContent/i.test(url)) {
      let parsedBody: unknown = null;

      try {
        if (typeof body === "string") {
          parsedBody = JSON.parse(body);
        }
      } catch {}

      if (Array.isArray(parsedBody)) {
        const first = parsedBody[0];
        if (typeof first === "string") {
          latestRequestModel = first;
        }
        latestRequestPayload = parsedBody;
      }

      window.dispatchEvent(
        new CustomEvent("gemini_generation_start", {
          detail: {
            model: latestRequestModel,
            payload: latestRequestPayload,
          },
        })
      );

      this.addEventListener("progress", () => {
        const text = this.responseText || "";
        window.dispatchEvent(
          new CustomEvent("gemini_generation_progress", {
            detail: {
              length: text.length,
              tail: text.slice(-400),
            },
          })
        );
      });

      this.addEventListener("load", () => {
        const fullResponse = this.responseText || "";
        window.dispatchEvent(
          new CustomEvent("gemini_generation_end", {
            detail: {
              model: latestRequestModel,
              fullResponse,
              requestPayload: latestRequestPayload,
            },
          })
        );
      });

      this.addEventListener("error", () => {
        window.dispatchEvent(new CustomEvent("gemini_generation_error"));
      });
      this.addEventListener("abort", () => {
        window.dispatchEvent(new CustomEvent("gemini_generation_error"));
      });
    }

    origSend.call(this, body);
  };

  window.addEventListener("gemini_trigger_export_json", () => {
    window.dispatchEvent(
      new CustomEvent("gemini_export_json_data", {
        detail: {
          model: latestRequestModel,
          requestPayload: latestRequestPayload,
        },
      })
    );
  });
})();
