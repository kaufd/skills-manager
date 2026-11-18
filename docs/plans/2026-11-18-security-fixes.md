# Security & Bug Fixes Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 bugs and 3 security issues: scan-before-install in a sandbox dir, registry-based cleanup, fail-closed missing-SKILL.md handling, no shell injection, quarantine with human `--force` override, stronger scanner.

**Architecture:** Single-file CLI (`src/skills-manager.ts`) keeps its structure. All `skills` CLI calls go through one `npx()` helper using `execFileSync` (args array, never a shell string). Install for untrusted repos runs twice: once into a `mkdtemp` sandbox for scanning all skill files, once for real. Cleanup trusts only the registry as the list of skills it installed.

**Tech Stack:** TypeScript (strict), node:child_process `execFileSync`, node:fs/promises, vitest with `vi.mock("node:child_process")`.

**Spec:** `docs/specs/2026-11-18-security-fixes-design.md`

## Global Constraints

- Node >= 18, no new dependencies (spec: Non-goals).
- Every subprocess call: `execFileSync(npxFile(), [args], { stdio: "pipe", timeout, cwd })` — no string commands, no `execSync`.
- `repo` must match `^[\w.-]+\/[\w.-]+$`, `skillName` must match `^[\w][\w.-]*$`; rejection happens before any subprocess (spec: Decisions/Injection).
- Untrusted + flagged skill is never installed without `--force` (spec: Quarantine).
- `SKILLS_CLI_VERSION` becomes `"1.5.20"` (spec: Decisions).
- Windows `npx.cmd` handled via `process.platform === "win32"` ternary (untested, spec: Non-goals).

## Review Focus

1. Malicious `repo`/`skillName` (`; rm -rf ~`, `$(...)`, spaces): rejected before any subprocess, and subprocess is `execFileSync` so even a miss can't inject. → Task 1 tests.
2. Sandbox temp dir left behind when scan or CLI throws mid-install: must be removed in `finally`. → Task 2 test (assert dir gone after quarantine result).
3. Cleanup with a registry entry whose skill no longer exists on disk: `skills remove` may fail → entry goes to `failed` and is kept, not reported `removed`. → Task 3 tests.
4. `searchSkillsSh` gets malformed/throwing JSON: returns `[]`, never throws. → existing test covers error; Task 5 re-runs suite.
5. `loadRegistry` on a corrupt registry file crashes the CLI: keep current fail-loud behavior (bug fix, not a redesign — spec Non-goals), but tests must not write corrupt fixtures.

---

### Task 1: Safe subprocess layer, input validation, scanner hardening

**Files:**
- Modify: `src/skills-manager.ts` (lines ~10-13 imports, 121-176 security/install helpers)
- Test: `tests/skills-manager.test.ts`

**Interfaces:**
- Consumes: none (leaf task).
- Produces (exported, used by Tasks 2-4):
  - `validateRepo(repo: string): boolean` — `^[\w.-]+\/[\w.-]+$`
  - `validateSkillName(name: string): boolean` — `^[\w][\w.-]*$`
  - `npx(args: string[], opts: { cwd: string; timeout?: number }): void` — `execFileSync` wrapper, throws on failure
  - `buildInstallArgs(repo: string, skillName: string): string[]` — returns `["skills@1.5.20", "add", repo, "--skill", skillName, "--copy", "-a", "claude-code", "-y"]`
  - `buildRemoveArgs(skillName: string): string[]` — `["skills@1.5.20", "remove", "-s", skillName, "-y"]`
  - `getLocalSkillNames(skillsDir?: string): string[]` — renamed from `getProjectSkillNames` (bug 1: directory contents are no longer assumed to be "project" skills; the name must not lie)
  - `scanSkillFile(path: string): Promise<ScanResult>` — reads one file, runs `scanSkillContent`
  - `scanSkillDir(skillDir: string): Promise<ScanResult>` — walks `skillDir` recursively (own tiny walker, no glob dep), scans every file ≤ 512 KB that decodes as UTF-8; merges flags, `safe` = no flags
- `SKILLS_CLI_VERSION` = `"1.5.20"`.

- [ ] **Step 1: Replace `execSync` import with `execFileSync`; add `npx()` helper**

  `npxFile()` returns `"npx.cmd"` on win32 else `"npx"`. First array element is `skills@${SKILLS_CLI_VERSION}` (consumed via `npx`'s package-spec arg).

- [ ] **Step 2: Add validators and arg builders**

  Delete `buildInstallCommand` (string) — replaced by `buildInstallArgs`.

- [ ] **Step 3: Rename `getProjectSkillNames` → `getLocalSkillNames`**; update its two call sites (they are removed in Tasks 2-3 anyway, keep compiling).

- [ ] **Step 4: Extend `DANGEROUS_PATTERNS`** with, per spec:
  - `/^\s*!\`[^\n]+\`/m` — description `"dangerous: shell command executed on skill load"` (the `!`…`` hook syntax)
  - `/^hooks:/m` on lines within the first frontmatter block — simplest honest form: `/^---\n[\s\S]*?^hooks:/m` — description `"dangerous: skill declares hooks"`
  - `/base64\s+(-d|--decode)[^|]*\|/i` — description `"dangerous: base64-decoded pipe to shell"`

- [ ] **Step 5: Implement `scanSkillFile` / `scanSkillDir`**

  Walker: `readdirSync(dir, { withFileTypes: true })`, recurse into directories, read files with `readFile`. Skip files > 512 KB and files whose content contains a NUL byte (binary). `scanSkillDir` returns merged flags (deduped).

- [ ] **Step 6: Tests**

  Replace the `buildInstallCommand` test with:

  ```ts
  it("builds install args as array for exactly one skill", () => {
    expect(buildInstallArgs("owner/repo", "vitest"))
      .toEqual(["skills@1.5.20", "add", "owner/repo", "--skill", "vitest", "--copy", "-a", "claude-code", "-y"]);
  });
  it("rejects malicious repo and skill names", () => {
    expect(validateRepo("owner/repo")).toBe(true);
    expect(validateRepo("a; rm -rf ~")).toBe(false);
    expect(validateRepo("$(whoami)/x")).toBe(false);
    expect(validateRepo("owner/repo extra")).toBe(false);
    expect(validateSkillName("vitest")).toBe(true);
    expect(validateSkillName("owasp-security")).toBe(true);
    expect(validateSkillName("x; rm -rf ~")).toBe(false);
    expect(validateSkillName("$(id)")).toBe(false);
    expect(validateSkillName("-n")).toBe(false); // must not start with a dash: option injection
  });
  it("flags load-time shell hooks and hooks frontmatter", () => {
    expect(scanSkillContent("# S\n\n!`rm -rf /tmp/x`\n").safe).toBe(false);
    expect(scanSkillContent("---\nname: x\nhooks: ...\n---\n# x\n").safe).toBe(false);
    expect(scanSkillContent("# S\n\n```bash\nbase64 -d <<< aGk= | sh\n```\n").safe).toBe(false);
  });
  it("scans all files in a skill dir, including scripts/", async () => {
    // mkdtemp skill dir with clean SKILL.md + malicious scripts/setup.sh
    // expect (await scanSkillDir(dir)).toEqual({ safe: false, flags: [expect.stringContaining("curl")] })
    // clean dir → { safe: true, flags: [] }
  });
  ```

- [ ] **Step 7: Run**

  Run: `bunx vitest run tests/skills-manager.test.ts`
  Expected: PASS (old `getProjectSkillNames` usages in tests, if any, renamed).

---

### Task 2: install() — sandbox pre-scan, quarantine with `--force`, fail-closed

**Files:**
- Modify: `src/skills-manager.ts` (install section, ~lines 194-264)
- Test: `tests/skills-manager.test.ts`

**Interfaces:**
- Consumes: Task 1's `npx`, `validateRepo`, `validateSkillName`, `buildInstallArgs`, `buildRemoveArgs`, `scanSkillDir`.
- Produces:
  - `install(repo: string, skillName: string, registryPath?: string, opts?: { force?: boolean }): Promise<InstallResult & { flags: string[] }>`
  - `InstallResult` gains `flags: string[]` (empty when not quarantined).

**Flow (spec: Decisions):**

- [ ] **Step 1: Validate inputs first**

  `install()` starts with validator checks → `{ installed: false, skillName, reason: "invalid repo" | "invalid skill name", flags: [] }` before any subprocess.

- [ ] **Step 2: Trusted-owner fast path**

  `isTrustedOwner(repo)` → real install directly (no sandbox), then Step 4.

- [ ] **Step 3: Sandbox scan for untrusted repos**

  `mkdtemp(join(tmpdir(), "skills-manager-"))` (use the approved temp root when set: `process.env.TMPDIR` is honored by `tmpdir()` automatically). Run `npx(buildInstallArgs(repo, skillName), { cwd: sandbox, timeout: 60_000 })`. Scan `join(sandbox, ".claude", "skills", skillName)` via `scanSkillDir` (missing dir → fail-closed, same as flags). Wrap the whole sandbox block in `try/finally { rm(sandbox, { recursive: true, force: true }) }` (Review Focus #2). If flags and not `opts.force` → `{ installed: false, reason: "quarantine: <flags>", flags }`, no real install.

- [ ] **Step 4: Real install + fail-closed verification (bug 3)**

  `npx(buildInstallArgs(...), { cwd: process.cwd(), timeout: 60_000 })`. Then read `join(SKILLS_DIR, skillName, "SKILL.md")`; on failure → best-effort `npx(buildRemoveArgs(skillName), ...)` and `{ installed: false, reason: "installed but SKILL.md not found; rolled back", flags: [] }`.

- [ ] **Step 5: Registry write unchanged** (plus `flags: []` in the return).

- [ ] **Step 6: Tests** — `vi.mock("node:child_process")` with a `execFileSync` mock that inspects `opts.cwd` and `args`:
  - When args contain `"add"` and `cwd` is the sandbox, the mock writes a controlled fake skill tree (clean or malicious per test) under `<cwd>/.claude/skills/<name>/`.
  - When `cwd` is `process.cwd()`, it writes the skill into `SKILLS_DIR` (point `SKILLS_DIR`-based paths at a `mkdtemp` project dir by testing via a temp `process.cwd`? — no: keep `install` writing to `SKILLS_DIR` const; in the mock, write into `join(process.cwd(), ".claude", "skills", <name>)` and clean up in `afterEach`).

  Cases:
  1. trusted repo → mock called once (no sandbox run), registry entry written, `{ installed: true, flags: [] }`
  2. untrusted + malicious sandbox content → `installed: false`, reason starts `"quarantine:"`, flags non-empty, real-install call never happened, sandbox dir removed (capture the mkdtemp path from mock calls, `existsSync` false after)
  3. untrusted + malicious + `opts.force = true` → installed, registry entry written
  4. untrusted + clean → installed
  5. `repo = "a; rm"` → mock never called
  6. real install writes no SKILL.md → `installed: false`, a `"remove"` call happened

- [ ] **Step 7: Run**

  Run: `bunx vitest run tests/skills-manager.test.ts`
  Expected: PASS

---

### Task 3: cleanup() — registry-based, `failed` list

**Files:**
- Modify: `src/skills-manager.ts` (cleanup section, ~lines 324-362)
- Test: `tests/skills-manager.test.ts`

**Interfaces:**
- Consumes: Task 1's `npx`, `buildRemoveArgs`.
- Produces:
  - `getSkillsToRemove(registry: SkillsRegistry, protectedNames: string[]): string[]` — signature unchanged, **semantics per spec**: candidates are registry entries (the skills this tool installed) with `useful !== true`, minus `protectedNames`. Disk contents are irrelevant.
  - `cleanup(registryPath?: string): Promise<{ removed: string[]; failed: string[]; kept: string[] }>`

- [ ] **Step 1: Rework `getSkillsToRemove`**

  Same filter body as today (`useful !== true`, excluding protected names) — the fix is that `cleanup` stops passing disk listings as the protected set.

- [ ] **Step 2: Rework `cleanup()` (bugs 1, 4)**

  - Protected = registry entries with `useful === true` (the filter itself) plus the `protectedNames` parameter for anything the orchestrator wants shielded explicitly (API compat with the old signature). Disk contents are never used to build the protected set — that was bug 1. Skills on disk that are not in the registry are never candidates because candidates come from the registry only.
  - For each name in `toRemove`: `try { npx(buildRemoveArgs(name), { cwd: process.cwd(), timeout: 30_000 }); removed.push(name); delete registry.skills[name]; } catch { failed.push(name); }` — registry entry deleted **only on success** (spec).
  - `kept` = remaining registry keys.
  - Delete `shouldSkipInstall`'s dependence on the old semantics: `install()` still calls it with `getLocalSkillNames()` — that check stays valid (name collision with any local skill, project or installed, is a real conflict).

- [ ] **Step 3: Tests**

  ```ts
  it("getSkillsToRemove: useful skill kept, useless and unevaluated removed", ...);   // existing two tests, unchanged assertions still pass
  it("cleanup: failed removal is reported in failed and kept in registry", async () => {
    // registry with one useful:false skill; mock execFileSync throws on "remove"
    // expect { removed: [], failed: ["owasp-security"], kept: ["owasp-security"] }
    // registry file on disk still contains the entry
  });
  it("cleanup: successful removal deletes registry entry", async () => {
    // mock succeeds → { removed: ["owasp-security"], failed: [], kept: [] }, registry file empty
  });
  it("cleanup: skills on disk but not in registry are never removed", async () => {
    // create .claude/skills/some-project-skill/SKILL.md; registry has another skill
    // mock must never be called with "some-project-skill"
  });
  ```

- [ ] **Step 4: Run**

  Run: `bunx vitest run tests/skills-manager.test.ts`
  Expected: PASS

---

### Task 4: CLI wiring + docs

**Files:**
- Modify: `src/skills-manager.ts` (`main()` install/cleanup cases, `printUsage`)
- Modify: `README.md`, `SKILL.md`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: CLI surface `install <owner/repo> <name> [--force]`, `cleanup` printing `Removed/Failed/Kept`.

- [ ] **Step 1: Parse `--force`** in the install case (`args.includes("--force")`), pass to `install(..., { force })`.
- [ ] **Step 2: Cleanup case prints `Failed:` line** when `result.failed.length > 0`; JSON output includes `failed`.
- [ ] **Step 3: Update `printUsage`** — add `[--force]`, describe quarantine semantics ("flagged skills are not installed; pass --force after human review").
- [ ] **Step 4: Update README.md** — Commands block (`install ... [--force]`, `cleanup` output), Security section (sandbox pre-scan, all-files scan, quarantine-not-auto-remove, execFileSync), remove the stale "Project skills in `.claude/skills/` are never removed" line → "Skills not installed by skills-manager are never removed". Same edits in SKILL.md (install section three-tier list and cleanup section).
- [ ] **Step 5: Run CLI smoke**

  Run: `bun run src/skills-manager.ts --help`
  Expected: usage text shows `--force` and updated security wording.

---

### Task 5: Full verification

- [ ] **Step 1:** `bunx vitest run` — Expected: all PASS, no test left referencing `buildInstallCommand` or `getProjectSkillNames`.
- [ ] **Step 2:** `bun run build` — Expected: clean tsup build, no TS errors.
- [ ] **Step 3:** Review the full test diff against the test-guard skill (mocks assert call args, no weakened assertions, tests clean up temp dirs and `.claude/skills` writes).
