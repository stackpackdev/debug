/**
 * adapters.ts — MCP tool discovery for visual integrations.
 *
 * Detects available tools from Ghost OS and Claude Preview at runtime.
 * All visual features gracefully degrade when no tools are available.
 */
export interface DoctorCheck {
    group: "core" | "perf" | "visual";
    name: string;
    status: "pass" | "warn" | "fail";
    message: string;
    fix?: string;
}
export interface EnvironmentCapabilities {
    core: {
        nodeVersion: string;
        nodeOk: boolean;
        gitAvailable: boolean;
        debugDirExists: boolean;
    };
    perf: {
        lighthouseAvailable: boolean;
        chromeAvailable: boolean;
    };
    visual: {
        ghostOsConfigured: boolean;
        claudePreviewConfigured: boolean;
    };
}
export declare function detectVisualToolsFromConfig(cwd: string): {
    ghostOs: boolean;
    claudePreview: boolean;
};
export declare function detectEnvironment(cwd: string): EnvironmentCapabilities;
export declare function formatDoctorReport(caps: EnvironmentCapabilities): DoctorCheck[];
export interface InstallableIntegration {
    id: string;
    name: string;
    capability: string;
    packageName: string;
    description: string;
    available: boolean;
    autoInstallable: boolean;
    installCommand: string | null;
    manualSteps: string | null;
    diskSize: string;
}
export declare function listInstallable(caps: EnvironmentCapabilities): InstallableIntegration[];
export declare function installIntegration(id: string, cwd: string): {
    success: boolean;
    message: string;
};
