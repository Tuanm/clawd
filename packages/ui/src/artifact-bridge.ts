// Bridge script injected into React artifact iframes.
// Creates window.ClauwdBridge with a narrow, safe postMessage-based API.
// Must use ES5 syntax — no module support in sandboxed iframes.

export interface BridgeContext {
  messagTs: string;
  channel: string;
}

export function generateBridgeScript(context: BridgeContext): string {
  return `(function() {
  var pendingActions = {};
  var actionListeners = [];
  var context = { message_ts: "${escapeJs(context.messagTs)}", channel: "${escapeJs(context.channel)}" };

  window.addEventListener('message', function(ev) {
    if (ev.data && ev.data.type === 'clawd-action-result' && pendingActions[ev.data.requestId]) {
      pendingActions[ev.data.requestId](ev.data);
      delete pendingActions[ev.data.requestId];
    }
    if (ev.data && ev.data.type === 'clawd-action-broadcast') {
      actionListeners.forEach(function(cb) { cb(ev.data); });
    }
  });

  window.ClauwdBridge = Object.freeze({
    sendAction: function(actionId, value) {
      return new Promise(function(resolve) {
        var requestId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        pendingActions[requestId] = resolve;
        parent.postMessage({ type: 'clawd-action', requestId: requestId, actionId: actionId, value: value }, '*');
        setTimeout(function() {
          if (pendingActions[requestId]) {
            delete pendingActions[requestId];
            resolve({ ok: false, error: 'timeout' });
          }
        }, 10000);
      });
    },
    getContext: function() { return context; },
    onActionResult: function(cb) { actionListeners.push(cb); }
  });
})();`;
}

/** Escape a string value for safe embedding in a JS string literal. */
function escapeJs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
