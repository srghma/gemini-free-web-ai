(() => {
  "use strict";

  const PRESET_NAME = "REMOTE_AI_CONTROL";
  const TARGET_CONTENT = `This page has injected chrome extension from ~/projects/gemini-free-web-ai/{content.js,...other extension files,server.py}

Also server.py is running as daemon on machine of user and at http://127.0.0.1:8765

This bridge is created to allow You (an autonomous AI agent) to execute python code commands directly on the user's machine to inspect code, debug, reproduce issues, and fix bugs.

### EXECUTION PROTOCOL
When you want to execute a command on the user's machine, output message with text

EXECUTE_NEXT_PYTHON
\`\`\`py
...python code
\`\`\`

Chrome extension will scan chat, send to server over websocket command execute-python-and-send-output-to with code, and tabId (to send outputs back). After execution is done - server will send to extension the output of command as ordinary message like

PREVOUS_PYTHON_OUTPUT
...

if there was error then

PREVOUS_PYTHON_ERROR
...

will be added.

User will initiate such long-running-tasks as usual by writing to this chrome tab. When task is finished, just output summary without EXECUTE_NEXT_PYTHON - this way cycle will be stopped.

Other supported commands are EXECUTE_NEXT_BASH,EXECUTE_NEXT_BUN

### GUIDELINES & ENVIRONMENT:
1. Environment: NixOS, zsh, bun, python, git, google-chrome-stable, rg, grep, find, fd. Imporant dirs are ~/.dotfiles and ~/projects
2. Non-interactive only: Never run interactive commands (e.g. nano, vim, man, commands waiting for confirmation). Always pass non-interactive flags like -y, --batch, or non-blocking parameters.
3. Autonomous Bug Fixing Cycle:
   - Phase 1 (Investigate): Identify the bug and relevant files.
   - Phase 2 (Diagnose): Run minimal commands to reproduce the failure.
   - Phase 3 (Patch): Apply targeted modifications to the affected source files.
   - Phase 4 (Verify): Re-run tests, builds, or checks to confirm the fix works.`;

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let lastHandledTurnText = "";

  // Angular-safe native input setter
  const setAngularValue = (el, val) => {
    el.focus();
    el.select?.();
    const protoSetter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    )?.set;

    if (protoSetter) {
      protoSetter.call(el, val);
    } else {
      el.value = val;
    }

    el.dispatchEvent(new Event("focus", { bubbles: true }));
    el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: val }));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    el.blur();
  };

  const ensurePresetSelected = async () => {
    await sleep(1500);

    // 1. Open sidebar if not visible
    let card = document.querySelector('button[aria-label="System instructions"], .system-instructions-card');
    if (!card || card.offsetParent === null) {
      const tuneBtn = document.querySelector('button[aria-label="Toggle run settings panel"], .runsettings-toggle-button');
      if (tuneBtn) {
        tuneBtn.click();
        await sleep(500);
      }
    }

    // 2. Open System Instructions modal
    card = document.querySelector('button[aria-label="System instructions"], .system-instructions-card');
    if (card) {
      card.click();
      await sleep(600);
    }

    // 3. Find preset dropdown
    const presetSelect = Array.from(document.querySelectorAll("mat-select"))
      .find((s) => !/medium|low|high/i.test(s.innerText));
    if (!presetSelect) return;

    presetSelect.click();
    await sleep(400);

    const options = Array.from(document.querySelectorAll("mat-option"));
    const existingOpt = options.find((opt) => opt.innerText.includes(PRESET_NAME));
    const untitledOpt = options.find((opt) => opt.innerText.replace(/\n/g, " ").trim() === "Untitled");
    const createOpt = options.find((opt) => /create new instruction/i.test(opt.innerText));

    const titleInput = document.querySelector('input[placeholder="Title"]');
    const textarea = document.querySelector('textarea[aria-label="System instructions"], textarea.in-run-settings');

    if (existingOpt) {
      existingOpt.click();
      await sleep(400);
    } else if (untitledOpt) {
      untitledOpt.click();
      await sleep(400);
      if (titleInput) setAngularValue(titleInput, PRESET_NAME);
      await sleep(300);
    } else {
      if (createOpt) {
        createOpt.click();
        await sleep(400);
      } else {
        document.body.click();
        await sleep(200);
      }
      if (titleInput) setAngularValue(titleInput, PRESET_NAME);
      await sleep(300);
    }

    // 4. Update content if differs
    if (textarea && textarea.value.trim() !== TARGET_CONTENT.trim()) {
      setAngularValue(textarea, TARGET_CONTENT);
      await sleep(300);
      if (titleInput && titleInput.value.trim() !== PRESET_NAME) {
        setAngularValue(titleInput, PRESET_NAME);
        await sleep(200);
      }
    }

    // 5. Close dialog & sidebar
    const closeSubPanel = document.querySelector('button[aria-label="Close panel"]');
    if (closeSubPanel) {
      closeSubPanel.click();
      await sleep(400);
    }

    if (window.innerWidth < 800) {
      const closeSidebar = document.querySelector('button[aria-label="Close run settings panel"]');
      if (closeSidebar) {
        closeSidebar.click();
        await sleep(300);
      }
    }
  };

  const submitPrompt = async (text) => {
    const promptInput = document.querySelector(
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

  // Watch for AI turns with command execution tags
  const startTurnScanner = () => {
    setInterval(() => {
      // If currently generating, wait
      if (document.querySelector('button[aria-label*="Stop" i]')) return;

      const turns = document.querySelectorAll("ms-chat-turn, .model-response-text, ms-model-chunk");
      if (turns.length === 0) return;

      const lastTurn = turns[turns.length - 1];
      const text = lastTurn.innerText?.trim() || "";

      if (!text || text === lastHandledTurnText) return;

      const cmdMatch = text.match(
        /(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)[\s\S]*?```(?:py|python|bash|sh|zsh|bun|js|ts)?\s*\n([\s\S]*?)```/i
      );

      if (cmdMatch) {
        lastHandledTurnText = text;
        const rawType = cmdMatch[1].toUpperCase();
        const type = rawType.includes("PYTHON") ? "python" : rawType.includes("BASH") ? "bash" : "bun";
        const code = cmdMatch[2].trim();

        console.log(`[Content] Found ${type} command to execute:\n`, code);
        chrome.runtime.sendMessage({
          action: "EXECUTE_COMMAND",
          type,
          code,
        });
      }
    }, 1000);
  };

  // Receive execution results and feed back to prompt
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "EXECUTION_RESULT") {
      const { type, output, error } = message;
      const upper = type.toUpperCase();

      let reply = `PREVOUS_${upper}_OUTPUT\n${output || ""}`;
      if (error && error.trim().length > 0) {
        reply += `\n\nPREVOUS_${upper}_ERROR\n${error.trim()}`;
      }

      console.log(`[Content] Submitting ${upper} execution result to AI Studio...`);
      submitPrompt(reply);
    }
  });

  (async () => {
    await ensurePresetSelected();
    startTurnScanner();
  })();
})();
