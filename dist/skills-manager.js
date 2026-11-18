#!/usr/bin/env node

// src/skills-manager.ts
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { basename, join } from "path";
import { tmpdir } from "os";
var TRUSTED_OWNERS = ["anthropics", "vercel-labs", "firebase", "trailofbits", "github"];
var DEFAULT_REGISTRY = {
  skills: {},
  lastSearched: null
};
var REGISTRY_PATH_DEFAULT = join(process.cwd(), ".claude", "skills-registry.json");
var SKILLS_DIR = join(process.cwd(), ".claude", "skills");
async function loadRegistry(path = REGISTRY_PATH_DEFAULT) {
  if (!existsSync(path)) return { ...DEFAULT_REGISTRY, skills: {} };
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}
async function saveRegistry(path = REGISTRY_PATH_DEFAULT, registry) {
  await writeFile(path, JSON.stringify(registry, null, 2), "utf-8");
}
function searchRegistry(registry, query) {
  const q = query.toLowerCase();
  const matches = Object.values(registry.skills).filter(
    (s) => s.skill.toLowerCase().includes(q) || s.repo.toLowerCase().includes(q)
  );
  return matches.sort((a, b) => {
    const score = (s) => s.useful === true ? 2 : s.useful === null ? 1 : 0;
    return score(b) - score(a);
  });
}
async function searchSkillsSh(query) {
  try {
    const url = `https://skills.sh/api/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.skills ?? []).map((s) => ({ skill: s.name, repo: s.source, installs: s.installs })).sort((a, b) => b.installs - a.installs);
  } catch {
    return [];
  }
}
async function search(query, registryPath = REGISTRY_PATH_DEFAULT) {
  const registry = await loadRegistry(registryPath);
  const fromRegistry = searchRegistry(registry, query);
  if (fromRegistry.some((s) => s.useful === true)) {
    return { fromRegistry, fromWeb: [] };
  }
  const fromWeb = await searchSkillsSh(query);
  return { fromRegistry, fromWeb };
}
function isTrustedOwner(repo) {
  const owner = repo.split("/")[0]?.toLowerCase();
  return TRUSTED_OWNERS.includes(owner);
}
var DANGEROUS_PATTERNS = [
  {
    pattern: /ignore\s+(previous|all|prior)\s+(instructions|prompts)/i,
    description: "prompt injection: ignore instructions"
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
    description: "suspicious: exfiltration pattern"
  },
  {
    pattern: /(read|cat|source|parse|load)\s+.*\.env\.local/i,
    description: "suspicious: reads .env.local"
  },
  {
    pattern: /^\s*!`[^\n]+`/m,
    description: "dangerous: shell command executed on skill load"
  },
  {
    pattern: /^---\n[\s\S]*?^hooks:/m,
    description: "dangerous: skill declares hooks"
  },
  {
    pattern: /base64\s+(-d|--decode)[^|]*\|/i,
    description: "dangerous: base64-decoded pipe to shell"
  }
];
function scanSkillContent(content) {
  const flags = [];
  for (const { pattern, description } of DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      flags.push(description);
    }
  }
  return { safe: flags.length === 0, flags };
}
var MAX_SCAN_FILE_BYTES = 512 * 1024;
async function scanSkillFile(path) {
  let content;
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
async function scanSkillDir(skillDir) {
  let entries;
  try {
    entries = await readdir(skillDir, { withFileTypes: true });
  } catch {
    return { safe: false, flags: ["skill directory not found or unreadable"] };
  }
  const flags = [];
  for (const entry of entries) {
    const full = join(skillDir, entry.name);
    if (entry.isDirectory()) {
      flags.push(...(await scanSkillDir(full)).flags);
    } else if (entry.isFile()) {
      flags.push(...(await scanSkillFile(full)).flags);
    } else {
      flags.push(`suspicious: non-regular file in skill directory: ${entry.name}`);
    }
  }
  const unique = [...new Set(flags)];
  return { safe: unique.length === 0, flags: unique };
}
var SKILLS_CLI_VERSION = "1.5.20";
var REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
var SKILL_NAME_PATTERN = /^[\w][\w.-]*$/;
function validateRepo(repo) {
  return REPO_PATTERN.test(repo);
}
function validateSkillName(name) {
  return SKILL_NAME_PATTERN.test(name);
}
function npxFile() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
function npx(args, opts) {
  execFileSync(npxFile(), args, { stdio: "pipe", cwd: opts.cwd, timeout: opts.timeout ?? 3e4 });
}
function buildInstallArgs(repo, skillName) {
  return [
    `skills@${SKILLS_CLI_VERSION}`,
    "add",
    repo,
    "--skill",
    skillName,
    "--copy",
    "-a",
    "claude-code",
    "-y"
  ];
}
function buildRemoveArgs(skillName) {
  return [`skills@${SKILLS_CLI_VERSION}`, "remove", "-s", skillName, "-y"];
}
function getLocalSkillNames(skillsDir = SKILLS_DIR) {
  try {
    return readdirSync(skillsDir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}
function shouldSkipInstall(skillName, localSkills) {
  return localSkills.includes(skillName);
}
async function install(repo, skillName, registryPath = REGISTRY_PATH_DEFAULT, opts = {}) {
  if (!validateRepo(repo)) {
    return { installed: false, skillName, reason: "invalid repo", flags: [] };
  }
  if (!validateSkillName(skillName)) {
    return { installed: false, skillName, reason: "invalid skill name", flags: [] };
  }
  if (shouldSkipInstall(skillName, getLocalSkillNames())) {
    return {
      installed: false,
      skillName,
      reason: `conflict: local skill "${skillName}" already exists`,
      flags: []
    };
  }
  let forceFlags = [];
  if (!isTrustedOwner(repo)) {
    let flags;
    try {
      flags = await scanInSandbox(repo, skillName);
    } catch (err) {
      return { installed: false, skillName, reason: `sandbox install failed: ${String(err)}`, flags: [] };
    }
    if (flags.length > 0 && !opts.force) {
      return { installed: false, skillName, reason: `quarantine: ${flags.join(", ")}`, flags };
    }
    forceFlags = flags;
  }
  try {
    npx(buildInstallArgs(repo, skillName), { cwd: process.cwd(), timeout: 6e4 });
  } catch (err) {
    return { installed: false, skillName, reason: `install failed: ${String(err)}`, flags: [] };
  }
  try {
    await readFile(join(SKILLS_DIR, skillName, "SKILL.md"), "utf-8");
  } catch {
    let rolledBack = false;
    try {
      npx(buildRemoveArgs(skillName), { cwd: process.cwd(), timeout: 15e3 });
      rolledBack = true;
    } catch {
    }
    return {
      installed: false,
      skillName,
      reason: rolledBack ? "installed but SKILL.md not found; rolled back" : `installed but SKILL.md not found; rollback failed, remove .claude/skills/${skillName} manually`,
      flags: []
    };
  }
  const registry = await loadRegistry(registryPath);
  registry.skills[skillName] = {
    repo,
    skill: skillName,
    usedIn: [],
    useful: null,
    lastUsed: null,
    installedAt: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
    trusted: isTrustedOwner(repo)
  };
  await saveRegistry(registryPath, registry);
  const reason = forceFlags.length > 0 ? `force-installed despite flags: ${forceFlags.join(", ")}` : "ok";
  return { installed: true, skillName, reason, flags: forceFlags };
}
async function scanInSandbox(repo, skillName) {
  const sandbox = await mkdtemp(join(tmpdir(), "skills-manager-"));
  try {
    npx(buildInstallArgs(repo, skillName), { cwd: sandbox, timeout: 6e4 });
    const scan = await scanSkillDir(join(sandbox, ".claude", "skills", skillName));
    return scan.flags;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}
function parseSkillsReport(subagentResponse) {
  const reportMatch = subagentResponse.match(
    /###\s*Skills\s*Report\s*\n([\s\S]*?)(?:\n###|\n---|$)/i
  );
  if (!reportMatch) return { used: [], ignored: [] };
  const block = reportMatch[1];
  const usedMatch = block.match(/[-*]\s*used:\s*(.+)/i);
  const ignoredMatch = block.match(/[-*]\s*ignored:\s*(.+)/i);
  const parseList = (raw) => {
    if (!raw) return [];
    return raw.split(/[,(]/).map((s) => s.replace(/\).*/, "").trim()).filter((s) => s.length > 0 && !s.includes(" "));
  };
  return {
    used: parseList(usedMatch?.[1]),
    ignored: parseList(ignoredMatch?.[1])
  };
}
function evaluateSkills(registry, report) {
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
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
function getSkillsToRemove(registry, protectedNames) {
  return Object.values(registry.skills).filter((s) => {
    if (protectedNames.includes(s.skill)) return false;
    return s.useful !== true;
  }).map((s) => s.skill);
}
async function cleanup(registryPath = REGISTRY_PATH_DEFAULT) {
  const registry = await loadRegistry(registryPath);
  const toRemove = getSkillsToRemove(registry, []);
  const removed = [];
  const failed = [];
  for (const name of toRemove) {
    if (!validateSkillName(name)) {
      failed.push(name);
      delete registry.skills[name];
      continue;
    }
    try {
      npx(buildRemoveArgs(name), { cwd: process.cwd(), timeout: 3e4 });
      removed.push(name);
      delete registry.skills[name];
    } catch {
      failed.push(name);
    }
  }
  const kept = Object.keys(registry.skills);
  await saveRegistry(registryPath, registry);
  return { removed, failed, kept };
}
function parseArgs(argv) {
  const [command = "help", ...args] = argv;
  return { command, args };
}
function printUsage() {
  console.log(`
skills-manager \u2014 dynamic skill management from skills.sh

Usage:
  skills-manager <command> [args]
  npx @thirdchimp/skills-manager <command> [args]

Commands:
  search <query> [limit]            Search skills (local registry \u2192 skills.sh), default 10
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
  Untrusted skills are installed into a sandbox dir first and every file
  is scanned (SKILL.md, scripts/, load-time hooks). Flagged skills are
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
          const status = s.useful === true ? "\u2705" : s.useful === false ? "\u274C" : "\u2753";
          console.log(`  ${status} ${s.skill} (${s.repo})`);
        }
      }
      if (result.fromWeb.length > 0) {
        console.log("From skills.sh:");
        for (const s of result.fromWeb.slice(0, limit)) {
          console.log(`  \u{1F4E6} ${s.skill} (${s.repo}) \u2014 ${s.installs} installs`);
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
          "Error: repo and name required\nUsage: skills-manager install <owner/repo> <skill-name> [--force]"
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
          "Error: file and id required\nUsage: skills-manager evaluate <response-file> <orch-id>"
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
        const status = entry.useful === true ? "\u2705" : entry.useful === false ? "\u274C" : "\u2753";
        console.log(
          `${status} ${entry.skill} (${entry.repo}) \u2014 last used: ${entry.lastUsed ?? "never"}`
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
      console.error(`Unknown command: ${command}
Run skills-manager --help for usage.`);
      process.exit(1);
  }
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("skills-manager.ts") || process.argv[1]?.endsWith("skills-manager")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
export {
  DEFAULT_REGISTRY,
  REGISTRY_PATH_DEFAULT,
  SKILLS_CLI_VERSION,
  SKILLS_DIR,
  TRUSTED_OWNERS,
  buildInstallArgs,
  buildRemoveArgs,
  cleanup,
  evaluateSkills,
  getLocalSkillNames,
  getSkillsToRemove,
  install,
  isTrustedOwner,
  loadRegistry,
  npx,
  parseArgs,
  parseSkillsReport,
  saveRegistry,
  scanSkillContent,
  scanSkillDir,
  scanSkillFile,
  search,
  searchRegistry,
  searchSkillsSh,
  shouldSkipInstall,
  validateRepo,
  validateSkillName
};
