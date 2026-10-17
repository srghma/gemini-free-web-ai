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

  const patchOpen = function (
    this: XHRWithUrl,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    this._url = url;
    if (typeof async === "boolean") {
      const fn = origOpen as (
        m: string,
        u: string | URL,
        a: boolean,
        un?: string | null,
        pw?: string | null
      ) => void;
      fn.call(this, method, url, async, username, password);
    } else {
      const fn = origOpen as (m: string, u: string | URL) => void;
      fn.call(this, method, url);
    }
  };
  XMLHttpRequest.prototype.open = patchOpen as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function (
    this: XHRWithUrl,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const url = String(this._url || "");

    if (/MakerSuiteService\/GenerateContent/i.test(url)) {
      let parsedBody: unknown = null;
      let lastText = "";

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

      const cacheChunk = () => {
        if (this.responseText && this.responseText.length >= lastText.length) {
          lastText = this.responseText;
        }
      };

      this.addEventListener("progress", cacheChunk);

      const notifyFinished = () => {
        if (lastText.length === 0 && this.responseText) {
          lastText = this.responseText;
        }
        if (lastText.length > 0) {
          window.dispatchEvent(
            new CustomEvent("gemini_generation_end", {
              detail: {
                model: latestRequestModel,
                fullResponse: lastText,
                requestPayload: latestRequestPayload,
              },
            })
          );
          lastText = "";
        }
      };

      this.addEventListener("readystatechange", () => {
        if (this.readyState === 3) cacheChunk();
        if (this.readyState === 0 || this.readyState === 4) notifyFinished();
      });

      this.addEventListener("abort", notifyFinished);
      this.addEventListener("loadend", notifyFinished);
      this.addEventListener("error", () => {
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
