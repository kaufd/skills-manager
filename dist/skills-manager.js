#!/usr/bin/env node
// @bun

// src/skills-manager.ts
import { readFile, writeFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
var TRUSTED_OWNERS = ["anthropics", "vercel-labs", "firebase", "trailofbits", "github"];
var DEFAULT_REGISTRY = {
  skills: {},
  lastSearched: null
};
var REGISTRY_PATH_DEFAULT = join(process.cwd(), ".claude", "skills-registry.json");
var SKILLS_DIR = join(process.cwd(), ".claude", "skills");
async function loadRegistry(path = REGISTRY_PATH_DEFAULT) {
  if (!existsSync(path))
    return { ...DEFAULT_REGISTRY, skills: {} };
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}
async function saveRegistry(path = REGISTRY_PATH_DEFAULT, registry) {
  await writeFile(path, JSON.stringify(registry, null, 2), "utf-8");
}
function searchRegistry(registry, query) {
  const q = query.toLowerCase();
  const matches = Object.values(registry.skills).filter((s) => s.skill.toLowerCase().includes(q) || s.repo.toLowerCase().includes(q));
  return matches.sort((a, b) => {
    const score = (s) => s.useful === true ? 2 : s.useful === null ? 1 : 0;
    return score(b) - score(a);
  });
}
async function searchSkillsSh(query) {
  try {
    const url = `https://skills.sh/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url);
    if (!resp.ok)
      return [];
    const text = await resp.text();
    const regex = /(\S+)\s+\((\S+\/\S+)\)\s*[-\u2014]\s*(\d+)\s*install/gi;
    const candidates = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      candidates.push({
        skill: match[1],
        repo: match[2],
        installs: parseInt(match[3], 10)
      });
    }
    return candidates.sort((a, b) => b.installs - a.installs);
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
var SKILLS_CLI_VERSION = "1.4.6";
function buildInstallCommand(repo, opts = {}) {
  const parts = [`npx skills@${SKILLS_CLI_VERSION} add ${repo}`];
  if (opts.copy)
    parts.push("--copy");
  parts.push("-y");
  return parts.join(" ");
}
function getProjectSkillNames(skillsDir = SKILLS_DIR) {
  try {
    return readdirSync(skillsDir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}
function shouldSkipInstall(skillName, projectSkills) {
  return projectSkills.includes(skillName);
}
function evaluateInstallSafety(repo, skillContent) {
  if (isTrustedOwner(repo)) {
    return { action: "allow", flags: [] };
  }
  const scan = scanSkillContent(skillContent);
  if (!scan.safe) {
    return { action: "quarantine", flags: scan.flags };
  }
  return { action: "allow", flags: [] };
}
async function install(repo, skillName, registryPath = REGISTRY_PATH_DEFAULT) {
  const projectSkills = getProjectSkillNames();
  if (shouldSkipInstall(skillName, projectSkills)) {
    return {
      installed: false,
      skillName,
      reason: `conflict: project skill "${skillName}" already exists`
    };
  }
  const cmd = buildInstallCommand(repo, { copy: true });
  try {
    execSync(cmd, { stdio: "pipe", timeout: 30000 });
  } catch (err) {
    return {
      installed: false,
      skillName,
      reason: `install failed: ${String(err)}`
    };
  }
  const skillMdPath = join(SKILLS_DIR, skillName, "SKILL.md");
  let content;
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
        timeout: 15000
      });
    } catch {}
    return {
      installed: false,
      skillName,
      reason: `quarantine: ${safety.flags.join(", ")}`
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
    trusted: isTrustedOwner(repo)
  };
  await saveRegistry(registryPath, registry);
  return { installed: true, skillName, reason: "ok" };
}
function parseSkillsReport(subagentResponse) {
  const reportMatch = subagentResponse.match(/###\s*Skills\s*Report\s*\n([\s\S]*?)(?:\n###|\n---|$)/i);
  if (!reportMatch)
    return { used: [], ignored: [] };
  const block = reportMatch[1];
  const usedMatch = block.match(/[-*]\s*used:\s*(.+)/i);
  const ignoredMatch = block.match(/[-*]\s*ignored:\s*(.+)/i);
  const parseList = (raw) => {
    if (!raw)
      return [];
    return raw.split(/[,(]/).map((s) => s.replace(/\).*/, "").trim()).filter((s) => s.length > 0 && !s.includes(" "));
  };
  return {
    used: parseList(usedMatch?.[1]),
    ignored: parseList(ignoredMatch?.[1])
  };
}
function evaluateSkills(registry, report) {
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
function getSkillsToRemove(registry, projectSkills) {
  return Object.values(registry.skills).filter((s) => {
    if (projectSkills.includes(s.skill))
      return false;
    return s.useful !== true;
  }).map((s) => s.skill);
}
async function cleanup(registryPath = REGISTRY_PATH_DEFAULT) {
  const registry = await loadRegistry(registryPath);
  const projectSkills = getProjectSkillNames();
  const toRemove = getSkillsToRemove(registry, projectSkills);
  const removed = [];
  for (const name of toRemove) {
    try {
      execSync(`npx skills@${SKILLS_CLI_VERSION} remove -s ${name} -y`, {
        stdio: "pipe",
        timeout: 15000
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
  search <query>                    Search skills (local registry \u2192 skills.sh)
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
        console.error(`Error: query required
Usage: skills-manager search <query>`);
        process.exit(1);
      }
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
        for (const s of result.fromWeb.slice(0, 5)) {
          console.log(`  \uD83D\uDCE6 ${s.skill} (${s.repo}) \u2014 ${s.installs} installs`);
        }
      }
      if (result.fromRegistry.length === 0 && result.fromWeb.length === 0) {
        console.log("No results found.");
      }
      console.log(`
---JSON---`);
      console.log(JSON.stringify(result));
      break;
    }
    case "install": {
      const repo = args[0];
      const skillName = args[1];
      if (!repo || !skillName) {
        console.error(`Error: repo and name required
Usage: skills-manager install <owner/repo> <skill-name>`);
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
        console.error(`Error: file and id required
Usage: skills-manager evaluate <response-file> <orch-id>`);
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
        const status = entry.useful === true ? "\u2705" : entry.useful === false ? "\u274C" : "\u2753";
        console.log(`${status} ${entry.skill} (${entry.repo}) \u2014 last used: ${entry.lastUsed ?? "never"}`);
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
  shouldSkipInstall,
  searchSkillsSh,
  searchRegistry,
  search,
  scanSkillContent,
  saveRegistry,
  parseSkillsReport,
  parseArgs,
  loadRegistry,
  isTrustedOwner,
  install,
  getSkillsToRemove,
  getProjectSkillNames,
  evaluateSkills,
  evaluateInstallSafety,
  cleanup,
  buildInstallCommand,
  TRUSTED_OWNERS,
  SKILLS_DIR,
  SKILLS_CLI_VERSION,
  REGISTRY_PATH_DEFAULT,
  DEFAULT_REGISTRY
};
