# 需求导图

把一份项目需求台账渲染成交互式思维导图，让「当前要求 / 旧要求 / 状态 / 依据」在一个界面里可查、可筛选、可打印。

## 功能

- **文档预览**：打开任意需求台账文件（`*.reqmap.json` / `需求台账*.json` / `requirements.json`），右侧 Sidebar 直接渲染导图；可切回纯文本。
- **右侧栏标签页**：在右侧栏的「+」添加菜单里选「需求导图」，或点会话头部的导图图标，即可把导图作为可拖拽、可全屏的标签页打开。
- **独立页面**：侧边栏面板列表中的「需求导图」入口。打开后**自动扫描当前工作区**里的需求台账并加载，**不需要手填路径**；有多个台账时用下拉切换。
- **生成**：工作区没有台账时，空状态里有「生成需求导图」按钮。点击后由**插件在 Host 后台**完成：读取工作区文档 → 调用部署默认模型 → 校验并写入 `docs/requirements/requirements.reqmap.json`，**不会产生会话轮次**。写入后页面自动刷新显示。
- **后台任务**：生成是 **Host 侧任务**（按会话一个）。点一次就启动，切换会话不会中断；回到该会话会继续显示「生成中」，完成后自动出现导图。
- **暂停**：生成中按钮变成「暂停」，点击即取消当前任务。
- **刷新**：「刷新」和「重新扫描」都会重新扫描工作区并重读文件，所以需求变更后点一次就能看到最新导图；页面同时监听文件变更自动刷新。

## 后台生成的实现要点

参考 `dsh-super-kanban` 的 AI 润色做法：

- 用 `ctx.get('llm')` 做**非阻塞**探测（不用 `ctx.llm` 属性访问，未声明 `inject` 会抛错；也不用 `ctx.inject` 探测，服务缺失时回调不执行）；
- 优先 `llm.prepareCall(...)` 选取 reasoning effort 与输出上限，适配器没有该方法时退回 `llm.stream(...)`；
- **不传 `sessionId`**，避免官方路由把会话日志挂到请求上；
- `finish` 的 `reason` 是对象（`{ kind: 'stop' | 'max-tokens' | 'aborted' | 'error' }`），必须按 `kind` 判断；流没有终止帧、`aborted`、`error` 都算失败；
- 120 秒超时，超时通过 `AbortController` 取消。

## 生成任务的路由

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/requirement-map/generate` | 启动（或复用）该会话的生成任务，立即返回 `{ state: 'running' }` |
| `GET` | `/requirement-map/generate/status?sessionId=…` | 返回任务状态：`idle` / `running` / `done` / `error` / `cancelled` |
| `POST` | `/requirement-map/generate/cancel` | 取消该会话的运行中任务 |

任务保存在 Host 内存里，完成后保留 10 分钟。前端每 2 秒轮询一次；`done` 时自动重读台账。
- **模型工具**：`requirement_map` 提供 `init / validate / summary / search / show / add / update`，让 agent 以结构化方式维护台账。

## 交互

- 关键词搜索：编号、标题、当前/旧要求、备注、分组、主分支。
- 状态筛选：选项来自 `meta.statuses`；「优先看未闭环」按状态名关键词（未完成/部分完成/待核实 等）匹配。
- 展开/收起全部、隐藏旧要求、打印/保存 PDF。
- 每条需求显示：**绿色当前要求**、**红色旧要求/已替代**、边界备注、依据。
- 响应式：窄屏单列，宽屏多列。

## 发现规则

页面在所选会话的工作区根目录下按**文件名/路径**搜索以下片段，再对每个候选 `.json` 做 **schema 校验**（必须含 `meta` 对象与 `requirements` 数组），只保留真正的需求台账：

| 片段 | 命中 |
|---|---|
| `reqmap.json` | `*.reqmap.json` |
| `需求台账` | `需求台账-2026-11-12.json` 等 |
| `requirements.json` | `requirements.json` |
| `docs/requirements` | 该目录下的任意 `.json` |

排除 `node_modules`、`.git`、`dist`、`build`、`.next`、`coverage`、`vendor`、`.venv`；最多读取 60 个候选做校验。默认会话取主视图正在显示的那个，否则取会话列表第一个。台账超过 5000 行时自动分页读取。

## 台账格式

唯一数据源是 JSON 台账：

```json
{
  "meta": {
    "title": "项目需求导图",
    "date": "2026-11-23",
    "branch": "feat/example",
    "head": "abc1234",
    "scope": "范围说明",
    "image_note": "",
    "statuses": { "未完成": "说明", "已上线": "说明" },
    "roots": ["主分支 A", "主分支 B"]
  },
  "requirements": [
    {
      "id": "DB-01",
      "root": "主分支 A",
      "group": "分组",
      "title": "标题",
      "current": "当前要求",
      "old": "旧要求",
      "status": "已上线",
      "source": "docs/example.md",
      "note": ""
    }
  ]
}
```

- `id` 唯一；`root` 必须属于 `meta.roots`；`status` 必须是 `meta.statuses` 的键。
- `old` 保留被替代口径，不删除；`note` 写边界、待确认事项或剩余工作。
- 状态语义由 `meta.statuses` 定义，UI 不硬编码业务状态。

## 使用

1. 让 agent 从仓库或会话中提取需求并写入台账，或复制 `examples/requirements.reqmap.json` 起步。
2. 打开侧边栏「需求导图」页面：插件自动扫描并加载台账，无需填路径。
3. 在文件树中打开 `*.reqmap.json` 也可直接预览。
4. 搜索、筛选、展开、打印。

## 边界

- 导图只读；编辑通过 agent 工具或直接改 JSON 完成。
- 打印使用浏览器原生打印，输出当前页面；需要完整内容时先清空搜索并选择「全部状态」。
- 发现范围限于所选会话的工作区根目录；工作区外的台账需要在文件树中打开。
- 自动同步依赖文件监听；监听不可用时仍可点「刷新」。
- 不自动推断需求间依赖；如需关联，请在台账中显式记录。
