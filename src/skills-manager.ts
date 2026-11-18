#!/usr/bin/env node
/**
 * Skills Manager — search, install, evaluate and cleanup skills from skills.sh.
 * Used by AI orchestrators for dynamic skill management per task.
 *
 * Usage: skills-manager <command> [args]
 *        npx @thirdchimp/skills-manager <command> [args]
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

// --- Types ---

export interface SkillEntry {
  repo: string;
  skill: string;
  usedIn: string[];
  useful: boolean | null;
  lastUsed: string | null;
  installedAt: string;
  trusted: boolean;
}

export interface SkillsRegistry {
  skills: Record<string, SkillEntry>;
  lastSearched: string | null;
}

// --- Constants ---

export const TRUSTED_OWNERS = ["anthropics", "vercel-labs", "firebase", "trailofbits", "github"];

export const DEFAULT_REGISTRY: SkillsRegistry = {
  skills: {},
  lastSearched: null,
};

// Paths are relative to the user's project CWD (not this package location)
export const REGISTRY_PATH_DEFAULT = join(process.cwd(), ".claude", "skills-registry.json");
export const SKILLS_DIR = join(process.cwd(), ".claude", "skills");

// --- Registry ---

export async function loadRegistry(path: string = REGISTRY_PATH_DEFAULT): Promise<SkillsRegistry> {
  if (!existsSync(path)) return { ...DEFAULT_REGISTRY, skills: {} };
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as SkillsRegistry;
}

export async function saveRegistry(
  path: string = REGISTRY_PATH_DEFAULT,
  registry: SkillsRegistry,
): Promise<void> {
  // Write-then-rename so an interrupted write never leaves a truncated registry.
  // simplicity: concurrent sessions can still lose each other's updates (last write wins); add a lock if that bites
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(registry, null, 2), "utf-8");
  await rename(tmp, path);
}

// --- Search ---

export interface SkillCandidate {
  repo: string;
  skill: string;
  installs: number;
}

export function searchRegistry(registry: SkillsRegistry, query: string): SkillEntry[] {
  const q = query.toLowerCase();
  const matches = Object.values(registry.skills).filter(
    (s) => s.skill.toLowerCase().includes(q) || s.repo.toLowerCase().includes(q),
  );

  return matches.sort((a, b) => {
    const score = (s: SkillEntry) => (s.useful === true ? 2 : s.useful === null ? 1 : 0);
    return score(b) - score(a);
  });
}

export async function searchSkillsSh(query: string): Promise<SkillCandidate[]> {
  try {
    const url = `https://skills.sh/api/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json() as { skills: { name: string; source: string; installs: number }[] };
    // Keep skills.sh order: it ranks by relevance (Algolia), re-sorting by installs loses that
    return (data.skills ?? []).map((s) => ({ skill: s.name, repo: s.source, installs: s.installs }));
  } catch {
    return [];
  }
}

export async function search(
  query: string,
  registryPath: string = REGISTRY_PATH_DEFAULT,
): Promise<{ fromRegistry: SkillEntry[]; fromWeb: SkillCandidate[] }> {
  const registry = await loadRegistry(registryPath);
  const fromRegistry = searchRegistry(registry, query);

  if (fromRegistry.some((s) => s.useful === true)) {
    return { fromRegistry, fromWeb: [] };
  }

  const fromWeb = await searchSkillsSh(query);
  return { fromRegistry, fromWeb };
}

// --- Security ---

export function isTrustedOwner(repo: string): boolean {
  const owner = repo.split("/")[0]?.toLowerCase();
  return TRUSTED_OWNERS.includes(owner);
}

export interface ScanResult {
  safe: boolean;
  flags: string[];
}

const DANGEROUS_PATTERNS: { pattern: RegExp; description: string }[] = [
  {
    pattern: /ignore\s+(previous|all|prior)\s+(instructions|prompts)/i,
    description: "prompt injection: ignore instructions",
  },
  { pattern: /you\s+are\s+now\s+/i, description: "prompt injection: role reassignment" },
  { pattern: /system:\s/i, description: "prompt injection: system prompt override" },
  { pattern: /\bdo\s+not\s+follow\b/i, description: "prompt injection: instruction override" },
  { pattern: /curl\s+.+\|\s*(sh|bash)/i, description: "dangerous: pipe curl to shell" },
  { pattern: /wget\s+.+\|\s*(sh|bash)/i, description: "dangerous: pipe wget to shell" },
  { pattern: /rm\s+-rf\s+[\/~]/i, description: "dangerous: recursive delete from root/home" },
  { pattern: /process\.env\.\w*secret/i, description: "suspicious: secret env access" },
  { pattern: /process\.env\.\w*token/i, description: "suspicious: token env access" },
  { pattern: /process\.env\.\w*key/i, description: "suspicious: key env access" },
  {
    pattern: /send\s+(it\s+)?to\s+(the\s+)?(api|server|endpoint|url)/i,
    description: "suspicious: exfiltration pattern",
  },
  {
    pattern: /(read|cat|source|parse|load)\s+.*\.env\.local/i,
    description: "suspicious: reads .env.local",
  },
  {
    pattern: /^\s*!`[^\n]+`/m,
    description: "dangerous: shell command executed on skill load",
  },
  {
    pattern: /^---\n[\s\S]*?^hooks:/m,
    description: "dangerous: skill declares hooks",
  },
  {
    pattern: /base64\s+(-d|--decode)[^|]*\|/i,
    description: "dangerous: base64-decoded pipe to shell",
  },
];

export function scanSkillContent(content: string): ScanResult {
  const flags: string[] = [];
  for (const { pattern, description } of DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      flags.push(description);
    }
  }
  return { safe: flags.length === 0, flags };
}

const MAX_SCAN_FILE_BYTES = 512 * 1024;

// Anything we cannot scan is flagged, never trusted: a padded or NUL-prefixed
// file must land in quarantine for human review, not silently pass.
export async function scanSkillFile(path: string): Promise<ScanResult> {
  let content: Buffer;
  try {
    const info = await stat(path);
    if (info.size > MAX_SCAN_FILE_BYTES) {
      return { safe: false, flags: [`file too large to scan: ${basename(path)}`] };
    }
    content = await readFile(path);
  } catch {
    return { safe: false, flags: [`unreadable file: ${basename(path)}`] };
  }
  if (content.includes(0)) {
    return { safe: false, flags: [`binary file in skill: ${basename(path)}`] };
  }
  return scanSkillContent(content.toString("utf-8"));
}

/** Scans every file of an installed skill tree (SKILL.md, scripts/, ...). Fails closed. */
export async function scanSkillDir(skillDir: string): Promise<ScanResult> {
  let entries;
  try {
    entries = await readdir(skillDir, { withFileTypes: true });
  } catch {
    return { safe: false, flags: ["skill directory not found or unreadable"] };
  }
  const flags: string[] = [];
  for (const entry of entries) {
    const full = join(skillDir, entry.name);
    if (entry.isDirectory()) {
      flags.push(...(await scanSkillDir(full)).flags);
    } else if (entry.isFile()) {
      flags.push(...(await scanSkillFile(full)).flags);
    } else {
      // symlink, fifo, ... — the real install would materialize it, we cannot scan through it
      flags.push(`suspicious: non-regular file in skill directory: ${entry.name}`);
    }
  }
  const unique = [...new Set(flags)];
  return { safe: unique.length === 0, flags: unique };
}

// --- Install ---

export const SKILLS_CLI_VERSION = "1.5.20";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const SKILL_NAME_PATTERN = /^[\w][\w.-]*$/;

export function validateRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

export function validateSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

function npxFile(): string {
  // simplicity: Windows untested — Node ≥18.20 blocks .cmd without shell:true; treat as unsupported
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/** Runs the skills CLI without a shell — each arg is a separate argv entry, nothing is interpolated. */
export function npx(args: string[], opts: { cwd: string; timeout?: number }): void {
  execFileSync(npxFile(), args, { stdio: "pipe", cwd: opts.cwd, timeout: opts.timeout ?? 30_000 });
}

/** Args for downloading exactly one skill as a copy via the claude-code agent (target dir is the CLI's cwd). */
export function buildInstallArgs(repo: string, skillName: string): string[] {
  return [
    `skills@${SKILLS_CLI_VERSION}`,
    "add",
    repo,
    "--skill",
    skillName,
    "--copy",
    "-a",
    "claude-code",
    "-y",
  ];
}

/** Names of skills physically present in the local skills dir (project-owned or installed). */
export function getLocalSkillNames(skillsDir: string = SKILLS_DIR): string[] {
  try {
    return readdirSync(skillsDir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

// Case-insensitive: on macOS/Windows "Vitest" and "vitest" are the same directory.
export function shouldSkipInstall(skillName: string, localSkills: string[]): boolean {
  const name = skillName.toLowerCase();
  return localSkills.some((s) => s.toLowerCase() === name);
}

export interface InstallResult {
  installed: boolean;
  skillName: string;
  reason: string;
  flags: string[];
}

/**
 * Installs exactly one skill. Every repo is downloaded once into a throwaway
 * sandbox dir; untrusted ones are scanned there (flagged skills are quarantined
 * unless opts.force is set after human review). The very copy that was scanned
 * is then moved into .claude/skills — nothing is downloaded a second time.
 */
export async function install(
  repo: string,
  skillName: string,
  registryPath: string = REGISTRY_PATH_DEFAULT,
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  if (!validateRepo(repo)) {
    return { installed: false, skillName, reason: "invalid repo", flags: [] };
  }
  if (!validateSkillName(skillName)) {
    return { installed: false, skillName, reason: "invalid skill name", flags: [] };
  }
  // Cheap early exit; the authoritative check below uses the real directory name.
  if (shouldSkipInstall(skillName, getLocalSkillNames())) {
    return { installed: false, skillName, reason: `conflict: local skill "${skillName}" already exists`, flags: [] };
  }

  const sandbox = await mkdtemp(join(tmpdir(), "skills-manager-"));
  try {
    try {
      npx(buildInstallArgs(repo, skillName), { cwd: sandbox, timeout: 60_000 });
    } catch (err) {
      return { installed: false, skillName, reason: `sandbox install failed: ${String(err)}`, flags: [] };
    }

    // The CLI names the directory after the skill's frontmatter name (lowercased,
    // sanitized), not after --skill, so read the real name from disk.
    const sandboxSkills = join(sandbox, ".claude", "skills");
    const dirs = getLocalSkillNames(sandboxSkills);
    if (dirs.length !== 1) {
      return { installed: false, skillName, reason: `expected exactly one skill in download, got ${dirs.length}`, flags: [] };
    }
    const dirName = dirs[0];
    const source = join(sandboxSkills, dirName);
    if (!validateSkillName(dirName)) {
      return { installed: false, skillName, reason: `invalid installed directory name "${dirName}"`, flags: [] };
    }
    if (!existsSync(join(source, "SKILL.md"))) {
      return { installed: false, skillName: dirName, reason: "SKILL.md not found in download", flags: [] };
    }
    if (shouldSkipInstall(dirName, getLocalSkillNames())) {
      return { installed: false, skillName: dirName, reason: `conflict: local skill "${dirName}" already exists`, flags: [] };
    }

    let flags: string[] = [];
    if (!isTrustedOwner(repo)) {
      flags = (await scanSkillDir(source)).flags;
      if (flags.length > 0 && !opts.force) {
        return { installed: false, skillName: dirName, reason: `quarantine: ${flags.join(", ")}`, flags };
      }
    }

    // Copy next to the target, then rename: the target never exists half-written,
    // and rename refuses to replace a non-empty directory that appeared meanwhile.
    await mkdir(SKILLS_DIR, { recursive: true });
    const staging = join(SKILLS_DIR, `.${dirName}.${process.pid}.tmp`);
    try {
      await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
      await rename(staging, join(SKILLS_DIR, dirName));
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      return { installed: false, skillName: dirName, reason: `copy failed: ${String(err)}`, flags };
    }

    const registry = await loadRegistry(registryPath);
    registry.skills[dirName] = {
      repo,
      skill: dirName,
      usedIn: [],
      useful: null,
      lastUsed: null,
      installedAt: new Date().toISOString().split("T")[0],
      trusted: isTrustedOwner(repo),
    };
    await saveRegistry(registryPath, registry);

    const reason = flags.length > 0 ? `force-installed despite flags: ${flags.join(", ")}` : "ok";
    return { installed: true, skillName: dirName, reason, flags };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

// --- Evaluate ---

export interface SkillsReport {
  used: string[];
  ignored: string[];
}

export function parseSkillsReport(subagentResponse: string): SkillsReport {
  const reportMatch = subagentResponse.match(
    /###\s*Skills\s*Report\s*\n([\s\S]*?)(?:\n###|\n---|$)/i,
  );
  if (!reportMatch) return { used: [], ignored: [] };

  const block = reportMatch[1];

  const usedMatch = block.match(/[-*]\s*used:\s*(.+)/i);
  const ignoredMatch = block.match(/[-*]\s*ignored:\s*(.+)/i);

  const parseList = (raw: string | undefined): string[] => {
    if (!raw) return [];
    return raw
      .split(/[,(]/)
      .map((s) => s.replace(/\).*/, "").trim())
      .filter((s) => s.length > 0 && !s.includes(" "));
  };

  return {
    used: parseList(usedMatch?.[1]),
    ignored: parseList(ignoredMatch?.[1]),
  };
}

/** Updates registry based on Skills Report. Mutates the input registry object. */
export function evaluateSkills(
  registry: SkillsRegistry,
  report: SkillsReport & { orchestrationId: string },
): SkillsRegistry {
  const today = new Date().toISOString().split("T")[0];

  for (const name of report.used) {
    if (registry.skills[name]) {
      registry.skills[name].useful = true;
      registry.skills[name].lastUsed = today;
      if (!registry.skills[name].usedIn.includes(report.orchestrationId)) {
        registry.skills[name].usedIn.push(report.orchestrationId);
      }
    }
  }

  // "Not needed for this task" must not outvote earlier runs where the skill was used.
  for (const name of report.ignored) {
    const entry = registry.skills[name];
    if (entry && entry.usedIn.length === 0) {
      entry.useful = false;
    }
  }

  return registry;
}

// --- Cleanup ---

/**
 * Candidates for removal: registry entries (skills installed by this tool)
 * that were never marked useful, minus explicitly protected names.
 * Skills on disk that are not in the registry are project-owned and never touched.
 */
export function getSkillsToRemove(registry: SkillsRegistry, protectedNames: string[]): string[] {
  return Object.values(registry.skills)
    .filter((s) => {
      if (protectedNames.includes(s.skill)) return false;
      return s.useful !== true;
    })
    .map((s) => s.skill);
}

export async function cleanup(
  registryPath: string = REGISTRY_PATH_DEFAULT,
): Promise<{ removed: string[]; failed: string[]; kept: string[] }> {
  const registry = await loadRegistry(registryPath);
  const toRemove = getSkillsToRemove(registry, []);

  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of toRemove) {
    if (!validateSkillName(name)) {
      // install() only writes valid names; a hand-edited registry must never
      // reach the filesystem as a path. Surface it and drop the unusable entry.
      failed.push(name);
      delete registry.skills[name];
      continue;
    }
    try {
      // Only the copy install() made; other agents' skill dirs are never touched.
      await rm(join(SKILLS_DIR, name), { recursive: true, force: true });
      removed.push(name);
      delete registry.skills[name]; // entry is dropped only after a successful removal
    } catch {
      failed.push(name);
    }
  }

  const kept = Object.keys(registry.skills);

  await saveRegistry(registryPath, registry);
  return { removed, failed, kept };
}

// --- CLI ---

export function parseArgs(argv: string[]): { command: string; args: string[] } {
  const [command = "help", ...args] = argv;
  return { command, args };
}

function printUsage() {
  console.log(`
skills-manager — dynamic skill management from skills.sh

Usage:
  skills-manager <command> [args]
  npx @thirdchimp/skills-manager <command> [args]

Commands:
  search <query> [limit]            Search skills (local registry → skills.sh), default 10
  install <owner/repo> <name> [--force]
                                    Install a skill with security scanning
  evaluate <response-file> <id>     Parse Skills Report from subagent response
  cleanup                           Remove unused skills
  list                              Show local registry
  help, --help, -h                  Show this help

Examples:
  skills-manager search vitest
  skills-manager install bobmatnyc/claude-mpm-skills vitest
  skills-manager install bobmatnyc/claude-mpm-skills vitest --force
  skills-manager evaluate /tmp/response.txt orch-2026-03-28
  skills-manager cleanup
  skills-manager list

Registry:
  Stored at .claude/skills-registry.json in your project root.
  Tracks install history and usefulness per orchestration run.

Security:
  Trusted owners (anthropics, vercel-labs, github, ...) skip scanning.
  Every skill is downloaded once into a sandbox dir; untrusted ones have
  every file scanned there (SKILL.md, scripts/, load-time hooks). The
  scanned copy itself is moved into .claude/skills. Flagged skills are
  quarantined: NOT installed, flags are returned. Pass --force after
  human review to install anyway.
`);
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "search": {
      const query = args[0];
      if (!query) {
        console.error("Error: query required\nUsage: skills-manager search <query> [limit]");
        process.exit(1);
      }
      const limit = parseInt(args[1] ?? "10", 10) || 10;
      const result = await search(query);
      if (result.fromRegistry.length > 0) {
        console.log("From registry:");
        for (const s of result.fromRegistry) {
          const status = s.useful === true ? "✅" : s.useful === false ? "❌" : "❓";
          console.log(`  ${status} ${s.skill} (${s.repo})`);
        }
      }
      if (result.fromWeb.length > 0) {
        console.log("From skills.sh:");
        for (const s of result.fromWeb.slice(0, limit)) {
          console.log(`  📦 ${s.skill} (${s.repo}) — ${s.installs} installs`);
        }
      }
      if (result.fromRegistry.length === 0 && result.fromWeb.length === 0) {
        console.log("No results found.");
      }
      console.log("\n---JSON---");
      console.log(JSON.stringify(result));
      break;
    }

    case "install": {
      const force = args.includes("--force");
      const [repo, skillName] = args.filter((a) => a !== "--force");
      if (!repo || !skillName) {
        console.error(
          "Error: repo and name required\nUsage: skills-manager install <owner/repo> <skill-name> [--force]",
        );
        process.exit(1);
      }
      const result = await install(repo, skillName, REGISTRY_PATH_DEFAULT, { force });
      console.log(JSON.stringify(result));
      break;
    }

    case "evaluate": {
      const responseFile = args[0];
      const orchId = args[1];
      if (!responseFile || !orchId) {
        console.error(
          "Error: file and id required\nUsage: skills-manager evaluate <response-file> <orch-id>",
        );
        process.exit(1);
      }
      const response = await readFile(responseFile, "utf-8");
      const report = parseSkillsReport(response);
      const registry = await loadRegistry();
      const updated = evaluateSkills(registry, { ...report, orchestrationId: orchId });
      await saveRegistry(REGISTRY_PATH_DEFAULT, updated);
      console.log(JSON.stringify({ report, updated: Object.keys(updated.skills) }));
      break;
    }

    case "cleanup": {
      const result = await cleanup();
      console.log(`Removed: ${result.removed.join(", ") || "none"}`);
      if (result.failed.length > 0) {
        console.log(`Failed:  ${result.failed.join(", ")}`);
      }
      console.log(`Kept:    ${result.kept.join(", ") || "none"}`);
      console.log(JSON.stringify(result));
      break;
    }

    case "list": {
      const registry = await loadRegistry();
      const entries = Object.values(registry.skills);
      if (entries.length === 0) {
        console.log("Registry is empty.");
        break;
      }
      for (const entry of entries) {
        const status = entry.useful === true ? "✅" : entry.useful === false ? "❌" : "❓";
        console.log(
          `${status} ${entry.skill} (${entry.repo}) — last used: ${entry.lastUsed ?? "never"}`,
        );
      }
      break;
    }

    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;

    default:
      console.error(`Unknown command: ${command}\nRun skills-manager --help for usage.`);
      process.exit(1);
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("skills-manager.ts") ||
  process.argv[1]?.endsWith("skills-manager")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
