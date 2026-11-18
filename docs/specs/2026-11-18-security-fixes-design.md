# Security & bug fixes — design

Date: 2026-11-18. Scope: `src/skills-manager.ts`, tests, docs. One flow redesigned (install), one fixed (cleanup).

## Intent

Fix the 4 bugs and 3 security issues from review. Root causes: install scans
**after** files land in agent dirs, cleanup treats installed skills as
"project" skills, and CLI args are interpolated into shell strings.

## Approaches considered (scan-before-install)

1. **Temp-dir install (picked).** Run `skills add` in a sandbox dir, scan all
   files there, real install only if safe. Scans exactly what will be
   installed; works for any source; CLI runs twice (npx cache makes it cheap).
   Empirically verified: CLI installs into arbitrary cwd.
2. GitHub API fetch — rejected: GitHub-only, 60 req/h rate limit, duplicates
   the CLI's skill-discovery logic.
3. Keep scan-after-install — rejected: leaves the toctou window (security issue 2).

## Decisions

- **Cleanup (bug 1):** registry is the source of truth for "installed by
  skills-manager". Candidates for removal = registry entries with
  `useful !== true`, minus an explicit protected list. Skills on disk that are
  **not** in the registry are project skills — never touched. Failed removals
  go to a new `failed` list, not `removed` (bug 4); registry entry is deleted
  only after successful removal.
- **Install (bug 2):** always `--skill <name> -a claude-code` — exactly one
  skill, deterministic target dir.
- **Fail-closed (bug 3):** missing SKILL.md after install → best-effort
  remove, `installed: false`.
- **Injection (sec 1):** `execFileSync` with args arrays everywhere; `repo`
  must match `^[\w.-]+/[\w.-]+$`, `skillName` — `^[\w][\w.-]*$`; anything else
  is rejected before any subprocess runs.
- **Quarantine with human confirmation (sec 3):** untrusted skill with flags
  is **not installed**; flags are returned to the orchestrator; a human can
  override with `install ... --force`. No silent auto-remove.
- **Scanner (sec 3):** scans **all text files** of the skill (incl.
  `scripts/`), not just SKILL.md; new patterns: `!`…`` (exec-on-load),
  frontmatter `hooks:`, `base64 -d | sh`. Honest limit: regex heuristics are
  a first line of defense, not a guarantee — that's why quarantine is
  human-in-the-loop.
- `SKILLS_CLI_VERSION` bump 1.4.6 → 1.5.20 (flags verified empirically).

## Non-goals

Sandboxed script execution, non-GitHub sources, agents other than
claude-code, LLM-based content analysis, Windows CI (npx.cmd handled, not tested).

## Residual risks

Repo HEAD can move between sandbox install and real install (scan copy may
differ from what lands). Accepted: installs are interactive-frequency events.
