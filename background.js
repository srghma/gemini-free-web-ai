(() => {
  "use strict";

  const WS_URL = "ws://127.0.0.1:8765";
  let socket = null;
  const pendingQueue = [];

  const connect = () => {
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      console.log("[Background] Connected to local server.py daemon.");
      while (pendingQueue.length > 0) {
        socket.send(JSON.stringify(pendingQueue.shift()));
      }
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const { tabId, type, output, error } = data;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            action: "EXECUTION_RESULT",
            type,
            output,
            error,
          });
        }
      } catch (err) {
        console.error("[Background] Failed parsing server message:", err);
      }
    };

    socket.onclose = () => {
      console.warn("[Background] WebSocket closed. Reconnecting in 2s...");
      setTimeout(connect, 2000);
    };

    socket.onerror = (err) => {
      console.error("[Background] WebSocket error:", err);
      socket.close();
    };
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "EXECUTE_COMMAND") {
      const payload = {
        command: `execute-${message.type}-and-send-output-to`,
        type: message.type,
        code: message.code,
        tabId: sender.tab?.id,
      };

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      } else {
        pendingQueue.push(payload);
      }
      sendResponse({ status: "queued" });
    }
    return true;
  });

  connect();
})();
