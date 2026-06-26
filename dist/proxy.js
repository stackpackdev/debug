import { createServer } from "node:http";
import httpProxy from "http-proxy";
import { WebSocketServer } from "ws";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { onBrowserEvent } from "./capture.js";
import { createGunzip } from "node:zlib";
import { decodeWireMessage, encodeWireMessage, createLoopEvent, } from "./loop-protocol.js";
import { startLoopForwarder } from "./loop-forwarder.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INJECTED_SCRIPT_TAG = `<script src="/__stackpack_debug/injected.js"></script>`;
let injectedScriptCache = null;
function getInjectedScript() {
    if (!injectedScriptCache) {
        injectedScriptCache = readFileSync(join(__dirname, "injected.js"), "utf-8");
    }
    return injectedScriptCache;
}
export function startProxy(opts) {
    const { targetPort, listenPort } = opts;
    const cwd = opts.cwd ?? process.cwd();
    const forwarder = startLoopForwarder(cwd);
    const target = `http://127.0.0.1:${targetPort}`;
    const proxy = httpProxy.createProxyServer({
        target,
        ws: true,
        selfHandleResponse: true,
    });
    // Handle proxy responses: inject script into HTML
    proxy.on("proxyRes", (proxyRes, req, res) => {
        const contentType = proxyRes.headers["content-type"] ?? "";
        const isHtml = contentType.includes("text/html");
        if (!isHtml) {
            // Pass through non-HTML responses unchanged
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
            return;
        }
        // Buffer and modify HTML responses
        const chunks = [];
        const encoding = proxyRes.headers["content-encoding"];
        let stream = proxyRes;
        if (encoding === "gzip") {
            stream = proxyRes.pipe(createGunzip());
        }
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => {
            let body = Buffer.concat(chunks).toString("utf-8");
            // Inject our script before </body> or at end of document
            if (body.includes("</body>")) {
                body = body.replace("</body>", `${INJECTED_SCRIPT_TAG}\n</body>`);
            }
            else if (body.includes("</html>")) {
                body = body.replace("</html>", `${INJECTED_SCRIPT_TAG}\n</html>`);
            }
            else {
                body += `\n${INJECTED_SCRIPT_TAG}`;
            }
            // Send modified response without compression
            const headers = { ...proxyRes.headers };
            delete headers["content-encoding"];
            delete headers["content-length"];
            headers["content-length"] = String(Buffer.byteLength(body));
            res.writeHead(proxyRes.statusCode ?? 200, headers);
            res.end(body);
        });
        stream.on("error", () => {
            // If decompression fails, pass through raw
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
        });
    });
    proxy.on("error", (err, _req, res) => {
        if (res && "writeHead" in res) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end(`stackpack-debug proxy error: ${err.message}`);
        }
    });
    // HTTP server
    const server = createServer((req, res) => {
        // Serve our injected script
        if (req.url === "/__stackpack_debug/injected.js") {
            try {
                const script = getInjectedScript();
                res.writeHead(200, {
                    "Content-Type": "application/javascript",
                    "Cache-Control": "no-cache",
                });
                res.end(script);
            }
            catch {
                res.writeHead(404);
                res.end("injected.js not found");
            }
            return;
        }
        // Proxy everything else
        proxy.web(req, res);
    });
    // WebSocket handling
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws) => {
        ws.on("message", (data) => {
            const raw = data.toString();
            // First: try as a Loop wire message (state telemetry, or wrapped events).
            // On hit, forward upstream to MCP and stop — these are not browser events.
            const wire = decodeWireMessage(raw);
            if (wire) {
                forwarder.send(raw);
                return;
            }
            // Otherwise: existing browser-event path (console/error/network).
            try {
                const event = JSON.parse(raw);
                onBrowserEvent(event);
                // Also surface browser events on the unified timeline by wrapping
                // them as loop:event messages and forwarding upstream. Keeps
                // debug://timeline a true cross-source view.
                const loopEv = browserEventToLoopEvent(event);
                if (loopEv) {
                    forwarder.send(encodeWireMessage({ type: "loop:event", event: loopEv }));
                }
            }
            catch {
                // Ignore malformed messages
            }
        });
    });
    server.on("upgrade", (req, socket, head) => {
        // Our debug WebSocket
        if (req.url === "/__stackpack_debug/ws") {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit("connection", ws, req);
            });
            return;
        }
        // Proxy all other WebSocket upgrades (e.g., HMR)
        proxy.ws(req, socket, head);
    });
    // Security: bind to localhost only — never expose to network
    server.listen(listenPort, "127.0.0.1", () => {
        // Server started
    });
    return {
        close() {
            forwarder.close();
            wss.close();
            server.close();
            proxy.close();
        },
    };
}
/**
 * Map a browser-injected event ({type, data, ts}) to a LoopEvent for
 * upstream forwarding. Returns null for events that don't belong on the
 * timeline (e.g. successful network calls).
 */
function browserEventToLoopEvent(event) {
    if (!event || typeof event !== "object")
        return null;
    const data = event.data ?? {};
    if (event.type === "console") {
        if (data.level !== "error" && data.level !== "warn")
            return null;
        return createLoopEvent({
            source: "browser",
            kind: data.level === "error" ? "console.error" : "console.warn",
            payload: { message: Array.isArray(data.args) ? data.args.join(" ") : String(data.args ?? "") },
        });
    }
    if (event.type === "error") {
        if (data.type === "unhandledrejection") {
            return createLoopEvent({
                source: "browser",
                kind: "unhandled.rejection",
                payload: { reason: data.message ?? data.reason ?? "" },
            });
        }
        return createLoopEvent({
            source: "browser",
            kind: "window.error",
            payload: {
                message: data.message,
                source: data.source,
                line: data.line,
            },
        });
    }
    if (event.type === "network") {
        return createLoopEvent({
            source: "network",
            kind: "request.failed",
            payload: {
                method: data.method,
                url: data.url,
                status: data.status,
                error: data.error,
            },
        });
    }
    return null;
}
/**
 * Detect the dev server port by watching child process output.
 * Returns a promise that resolves with the port or rejects after timeout.
 */
export function detectPort(stdout, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        // Ordered from most specific to least. No greedy catch-all patterns.
        const patterns = [
            /https?:\/\/localhost:(\d+)/,
            /https?:\/\/127\.0\.0\.1:(\d+)/,
            /https?:\/\/0\.0\.0\.0:(\d+)/,
            /https?:\/\/\[::\]:(\d+)/,
            /listening\s+(?:on\s+)?(?:port\s+)?(\d{4,5})/i,
            /localhost:(\d{4,5})/,
            /127\.0\.0\.1:(\d{4,5})/,
        ];
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Could not auto-detect dev server port within timeout. Use --port to specify."));
        }, timeoutMs);
        function onData(chunk) {
            const text = chunk.toString();
            for (const pattern of patterns) {
                const match = pattern.exec(text);
                if (match) {
                    const port = parseInt(match[1], 10);
                    if (port >= 1024 && port <= 65535) {
                        cleanup();
                        resolve(port);
                        return;
                    }
                }
            }
        }
        function cleanup() {
            clearTimeout(timer);
            stdout.removeListener("data", onData);
        }
        stdout.on("data", onData);
    });
}
//# sourceMappingURL=proxy.js.map