/**
 * Vite plugin for stackpack-debug.
 * Injects console/error/network capture directly into HTML served by Vite.
 *
 * This is critical for Tauri/Electron apps where the webview loads from
 * the Vite dev server directly (not through the stackpack-debug proxy).
 *
 * Usage in vite.config.ts:
 *   import debugToolkit from 'stackpack-debug/vite-plugin';
 *   export default defineConfig({ plugins: [debugToolkit()] });
 *
 * Or auto-configured by `npx stackpack-debug init` for Tauri projects.
 */

import type { Plugin } from "vite";

export interface DebugToolkitPluginOptions {
  /** Port the stackpack-debug proxy WebSocket listens on. Default: auto-detect from env or 2420 */
  wsPort?: number;
  /** Disable in production builds. Default: true (only active in dev) */
  devOnly?: boolean;
  /** When true, inject an import() that calls stackpack-state's autoAttach() during dev. */
  stateTelemetry?: boolean;
}

/** Alias for DebugToolkitPluginOptions */
export type StackpackDebugOptions = DebugToolkitPluginOptions;

export default function debugToolkitPlugin(opts: DebugToolkitPluginOptions = {}): Plugin {
  const devOnly = opts.devOnly ?? true;
  let wsPort = opts.wsPort ?? parseInt(process.env.DEBUG_TOOLKIT_WS_PORT ?? "0", 10);

  return {
    name: "stackpack-debug",
    apply: devOnly ? "serve" : undefined,

    configResolved(config) {
      // Auto-detect WS port: proxy listens on devServerPort + 1000
      if (!wsPort && config.server?.port) {
        wsPort = config.server.port + 1000;
      }
      if (!wsPort) {
        wsPort = 2420; // fallback
      }
    },

    transformIndexHtml(html: string) {
      // Inline the capture script — connects back to toolkit's WebSocket
      const script = buildInlineScript(wsPort);
      const tags = [
        {
          tag: "script" as const,
          attrs: { "data-stackpack-debug": "true" },
          children: script,
          injectTo: "body" as const,
        },
      ];

      if (opts.stateTelemetry) {
        const inject =
          `<script type="module">\n  import('stackpack-state/telemetry').then(m => m.autoAttach()).catch(() => {});\n</script>`;
        const injectedHtml = html.includes("</body>")
          ? html.replace("</body>", `${inject}\n</body>`)
          : html + inject;
        return { html: injectedHtml, tags };
      }

      return tags;
    },
  };
}

/** Named export alias — preferred for new consumers */
export { debugToolkitPlugin as stackpackDebug };

function buildInlineScript(wsPort: number): string {
  return `
(function() {
  "use strict";
  if (window.__stackpack_debug_injected) return;
  window.__stackpack_debug_injected = true;

  var hostPort = "127.0.0.1:${wsPort}";
  var wsUrl = "ws://" + hostPort + "/__stackpack_debug/ws";
  var toolkitOrigins = ["ws://" + hostPort, "http://" + hostPort];
  var ws;
  var queue = [];
  var reconnectAttempts = 0;
  var maxReconnects = 5;

  // --- CSP self-diagnosis -------------------------------------------------
  // If the host page's Content Security Policy blocks our WS/HTTP origin,
  // the connect() call below fails silently. Listen for the standard
  // securitypolicyviolation event and render an in-page banner so the user
  // knows exactly what to add to their CSP.
  var cspBannerShown = {};
  function isToolkitBlock(blockedURI) {
    if (!blockedURI || typeof blockedURI !== "string") return false;
    if (blockedURI === "inline" || blockedURI === "eval") return false;
    for (var i = 0; i < toolkitOrigins.length; i++) {
      if (blockedURI.indexOf(toolkitOrigins[i]) === 0) return true;
    }
    return blockedURI.indexOf(hostPort) !== -1;
  }
  function renderCspBanner(directive, blockedURI) {
    var dedupeKey = directive + "|" + blockedURI;
    if (cspBannerShown[dedupeKey]) return;
    cspBannerShown[dedupeKey] = true;
    try {
      if (sessionStorage.getItem("__stackpack_csp_banner_dismissed") === "1") return;
    } catch (_) {}
    if (document.getElementById("__stackpack-csp-banner")) return;

    var snippet = (directive || "connect-src") + " ws://" + hostPort + " http://" + hostPort;
    var wrap = document.createElement("div");
    wrap.id = "__stackpack-csp-banner";
    wrap.setAttribute("style",
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;" +
      "background:#fff3cd;color:#664d03;border-top:2px solid #ffc107;" +
      "font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;" +
      "padding:12px 16px;box-shadow:0 -2px 8px rgba(0,0,0,0.08);"
    );
    var heading = document.createElement("div");
    heading.setAttribute("style", "font-weight:600;margin-bottom:4px;");
    heading.textContent = "stackpack-debug was blocked by your Content Security Policy.";
    var detail = document.createElement("div");
    detail.setAttribute("style", "margin-bottom:6px;");
    detail.textContent = "Blocked: " + blockedURI + " (directive: " + (directive || "connect-src") + "). Add this to your connect-src directive:";
    var codeRow = document.createElement("div");
    codeRow.setAttribute("style", "display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;");
    var code = document.createElement("code");
    code.setAttribute("style", "background:#fff;border:1px solid #e0cfa0;padding:4px 8px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all;");
    code.textContent = snippet;
    var copyBtn = document.createElement("button");
    copyBtn.setAttribute("type", "button");
    copyBtn.setAttribute("style", "background:#ffc107;color:#664d03;border:none;padding:4px 10px;border-radius:4px;font:inherit;cursor:pointer;");
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", function() {
      try {
        navigator.clipboard.writeText(snippet);
        copyBtn.textContent = "Copied ✓";
        setTimeout(function() { copyBtn.textContent = "Copy"; }, 2000);
      } catch (_) {}
    });
    codeRow.appendChild(code);
    codeRow.appendChild(copyBtn);
    var footer = document.createElement("div");
    footer.setAttribute("style", "display:flex;justify-content:space-between;align-items:center;");
    var learn = document.createElement("a");
    learn.setAttribute("href", "https://github.com/stackpackdev/debug#csp");
    learn.setAttribute("target", "_blank");
    learn.setAttribute("rel", "noopener");
    learn.setAttribute("style", "color:#664d03;text-decoration:underline;");
    learn.textContent = "Learn more";
    var dismiss = document.createElement("button");
    dismiss.setAttribute("type", "button");
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.setAttribute("style", "background:transparent;border:none;color:#664d03;font-size:18px;line-height:1;cursor:pointer;padding:0 4px;");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", function() {
      try { sessionStorage.setItem("__stackpack_csp_banner_dismissed", "1"); } catch (_) {}
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    });
    footer.appendChild(learn);
    footer.appendChild(dismiss);
    wrap.appendChild(heading);
    wrap.appendChild(detail);
    wrap.appendChild(codeRow);
    wrap.appendChild(footer);
    if (document.body) {
      document.body.appendChild(wrap);
    } else {
      document.addEventListener("DOMContentLoaded", function() {
        if (document.body) document.body.appendChild(wrap);
      }, { once: true });
    }
  }
  document.addEventListener("securitypolicyviolation", function(e) {
    if (!isToolkitBlock(e.blockedURI)) return;
    var directive = e.effectiveDirective || e.violatedDirective || "connect-src";
    renderCspBanner(directive, e.blockedURI);
  });

  function send(type, data) {
    var msg = JSON.stringify({ type: type, data: data, ts: Date.now() });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      queue.push(msg);
      if (queue.length > 100) queue.shift();
    }
  }

  function connect() {
    try { ws = new WebSocket(wsUrl); } catch (_) { return; }
    ws.addEventListener("open", function() {
      reconnectAttempts = 0;
      send("console", { level: "info", args: ["[stackpack-debug] Connected to capture server"] });
      for (var i = 0; i < queue.length; i++) ws.send(queue[i]);
      queue = [];
    });
    ws.addEventListener("close", function() {
      if (reconnectAttempts >= maxReconnects) return;
      var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 16000);
      reconnectAttempts++;
      setTimeout(connect, delay);
    });
    ws.addEventListener("error", function() {});
  }
  connect();

  // Console capture
  ["log", "warn", "error", "info", "debug"].forEach(function(method) {
    var orig = console[method];
    console[method] = function() {
      var args = Array.prototype.slice.call(arguments);
      send("console", {
        level: method,
        args: args.map(function(a) {
          try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
          catch (_) { return "[unserializable]"; }
        })
      });
      return orig.apply(console, arguments);
    };
  });

  // Error capture
  window.addEventListener("error", function(e) {
    send("error", { message: e.message, source: e.filename, line: e.lineno, column: e.colno });
  });
  window.addEventListener("unhandledrejection", function(e) {
    send("error", { message: e.reason ? String(e.reason) : "Unhandled promise rejection", type: "unhandledrejection" });
  });

  // Fetch failure capture
  var origFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var url = String(args[0] && args[0].url ? args[0].url : args[0]);
    var method = (args[1] && args[1].method) || (args[0] && args[0].method) || "GET";
    return origFetch.apply(this, args).then(
      function(res) {
        if (!res.ok) send("network", { url: url, method: method, status: res.status, statusText: res.statusText });
        return res;
      },
      function(err) {
        send("network", { url: url, method: method, error: err.message || String(err) });
        throw err;
      }
    );
  };

  // XHR failure capture
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._dbg_method = method;
    this._dbg_url = String(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    self.addEventListener("load", function() {
      if (self.status >= 400) send("network", { url: self._dbg_url, method: self._dbg_method, status: self.status, statusText: self.statusText });
    });
    self.addEventListener("error", function() {
      send("network", { url: self._dbg_url, method: self._dbg_method, error: "Network error" });
    });
    return origSend.apply(this, arguments);
  };
})();
`.trim();
}
