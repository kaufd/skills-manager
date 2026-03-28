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
  install <owner/repo> <name>       Install a skill with security scanning
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

### install

Installs a skill from a GitHub repo with a three-tier security check:

1. **Trusted owners** (anthropics, vercel-labs, github, firebase, trailofbits) — installed without scanning
2. **Content scan** — checks SKILL.md for prompt injection, dangerous shell commands, secret access patterns
3. **Quarantine** — removes the skill and reports if flags are found

```bash
skills-manager install bobmatnyc/claude-mpm-skills vitest
```

Returns JSON: `{ installed, skillName, reason }`.

### evaluate

Parses a `### Skills Report` section from a subagent response file and updates the local registry.

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

Removes skills marked as `useful: false` or never evaluated (`useful: null`). Project skills in `.claude/skills/` are never removed.

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

## Orchestrator Integration

### Phase 1.5 — Skills Discovery (after planning, before task loop)

```js
const keywords = ["testing", "security", "database"]
let installed = 0

for (const keyword of keywords) {
  if (installed >= 2) break  // max 2 external skills per orchestration

  const output = execSync(`skills-manager search "${keyword}"`).toString()
  const json = JSON.parse(output.split("---JSON---")[1])

  // Already have a useful skill in registry — skip
  if (json.fromRegistry.some(s => s.useful === true)) continue

  // Top result from skills.sh — install it
  if (json.fromWeb.length > 0) {
    const top = json.fromWeb[0]
    execSync(`skills-manager install "${top.repo}" "${top.skill}"`)
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
execSync(`skills-manager evaluate "${tmpFile}" "${orchestrationId}"`)
unlinkSync(tmpFile)
```

### Phase 4.5 — Cleanup after all tasks complete

```js
execSync("skills-manager cleanup")
```

## Security

Scanned patterns include:

| Category | Examples |
|----------|----------|
| Prompt injection | `ignore previous instructions`, `you are now`, `do not follow` |
| Dangerous shell | `curl ... \| sh`, `wget ... \| bash`, `rm -rf /` |
| Secret access | `process.env.*SECRET`, `process.env.*TOKEN`, `process.env.*KEY` |
| Exfiltration | `send it to the API`, reads `.env.local` |

## License

MIT
