# Requirement map

把一份项目需求台账（`*.reqmap.json`）渲染成交互式思维导图。台账是唯一数据源，agent 负责从仓库或会话中提取需求并维护它。

## What it registers

- **Document preview** — 打开任意需求台账文件时，右侧 Sidebar 的文档预览会渲染导图；可在预览头部切换到纯文本。
- **Right Sidebar tab** — 右侧栏「+」添加菜单里的「需求导图」，或会话头部的导图图标，把导图作为可拖拽、可全屏的标签页打开（与「任务看板」同级）。
- **Global page** — 侧边栏面板列表中的「需求导图」入口。打开后自动扫描当前工作区里的需求台账并加载，**不需要手填路径**；多个台账时用下拉切换，并监听文件变更自动刷新。
- **Generate** — 工作区没有台账时，空状态里的「生成需求导图」由插件在 Host 后台完成：读取工作区文档 → 调用部署默认模型 → 校验并写入 `docs/requirements/requirements.reqmap.json`，不产生会话轮次。生成是**按会话的 Host 任务**，切换会话不中断；生成中可点「暂停」取消。
- **Model tool** — `requirement_map`，让 agent 以结构化参数读取、校验、搜索和写入台账。

## 台账发现

按文件名/路径搜索 `reqmap.json`、`需求台账`、`requirements.json`、`docs/requirements`，再对每个候选 `.json` 做 schema 校验（`meta` 对象 + `requirements` 数组），只保留真正的台账。因此 `需求台账-2026-11-12.json`、`requirements.reqmap.json`、`docs/requirements/*.json` 都能被识别，而 `relations.json`、`package.json` 之类会被忽略。

## Ledger format

```json
{
  "meta": {
    "title": "项目需求导图",
    "date": "2026-11-23",
    "branch": "feat/example",
    "head": "abc1234",
    "scope": "本会话已下发需求＋仓库方案/实施记录；新要求覆盖旧要求。",
    "image_note": "",
    "statuses": {
      "未完成": "已有明确未完成或失败证据。",
      "部分完成": "已有实现，但此项明确仍有未完成部分。",
      "待核实": "需要补专项验收或核对实际交付，不能直接打勾。",
      "暂缓": "用户明确暂不做，或正式启用前置条件未满足。",
      "已上线": "有本机或服务器生效证据；不等于最新安装包已包含。"
    },
    "roots": ["导播台页面", "直播间设置页"]
  },
  "requirements": [
    {
      "id": "DB-01",
      "root": "导播台页面",
      "group": "设置与开播入口",
      "title": "直播间设置高亮",
      "current": "设置入口做成明显高亮按钮；打开设置期间置灰，关闭后恢复。",
      "old": "原文字入口不明显。",
      "status": "已上线",
      "source": "docs/example.md",
      "note": ""
    }
  ]
}
```

- `id` 必须唯一；`root` 必须是 `meta.roots` 之一；`status` 必须是 `meta.statuses` 的键。
- `old` 保留被替代的口径，不要删除；`note` 写边界、待确认事项或剩余工作。
- 状态语义由 `meta.statuses` 定义；UI 的「优先看未闭环」按状态名关键词匹配（未完成/部分完成/待核实 等）。

## Usage

1. 让 agent 生成台账，或复制 `examples/requirements.reqmap.json` 起步。
2. 在文件树中打开 `*.reqmap.json`，或从侧边栏「需求导图」页面加载。
3. 搜索、筛选状态、展开/收起、隐藏旧要求、打印/保存 PDF。

## Limitations

- 导图只读；编辑通过 agent 工具或直接改 JSON 完成。
- 打印使用浏览器原生打印，会输出当前页面；需要完整内容时先清空搜索并选择「全部状态」。
- 台账路径相对于所选会话的工作区根目录解析。
