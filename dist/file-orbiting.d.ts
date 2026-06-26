/**
 * file-orbiting.ts — detect the "editing the same file repeatedly while the bug
 * lives elsewhere" loop.
 *
 * The session already detects *error-fingerprint* orbiting. That missed the
 * motivating bug because the error text shifted between attempts; what stayed
 * constant was the set of files the agent kept editing. This complements it by
 * watching the files, not the errors.
 */
export interface OrbitEntry {
    sourceFiles: string[];
    resolved: boolean;
}
export interface FileOrbitWarning {
    file: string;
    attempts: number;
    message: string;
}
/**
 * Returns a warning when the same source file has been the suspect across
 * ORBIT_THRESHOLD+ consecutive *unresolved* attempts at the tail of the
 * trajectory. Null otherwise.
 */
export declare function detectFileOrbiting(trajectory: OrbitEntry[]): FileOrbitWarning | null;
