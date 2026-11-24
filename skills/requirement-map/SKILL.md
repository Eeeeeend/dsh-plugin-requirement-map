---
name: requirement-map
description: Extract and maintain a project requirement mind-map ledger (*.reqmap.json) that the DSH Requirement map page renders. Use when the user asks for a requirement mind map, a requirement ledger, a 需求导图, or asks to record/update requirements for a project.
whenToUse: The user wants a project requirement mind map, a requirement ledger, or asks to add/update/review requirements in a DSH workspace.
---

# Requirement map

Maintain one JSON ledger per project; the DSH **Requirement map** page and the `*.reqmap.json` document preview render it. The ledger is the single source of truth — never keep a second copy of the requirements in prose.

## Ledger shape

```json
{
  "meta": {
    "title": "项目需求导图",
    "date": "YYYY-MM-DD",
    "branch": "feat/…",
    "head": "abcdef0",
    "scope": "本会话已下发需求＋仓库方案/实施记录；新要求覆盖旧要求。",
    "image_note": "",
    "statuses": { "未完成": "…", "部分完成": "…", "待核实": "…", "暂缓": "…", "已上线": "…" },
    "roots": ["主分支 A", "主分支 B"]
  },
  "requirements": [
    { "id": "DB-01", "root": "主分支 A", "group": "分组", "title": "标题",
      "current": "当前要求", "old": "旧要求", "status": "已上线", "source": "docs/…", "note": "" }
  ]
}
```

## Workflow

1. **Locate the ledger.** Prefer an existing `*.reqmap.json` in the workspace. Create one with `requirement_map` `action: "init"` only when none exists.
2. **Find the relevant IDs before writing.** Use `action: "search"` (default 8 results) and `action: "show"` for exact current wording. Do not re-read the whole ledger by default.
3. **Reuse IDs; never renumber.** New requirements take the next unused number in their prefix (`DB-`, `CFG-`, `ST-`, `SYS-`, …). Updating a requirement keeps its ID.
4. **Write the new wording into `current`.** Move the replaced wording into `old`, appending to earlier history instead of overwriting it. A removed feature becomes "移除/不再提供" with the reason kept in `note`.
5. **Attach evidence.** `source` names the user instruction or a real repository path; `note` records open questions, acceptance scope, and remaining work. Do not invent dates or evidence.
6. **Keep status honest.** Use only keys in `meta.statuses`. "Has implementation record" is not re-verification; "deployed" is not "installer shipped".
7. **Validate.** Run `requirement_map` `action: "validate"`; fix every error before finishing.
8. **Report.** Tell the user the affected IDs and their statuses, and that the ledger is the source of truth.

## Rules

- One integrator writes the ledger at a time; parallel agents hand over entries instead of forking the file.
- Do not delete a requirement just because it was replaced — keep the node and move its wording to `old`.
- `root` must be one of `meta.roots`; `status` must be one of `meta.statuses` keys.
- The UI is read-only; editing happens through this tool or the JSON file.
