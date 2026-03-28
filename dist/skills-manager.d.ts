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
declare const SKILLS_CLI_VERSION = "1.4.6";
declare function buildInstallCommand(repo: string, opts?: {
    copy?: boolean;
}): string;
declare function getProjectSkillNames(skillsDir?: string): string[];
declare function shouldSkipInstall(skillName: string, projectSkills: string[]): boolean;
interface SafetyResult {
    action: "allow" | "quarantine";
    flags: string[];
}
declare function evaluateInstallSafety(repo: string, skillContent: string): SafetyResult;
interface InstallResult {
    installed: boolean;
    skillName: string;
    reason: string;
}
declare function install(repo: string, skillName: string, registryPath?: string): Promise<InstallResult>;
interface SkillsReport {
    used: string[];
    ignored: string[];
}
declare function parseSkillsReport(subagentResponse: string): SkillsReport;
/** Updates registry based on Skills Report. Mutates the input registry object. */
declare function evaluateSkills(registry: SkillsRegistry, report: SkillsReport & {
    orchestrationId: string;
}): SkillsRegistry;
declare function getSkillsToRemove(registry: SkillsRegistry, projectSkills: string[]): string[];
declare function cleanup(registryPath?: string): Promise<{
    removed: string[];
    kept: string[];
}>;
declare function parseArgs(argv: string[]): {
    command: string;
    args: string[];
};

export { DEFAULT_REGISTRY, type InstallResult, REGISTRY_PATH_DEFAULT, SKILLS_CLI_VERSION, SKILLS_DIR, type SafetyResult, type ScanResult, type SkillCandidate, type SkillEntry, type SkillsRegistry, type SkillsReport, TRUSTED_OWNERS, buildInstallCommand, cleanup, evaluateInstallSafety, evaluateSkills, getProjectSkillNames, getSkillsToRemove, install, isTrustedOwner, loadRegistry, parseArgs, parseSkillsReport, saveRegistry, scanSkillContent, search, searchRegistry, searchSkillsSh, shouldSkipInstall };
