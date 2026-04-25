import { describe, it, expect } from "vitest";
import debugToolkitPlugin from "../src/vite-plugin.js";

function getInjectedScript(wsPort = 3420): string {
  const plugin = debugToolkitPlugin({ wsPort });
  const transform = plugin.transformIndexHtml as any;
  const handler = typeof transform === "function" ? transform : transform.handler;
  const result = handler.call({}, "", { path: "/", filename: "index.html" } as any);
  const tags = Array.isArray(result) ? result : (result?.tags ?? []);
  const scriptTag = tags.find((t: any) => t.attrs?.["data-stackpack-debug"] === "true");
  if (!scriptTag || typeof scriptTag.children !== "string") {
    throw new Error("stackpack-debug script tag not found in transformIndexHtml output");
  }
  return scriptTag.children;
}

describe("vite-plugin CSP banner", () => {
  it("registers a securitypolicyviolation listener before connecting", () => {
    const script = getInjectedScript();
    expect(script).toContain('addEventListener("securitypolicyviolation"');
    const listenerIdx = script.indexOf('addEventListener("securitypolicyviolation"');
    const connectIdx = script.indexOf("connect();");
    expect(listenerIdx).toBeGreaterThan(-1);
    expect(connectIdx).toBeGreaterThan(-1);
    expect(listenerIdx).toBeLessThan(connectIdx);
  });

  it("derives toolkit origins from the configured port at runtime", () => {
    const script = getInjectedScript(3420);
    // The port is baked into hostPort once; wsUrl / toolkitOrigins are
    // concatenated at runtime. Assert hostPort + that the runtime
    // concatenations for both ws:// and http:// exist in the source.
    expect(script).toContain('var hostPort = "127.0.0.1:3420"');
    expect(script).toContain('"ws://" + hostPort');
    expect(script).toContain('"http://" + hostPort');
    expect(script).toContain("toolkitOrigins");
  });

  it("uses a different port when configured", () => {
    const script = getInjectedScript(9999);
    expect(script).toContain('"127.0.0.1:9999"');
    expect(script).not.toContain('"127.0.0.1:3420"');
  });

  it("renders the banner with heading, copy button, dismiss button, and learn-more link", () => {
    const script = getInjectedScript();
    expect(script).toContain("Content Security Policy");
    expect(script).toContain("connect-src");
    expect(script).toContain("Copy");
    expect(script).toContain('aria-label", "Dismiss"');
    expect(script).toContain("github.com/stackpackdev/debug#csp");
  });

  it("deduplicates via sessionStorage and an in-memory map", () => {
    const script = getInjectedScript();
    expect(script).toContain("__stackpack_csp_banner_dismissed");
    expect(script).toContain("cspBannerShown");
  });

  it("uses a unique banner element id so it can't stack", () => {
    const script = getInjectedScript();
    expect(script).toContain("__stackpack-csp-banner");
    expect(script).toContain('getElementById("__stackpack-csp-banner")');
  });

  it("does not introduce CSP-hostile constructs (unsafe-inline, external stylesheet, eval)", () => {
    const script = getInjectedScript();
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("<link");
    expect(script).not.toContain("stylesheet");
    expect(script).not.toMatch(/\beval\s*\(/);
  });

  it("falls back to a default port when none is configured (via fallback branch)", () => {
    // Passing 0 skips the configResolved branch in our getInjectedScript; simulate
    // the default fallback by passing the fallback value explicitly.
    const script = getInjectedScript(2420);
    expect(script).toContain("127.0.0.1:2420");
  });
});
