#!/usr/bin/env node

// src/skills-manager.ts
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, writeFile } from "fs/promises";
import { constants, existsSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { basename, dirname, join } from "path";
import { tmpdir } from "os";
import lockfile from "proper-lockfile";
var TRUSTED_OWNERS = ["anthropics", "vercel-labs", "firebase", "trailofbits", "github"];
var DEFAULT_REGISTRY = {
  skills: {},
  lastSearched: null
};
var REGISTRY_PATH_DEFAULT = join(process.cwd(), ".claude", "skills-registry.json");
var SKILLS_DIR = join(process.cwd(), ".claude", "skills");
async function ensureRegistryDirectory(path) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error(`Registry parent must be a directory: ${directory}`);
  }
}
async function withRegistryLock(path, update) {
  await ensureRegistryDirectory(path);
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 12e4,
    retries: { retries: 32, minTimeout: 20, maxTimeout: 500, randomize: true }
  });
  try {
    return await update();
  } finally {
    await release();
  }
}
async function loadRegistry(path = REGISTRY_PATH_DEFAULT) {
  if (!existsSync(path)) return { ...DEFAULT_REGISTRY, skills: {} };
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}
async function saveRegistry(path = REGISTRY_PATH_DEFAULT, registry) {
  await ensureRegistryDirectory(path);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(registry, null, 2), { flag: "wx", mode: 384 });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
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
    return (data.skills ?? []).map((s) => ({ skill: s.name, repo: s.source, installs: s.installs }));
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
var READ_SKILL_FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
async function scanSkillFile(path) {
  let content;
  try {
    const file = await open(path, READ_SKILL_FILE);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("not a regular file");
      if (info.size > MAX_SCAN_FILE_BYTES) {
        return { safe: false, flags: [`file too large to scan: ${basename(path)}`] };
      }
      content = await file.readFile();
    } finally {
      await file.close();
    }
  } catch {
    return { safe: false, flags: [`unreadable file: ${basename(path)}`] };
  }
  return scanSkillBytes(content, path);
}
function scanSkillBytes(content, path) {
  if (content.includes(0)) {
    return { safe: false, flags: [`binary file in skill: ${basename(path)}`] };
  }
  return scanSkillContent(content.toString("utf-8"));
}
async function scanSkillDir(skillDir) {
  try {
    const { flags } = await inspectSkillTree(skillDir, basename(skillDir), true);
    return { safe: flags.length === 0, flags };
  } catch {
    return { safe: false, flags: ["skill directory not found or unreadable"] };
  }
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
function getLocalSkillNames(skillsDir = SKILLS_DIR) {
  try {
    return readdirSync(skillsDir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}
function shouldSkipInstall(skillName, localSkills) {
  const name = skillName.toLowerCase();
  return localSkills.some((s) => s.toLowerCase() === name);
}
var SHA256_PATTERN = /^[a-f0-9]{64}$/i;
async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
async function hasRealSkillParents(skillsDir) {
  for (const path of [dirname(skillsDir), skillsDir]) {
    const info = await pathInfo(path);
    if (info && !info.isDirectory()) return false;
  }
  return true;
}
function fileIdentity(info) {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}
async function inspectSkillTree(root, name, scan = false) {
  const hash = createHash("sha256");
  const flags = /* @__PURE__ */ new Set();
  const directoryModes = [];
  let hasSymlinks = false;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error("skill root is not a directory");
  hash.update(JSON.stringify(name) + "\n");
  async function visit(path, relative, info) {
    const mode = info.mode & 4095;
    if (info.isDirectory()) {
      hash.update(JSON.stringify(["directory", relative, mode]) + "\n");
      directoryModes.push({ relative, mode });
      const children = await readdir(path, { encoding: "buffer" });
      children.sort(Buffer.compare);
      for (const raw of children) {
        const child = raw.toString("utf8");
        if (!Buffer.from(child).equals(raw)) throw new Error("unsupported non-UTF-8 skill path");
        const childPath = join(path, child);
        await visit(childPath, relative ? `${relative}/${child}` : child, await lstat(childPath));
      }
      return;
    }
    if (info.isSymbolicLink()) {
      const link = await readlink(path, { encoding: "buffer" });
      hash.update(JSON.stringify(["symlink", relative, mode, link.toString("base64")]) + "\n");
      hasSymlinks = true;
      if (scan) flags.add(`suspicious: non-regular file in skill directory: ${basename(path)}`);
      return;
    }
    if (!info.isFile()) throw new Error(`unsupported file in skill tree: ${relative}`);
    const file = await open(path, READ_SKILL_FILE);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.mode !== info.mode || fileIdentity(opened) !== fileIdentity(info)) {
        throw new Error(`file changed while reading skill tree: ${relative}`);
      }
      const digest = createHash("sha256");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        digest.update(chunk);
        bytes += chunk.length;
        if (scan && bytes <= MAX_SCAN_FILE_BYTES) chunks.push(chunk);
      }
      hash.update(JSON.stringify(["file", relative, mode, digest.digest("hex")]) + "\n");
      if (scan) {
        if (bytes > MAX_SCAN_FILE_BYTES) flags.add(`file too large to scan: ${basename(path)}`);
        else for (const flag of scanSkillBytes(Buffer.concat(chunks), path).flags) flags.add(flag);
      }
    } finally {
      await file.close();
    }
  }
  await visit(root, "", rootInfo);
  return { contentHash: hash.digest("hex"), flags: [...flags], directoryModes, hasSymlinks };
}
async function install(repo, skillName, registryPath = REGISTRY_PATH_DEFAULT, opts = {}) {
  if (!validateRepo(repo)) {
    return { installed: false, skillName, reason: "invalid repo", flags: [] };
  }
  if (!validateSkillName(skillName)) {
    return { installed: false, skillName, reason: "invalid skill name", flags: [] };
  }
  if (opts.force !== void 0 && (typeof opts.force !== "string" || !SHA256_PATTERN.test(opts.force))) {
    return { installed: false, skillName, reason: "--force requires a SHA-256 content hash", flags: [] };
  }
  if (!await hasRealSkillParents(SKILLS_DIR)) {
    return { installed: false, skillName, reason: "unsafe project skills directory", flags: [] };
  }
  if (shouldSkipInstall(skillName, getLocalSkillNames())) {
    return { installed: false, skillName, reason: `conflict: local skill "${skillName}" already exists`, flags: [] };
  }
  const sandbox = await mkdtemp(join(tmpdir(), "skills-manager-"));
  try {
    try {
      npx(buildInstallArgs(repo, skillName), { cwd: sandbox, timeout: 6e4 });
    } catch (err) {
      return { installed: false, skillName, reason: `sandbox install failed: ${String(err)}`, flags: [] };
    }
    const sandboxSkills = join(sandbox, ".claude", "skills");
    if (!await hasRealSkillParents(sandboxSkills)) {
      return { installed: false, skillName, reason: "unsafe sandbox skills directory", flags: [] };
    }
    const dirs = getLocalSkillNames(sandboxSkills);
    if (dirs.length !== 1) {
      return { installed: false, skillName, reason: `expected exactly one skill in download, got ${dirs.length}`, flags: [] };
    }
    const dirName = dirs[0];
    const source = join(sandboxSkills, dirName);
    if (!validateSkillName(dirName)) {
      return { installed: false, skillName, reason: `invalid installed directory name "${dirName}"`, flags: [] };
    }
    const sourceInfo = await pathInfo(source);
    if (!sourceInfo?.isDirectory()) {
      return { installed: false, skillName: dirName, reason: "unsafe downloaded skill directory", flags: [] };
    }
    const instructions = await pathInfo(join(source, "SKILL.md"));
    if (instructions?.isSymbolicLink()) {
      return { installed: false, skillName: dirName, reason: "SKILL.md must be a regular file", flags: [] };
    }
    if (!instructions?.isFile()) {
      return { installed: false, skillName: dirName, reason: "SKILL.md not found in download", flags: [] };
    }
    const trusted = isTrustedOwner(repo);
    let tree;
    try {
      tree = await inspectSkillTree(source, dirName, !trusted);
    } catch (err) {
      return { installed: false, skillName: dirName, reason: `cannot inspect download: ${String(err)}`, flags: [] };
    }
    const { contentHash, flags, directoryModes, hasSymlinks } = tree;
    if (hasSymlinks) {
      return { installed: false, skillName: dirName, reason: "symbolic links are not supported in skill downloads", flags, contentHash };
    }
    if (opts.force !== void 0 && opts.force.toLowerCase() !== contentHash) {
      return { installed: false, skillName: dirName, reason: "reviewed content hash does not match download", flags, contentHash };
    }
    if (flags.length > 0 && opts.force === void 0) {
      return { installed: false, skillName: dirName, reason: `quarantine: ${flags.join(", ")}`, flags, contentHash };
    }
    return await withRegistryLock(registryPath, async () => {
      if (!await hasRealSkillParents(SKILLS_DIR)) {
        return { installed: false, skillName: dirName, reason: "unsafe project skills directory", flags, contentHash };
      }
      if (shouldSkipInstall(dirName, getLocalSkillNames())) {
        return { installed: false, skillName: dirName, reason: `conflict: local skill "${dirName}" already exists`, flags, contentHash };
      }
      const registry = await loadRegistry(registryPath);
      const destination = join(SKILLS_DIR, dirName);
      await mkdir(SKILLS_DIR, { recursive: true });
      const staging = await mkdtemp(join(SKILLS_DIR, ".skills-manager-"));
      const stagedSkill = join(staging, dirName);
      let directoryId;
      try {
        await cp(source, stagedSkill, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        for (const { relative } of directoryModes) {
          if (!(await lstat(join(stagedSkill, relative))).isDirectory()) {
            throw new Error("copied directory differs from checked download");
          }
        }
        for (const { relative, mode } of directoryModes.reverse()) {
          await chmod(join(stagedSkill, relative), mode);
        }
        const staged = await inspectSkillTree(stagedSkill, dirName);
        if (staged.contentHash !== contentHash) throw new Error("copied tree differs from checked download");
        directoryId = fileIdentity(await lstat(stagedSkill));
        await rename(stagedSkill, destination);
      } catch (err) {
        return { installed: false, skillName: dirName, reason: `copy failed: ${String(err)}`, flags, contentHash };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      const entry = {
        repo,
        skill: dirName,
        usedIn: [],
        useful: null,
        lastUsed: null,
        installedAt: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
        trusted,
        contentHash,
        directoryId
      };
      registry.skills = { ...registry.skills, [dirName]: entry };
      try {
        await saveRegistry(registryPath, registry);
      } catch (err) {
        await removeMatchingSkill(dirName, entry).catch(() => false);
        throw err;
      }
      const reason = flags.length > 0 ? `force-installed despite flags: ${flags.join(", ")}` : "ok";
      return { installed: true, skillName: dirName, reason, flags, contentHash };
    });
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
    if (Object.hasOwn(registry.skills, name)) {
      registry.skills[name].useful = true;
      registry.skills[name].lastUsed = today;
      if (!registry.skills[name].usedIn.includes(report.orchestrationId)) {
        registry.skills[name].usedIn.push(report.orchestrationId);
      }
    }
  }
  for (const name of report.ignored) {
    const entry = registry.skills[name];
    if (Object.hasOwn(registry.skills, name) && entry.usedIn.length === 0) {
      entry.useful = false;
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
async function removeMatchingSkill(name, entry) {
  if (!await hasRealSkillParents(SKILLS_DIR)) return false;
  const path = join(SKILLS_DIR, name);
  const info = await pathInfo(path);
  if (!info) return true;
  if (!info.isDirectory() || !entry?.contentHash || fileIdentity(info) !== entry.directoryId) {
    return false;
  }
  const { contentHash } = await inspectSkillTree(path, name);
  if (contentHash !== entry.contentHash || !await hasRealSkillParents(SKILLS_DIR)) return false;
  const current = await pathInfo(path);
  if (!current?.isDirectory() || fileIdentity(current) !== entry.directoryId) return false;
  await rm(path, { recursive: true });
  return true;
}
async function cleanup(registryPath = REGISTRY_PATH_DEFAULT) {
  return withRegistryLock(registryPath, async () => {
    const registry = await loadRegistry(registryPath);
    const toRemove = getSkillsToRemove(registry, []);
    const removed = [];
    const failed = [];
    const preserved = [];
    for (const name of toRemove) {
      if (!validateSkillName(name)) {
        failed.push(name);
        delete registry.skills[name];
        continue;
      }
      try {
        const entry = Object.hasOwn(registry.skills, name) ? registry.skills[name] : void 0;
        if (entry?.useful === true || !await removeMatchingSkill(name, entry)) {
          preserved.push(name);
          continue;
        }
        removed.push(name);
        delete registry.skills[name];
      } catch {
        failed.push(name);
      }
    }
    const kept = Object.keys(registry.skills);
    await saveRegistry(registryPath, registry);
    return { removed, failed, kept, preserved };
  });
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
  install <owner/repo> <name> [--force <sha256>]
                                    Install a skill with security scanning
  evaluate <response-file> <id>     Parse Skills Report from subagent response
  cleanup                           Remove unused skills
  list                              Show local registry
  help, --help, -h                  Show this help

Examples:
  skills-manager search vitest
  skills-manager install bobmatnyc/claude-mpm-skills vitest
  skills-manager install bobmatnyc/claude-mpm-skills vitest --force <approved-sha256>
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
  quarantined: review the flags and contentHash. Use --force <sha256>
  with the approved hash to install the reviewed version.
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
      const [repo, skillName, option, force] = args;
      if (!repo || !skillName || args.length !== 2 && (args.length !== 4 || option !== "--force" || !SHA256_PATTERN.test(force))) {
        console.error(
          "Usage: skills-manager install <owner/repo> <skill-name> [--force <sha256>]"
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
      const updated = await withRegistryLock(REGISTRY_PATH_DEFAULT, async () => {
        const registry = evaluateSkills(await loadRegistry(), { ...report, orchestrationId: orchId });
        await saveRegistry(REGISTRY_PATH_DEFAULT, registry);
        return Object.keys(registry.skills);
      });
      console.log(JSON.stringify({ report, updated }));
      break;
    }
    case "cleanup": {
      const result = await cleanup();
      console.log(`Removed: ${result.removed.join(", ") || "none"}`);
      if (result.failed.length > 0) {
        console.log(`Failed:  ${result.failed.join(", ")}`);
      }
      if (result.preserved.length > 0) {
        console.log(`Preserved: ${result.preserved.join(", ")}`);
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
