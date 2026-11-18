---
name: skills-manager
description: Dynamic skill discovery, install, evaluate and cleanup from skills.sh. Use in AI orchestrators or in a single agent session to find and install relevant skills per task, collect Skills Reports, and clean up unused skills afterwards.
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
Возвращает JSON после разделителя `---JSON---`. `fromWeb` идёт в порядке релевантности skills.sh, а не по числу установок. Первый результат не обязательно подходит задаче: выбирай по `name` и `repo`.

### install — установка с проверкой безопасности
```bash
skills-manager install bobmatnyc/claude-mpm-skills vitest
skills-manager install bobmatnyc/claude-mpm-skills vitest --force "$approved_hash"  # contentHash, подтверждённый пользователем
```

Четыре уровня безопасности:
1. Валидация входов — repo и имя скилла проверяются регэкспом до запуска любого процесса
2. Trusted owners (anthropics, vercel-labs, github, ...) — устанавливается без сканирования
3. Sandbox-сканирование — скилл скачивается один раз во временную папку, сканируются все файлы (SKILL.md, scripts/, синтаксис `` !`cmd` ``, hooks); в `.claude/skills` переносится именно проверенная копия. Каталог называется по имени из frontmatter скилла (в нижнем регистре) — реальное имя возвращается в `skillName`
4. При карантине покажи пользователю флаги и SHA-256 из поля `contentHash`. После подтверждения передай именно этот хеш в `--force <sha256>`. Если содержимое изменилось, потребуется новый просмотр. Для установки нужен обычный файл `SKILL.md` и дерево без символических ссылок.

### evaluate — обработка Skills Report субагента
```bash
skills-manager evaluate /path/to/response.txt orch-2026-03-28
```

Парсит раздел `### Skills Report` из ответа субагента и обновляет реестр.
Скилл из `ignored` помечается бесполезным, только если его ни разу не использовали в прошлых запусках.

### cleanup — удаление бесполезных скиллов
```bash
skills-manager cleanup
```

Удаляет неиспользованные скиллы, если каталог и хеш совпадают с записью установки. Изменённые или заменённые каталоги и старые установки без контрольных данных остаются на диске и попадают в `preserved`. Ошибки удаления попадают в `failed`.

### list — показать реестр
```bash
skills-manager list
```

## Один агент в одной сессии

Оркестратор не нужен: агент сам выбирает и оценивает скиллы.

1. `skills-manager search "<ключевое слово задачи>"` — из `fromWeb` выбери кандидата, подходящего **твоей задаче** (по `name` и `repo`), а не первый в списке. Если в `fromRegistry` есть `useful: true` — он уже установлен, используй его.
2. `skills-manager install <repo> <skill>` — при карантине покажи флаги и `contentHash`. Передавай `--force <sha256>` только с подтверждённым пользователем хешем.
3. Используй скилл. Если он не появился в списке доступных скиллов сессии, прочитай `.claude/skills/<skill>/SKILL.md` напрямую.
4. После работы запиши свой отчёт в файл и передай его в evaluate:
   ```bash
   report_file=$(mktemp)
   cat > "$report_file" <<'EOF'
   ### Skills Report
   - used: vitest
   - ignored: owasp-security (не понадобился)
   EOF
   skills-manager evaluate "$report_file" session-2026-11-18
   rm "$report_file"
   ```
5. `skills-manager cleanup` — в конце сессии, если неиспользованные скиллы больше не нужны.

## Интеграция с оркестратором

### Phase 1.5: Skills Discovery (после планирования)

```javascript
// Поиск по ключевым словам из задач плана
const keywords = ["testing", "security", "database"]
let externalSkillsInstalled = 0

for (const keyword of keywords) {
  if (externalSkillsInstalled >= 2) break  // макс 2 внешних скилла

  const output = execFileSync("skills-manager", ["search", keyword], { encoding: "utf8" })
  const json = JSON.parse(output.split("---JSON---")[1])

  // Есть useful:true в реестре → ставим
  const fromRegistry = json.fromRegistry.find(s => s.useful === true)
  if (fromRegistry) {
    // уже установлен, просто используем
    continue
  }

  // Есть на skills.sh → LLM оркестратора выбирает кандидата под задачу, не слепо [0]
  if (json.fromWeb.length > 0) {
    const top = pickForTask(json.fromWeb, taskDescription)
    const result = JSON.parse(execFileSync("skills-manager", ["install", top.repo, top.skill], { encoding: "utf8" }))
    if (result.installed) externalSkillsInstalled++
    else console.warn(result.reason, result.contentHash ?? "")
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
const reportDir = mkdtempSync(join(tmpdir(), "skills-report-"))
try {
  const reportFile = join(reportDir, "response.txt")
  writeFileSync(reportFile, workerResponse)
  execFileSync("skills-manager", ["evaluate", reportFile, orchestrationId])
} finally {
  rmSync(reportDir, { recursive: true, force: true })
}
```

### Phase 4.5: Cleanup

```javascript
const result = execFileSync("skills-manager", ["cleanup"])
```

## Реестр

Менеджер записывает историю в `.claude/skills-registry.json` и синхронизирует запись между локальными сессиями. У новых установок есть также `contentHash` и `directoryId` для проверки перед удалением. Пример старой записи:

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
