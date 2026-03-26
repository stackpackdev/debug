/**
 * adapters.ts — MCP tool discovery for visual integrations.
 *
 * Detects available tools from Ghost OS and Claude Preview at runtime.
 * All visual features gracefully degrade when no tools are available.
 */
const GHOST_TOOLS = {
    screenshot: "ghost_screenshot",
    dom: "ghost_read",
    inspect: "ghost_inspect",
};
const PREVIEW_TOOLS = {
    screenshot: "preview_screenshot",
    dom: "preview_snapshot",
    inspect: "preview_inspect",
};
export function detectVisualTools(availableTools) {
    const set = new Set(availableTools);
    const hasGhostScreenshot = set.has(GHOST_TOOLS.screenshot);
    const hasGhostDom = set.has(GHOST_TOOLS.dom);
    const hasGhostInspect = set.has(GHOST_TOOLS.inspect);
    const hasPreviewScreenshot = set.has(PREVIEW_TOOLS.screenshot);
    const hasPreviewDom = set.has(PREVIEW_TOOLS.dom);
    const hasPreviewInspect = set.has(PREVIEW_TOOLS.inspect);
    return {
        canScreenshot: hasGhostScreenshot || hasPreviewScreenshot,
        canReadDom: hasGhostDom || hasPreviewDom,
        canInspect: hasGhostInspect || hasPreviewInspect,
        screenshotTool: hasGhostScreenshot ? GHOST_TOOLS.screenshot
            : hasPreviewScreenshot ? PREVIEW_TOOLS.screenshot : null,
        domTool: hasGhostDom ? GHOST_TOOLS.dom
            : hasPreviewDom ? PREVIEW_TOOLS.dom : null,
        inspectTool: hasGhostInspect ? GHOST_TOOLS.inspect
            : hasPreviewInspect ? PREVIEW_TOOLS.inspect : null,
        availableTools: availableTools.filter((t) => Object.values(GHOST_TOOLS).includes(t) ||
            Object.values(PREVIEW_TOOLS).includes(t)),
    };
}
export function formatCapabilitiesSummary(caps) {
    if (!caps.canScreenshot && !caps.canReadDom) {
        return "No visual tools detected. Screenshots and DOM capture unavailable.";
    }
    const parts = [];
    if (caps.screenshotTool)
        parts.push(`screenshot: ${caps.screenshotTool}`);
    if (caps.domTool)
        parts.push(`DOM: ${caps.domTool}`);
    if (caps.inspectTool)
        parts.push(`inspect: ${caps.inspectTool}`);
    return `Visual tools: ${parts.join(", ")}`;
}
// ━━━ Environment Capability Detection ━━━
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
function checkNodeVersion() {
    const v = process.versions.node;
    const [major, minor] = v.split(".").map(Number);
    const ok = (major > 22) || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
    return { version: v, ok };
}
function checkGit() {
    try {
        execSync("git --version", { stdio: "pipe", timeout: 3000 });
        return true;
    }
    catch {
        return false;
    }
}
function checkLighthouse(cwd) {
    // Fast check: local binary
    if (existsSync(join(cwd, "node_modules", ".bin", "lighthouse")))
        return true;
    // Fallback: global
    try {
        execSync("lighthouse --version", { stdio: "pipe", timeout: 5000 });
        return true;
    }
    catch {
        return false;
    }
}
function checkChrome() {
    const platform = process.platform;
    if (platform === "darwin") {
        return existsSync("/Applications/Google Chrome.app");
    }
    if (platform === "linux") {
        try {
            execSync("which google-chrome || which chromium-browser", { stdio: "pipe", timeout: 3000 });
            return true;
        }
        catch {
            return false;
        }
    }
    if (platform === "win32") {
        const paths = [
            join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
            join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
        ];
        return paths.some(existsSync);
    }
    return false;
}
export function detectVisualToolsFromConfig(cwd) {
    const result = { ghostOs: false, claudePreview: false };
    // Check .mcp.json (Claude Code v2)
    for (const configFile of [".mcp.json", join(".claude", "mcp.json")]) {
        const p = join(cwd, configFile);
        if (!existsSync(p))
            continue;
        try {
            const config = JSON.parse(readFileSync(p, "utf-8"));
            const servers = config.mcpServers ?? {};
            for (const name of Object.keys(servers)) {
                const lower = name.toLowerCase();
                if (lower.includes("ghost"))
                    result.ghostOs = true;
                if (lower.includes("preview") || lower.includes("claude_preview") || lower.includes("claude-preview"))
                    result.claudePreview = true;
            }
        }
        catch { /* skip corrupt config */ }
    }
    return result;
}
export function detectEnvironment(cwd) {
    const node = checkNodeVersion();
    const visualConfig = detectVisualToolsFromConfig(cwd);
    return {
        core: {
            nodeVersion: node.version,
            nodeOk: node.ok,
            gitAvailable: checkGit(),
            debugDirExists: existsSync(join(cwd, ".debug")),
        },
        perf: {
            lighthouseAvailable: checkLighthouse(cwd),
            chromeAvailable: checkChrome(),
        },
        visual: {
            ghostOsConfigured: visualConfig.ghostOs,
            claudePreviewConfigured: visualConfig.claudePreview,
        },
    };
}
export function formatDoctorReport(caps) {
    const checks = [];
    // Core
    checks.push({
        group: "core", name: "Node.js",
        status: caps.core.nodeOk ? "pass" : "fail",
        message: caps.core.nodeOk ? `Node.js ${caps.core.nodeVersion}` : `Node.js ${caps.core.nodeVersion} (requires ≥20.19 or ≥22.12)`,
        fix: caps.core.nodeOk ? undefined : "Update Node.js: https://nodejs.org",
    });
    checks.push({
        group: "core", name: "Git",
        status: caps.core.gitAvailable ? "pass" : "fail",
        message: caps.core.gitAvailable ? "Git available" : "Git not found",
        fix: caps.core.gitAvailable ? undefined : "Install Git: https://git-scm.com",
    });
    checks.push({
        group: "core", name: ".debug dir",
        status: caps.core.debugDirExists ? "pass" : "warn",
        message: caps.core.debugDirExists ? ".debug/ directory exists" : ".debug/ not found (created on first use)",
    });
    // Performance
    checks.push({
        group: "perf", name: "Lighthouse",
        status: caps.perf.lighthouseAvailable ? "pass" : "warn",
        message: caps.perf.lighthouseAvailable ? "Lighthouse available" : "Lighthouse not found",
        fix: caps.perf.lighthouseAvailable ? undefined : "npm install -g lighthouse",
    });
    checks.push({
        group: "perf", name: "Chrome",
        status: caps.perf.chromeAvailable ? "pass" : "warn",
        message: caps.perf.chromeAvailable ? "Chrome available" : "Chrome not detected",
        fix: caps.perf.chromeAvailable ? undefined : "Install Chrome: https://google.com/chrome",
    });
    // Visual
    checks.push({
        group: "visual", name: "Ghost OS",
        status: caps.visual.ghostOsConfigured ? "pass" : "warn",
        message: caps.visual.ghostOsConfigured ? "Ghost OS configured" : "Ghost OS not configured",
        fix: caps.visual.ghostOsConfigured ? undefined : "Add ghost-os MCP server to .mcp.json",
    });
    checks.push({
        group: "visual", name: "Claude Preview",
        status: caps.visual.claudePreviewConfigured ? "pass" : "warn",
        message: caps.visual.claudePreviewConfigured ? "Claude Preview configured" : "Claude Preview not configured",
        fix: caps.visual.claudePreviewConfigured ? undefined : "Add Claude Preview MCP server to .mcp.json",
    });
    return checks;
}
//# sourceMappingURL=adapters.js.map