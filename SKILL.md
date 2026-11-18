---
name: skills-manager
description: Dynamic skill discovery, install, evaluate and cleanup from skills.sh. Use in AI orchestrators to automatically find and install relevant skills per task, collect Skills Reports from subagents, and clean up unused skills after orchestration.
metadata:
  version: "1.0.0"
  tags: ["orchestration", "skills", "agents", "claude"]
---

# Skills Manager

CLI-утилита для динамического управления скиллами с [skills.sh](https://skills.sh) в AI-оркестраторах.

## Установка

```bash
bun add -d @thirdchimp/skills-manager
```

Или разово через npx:
```bash
npx @thirdchimp/skills-manager search "vitest"
```

## Команды

### search — поиск скиллов
```bash
skills-manager search "vitest"
skills-manager search "security"
```

Сначала ищет в локальном реестре `.claude/skills-registry.json`, затем на skills.sh.
Возвращает JSON после разделителя `---JSON---`.

### install — установка с проверкой безопасности
```bash
skills-manager install bobmatnyc/claude-mpm-skills vitest
skills-manager install bobmatnyc/claude-mpm-skills vitest --force
```

Четыре уровня безопасности:
1. Валидация входов — repo и имя скилла проверяются регэкспом до запуска любого процесса
2. Trusted owners (anthropics, vercel-labs, github, ...) — устанавливается без сканирования
3. Sandbox-сканирование — скилл ставится во временную папку, сканируются все файлы (SKILL.md, scripts/, синтаксис `` !`cmd` ``, hooks)
4. Карантин — скилл с флагами НЕ устанавливается, флаги возвращаются оркестратору; `--force` ставит после подтверждения человеком

### evaluate — обработка Skills Report субагента
```bash
skills-manager evaluate /path/to/response.txt orch-2026-03-28
```

Парсит раздел `### Skills Report` из ответа субагента и обновляет реестр.

### cleanup — удаление бесполезных скиллов
```bash
skills-manager cleanup
```

Удаляет скиллы с `useful: false` или `useful: null` — только те, что установлены через skills-manager (по реестру). Скиллы вне реестра никогда не удаляются. Упавшие удаления попадают в `failed` и остаются в реестре.

### list — показать реестр
```bash
skills-manager list
```

## Интеграция с оркестратором

### Phase 1.5: Skills Discovery (после планирования)

```javascript
// Поиск по ключевым словам из задач плана
const keywords = ["testing", "security", "database"]
let externalSkillsInstalled = 0

for (const keyword of keywords) {
  if (externalSkillsInstalled >= 2) break  // макс 2 внешних скилла

  const output = execSync(`skills-manager search "${keyword}"`)
  const json = JSON.parse(output.split("---JSON---")[1])

  // Есть useful:true в реестре → ставим
  const fromRegistry = json.fromRegistry.find(s => s.useful === true)
  if (fromRegistry) {
    // уже установлен, просто используем
    continue
  }

  // Есть на skills.sh → ставим топ-1
  if (json.fromWeb.length > 0) {
    const top = json.fromWeb[0]
    execSync(`skills-manager install "${top.repo}" "${top.skill}"`)
    externalSkillsInstalled++
  }
}
```

### Step 1: Инструкция субагенту

В промпт worker/reviewer добавлять:

```
Доступные скиллы для этой задачи:
- [проектный] supabase-nextjs — Skill("supabase-nextjs")
- [внешний] vitest — Skill("vitest")

Используй релевантные скиллы ДО реализации.

В конце ответа добавь:
### Skills Report
- used: [список использованных]
- ignored: [список проигнорированных, с причиной]
```

### Step 1.5: Evaluate Skills Report

```javascript
const tmpFile = `${workspaceDir}/tmp-response.txt`
writeFileSync(tmpFile, workerResponse)
execSync(`skills-manager evaluate "${tmpFile}" "${orchestrationId}"`)
rmSync(tmpFile)
```

### Phase 4.5: Cleanup

```javascript
const result = execSync('skills-manager cleanup')
```

## Реестр

`.claude/skills-registry.json` — отслеживает историю использования скиллов:

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

## Skills Report формат

Субагенты должны добавлять в конец ответа:

```
### Skills Report
- used: vitest, supabase-nextjs
- ignored: owasp-security (не релевантен для UI задачи)
```
