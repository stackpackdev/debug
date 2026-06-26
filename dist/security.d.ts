/**
 * Validate that a file path is within the project root.
 * Resolves symlinks and rejects paths that escape the boundary.
 */
export declare function validateFilePath(filePath: string, projectRoot: string): string;
/**
 * Validate a command string for obvious injection attempts.
 * We allow commands but reject chaining operators.
 */
export declare function validateCommand(command: string): string;
/**
 * Redact sensitive information from captured text.
 */
export declare function redactSensitiveData(text: string): string;
/**
 * Deep-redact a captured value before it is surfaced to the agent. Walks
 * strings, arrays, and plain objects, applying redactSensitiveData to every
 * string. Used at the emit points of debug_capture / debug://errors so raw
 * browser/terminal capture `data` cannot carry secrets through.
 */
export declare function redactCaptureValue<T>(value: T): T;
/**
 * Redact sensitive headers from captured network requests.
 */
export declare function redactHeaders(headers: Record<string, string>): Record<string, string>;
/**
 * Ensure .debug/ is in .gitignore.
 */
export declare function ensureGitignore(projectRoot: string): void;
/**
 * Validate that an instrumentation expression is safe to inject.
 * Prevents code injection via the expression parameter.
 */
export declare function validateExpression(expression: string): string;
