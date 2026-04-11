/**
 * browser-capture.ts — Generate browser console scripts for closed agent platforms.
 *
 * Each platform has a different DOM structure for the preview iframe.
 * This module generates the correct capture script for each platform,
 * which the user pastes into their browser console.
 *
 * The script:
 * 1. Finds the preview iframe (platform-specific selector)
 * 2. Injects error/network listeners into the iframe's content window
 * 3. Sends captured events to a local WebSocket server (localhost only)
 * 4. Re-injects on iframe navigation (SPA route changes, HMR reloads)
 */

export type AgentPlatform = "lovable" | "bolt" | "replit" | "base44" | "custom";

interface PlatformConfig {
  name: string;
  urlPattern: RegExp;
  previewSelector: string;        // CSS selector for the preview iframe
  terminalSelector: string | null; // CSS selector for terminal output (if available)
  description: string;
}

const PLATFORMS: Record<AgentPlatform, PlatformConfig> = {
  lovable: {
    name: "Lovable",
    urlPattern: /lovable\.dev/,
    previewSelector: 'iframe[title*="preview" i], iframe[src*="webcontainer"], iframe[class*="preview"]',
    terminalSelector: null,
    description: "Lovable.dev AI app builder",
  },
  bolt: {
    name: "Bolt.new",
    urlPattern: /bolt\.new|stackblitz\.com/,
    previewSelector: 'iframe[title*="preview" i], iframe.result-iframe, iframe[src*="webcontainer"]',
    terminalSelector: '[class*="terminal"], [class*="xterm"]',
    description: "Bolt.new / StackBlitz WebContainer",
  },
  replit: {
    name: "Replit",
    urlPattern: /replit\.com/,
    previewSelector: 'iframe[title*="webview" i], iframe[title*="output" i], iframe.output-iframe',
    terminalSelector: '[class*="terminal"], [class*="xterm"]',
    description: "Replit Agent",
  },
  base44: {
    name: "Base44",
    urlPattern: /base44\.com/,
    previewSelector: 'iframe[title*="preview" i], iframe[class*="preview"]',
    terminalSelector: null,
    description: "Base44 AI app builder",
  },
  custom: {
    name: "Custom",
    urlPattern: /.*/,
    previewSelector: "iframe",
    terminalSelector: null,
    description: "Generic browser-based preview",
  },
};

/**
 * Detect which platform the user is on based on URL.
 */
export function detectPlatform(url: string): AgentPlatform | null {
  for (const [key, config] of Object.entries(PLATFORMS)) {
    if (key !== "custom" && config.urlPattern.test(url)) {
      return key as AgentPlatform;
    }
  }
  return null;
}

/**
 * Generate the browser console script for a given platform.
 * The script is a self-contained IIFE that the user pastes into DevTools console.
 */
export function generateCaptureScript(
  platform: AgentPlatform,
  opts: { wsPort?: number } = {},
): string {
  const config = PLATFORMS[platform];
  const wsPort = opts.wsPort ?? 3100;

  // The core capture logic — platform-agnostic error/network interception
  const coreCapture = `
    function __spdg_inject(win, label) {
      if (win.__spdg_injected) return;
      win.__spdg_injected = true;

      var ws = null;
      var queue = [];
      var retries = 0;

      function connect() {
        try {
          ws = new WebSocket('ws://localhost:${wsPort}/__spdg/ws');
          ws.onopen = function() {
            retries = 0;
            while (queue.length) ws.send(queue.shift());
          };
          ws.onclose = function() {
            ws = null;
            if (retries < 5) { retries++; setTimeout(connect, 1000 * retries); }
          };
        } catch(e) {}
      }
      connect();

      function send(evt) {
        evt.ts = Date.now();
        evt.source = label;
        var msg = JSON.stringify(evt);
        if (ws && ws.readyState === 1) ws.send(msg);
        else if (queue.length < 100) queue.push(msg);
      }

      // Capture errors
      win.addEventListener('error', function(e) {
        send({
          type: 'error',
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          stack: e.error ? e.error.stack : null
        });
      });

      // Capture unhandled rejections
      win.addEventListener('unhandledrejection', function(e) {
        send({
          type: 'rejection',
          reason: e.reason ? (e.reason.message || String(e.reason)) : 'unknown',
          stack: e.reason ? e.reason.stack : null
        });
      });

      // Capture console.error and console.warn
      var origError = win.console.error;
      var origWarn = win.console.warn;
      win.console.error = function() {
        send({ type: 'console', level: 'error', args: Array.from(arguments).map(String).join(' ') });
        return origError.apply(win.console, arguments);
      };
      win.console.warn = function() {
        send({ type: 'console', level: 'warn', args: Array.from(arguments).map(String).join(' ') });
        return origWarn.apply(win.console, arguments);
      };

      // Capture fetch failures
      var origFetch = win.fetch;
      if (origFetch) {
        win.fetch = function() {
          return origFetch.apply(this, arguments).then(function(res) {
            if (!res.ok) {
              send({ type: 'network', method: 'fetch', url: String(arguments[0]).slice(0, 200), status: res.status });
            }
            return res;
          }).catch(function(err) {
            send({ type: 'network', method: 'fetch', url: String(arguments[0]).slice(0, 200), error: err.message });
            throw err;
          });
        };
      }
    }
  `;

  // Platform-specific iframe finder and observer
  const platformScript = `
    (function() {
      ${coreCapture}

      // Inject into the main page too (catches top-level errors)
      __spdg_inject(window, 'page');

      var SELECTOR = '${config.previewSelector}';

      function findAndInject() {
        var iframes = document.querySelectorAll(SELECTOR);
        for (var i = 0; i < iframes.length; i++) {
          try {
            var win = iframes[i].contentWindow;
            if (win) __spdg_inject(win, 'preview');
          } catch(e) {
            // Cross-origin — can't inject directly
          }
        }
      }

      // Initial injection
      findAndInject();

      // Re-inject when new iframes appear (agent rebuilds, HMR)
      var observer = new MutationObserver(function() { findAndInject(); });
      observer.observe(document.body, { childList: true, subtree: true });

      // Re-inject periodically (handles iframe navigation that MutationObserver misses)
      setInterval(findAndInject, 3000);

      ${config.terminalSelector ? `
      // Terminal scraping (${config.name}-specific)
      var lastTerminal = '';
      setInterval(function() {
        var el = document.querySelector('${config.terminalSelector}');
        if (!el) return;
        var text = el.innerText || el.textContent || '';
        if (text === lastTerminal) return;
        var newLines = text.slice(lastTerminal.length);
        lastTerminal = text;
        if (/error|warn|panic|failed|crash/i.test(newLines)) {
          var ws = null;
          try {
            ws = new WebSocket('ws://localhost:${wsPort}/__spdg/ws');
            ws.onopen = function() {
              ws.send(JSON.stringify({
                type: 'terminal', level: 'error', text: newLines.slice(-500),
                ts: Date.now(), source: 'terminal'
              }));
              ws.close();
            };
          } catch(e) {}
        }
      }, 2000);
      ` : ""}

      console.log('[stackpack-debug] Capture active for ${config.name}. Errors will be forwarded to localhost:${wsPort}');
    })();
  `;

  // Minify (remove extra whitespace for console pasting)
  return platformScript
    .replace(/\/\/[^\n]*\n/g, "\n")  // strip comments
    .replace(/\n\s*\n/g, "\n")       // collapse blank lines
    .trim();
}

/**
 * Get the list of supported platforms for the setup wizard.
 */
export function listPlatforms(): Array<{ id: AgentPlatform; name: string; description: string }> {
  return Object.entries(PLATFORMS).map(([id, config]) => ({
    id: id as AgentPlatform,
    name: config.name,
    description: config.description,
  }));
}
