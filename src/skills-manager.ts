#!/usr/bin/env node
/**
 * Skills Manager — search, install, evaluate and cleanup skills from skills.sh.
 * Used by AI orchestrators for dynamic skill management per task.
 *
 * Usage: skills-manager <command> [args]
 *        npx @thirdchimp/skills-manager <command> [args]
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

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
  await writeFile(path, JSON.stringify(registry, null, 2), "utf-8");
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
    return (data.skills ?? [])
      .map((s) => ({ skill: s.name, repo: s.source, installs: s.installs }))
      .sort((a, b) => b.installs - a.installs);
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

// --- Install ---

export const SKILLS_CLI_VERSION = "1.4.6";

export function buildInstallCommand(repo: string, opts: { copy?: boolean } = {}): string {
  const parts = [`npx skills@${SKILLS_CLI_VERSION} add ${repo}`];
  if (opts.copy) parts.push("--copy");
  parts.push("-y");
  return parts.join(" ");
}

export function getProjectSkillNames(skillsDir: string = SKILLS_DIR): string[] {
  try {
    return readdirSync(skillsDir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

export function shouldSkipInstall(skillName: string, projectSkills: string[]): boolean {
  return projectSkills.includes(skillName);
}

export interface SafetyResult {
  action: "allow" | "quarantine";
  flags: string[];
}

export function evaluateInstallSafety(repo: string, skillContent: string): SafetyResult {
  if (isTrustedOwner(repo)) {
    return { action: "allow", flags: [] };
  }
  const scan = scanSkillContent(skillContent);
  if (!scan.safe) {
    return { action: "quarantine", flags: scan.flags };
  }
  return { action: "allow", flags: [] };
}

export interface InstallResult {
  installed: boolean;
  skillName: string;
  reason: string;
}

export async function install(
  repo: string,
  skillName: string,
  registryPath: string = REGISTRY_PATH_DEFAULT,
): Promise<InstallResult> {
  const projectSkills = getProjectSkillNames();

  if (shouldSkipInstall(skillName, projectSkills)) {
    return {
      installed: false,
      skillName,
      reason: `conflict: project skill "${skillName}" already exists`,
    };
  }

  const cmd = buildInstallCommand(repo, { copy: true });
  try {
    execSync(cmd, { stdio: "pipe", timeout: 30_000 });
  } catch (err) {
    return {
      installed: false,
      skillName,
      reason: `install failed: ${String(err)}`,
    };
  }

  const skillMdPath = join(SKILLS_DIR, skillName, "SKILL.md");
  let content: string;
  try {
    content = await readFile(skillMdPath, "utf-8");
  } catch {
    return { installed: true, skillName, reason: "installed, SKILL.md not found for scan" };
  }

  const safety = evaluateInstallSafety(repo, content);
  if (safety.action === "quarantine") {
    try {
      execSync(`npx skills@${SKILLS_CLI_VERSION} remove -s ${skillName} -y`, {
        stdio: "pipe",
        timeout: 15_000,
      });
    } catch {
      /* best effort */
    }
    return {
      installed: false,
      skillName,
      reason: `quarantine: ${safety.flags.join(", ")}`,
    };
  }

  const registry = await loadRegistry(registryPath);
  registry.skills[skillName] = {
    repo,
    skill: skillName,
    usedIn: [],
    useful: null,
    lastUsed: null,
    installedAt: new Date().toISOString().split("T")[0],
    trusted: isTrustedOwner(repo),
  };
  await saveRegistry(registryPath, registry);

  return { installed: true, skillName, reason: "ok" };
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

  for (const name of report.ignored) {
    if (registry.skills[name]) {
      registry.skills[name].useful = false;
    }
  }

  return registry;
}

// --- Cleanup ---

export function getSkillsToRemove(registry: SkillsRegistry, projectSkills: string[]): string[] {
  return Object.values(registry.skills)
    .filter((s) => {
      if (projectSkills.includes(s.skill)) return false;
      return s.useful !== true;
    })
    .map((s) => s.skill);
}

export async function cleanup(
  registryPath: string = REGISTRY_PATH_DEFAULT,
): Promise<{ removed: string[]; kept: string[] }> {
  const registry = await loadRegistry(registryPath);
  const projectSkills = getProjectSkillNames();
  const toRemove = getSkillsToRemove(registry, projectSkills);

  const removed: string[] = [];
  for (const name of toRemove) {
    try {
      execSync(`npx skills@${SKILLS_CLI_VERSION} remove -s ${name} -y`, {
        stdio: "pipe",
        timeout: 15_000,
      });
      removed.push(name);
    } catch {
      removed.push(name);
    }
    if (registry.skills[name]?.useful === false) {
      delete registry.skills[name];
    }
  }

  const kept = Object.keys(registry.skills).filter((name) => !toRemove.includes(name));

  await saveRegistry(registryPath, registry);
  return { removed, kept };
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
  install <owner/repo> <name>       Install a skill with security scanning
  evaluate <response-file> <id>     Parse Skills Report from subagent response
  cleanup                           Remove unused skills
  list                              Show local registry
  help, --help, -h                  Show this help

Examples:
  skills-manager search vitest
  skills-manager install bobmatnyc/claude-mpm-skills vitest
  skills-manager evaluate /tmp/response.txt orch-2026-03-28
  skills-manager cleanup
  skills-manager list

Registry:
  Stored at .claude/skills-registry.json in your project root.
  Tracks install history and usefulness per orchestration run.

Security:
  Trusted owners (anthropics, vercel-labs, github, ...) skip scanning.
  Untrusted skills are scanned for prompt injection, dangerous shell
  commands, and secret access patterns before install.
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
      const repo = args[0];
      const skillName = args[1];
      if (!repo || !skillName) {
        console.error(
          "Error: repo and name required\nUsage: skills-manager install <owner/repo> <skill-name>",
        );
        process.exit(1);
      }
      const result = await install(repo, skillName);
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
