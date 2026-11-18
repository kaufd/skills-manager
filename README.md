# skills-manager

Dynamic skill discovery, install, evaluate and cleanup from [skills.sh](https://skills.sh) for AI agent orchestrators.

Designed to be used inside orchestration workflows (e.g. Claude Code `/orchestrate`) to automatically find and install relevant skills per task, collect feedback via Skills Reports, and remove unused skills after the run.

## Install

```bash
# Add to your project
bun add -d @thirdchimp/skills-manager

# Or run without installing
npx @thirdchimp/skills-manager --help
```

## Commands

```
skills-manager <command> [args]

Commands:
  search <query>                    Search skills (local registry → skills.sh)
  install <owner/repo> <name> [--force]
                                    Install a skill with security scanning
  evaluate <response-file> <id>     Parse Skills Report from subagent response
  cleanup                           Remove unused skills
  list                              Show local registry
  help, --help, -h                  Show this help
```

### search

Searches the local registry first. Falls back to skills.sh if no useful results are cached.

```bash
skills-manager search vitest
skills-manager search security
```

Output includes a `---JSON---` separator followed by machine-readable JSON — useful for orchestrators that need to parse results.

`fromWeb` keeps skills.sh's relevance order (not sorted by installs). The first result is not necessarily right for the task — the calling agent should pick by `name`/`repo`.

### install

Installs exactly one skill from a GitHub repo. Security pipeline:

1. **Input validation** — repo and skill names are checked (`^[\w.-]+/[\w.-]+$`, `^[\w][\w.-]*$`) before any subprocess runs
2. **Trusted owners** (anthropics, vercel-labs, github, firebase, trailofbits) — installed without scanning
3. **Sandbox scan** (everyone else) — the skill is downloaded once into a temporary sandbox dir and *every* file is scanned (SKILL.md, `scripts/`, load-time hooks, ...). The scanned copy itself is then moved into `.claude/skills` — nothing is downloaded twice
4. **Quarantine** — flagged skills are **not installed**; the flags are returned so a human can review. `--force` installs anyway after review

```bash
skills-manager install bobmatnyc/claude-mpm-skills vitest
skills-manager install bobmatnyc/claude-mpm-skills vitest --force   # after human review
```

Returns JSON: `{ installed, skillName, reason, flags }`.

The installed directory is named after the skill's own frontmatter name (lowercased), which may differ from `<name>`; the returned `skillName` is the real one. A local skill with the same name in any letter case is never overwritten.

### evaluate

Parses a `### Skills Report` section from a subagent response file and updates the local registry.

A skill listed as `ignored` is marked useless only if it has never been used in any earlier run — one "not needed this time" doesn't get a previously useful skill removed.

```bash
skills-manager evaluate /tmp/worker-response.txt orch-2026-03-28
```

Expected format in subagent response:

```
### Skills Report
- used: vitest, supabase-nextjs
- ignored: owasp-security (not relevant for this UI task)
```

### cleanup

Removes skills **installed by skills-manager** (tracked in the registry) that were marked `useful: false` or never evaluated. Skills not installed by skills-manager are never touched. Failed removals are reported in a separate `failed` list and stay in the registry for the next run.

```bash
skills-manager cleanup
```

### list

Shows all skills in the local registry with their status.

```bash
skills-manager list
# ✅ vitest (bobmatnyc/claude-mpm-skills) — last used: 2026-03-28
# ❌ owasp-security (hoodini/ai-agents-skills) — last used: never
# ❓ unknown-skill (x/y) — last used: never
```

## Registry

Skills usage history is stored in `.claude/skills-registry.json` in your project root:

```json
{
  "skills": {
    "vitest": {
      "repo": "bobmatnyc/claude-mpm-skills",
      "skill": "vitest",
      "usedIn": ["orch-001", "orch-002"],
      "useful": true,
      "lastUsed": "2026-03-28",
      "installedAt": "2026-03-25",
      "trusted": false
    }
  },
  "lastSearched": null
}
```

## Single Agent Session

No orchestrator needed — the agent itself picks and evaluates skills:

1. `skills-manager search "<keyword>"` — pick the candidate that fits **your task** from `fromWeb`, not blindly the first. A `useful: true` entry in `fromRegistry` is already installed.
2. `skills-manager install <repo> <skill>` — if quarantine flags come back, show them to the user; `--force` only after they confirm.
3. Use the skill. If it doesn't show up among the session's available skills, read `.claude/skills/<skill>/SKILL.md` directly.
4. When done, write your own `### Skills Report` to a file and run `skills-manager evaluate <file> <session-id>`.
5. `skills-manager cleanup` at the end of the session.

## Orchestrator Integration

### Phase 1.5 — Skills Discovery (after planning, before task loop)

```js
const keywords = ["testing", "security", "database"]
let installed = 0

for (const keyword of keywords) {
  if (installed >= 2) break  // max 2 external skills per orchestration

  const output = execFileSync("skills-manager", ["search", keyword]).toString()
  const json = JSON.parse(output.split("---JSON---")[1])

  // Already have a useful skill in registry — skip
  if (json.fromRegistry.some(s => s.useful === true)) continue

  // Let the orchestrator's LLM pick the candidate that fits the task — not blindly [0]
  if (json.fromWeb.length > 0) {
    const top = pickForTask(json.fromWeb, taskDescription)
    execFileSync("skills-manager", ["install", top.repo, top.skill])
    installed++
  }
}
```

### Step 1 — Tell the subagent which skills to use

Add to worker/reviewer prompt:

```
Available skills for this task:
- [project] supabase-nextjs — Skill("supabase-nextjs")
- [external] vitest — Skill("vitest")

Use relevant skills before implementing.

At the end of your response, add:
### Skills Report
- used: [list of skills you used]
- ignored: [list of skills you skipped, with reason]
```

### Step 1.5 — Evaluate Skills Report after subagent response

```js
const tmpFile = `${workspaceDir}/tmp-response.txt`
writeFileSync(tmpFile, workerResponse)
execFileSync("skills-manager", ["evaluate", tmpFile, orchestrationId])
unlinkSync(tmpFile)
```

### Phase 4.5 — Cleanup after all tasks complete

```js
execFileSync("skills-manager", ["cleanup"])
```

## Security

- All `skills` CLI invocations use `execFileSync` with argument arrays — repo and skill names are never interpolated into a shell string, and are additionally validated with a regexp before any subprocess runs. Call skills-manager the same way from your orchestrator: values from skills.sh are external data.
- The `skills` CLI only downloads into a sandbox dir. skills-manager itself copies the scanned skill into `.claude/skills` and `cleanup` removes only that directory — skill dirs of other agents (`.agents/`, `.cursor/`, ...) are never touched.
- Untrusted skills have every file (not just SKILL.md) scanned before anything lands in the project.

Scanned patterns include:

| Category | Examples |
|----------|----------|
| Prompt injection | `ignore previous instructions`, `you are now`, `do not follow` |
| Dangerous shell | `curl ... \| sh`, `wget ... \| bash`, `rm -rf /`, `base64 -d ... \| sh` |
| Load-time hooks | `` !`command` `` executed on skill load, `hooks:` frontmatter |
| Secret access | `process.env.*SECRET`, `process.env.*TOKEN`, `process.env.*KEY` |
| Exfiltration | `send it to the API`, reads `.env.local` |

Regex heuristics are a first line of defense, not a guarantee — that is why flagged skills are quarantined for human review (`--force` to override) instead of being silently trusted.

## License

MIT
