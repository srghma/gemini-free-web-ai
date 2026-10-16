(() => {
  "use strict";

  const CONFIG = Object.freeze({
    wsUrl: "ws://127.0.0.1:8765",
    presetName: "REMOTE_AI_CONTROL",
    defaultTimeout: "60s",
    pollIntervalMs: 1000,
    domTimeoutMs: 7000,
  });

  const TARGET_CONTENT = `This page has injected chrome extension from ~/projects/gemini-free-web-ai/{content.js,...other extension files,server.py}

Also server.py is running as daemon on machine of user and at http://127.0.0.1:8765

This bridge is created to allow You (an autonomous AI agent) to execute python code commands directly on the user's machine to inspect code, debug, reproduce issues, and fix bugs.

### EXECUTION PROTOCOL
When you want to execute a command on the user's machine, output message with text

EXECUTE_NEXT_PYTHON
\`\`\`py
...python code
\`\`\`
or with a custom timeout (default is 1 minute; units: s, m, h, d):
EXECUTE_NEXT_PYTHON(timeout=2h)
\`\`\`py
...python code
\`\`\`

Chrome extension will scan chat, send to server over websocket command execute-python-and-send-output-to with code and timeout.
After execution is done:
- Normal completion:
  PREVOUS_{LANG}_OUTPUT
  ...
- If command timed out:
  PREVIOUS_{LANG}_TIMEOUT
  ...stdout and stderr with [e] and [o] markers
- If command errored:
  PREVIOUS_{LANG}_ERROR (status=n)
  ...stdout and stderr with [e] and [o] markers

User will initiate such long-running-tasks as usual by writing to this chrome tab. When task is finished, just output summary without EXECUTE_NEXT_* - this way cycle will be stopped.

Other supported commands are EXECUTE_NEXT_BASH, EXECUTE_NEXT_BUN (which also support timeout=...)

### GUIDELINES & ENVIRONMENT:
1. Environment: NixOS, zsh, bun, python, git, google-chrome-stable, rg, grep, find, fd. Imporant dirs are ~/.dotfiles and ~/projects
2. Non-interactive only: Never run interactive commands (e.g. nano, vim, man, commands waiting for confirmation). Always pass non-interactive flags like -y, --batch, or non-blocking parameters.
3. Autonomous Bug Fixing Cycle:
   - Phase 1 (Investigate): Identify the bug and relevant files.
   - Phase 2 (Diagnose): Run minimal commands to reproduce the failure.
   - Phase 3 (Patch): Apply targeted modifications to the affected source files.
   - Phase 4 (Verify): Re-run tests, builds, or checks to confirm the fix works.`;

  // --- Functional DOM Utilities ---
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitFor = async (predicate, timeout = CONFIG.domTimeoutMs, step = 150) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = predicate();
      if (result) return result;
      await sleep(step);
    }
    return null;
  };

  const waitForEl = (selector, timeout = CONFIG.domTimeoutMs) =>
    waitFor(() => {
      const el = document.querySelector(selector);
      return el && (el.offsetParent !== null || selector.includes("option") || selector.includes("status"))
        ? el
        : null;
    }, timeout);

  // Angular Ivy native setter pipeline
  const setAngularValue = (el, val) => {
    el.focus();
    el.select?.();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, val) ?? (el.value = val);

    const dispatch = (type, evtClass = Event, init = {}) =>
      el.dispatchEvent(new evtClass(type, { bubbles: true, ...init }));

    dispatch("focus");
    dispatch("beforeinput", InputEvent, { inputType: "insertText", data: val });
    dispatch("input", InputEvent, { inputType: "insertText", data: val });
    dispatch("keydown", KeyboardEvent, { key: "Enter", code: "Enter" });
    dispatch("keyup", KeyboardEvent, { key: "Enter", code: "Enter" });
    dispatch("change");
    dispatch("blur");
    el.blur();
  };

  // --- UI State Manager ---
  const StatusManager = (() => {
    let state = { status: "offline", label: "Connecting..." };

    const STYLES = {
      ready: { bg: "rgba(46, 125, 50, 0.15)", fg: "#81c784", border: "rgba(129, 199, 132, 0.3)", icon: "🟢" },
      running: { bg: "rgba(245, 124, 0, 0.15)", fg: "#ffb74d", border: "rgba(255, 183, 77, 0.3)", icon: "🟡" },
      offline: { bg: "rgba(211, 47, 47, 0.15)", fg: "#e57373", border: "rgba(229, 115, 115, 0.3)", icon: "🔴" },
    };

    const render = () => {
      const headerRight = document.querySelector("ms-header .toolbar-right");
      if (!headerRight) return;

      let badge = document.getElementById("gemini-bridge-status");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "gemini-bridge-status";
        badge.style.cssText =
          "display:inline-flex;align-items:center;gap:6px;padding:4px 10px;margin-right:8px;border-radius:12px;font-size:11px;font-family:monospace;font-weight:600;user-select:none;";
        headerRight.prepend(badge);
      }

      const style = STYLES[state.status] || STYLES.offline;
      badge.style.background = style.bg;
      badge.style.color = style.fg;
      badge.style.border = `1px solid ${style.border}`;
      badge.innerText = `${style.icon} ${state.label}`;
    };

    return {
      set: (newStatus, newLabel) => {
        state = { status: newStatus ?? state.status, label: newLabel ?? state.label };
        render();
      },
      render,
    };
  })();

  // --- Preset Synchronizer ---
  const ensurePresetSelected = async () => {
    // 1. Open sidebar if not already rendered
    let card = document.querySelector('button[aria-label="System instructions"], .system-instructions-card');
    if (!card || card.offsetParent === null) {
      const tuneBtn = await waitForEl('button[aria-label="Toggle run settings panel"], .runsettings-toggle-button');
      if (tuneBtn) {
        tuneBtn.click();
        await sleep(500);
      }
    }

    // 2. Open dialog
    card = await waitForEl('button[aria-label="System instructions"], .system-instructions-card');
    if (!card) return;
    card.click();
    await sleep(400);

    // 3. Open preset selector
    const presetSelect = Array.from(document.querySelectorAll("mat-select")).find(
      (s) => !/medium|low|high/i.test(s.innerText) && !/gemini/i.test(s.innerText)
    );
    if (!presetSelect) return;

    presetSelect.click();
    await waitForEl("mat-option", 4000);

    const options = Array.from(document.querySelectorAll("mat-option"));
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

    // 4. Update title & content if required
    const titleInput = await waitForEl('input[placeholder="Title"]', 4000);
    const textarea = await waitForEl('textarea[aria-label="System instructions"], textarea.in-run-settings', 4000);

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

    // 5. Wait for "Saved" confirmation indicator
    if (needsSave) {
      await waitForEl(".saving-status.visible, [header].saving-status.visible", 4000);
      await sleep(400);
    }

    // 6. Close dialog & sidebar
    document.querySelector('button[aria-label="Close panel"]')?.click();
    await sleep(300);
    if (window.innerWidth < 800) {
      document.querySelector('button[aria-label="Close run settings panel"]')?.click();
    }
  };

  // --- Output Formatter Pipeline ---
  const formatExecutionReply = ({ type, output, timedOut, exitCode }) => {
    const lang = (type || "PYTHON").toUpperCase();
    const content = output || "";

    if (timedOut) {
      return `PREVIOUS_${lang}_TIMEOUT\n${content}`;
    }
    if (exitCode !== 0) {
      return `PREVIOUS_${lang}_ERROR (status=${exitCode})\n${content}`;
    }
    return `PREVOUS_${lang}_OUTPUT\n${content}`;
  };

  const submitPrompt = async (text) => {
    const promptInput = await waitForEl(
      'textarea[aria-label*="prompt" i], textarea[placeholder*="prompt" i], textarea.textarea'
    );
    if (!promptInput) return;

    setAngularValue(promptInput, text);
    await sleep(300);

    promptInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        ctrlKey: true,
        bubbles: true,
      })
    );
  };

  // --- WebSocket Connection ---
  const createWebSocket = () => {
    const socket = new WebSocket(CONFIG.wsUrl);

    socket.onopen = () => {
      console.log("[Bridge] Connected to daemon.");
      StatusManager.set("ready", "Bridge Ready");
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.status === "running") {
          StatusManager.set("running", `Running ${data.type.toUpperCase()}...`);
          return;
        }

        StatusManager.set("ready", "Bridge Ready");
        submitPrompt(formatExecutionReply(data));
      } catch (err) {
        console.error("[Bridge] Failed parsing message:", err);
      }
    };

    socket.onclose = () => {
      StatusManager.set("offline", "Server Offline");
      setTimeout(createWebSocket, 2000);
    };

    socket.onerror = () => socket.close();

    return socket;
  };

  // --- Turn Scanner ---
  const startTurnScanner = (getSocket) => {
    let lastHandledText = "";

    setInterval(() => {
      StatusManager.render();

      if (document.querySelector('button[aria-label*="Stop" i]')) return;

      const turns = document.querySelectorAll("ms-chat-turn, .model-response-text, ms-model-chunk");
      if (turns.length === 0) return;

      const text = turns[turns.length - 1].innerText?.trim() || "";
      if (!text || text === lastHandledText) return;

      const match = text.match(
        /(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?(?:s|m|h|d)?)\))?[\s\S]*?```(?:py|python|bash|sh|zsh|bun|js|ts)?\s*\n([\s\S]*?)```/i
      );

      if (match) {
        lastHandledText = text;
        const [, rawType, timeoutRaw, code] = match;
        const type = rawType.toLowerCase().replace("execute_next_", "");
        const timeout = timeoutRaw || CONFIG.defaultTimeout;

        StatusManager.set("running", `Queued ${type.toUpperCase()} (${timeout})...`);

        const socket = getSocket();
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              command: `execute-${type}-and-send-output-to`,
              type,
              timeout,
              code: code.trim(),
            })
          );
        }
      }
    }, CONFIG.pollIntervalMs);
  };

  // --- Bootstrap ---
  (async () => {
    let activeSocket = createWebSocket();
    await ensurePresetSelected();
    startTurnScanner(() => activeSocket);
  })();
})();
