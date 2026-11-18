#!/usr/bin/env node
/**
 * Skills Manager — search, install, evaluate and cleanup skills from skills.sh.
 * Used by AI orchestrators for dynamic skill management per task.
 *
 * Usage: skills-manager <command> [args]
 *        npx @thirdchimp/skills-manager <command> [args]
 */
interface SkillEntry {
    repo: string;
    skill: string;
    usedIn: string[];
    useful: boolean | null;
    lastUsed: string | null;
    installedAt: string;
    trusted: boolean;
    contentHash?: string;
    directoryId?: string;
}
interface SkillsRegistry {
    skills: Record<string, SkillEntry>;
    lastSearched: string | null;
}
declare const TRUSTED_OWNERS: string[];
declare const DEFAULT_REGISTRY: SkillsRegistry;
declare const REGISTRY_PATH_DEFAULT: string;
declare const SKILLS_DIR: string;
declare function loadRegistry(path?: string): Promise<SkillsRegistry>;
declare function saveRegistry(path: string | undefined, registry: SkillsRegistry): Promise<void>;
interface SkillCandidate {
    repo: string;
    skill: string;
    installs: number;
}
declare function searchRegistry(registry: SkillsRegistry, query: string): SkillEntry[];
declare function searchSkillsSh(query: string): Promise<SkillCandidate[]>;
declare function search(query: string, registryPath?: string): Promise<{
    fromRegistry: SkillEntry[];
    fromWeb: SkillCandidate[];
}>;
declare function isTrustedOwner(repo: string): boolean;
interface ScanResult {
    safe: boolean;
    flags: string[];
}
declare function scanSkillContent(content: string): ScanResult;
declare function scanSkillFile(path: string): Promise<ScanResult>;
/** Scans every file of an installed skill tree (SKILL.md, scripts/, ...). Fails closed. */
declare function scanSkillDir(skillDir: string): Promise<ScanResult>;
declare const SKILLS_CLI_VERSION = "1.5.20";
declare function validateRepo(repo: string): boolean;
declare function validateSkillName(name: string): boolean;
/** Runs the skills CLI without a shell — each arg is a separate argv entry, nothing is interpolated. */
declare function npx(args: string[], opts: {
    cwd: string;
    timeout?: number;
}): void;
/** Args for downloading exactly one skill as a copy via the claude-code agent (target dir is the CLI's cwd). */
declare function buildInstallArgs(repo: string, skillName: string): string[];
/** Names of skills physically present in the local skills dir (project-owned or installed). */
declare function getLocalSkillNames(skillsDir?: string): string[];
declare function shouldSkipInstall(skillName: string, localSkills: string[]): boolean;
interface InstallResult {
    installed: boolean;
    skillName: string;
    reason: string;
    flags: string[];
    contentHash?: string;
}
/**
 * Installs exactly one skill. Every repo is downloaded once into a throwaway
 * sandbox dir. An untrusted skill with flags requires approval of its exact
 * tree hash. The project copy is verified against the original download.
 */
declare function install(repo: string, skillName: string, registryPath?: string, opts?: {
    force?: string;
}): Promise<InstallResult>;
interface SkillsReport {
    used: string[];
    ignored: string[];
}
declare function parseSkillsReport(subagentResponse: string): SkillsReport;
/** Updates registry based on Skills Report. Mutates the input registry object. */
declare function evaluateSkills(registry: SkillsRegistry, report: SkillsReport & {
    orchestrationId: string;
}): SkillsRegistry;
/**
 * Candidates for removal: registry entries (skills installed by this tool)
 * that were never marked useful, minus explicitly protected names.
 * Skills on disk that are not in the registry are project-owned and never touched.
 */
declare function getSkillsToRemove(registry: SkillsRegistry, protectedNames: string[]): string[];
declare function cleanup(registryPath?: string): Promise<{
    removed: string[];
    failed: string[];
    kept: string[];
    preserved: string[];
}>;
declare function parseArgs(argv: string[]): {
    command: string;
    args: string[];
};

export { DEFAULT_REGISTRY, type InstallResult, REGISTRY_PATH_DEFAULT, SKILLS_CLI_VERSION, SKILLS_DIR, type ScanResult, type SkillCandidate, type SkillEntry, type SkillsRegistry, type SkillsReport, TRUSTED_OWNERS, buildInstallArgs, cleanup, evaluateSkills, getLocalSkillNames, getSkillsToRemove, install, isTrustedOwner, loadRegistry, npx, parseArgs, parseSkillsReport, saveRegistry, scanSkillContent, scanSkillDir, scanSkillFile, search, searchRegistry, searchSkillsSh, shouldSkipInstall, validateRepo, validateSkillName };
