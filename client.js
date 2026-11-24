// Browser half of dsh-plugin-requirement-map.
//
// Two surfaces share one renderer:
//   1. a document preview for requirement ledgers in the right Sidebar;
//   2. a global "Requirement map" page in the sidebar panel list.
//
// The page discovers ledgers by scanning the selected session's workspace, so
// nobody has to know or type a path, and it follows the file it shows: an agent
// write appears without a manual refresh.
//
// Discovery accepts the project conventions in use — `*.reqmap.json`,
// `需求台账*.json`, `requirements.json`, and any JSON under `docs/requirements` —
// then keeps only documents that validate as a ledger (`meta` + `requirements[]`).
//
// The ledger is the single source of truth: meta (title/date/branch/head/scope/
// statuses/roots) plus requirements[] (id/root/group/title/current/old/status/
// source/note). The agent writes it; this module renders it.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-requirement-map',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    /** Hook shim so a minimal render harness without useRef still works. */
    const useRef = React.useRef ?? ((value) => ({ current: value }))
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'requirementMap'
    const DOC_ID = 'dsh-plugin-requirement-map/mindmap'
    const PANEL_ID = 'requirement-map'
    const SIDE_ID = 'dsh-plugin-requirement-map/page'
    const SIDE_KIND = 'requirement-map'

    /** Name and path fragments that may lead to a ledger. */
    const SCAN_QUERIES = ['reqmap.json', '需求台账', 'requirements.json', 'docs/requirements']
    /** Directories never worth scanning. */
    const SCAN_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv']
    /** Candidates read to confirm the schema; keeps a broad workspace responsive. */
    const SCAN_MAX_CANDIDATES = 60
    /** Ledger pages are read in 5000-line windows until `eof`. */
    const READ_PAGE_LINES = 5000
    /** Default ledger path the background generator writes. */
    const DEFAULT_LEDGER_PATH = 'docs/requirements/requirements.reqmap.json'
    /** Host route that generates a ledger in the background. */
    const GENERATE_ROUTE = '/requirement-map/generate'
    /** Host route that reports one Session's generation job. */
    const STATUS_ROUTE = '/requirement-map/generate/status'
    /** Host route that pauses one Session's generation job. */
    const CANCEL_ROUTE = '/requirement-map/generate/cancel'
    /** Host route that lists candidate project roots for one Session. */
    const PROJECTS_ROUTE = '/requirement-map/generate/projects'
    /** Host route that writes one requirement's status back to the ledger. */
    const SET_STATUS_ROUTE = '/requirement-map/status'
    /** Last project chosen per Session, kept across tab remounts. */
    const PROJECT_MEMORY = new Map()

    // ── Locales ──────────────────────────────────────────────────────────

    const zh = {
      'viewer.label': '需求导图',
      'panel': '需求导图',
      'page.title': '项目需求思维导图',
      'page.subtitle': '自动扫描当前工作区里的需求台账（*.reqmap.json / 需求台账*.json / requirements.json），并跟随文件变更同步。',
      'page.session': '工作区会话',
      'page.ledger': '台账',
      'page.reload': '刷新',
      'page.rescan': '重新扫描',
      'page.scanning': '正在扫描工作区里的需求台账…',
      'page.loading': '正在读取台账…',
      'page.none': '这个项目里还没有需求台账。',
      'page.hint': '点「生成需求导图」由插件自动生成；也可以把台账保存为 *.reqmap.json 后在右侧文件树中打开。',
      'page.noSession': '当前没有可用会话；请先在左侧打开一个工作区。',
      'page.error': '读取失败',
      'page.generate': '生成需求导图',
      'page.generatingShort': '生成中…',
      'page.generating': '正在后台生成台账，请稍候…',
      'page.generated': '已生成 {count} 项需求：{path}（项目：{project}）',
      'page.generateFailed': '生成失败',
      'page.pause': '暂停',
      'status.label': '状态',
      'status.hint': '点击更改状态',
      'status.failed': '状态更新失败',
      'page.project': '项目',
      'page.paused': '已暂停生成',
      'search.label': '查需求',
      'search.placeholder': '搜索：编号、标题、当前/旧要求、备注…',
      'filter.label': '状态',
      'filter.all': '全部状态',
      'filter.unfinished': '优先看未闭环',
      'expand': '展开全部',
      'collapse': '收起全部',
      'hideOld': '隐藏旧要求',
      'showOld': '显示旧要求',
      'print': '打印 / 保存PDF',
      'counter': '显示 {shown} / {total} 项',
      'empty': '没有匹配项，试试其他关键词或状态。',
      'current': '当前要求',
      'old': '旧要求 / 已替代',
      'note': '边界',
      'source': '依据',
      'context': '更新 {date} · 分支 {branch} · HEAD {head} · {count} 项需求',
      'scope': '范围',
      'legend.current': '当前：应执行的最新口径',
      'legend.old': '旧：保留追溯，不再执行',
      'legend.note': '“有实现记录”不等于本轮已复验，也不等于安装包已更新。',
      'maintain': '维护方法：需求编号不变；新口径写“当前”，被替代内容移入“旧”；状态更新必须附证据。',
    }

    const en = {
      'viewer.label': 'Requirement map',
      'panel': 'Requirement map',
      'page.title': 'Project requirement mind map',
      'page.subtitle': 'Scans the current workspace for requirement ledgers (*.reqmap.json / requirements.json) and follows their changes.',
      'page.session': 'Workspace session',
      'page.ledger': 'Ledger',
      'page.reload': 'Reload',
      'page.rescan': 'Rescan',
      'page.scanning': 'Scanning the workspace for requirement ledgers…',
      'page.loading': 'Reading the ledger…',
      'page.none': 'No requirement ledger in this project yet.',
      'page.hint': 'Use Generate map to create one, or save a ledger as *.reqmap.json and open it from the file tree.',
      'page.noSession': 'No session is available; open a workspace on the left first.',
      'page.error': 'Read failed',
      'page.generate': 'Generate map',
      'page.generatingShort': 'Generating…',
      'page.generating': 'Generating the ledger in the background…',
      'page.generated': 'Generated {count} requirements: {path} (project: {project})',
      'page.generateFailed': 'Generation failed',
      'page.pause': 'Pause',
      'status.label': 'Status',
      'status.hint': 'Click to change status',
      'status.failed': 'Status update failed',
      'page.project': 'Project',
      'page.paused': 'Generation paused',
      'search.label': 'Find',
      'search.placeholder': 'Search id, title, current/old text, note…',
      'filter.label': 'Status',
      'filter.all': 'All statuses',
      'filter.unfinished': 'Open items first',
      'expand': 'Expand all',
      'collapse': 'Collapse all',
      'hideOld': 'Hide old',
      'showOld': 'Show old',
      'print': 'Print / Save PDF',
      'counter': 'Showing {shown} / {total}',
      'empty': 'No matches. Try another keyword or status.',
      'current': 'Current requirement',
      'old': 'Old / replaced',
      'note': 'Boundary',
      'source': 'Source',
      'context': 'Updated {date} · branch {branch} · HEAD {head} · {count} requirements',
      'scope': 'Scope',
      'legend.current': 'Current: the authoritative requirement',
      'legend.old': 'Old: kept for traceability, not a task',
      'legend.note': '"Has implementation record" is not re-verification, and not an updated installer.',
      'maintain': 'Maintenance: keep IDs stable; write new wording under Current and move replaced text to Old; attach evidence to status changes.',
    }

    // ── Styles ───────────────────────────────────────────────────────────

    const CSS = `
.reqmap-root,.reqmap-page{box-sizing:border-box;display:flex;flex-direction:column;min-height:100%;height:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-family:var(--dsw-font-family-sans,system-ui,-apple-system,"Microsoft YaHei","Noto Sans CJK SC",sans-serif);font-size:13px;line-height:1.6}
.reqmap-root *,.reqmap-page *{box-sizing:border-box}
.reqmap-embedded{height:auto;min-height:0;display:block}
.reqmap-embedded .reqmap-main{overflow:visible;padding:14px 20px 28px}
.reqmap-head{padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.reqmap-head-compact{padding:10px 16px 8px}
.reqmap-title{margin:0 0 3px;font-size:18px;font-weight:650;letter-spacing:.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reqmap-head-compact .reqmap-title{font-size:15px}
.reqmap-context{margin:2px 0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reqmap-toolbar{position:sticky;top:0;z-index:6;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 97%,transparent);border-bottom:1px solid var(--dsw-alias-border-l2)}
.reqmap-toolbar-group{display:flex;align-items:center;gap:6px;min-width:0}
.reqmap-toolbar-right{margin-left:auto;gap:4px}
.reqmap-label{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.reqmap-input,.reqmap-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 9px;min-height:28px;transition:border-color .15s ease,background-color .15s ease}
.reqmap-input{width:190px;max-width:100%}
.reqmap-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.reqmap-input-path{flex:1 1 260px;min-width:180px}
.reqmap-btn{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid transparent;border-radius:7px;padding:5px 9px;min-height:28px;cursor:pointer;transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.reqmap-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.reqmap-btn:disabled{opacity:.45;cursor:default}
.reqmap-btn-soft{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.reqmap-btn-primary{background:var(--dsw-alias-state-business-primary,#2457c5);border-color:transparent;color:var(--dsw-alias-label-on-color,#fff);font-weight:560}
.reqmap-btn-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-state-business-primary,#2457c5);color:var(--dsw-alias-label-on-color,#fff)}
.reqmap-btn-danger{background:var(--dsw-alias-state-error-primary,#a33f3f);border-color:transparent;color:var(--dsw-alias-label-on-color,#fff);font-weight:560}
.reqmap-btn-danger:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-state-error-primary,#a33f3f)}
.reqmap-input:focus-visible,.reqmap-select:focus-visible,.reqmap-btn:focus-visible,.reqmap-group-summary:focus-visible,.reqmap-req-summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.reqmap-counter{margin-left:8px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reqmap-legend{display:flex;flex-wrap:wrap;gap:14px;padding:7px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.reqmap-legend-item{display:inline-flex;align-items:center}
.reqmap-legend-item::before{content:"";display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:2px}
.reqmap-legend-current::before{background:var(--dsw-alias-state-success-primary,#216744)}
.reqmap-legend-old::before{background:var(--dsw-alias-state-error-primary,#a33f3f)}
.reqmap-main{flex:1;overflow:auto;padding:16px 20px 28px}
.reqmap-page-body{flex:1;overflow:auto;padding:0}
.reqmap-page-form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.reqmap-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;align-items:start}
.reqmap-branch{min-width:0;--reqmap-accent:var(--dsw-alias-state-business-primary,#2457c5);border:1px solid color-mix(in srgb,var(--reqmap-accent) 16%,var(--dsw-alias-border-l2));border-radius:10px;background:color-mix(in srgb,var(--reqmap-accent) 4%,var(--dsw-alias-bg-layer-1));padding-bottom:6px}
.reqmap-branch-head{position:sticky;top:calc(var(--reqmap-toolbar-h,46px) + 6px);z-index:3;display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid color-mix(in srgb,var(--reqmap-accent) 18%,var(--dsw-alias-border-l2));border-radius:9px 9px 0 0;background:color-mix(in srgb,var(--reqmap-accent) 9%,var(--dsw-alias-bg-layer-1))}
.reqmap-branch-dot{width:7px;height:7px;border-radius:50%;background:var(--reqmap-accent);flex:none}
.reqmap-branch-title{margin:0;font-size:13.5px;font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reqmap-branch-count{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.reqmap-groups{position:relative;display:flex;flex-direction:column;gap:2px;padding:3px 8px 2px 12px;margin-top:3px}
.reqmap-groups::before{content:"";position:absolute;left:9px;top:2px;bottom:10px;width:1px;background:color-mix(in srgb,var(--reqmap-accent) 26%,transparent)}
.reqmap-group{position:relative;border:0;border-radius:7px;background:transparent;overflow:hidden;transition:background-color 180ms ease,box-shadow 200ms ease}
.reqmap-group+.reqmap-group{border-top:1px solid color-mix(in srgb,var(--reqmap-accent) 12%,var(--dsw-alias-border-l2))}
.reqmap-group-summary::before{content:"";position:absolute;left:-9px;top:50%;width:7px;height:1px;background:color-mix(in srgb,var(--reqmap-accent) 40%,transparent)}
.reqmap-group.is-open{background:color-mix(in srgb,var(--reqmap-accent) 5%,var(--dsw-alias-bg-layer-1))}
.reqmap-group-summary,.reqmap-req-summary{display:flex;align-items:center;gap:8px;width:100%;padding:8px 11px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.reqmap-group-summary{position:relative;font-weight:560;font-size:12.5px}
.reqmap-caret{display:inline-block;width:10px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;transition:transform 240ms cubic-bezier(.34,1.4,.64,1)}
.is-open>.reqmap-group-summary>.reqmap-caret,.is-open>.reqmap-req-summary>.reqmap-caret{transform:rotate(90deg)}
.reqmap-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reqmap-group-count{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.reqmap-collapse{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows 280ms cubic-bezier(.16,1,.3,1),opacity 200ms ease}
.reqmap-collapse[data-open="true"]{grid-template-rows:1fr;opacity:1}
.reqmap-collapse-inner{overflow:hidden;min-height:0;transform:translateY(-6px);transition:transform 280ms cubic-bezier(.16,1,.3,1)}
.reqmap-collapse[data-open="true"]>.reqmap-collapse-inner{transform:translateY(0)}
.reqmap-reqs{position:relative;display:flex;flex-direction:column;gap:5px;padding:3px 4px 7px 14px}
.reqmap-reqs::before{content:"";position:absolute;left:5px;top:2px;bottom:9px;width:1px;background:color-mix(in srgb,var(--reqmap-accent) 18%,transparent)}
.reqmap-req{contain:layout style;border:1px solid color-mix(in srgb,var(--reqmap-accent) 10%,var(--dsw-alias-border-l2));border-radius:7px;background:var(--dsw-alias-bg-layer-1);transition:border-color 160ms ease,box-shadow 200ms ease,transform 200ms cubic-bezier(.2,.7,.3,1),background-color 200ms ease}
.reqmap-req:hover{border-color:color-mix(in srgb,var(--reqmap-accent) 26%,var(--dsw-alias-border-l2));box-shadow:0 1px 6px rgba(16,24,40,.06);transform:translateY(-1px)}
.reqmap-req.is-open:hover{transform:none}
.reqmap-req[data-preview="true"],.reqmap-group[data-preview="true"]{border-color:color-mix(in srgb,var(--reqmap-accent) 30%,var(--dsw-alias-border-l2));box-shadow:0 3px 14px rgba(16,24,40,.07)}
.reqmap-req-summary,.reqmap-group-summary{border-radius:6px;transition:background-color 160ms ease}
.reqmap-req-summary:hover,.reqmap-group-summary:hover{background:color-mix(in srgb,var(--reqmap-accent) 5%,transparent)}
.reqmap-req.is-open{background:color-mix(in srgb,var(--reqmap-accent) 4%,var(--dsw-alias-bg-layer-1))}
.reqmap-req-head{display:flex;align-items:center;gap:6px;padding:6px 8px 6px 10px}
.reqmap-req-summary{padding:0;flex:1;min-width:0}
.reqmap-badge-select{appearance:none;-webkit-appearance:none;font:inherit;font-size:10.5px;line-height:1.6;padding:1px 20px 1px 8px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 11px) 50%,calc(100% - 8px) 50%;background-size:3px 3px,3px 3px;background-repeat:no-repeat;transition:filter 140ms ease,border-color 160ms ease}
.reqmap-badge-select:hover{filter:brightness(1.05)}
.reqmap-badge-select option{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.reqmap-status-error{margin:6px 16px 0;color:var(--dsw-alias-state-error-primary,#a33f3f);font-size:11.5px}
.reqmap-rid{font-family:var(--dsw-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:nowrap;flex:none}
.reqmap-req-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reqmap-badge{flex:none;display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:10.5px;line-height:1.6;white-space:nowrap;border:1px solid transparent}
.reqmap-badge::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.reqmap-badge.live{color:var(--dsw-alias-state-success-primary,#216744);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#216744) 13%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#216744) 30%,transparent)}
.reqmap-badge.open{color:var(--dsw-alias-state-warn-primary,#9a5b00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#9a5b00) 13%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#9a5b00) 30%,transparent)}
.reqmap-badge.hold{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.reqmap-badge.done{color:var(--dsw-alias-state-business-primary,#2457c5);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2457c5) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2457c5) 28%,transparent)}
.reqmap-compare{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:2px 10px 8px}
.reqmap-compare.single{grid-template-columns:1fr}
.reqmap-version{padding:7px 10px;border-radius:0 6px 6px 0;background:var(--dsw-alias-bg-layer-2)}
.reqmap-version strong{display:block;margin-bottom:2px;font-size:10.5px;font-weight:600}
.reqmap-version p{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.reqmap-current{border-left:3px solid var(--dsw-alias-state-success-primary,#216744);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#216744) 7%,var(--dsw-alias-bg-layer-2))}
.reqmap-current strong{color:var(--dsw-alias-state-success-primary,#216744)}
.reqmap-old{border-left:3px solid var(--dsw-alias-state-error-primary,#a33f3f);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#a33f3f) 6%,var(--dsw-alias-bg-layer-2))}
.reqmap-old strong{color:var(--dsw-alias-state-error-primary,#a33f3f)}
.reqmap-hide-old .reqmap-old{display:none}
.reqmap-hide-old .reqmap-compare{grid-template-columns:1fr}
.reqmap-notes{padding:0 10px 9px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.reqmap-notes p{margin:2px 0}
.reqmap-source{word-break:break-all;color:var(--dsw-alias-label-tertiary)}
.reqmap-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.reqmap-generate{margin:10px 0 6px;padding:8px 18px;font-size:13px}
.reqmap-notice{margin:8px 16px 0;color:var(--dsw-alias-state-business-primary,#2457c5);font-size:12px}
.reqmap-hint{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.reqmap-error{margin:14px 16px;padding:10px 12px;border-radius:7px;color:var(--dsw-alias-state-error-primary,#a33f3f);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#a33f3f) 9%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#a33f3f) 28%,transparent);white-space:pre-wrap;word-break:break-word;font-size:12px}
.reqmap-foot{padding:10px 16px 16px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.reqmap-foot p{margin:3px 0}
.reqmap-header-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.reqmap-header-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.reqmap-header-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.reqmap-collapse{transition:none}.reqmap-caret{transition:none}.reqmap-req{transition:none}}
@media (max-width:720px){.reqmap-grid{grid-template-columns:1fr}.reqmap-compare{grid-template-columns:1fr}.reqmap-input{width:100%}.reqmap-toolbar{padding:8px 12px}.reqmap-main{padding:14px 12px 24px}}
@media print{.reqmap-collapse{grid-template-rows:1fr !important;opacity:1 !important}.reqmap-toolbar,.reqmap-page-form{position:static;backdrop-filter:none}.reqmap-branch-head{position:static}}
`

    // ── Ledger parsing ───────────────────────────────────────────────────

    const OPEN_RE = /未完成|部分完成|待核实|未闭环|进行中|待办|open|partial|pending|verify/i
    const HOLD_RE = /暂缓|暂停|搁置|挂起|hold|defer|pause/i
    const LIVE_RE = /已上线|已完成|完成|已交付|live|done|complete|shipped/i

    /** Parse and normalize one ledger; throws on a structurally unusable document. */
    function parseLedger(text) {
      const raw = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ledger must be a JSON object')
      const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {}
      const rows = Array.isArray(raw.requirements)
        ? raw.requirements.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
        : []
      const roots = Array.isArray(meta.roots) && meta.roots.length > 0
        ? meta.roots.filter((root) => typeof root === 'string')
        : [...new Set(rows.map((row) => row.root).filter((root) => typeof root === 'string' && root))]
      const statuses = meta.statuses && typeof meta.statuses === 'object' && !Array.isArray(meta.statuses) ? meta.statuses : {}
      return { meta: { ...meta, roots, statuses }, rows }
    }

    /** Whether a parsed document is a requirement ledger rather than unrelated JSON. */
    function isLedger(value) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Boolean(value.meta) && typeof value.meta === 'object' && !Array.isArray(value.meta)
        && Array.isArray(value.requirements)
    }

    function statusTone(status) {
      const value = String(status ?? '')
      if (LIVE_RE.test(value)) return 'live'
      if (OPEN_RE.test(value)) return 'open'
      if (HOLD_RE.test(value)) return 'hold'
      return 'done'
    }

    function isOpen(status) {
      return OPEN_RE.test(String(status ?? ''))
    }

    // ── Mind map ─────────────────────────────────────────────────────────

    /** Soft accents that keep branch blocks distinguishable in both themes. */
    const BRANCH_ACCENTS = ['#5b82f7', '#8b5cf6', '#14b8a6', '#f59e0b', '#f43f5e', '#6366f1']

    /**
     * One requirement row. Hover state is local so pointing at a row re-renders
     * that row only, not the whole map.
     */
    function ReqRow({ row, t, statusNames, displayStatus, pinned, canEdit, onTogglePin, onChangeStatus }) {
      const [hovered, setHovered] = React.useState(false)
      const timer = useRef(0)
      React.useEffect(() => () => clearTimeout(timer.current), [])
      const enter = () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setHovered(true), 40)
      }
      const leave = () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setHovered(false), 260)
      }
      const previewed = !pinned && hovered
      const open = pinned || previewed
      // Collapsed rows hold no comparison body and no status control, which is
      // most of the DOM in a large ledger.
      const [mounted, setMounted] = React.useState(open)
      if (open && !mounted) setMounted(true)
      React.useEffect(() => {
        if (open) return undefined
        const timer = setTimeout(() => setMounted(false), 320)
        return () => clearTimeout(timer)
      }, [open])
      return h('div', {
        className: 'reqmap-req' + (open ? ' is-open' : ''),
        'data-preview': String(previewed),
        onMouseEnter: enter,
        onMouseLeave: leave,
      },
        h('div', { className: 'reqmap-req-head' },
          h('button', {
            className: 'reqmap-req-summary',
            type: 'button',
            'aria-expanded': String(pinned),
            onClick: () => {
              clearTimeout(timer.current)
              setHovered(false)
              onTogglePin(row.id)
            },
          },
            h('span', { className: 'reqmap-caret', 'aria-hidden': true }, '▸'),
            h('span', { className: 'reqmap-rid' }, row.id),
            h('span', { className: 'reqmap-req-title' }, row.title),
          ),
          canEdit && open
            ? h('select', {
              className: 'reqmap-badge reqmap-badge-select ' + statusTone(displayStatus),
              value: displayStatus,
              'aria-label': t('status.label'),
              title: t('status.hint'),
              onClick: (event) => event.stopPropagation(),
              onChange: (event) => {
                event.stopPropagation()
                onChangeStatus(row.id, event.target.value)
              },
            }, statusNames.map((name) => h('option', { key: name, value: name }, name)))
            : h('span', { className: 'reqmap-badge ' + statusTone(displayStatus) }, displayStatus),
        ),
        h('div', { className: 'reqmap-collapse', 'data-open': String(open) },
          h('div', { className: 'reqmap-collapse-inner' },
            mounted ? [
              h('div', { className: 'reqmap-compare' + (row.old ? '' : ' single') },
                h('div', { className: 'reqmap-version reqmap-current' },
                  h('strong', null, t('current')),
                  h('p', null, row.current),
                ),
                row.old
                  ? h('div', { className: 'reqmap-version reqmap-old' },
                    h('strong', null, t('old')),
                    h('p', null, row.old),
                  )
                  : null,
              ),
              (row.note || row.source)
                ? h('div', { className: 'reqmap-notes' },
                  row.note ? h('p', { className: 'reqmap-note' }, t('note') + '：' + row.note) : null,
                  row.source ? h('p', { className: 'reqmap-source' }, t('source') + '：' + row.source) : null,
                )
                : null,
            ] : null,
          ),
        ),
      )
    }

    /** One group: a row inside its branch, with its own hover preview. */
    function GroupBlock({ groupKey, name, count, pinned, onTogglePin, children }) {
      const [hovered, setHovered] = React.useState(false)
      const timer = useRef(0)
      React.useEffect(() => () => clearTimeout(timer.current), [])
      const enter = () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setHovered(true), 50)
      }
      const leave = () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setHovered(false), 280)
      }
      const previewed = !pinned && hovered
      const open = pinned || previewed
      // A collapsed group holds no rows at all: most of a large ledger stays
      // out of the DOM until it is looked at.
      const [mounted, setMounted] = React.useState(open)
      if (open && !mounted) setMounted(true)
      React.useEffect(() => {
        if (open) return undefined
        const timer = setTimeout(() => setMounted(false), 320)
        return () => clearTimeout(timer)
      }, [open])
      return h('div', {
        className: 'reqmap-group' + (open ? ' is-open' : ''),
        'data-preview': String(previewed),
        onMouseEnter: enter,
        onMouseLeave: leave,
      },
        h('button', {
          className: 'reqmap-group-summary',
          type: 'button',
          'aria-expanded': String(pinned),
          onClick: () => {
            clearTimeout(timer.current)
            setHovered(false)
            onTogglePin()
          },
        },
          h('span', { className: 'reqmap-caret', 'aria-hidden': true }, '▸'),
          h('span', { className: 'reqmap-group-name' }, name),
          h('span', { className: 'reqmap-group-count' }, String(count)),
        ),
        h('div', { className: 'reqmap-collapse', 'data-open': String(open) },
          h('div', { className: 'reqmap-collapse-inner' },
            mounted ? h('div', { className: 'reqmap-reqs' }, children) : null,
          ),
        ),
      )
    }

    function RequirementMap({ data, t, showHeader = true, embedded = false, onSetStatus }) {
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [showOld, setShowOld] = React.useState(true)
      const [openGroups, setOpenGroups] = React.useState(() => new Set())
      const [openReqs, setOpenReqs] = React.useState(() => new Set())
      const [statusOverride, setStatusOverride] = React.useState({})
      const [statusError, setStatusError] = React.useState('')
      const rootRef = useRef(null)
      const toolbarRef = useRef(null)

      // The toolbar is sticky and may wrap; publish its height so branch heads
      // stick below it instead of sliding underneath.
      React.useEffect(() => {
        const root = rootRef.current
        const toolbar = toolbarRef.current
        if (!root || !toolbar) return undefined
        const apply = () => root.style.setProperty('--reqmap-toolbar-h', `${toolbar.offsetHeight}px`)
        apply()
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(apply)
        observer.observe(toolbar)
        return () => observer.disconnect()
      }, [])

      const changeStatus = async (id, status) => {
        if (typeof onSetStatus !== 'function') return
        setStatusError('')
        setStatusOverride((previous) => ({ ...previous, [id]: status }))
        try {
          await onSetStatus(id, status)
        } catch (error) {
          setStatusOverride((previous) => {
            const next = { ...previous }
            delete next[id]
            return next
          })
          setStatusError(t('status.failed') + '：' + String(error?.message ?? error))
        }
      }

      const { meta, rows } = data
      const statusNames = Object.keys(meta.statuses)

      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        return rows.filter((row) => {
          if (needle) {
            const haystack = [row.id, row.title, row.current, row.old, row.note, row.group, row.root]
              .filter((value) => typeof value === 'string')
              .join(' ')
              .toLowerCase()
            if (!haystack.includes(needle)) return false
          }
          if (filter === 'all') return true
          if (filter === '__unfinished__') return isOpen(row.status)
          return row.status === filter
        })
      }, [rows, query, filter])

      const groupsByRoot = React.useMemo(() => {
        const map = new Map()
        for (const root of meta.roots) map.set(root, new Map())
        for (const row of visible) {
          if (!map.has(row.root)) map.set(row.root, new Map())
          const groups = map.get(row.root)
          if (!groups.has(row.group)) groups.set(row.group, [])
          groups.get(row.group).push(row)
        }
        return map
      }, [visible, meta.roots])

      const toggleIn = (setter) => (key) => setter((previous) => {
        const next = new Set(previous)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      const toggleGroup = toggleIn(setOpenGroups)
      const toggleReq = toggleIn(setOpenReqs)

      const expandAll = () => {
        const groups = new Set()
        const reqs = new Set()
        for (const [root, groupMap] of groupsByRoot) {
          for (const [group, list] of groupMap) {
            groups.add(root + '::' + group)
            for (const row of list) reqs.add(row.id)
          }
        }
        setOpenGroups(groups)
        setOpenReqs(reqs)
      }
      const collapseAll = () => {
        setOpenGroups(new Set())
        setOpenReqs(new Set())
      }

      const contextText = t('context', {
        date: meta.date || '—',
        branch: meta.branch || '—',
        head: meta.head || '—',
        count: String(rows.length),
      })

      const branchNodes = []
      let branchIndex = 0
      for (const [root, groupMap] of groupsByRoot) {
        const rootRows = [...groupMap.values()].reduce((sum, list) => sum + list.length, 0)
        if (rootRows === 0) continue
        const accent = BRANCH_ACCENTS[branchIndex % BRANCH_ACCENTS.length]
        branchIndex += 1
        const groupNodes = []
        for (const [group, list] of groupMap) {
          const groupKey = root + '::' + group
          const rowNodes = list.map((row) => h(ReqRow, {
            key: row.id,
            row,
            t,
            statusNames,
            displayStatus: statusOverride[row.id] ?? row.status,
            pinned: openReqs.has(row.id),
            canEdit: typeof onSetStatus === 'function',
            onTogglePin: () => toggleReq(row.id),
            onChangeStatus: (id, status) => { void changeStatus(id, status) },
          }))
          groupNodes.push(h(GroupBlock, {
            key: groupKey,
            groupKey,
            name: group,
            count: list.length,
            pinned: openGroups.has(groupKey),
            onTogglePin: () => toggleGroup(groupKey),
          }, rowNodes))
        }
        branchNodes.push(h('section', { className: 'reqmap-branch', key: root, style: { '--reqmap-accent': accent } },
          h('div', { className: 'reqmap-branch-head' },
            h('span', { className: 'reqmap-branch-dot', 'aria-hidden': true }),
            h('h2', { className: 'reqmap-branch-title' }, root),
            h('small', { className: 'reqmap-branch-count' }, rootRows + ' 项'),
          ),
          h('div', { className: 'reqmap-groups' }, groupNodes),
        ))
      }

      return h('div', { className: 'reqmap-root' + (embedded ? ' reqmap-embedded' : ''), ref: rootRef },
        h('style', null, CSS),
        showHeader
          ? h('header', { className: 'reqmap-head' },
            h('h1', { className: 'reqmap-title' }, meta.title || t('page.title')),
            h('p', { className: 'reqmap-context' }, contextText),
            h('p', { className: 'reqmap-context' }, t('legend.note')),
          )
          : null,
        h('div', { className: 'reqmap-toolbar', ref: toolbarRef },
          h('div', { className: 'reqmap-toolbar-group' },
            h('input', {
              className: 'reqmap-input',
              type: 'search',
              value: query,
              placeholder: t('search.placeholder'),
              'aria-label': t('search.label'),
              onChange: (event) => setQuery(event.target.value),
            }),
            h('select', {
              className: 'reqmap-select',
              value: filter,
              'aria-label': t('filter.label'),
              onChange: (event) => setFilter(event.target.value),
            },
              h('option', { value: 'all' }, t('filter.all')),
              h('option', { value: '__unfinished__' }, t('filter.unfinished')),
              statusNames.map((name) => h('option', { key: name, value: name }, name)),
            ),
          ),
          h('div', { className: 'reqmap-toolbar-group reqmap-toolbar-right' },
            h('button', { className: 'reqmap-btn', type: 'button', onClick: expandAll }, t('expand')),
            h('button', { className: 'reqmap-btn', type: 'button', onClick: collapseAll }, t('collapse')),
            h('button', {
              className: 'reqmap-btn',
              type: 'button',
              'aria-pressed': String(showOld),
              onClick: () => setShowOld((value) => !value),
            }, showOld ? t('hideOld') : t('showOld')),
            h('button', { className: 'reqmap-btn', type: 'button', onClick: () => window.print() }, t('print')),
            h('span', { className: 'reqmap-counter', 'aria-live': 'polite' }, t('counter', {
              shown: String(visible.length),
              total: String(rows.length),
            })),
          ),
        ),
        h('div', { className: 'reqmap-legend' },
          h('span', { className: 'reqmap-legend-item reqmap-legend-current' }, t('legend.current')),
          h('span', { className: 'reqmap-legend-item reqmap-legend-old' }, t('legend.old')),
        ),
        statusError ? h('p', { className: 'reqmap-status-error', role: 'status' }, statusError) : null,
        h('main', { className: 'reqmap-main' + (showOld ? '' : ' reqmap-hide-old') },
          h('div', { className: 'reqmap-grid' }, branchNodes),
          visible.length === 0 ? h('p', { className: 'reqmap-empty' }, t('empty')) : null,
        ),
        h('footer', { className: 'reqmap-foot' },
          meta.scope ? h('p', null, t('scope') + '：' + meta.scope) : null,
          h('p', null, t('maintain')),
        ),
      )
    }



    // ── Document preview ─────────────────────────────────────────────────

    function DocumentBody({ content, t }) {
      const text = content && content.kind === 'text' ? content.text : ''
      const parsed = React.useMemo(() => {
        if (!text) return { kind: 'empty' }
        try {
          return { kind: 'ok', data: parseLedger(text) }
        } catch (error) {
          return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
        }
      }, [text])
      if (parsed.kind === 'empty') return h('p', { className: 'reqmap-empty' }, t('page.loading'))
      if (parsed.kind === 'error') {
        return h('div', { className: 'reqmap-error' }, t('page.error') + '：' + parsed.message)
      }
      return h(RequirementMap, { data: parsed.data, t })
    }

    // ── Global page ──────────────────────────────────────────────────────

    /** Prefer the plugin's canonical path, then reqmap, then the legacy ledger name. */
    function ledgerRank(path) {
      const lower = String(path ?? '').toLowerCase()
      if (lower.endsWith('docs/requirements/requirements.reqmap.json')) return 0
      if (lower.endsWith('.reqmap.json')) return 1
      if (/需求台账/u.test(lower)) return 2
      if (lower.endsWith('requirements.json')) return 3
      return 4
    }

    /** The session the main view shows, else the first catalogued one. */
    function pickSession(list, retainedBy) {
      const ids = Array.isArray(list?.ids) ? list.ids : []
      return ids.find((id) => (retainedBy(id) ?? 0) > 0) ?? ids[0] ?? ''
    }

    function Page({ t, sessionId: fixedSessionId, compact = false, listSessions, subscribeSessions, retainedBy, searchLedgers, readLedger, watchLedger, sendPrompt }) {
      const [list, setList] = React.useState(() => listSessions())
      const [sessionId, setSessionId] = React.useState(() => fixedSessionId || pickSession(listSessions(), retainedBy))
      const [ledgers, setLedgers] = React.useState([])
      const [selected, setSelected] = React.useState('')
      const [token, setToken] = React.useState(0)
      const [job, setJob] = React.useState({ state: 'idle' })
      const [projects, setProjects] = React.useState([])
      const [project, setProject] = React.useState('')
      const [state, setState] = React.useState({ kind: 'discovering' })

      // Keep the session catalog fresh.
      React.useEffect(() => subscribeSessions(() => setList(listSessions())), [])

      const sessions = React.useMemo(() => {
        const ids = Array.isArray(list?.ids) ? list.ids : []
        return ids.map((id) => ({ id, label: list?.byId?.[id]?.title || list?.byId?.[id]?.cwd || id }))
      }, [list])

      // Adopt the main-view session once the catalog arrives.
      React.useEffect(() => {
        if (!sessionId && sessions.length > 0) setSessionId(fixedSessionId || pickSession(list, retainedBy))
      }, [sessionId, sessions, list, retainedBy, fixedSessionId])

      // Discover ledgers in the selected session's workspace. `token` re-runs this
      // for both the refresh and rescan buttons, so a newly created ledger appears.
      React.useEffect(() => {
        if (!sessionId) {
          setState({ kind: 'nosession' })
          return undefined
        }
        let cancelled = false
        setState((previous) => (previous.kind === 'ok' ? previous : { kind: 'discovering' }))
        searchLedgers(sessionId)
          .then((found) => {
            if (cancelled) return
            setLedgers(found)
          })
          .catch((error) => {
            if (!cancelled) setState({ kind: 'error', message: String(error?.message ?? error) })
          })
        return () => { cancelled = true }
      }, [sessionId, token])

      // One project owns its ledgers: the workspace list is narrowed to the
      // selected project, so the ledger can never drift to another project.
      const projectLedgers = React.useMemo(() => {
        const scoped = project && project !== '.'
          ? ledgers.filter((item) => item.path === project || item.path.startsWith(project + '/'))
          : ledgers
        return [...scoped].sort((left, right) => ledgerRank(left.path) - ledgerRank(right.path) || left.path.localeCompare(right.path))
      }, [ledgers, project])

      // Auto-select the project's best ledger; never keep one from another project.
      React.useEffect(() => {
        setSelected((previous) => (previous && projectLedgers.some((item) => item.path === previous)
          ? previous
          : (projectLedgers[0]?.path ?? '')))
      }, [projectLedgers])

      // An empty project scope is the "no ledger" state, regardless of other projects.
      React.useEffect(() => {
        if (!sessionId) return
        if (projectLedgers.length === 0) setState({ kind: 'none' })
      }, [projectLedgers, sessionId])

      // Load the selected ledger; `token` re-reads it, so a requirement change shows.
      React.useEffect(() => {
        if (!selected) return undefined
        let cancelled = false
        setState({ kind: 'loading' })
        readLedger(sessionId, selected)
          .then((text) => {
            if (cancelled) return
            setState({ kind: 'ok', data: parseLedger(text), path: selected })
          })
          .catch((error) => {
            if (!cancelled) setState({ kind: 'error', message: String(error?.message ?? error) })
          })
        return () => { cancelled = true }
      }, [selected, sessionId, token])

      // Follow the file so an agent write shows up without a manual refresh.
      React.useEffect(() => {
        if (!selected || !sessionId) return undefined
        return watchLedger(sessionId, selected, () => setToken((value) => value + 1))
      }, [selected, sessionId])

      React.useEffect(() => {
        if (!sessionId) return undefined
        let cancelled = false
        fetch(`${PROJECTS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((result) => {
            if (cancelled || !result?.ok) return
            const items = Array.isArray(result.projects) ? result.projects : []
            setProjects(items)
            setProject((previous) => {
              const remembered = previous || PROJECT_MEMORY.get(sessionId) || ''
              if (remembered && items.some((item) => item.path === remembered)) return remembered
              return items[0]?.path ?? ''
            })
          })
          .catch(() => {})
        return () => { cancelled = true }
      }, [sessionId])

      // A different project is a different Host job; drop the previous view.
      React.useEffect(() => {
        setJob({ state: 'idle', project })
      }, [project])

      // Adopt an existing Host job when the page mounts or the Session changes,
      // so switching away and back keeps showing the same generation.
      React.useEffect(() => {
        if (!sessionId) return undefined
        let cancelled = false
        fetch(`${STATUS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`, { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((result) => { if (!cancelled && result) setJob(result) })
          .catch(() => {})
        return () => { cancelled = true }
      }, [sessionId, project])

      // Poll while the Host job runs; a finished job refreshes the map.
      React.useEffect(() => {
        if (job.state !== 'running' || !sessionId || !project) return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const response = await fetch(`${STATUS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`, { credentials: 'same-origin' })
            if (!response.ok) return
            const result = await response.json()
            if (cancelled || !result) return
            setJob(result)
            if (result.state === 'done') setToken((value) => value + 1)
          } catch {
            // Keep polling; the manual buttons remain.
          }
        }
        const timer = setInterval(tick, 2000)
        void tick()
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [job.state, sessionId, project])

      const generate = async () => {
        if (!sessionId || !project || job.state === 'running') return
        setJob({ state: 'running' })
        try {
          const response = await fetch(GENERATE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionId, path: DEFAULT_LEDGER_PATH, project }),
          })
          const result = await response.json().catch(() => ({}))
          if (!response.ok || !result?.ok) throw new Error(result?.error || `HTTP ${response.status}`)
          setJob(result)
        } catch (error) {
          setJob({ state: 'error', error: String(error?.message ?? error) })
        }
      }

      const pause = async () => {
        if (!sessionId || job.state !== 'running') return
        try {
          await fetch(CANCEL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionId, project }),
          })
          setJob({ state: 'cancelled' })
        } catch {
          // The next poll reflects the Host state.
        }
      }

      const onSetStatus = async (id, status) => {
        if (!sessionId || !selected) throw new Error('no ledger selected')
        const response = await fetch(SET_STATUS_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId, path: selected, id, status }),
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok || !result?.ok) throw new Error(result?.error || `HTTP ${response.status}`)
        setToken((value) => value + 1)
      }

      const running = job.state === 'running'
      const notice = job.state === 'done'
        ? t('page.generated', { count: String(job.result?.count ?? 0), path: job.result?.path ?? '', project: job.result?.project ?? '' })
        : job.state === 'error'
          ? t('page.generateFailed') + '：' + (job.error ?? '')
          : job.state === 'cancelled'
            ? t('page.paused')
            : ''

      const current = ledgers.find((item) => item.path === selected)

      return h('div', { className: 'reqmap-page' },
        h('style', null, CSS),
        h('header', { className: 'reqmap-head reqmap-head-compact' },
          h('h1', { className: 'reqmap-title' },
            state.kind === 'ok' && state.data?.meta?.title ? state.data.meta.title : t('page.title')),
          h('p', { className: 'reqmap-context' },
            state.kind === 'ok'
              ? t('context', {
                date: state.data?.meta?.date || '—',
                branch: state.data?.meta?.branch || '—',
                head: state.data?.meta?.head || '—',
                count: String(state.data?.rows?.length ?? 0),
              })
              : t('page.subtitle')),
        ),
        h('div', { className: 'reqmap-page-form' },
          !fixedSessionId && sessions.length > 1 ? h('label', { className: 'reqmap-label', htmlFor: 'reqmap-session' }, t('page.session')) : null,
          !fixedSessionId && sessions.length > 1
            ? h('select', {
              id: 'reqmap-session',
              className: 'reqmap-select',
              value: sessionId,
              onChange: (event) => {
                setSessionId(event.target.value)
                setSelected('')
              },
            }, sessions.map((session) => h('option', { key: session.id, value: session.id }, session.label)))
            : null,
          projects.length > 1
            ? h('select', {
              id: 'reqmap-project',
              className: 'reqmap-select reqmap-input-path',
              value: project,
              onChange: (event) => {
                PROJECT_MEMORY.set(sessionId, event.target.value)
                setProject(event.target.value)
              },
            }, projects.map((item) => h('option', { key: item.path, value: item.path }, item.name || item.path)))
            : null,
          h('button', {
            className: 'reqmap-btn reqmap-btn-soft',
            type: 'button',
            onClick: () => setToken((value) => value + 1),
          }, t('page.rescan')),
          h('button', {
            className: 'reqmap-btn reqmap-btn-soft',
            type: 'button',
            onClick: () => setToken((value) => value + 1),
          }, t('page.reload')),
          running
            ? h('button', {
              className: 'reqmap-btn reqmap-btn-danger',
              type: 'button',
              onClick: pause,
            }, t('page.pause'))
            : h('button', {
              className: 'reqmap-btn reqmap-btn-primary',
              type: 'button',
              disabled: !sessionId || !project,
              onClick: generate,
            }, t('page.generate')),
          running ? h('span', { className: 'reqmap-counter' }, t('page.generatingShort')) : null,
          current ? h('span', { className: 'reqmap-counter', title: current.path }, current.path) : null,
        ),
        h('div', { className: 'reqmap-page-body' },
          state.kind === 'discovering' ? h('p', { className: 'reqmap-empty' }, t('page.scanning')) : null,
          state.kind === 'nosession' ? h('p', { className: 'reqmap-empty' }, t('page.noSession')) : null,
          state.kind === 'none'
            ? h('div', { className: 'reqmap-empty' },
              h('p', null, t('page.none')),
              running
                ? h('button', {
                  className: 'reqmap-btn reqmap-btn-danger reqmap-generate',
                  type: 'button',
                  onClick: pause,
                }, t('page.pause'))
                : h('button', {
                  className: 'reqmap-btn reqmap-btn-primary reqmap-generate',
                  type: 'button',
                  disabled: !sessionId || !project,
                  onClick: generate,
                }, t('page.generate')),
              notice ? h('p', { className: 'reqmap-notice' }, notice) : null,
              running ? h('p', { className: 'reqmap-notice' }, t('page.generating')) : null,
              h('p', { className: 'reqmap-hint' }, t('page.hint')),
            )
            : null,
          state.kind === 'loading' ? h('p', { className: 'reqmap-empty' }, t('page.loading')) : null,
          state.kind === 'error' ? h('div', { className: 'reqmap-error' }, t('page.error') + '：' + state.message) : null,
          state.kind === 'ok' ? h(RequirementMap, { data: state.data, t, showHeader: false, embedded: true, onSetStatus }) : null,
          notice && state.kind !== 'none' ? h('p', { className: 'reqmap-notice' }, notice) : null,
          running && state.kind !== 'none' ? h('p', { className: 'reqmap-notice' }, t('page.generating')) : null,
        ),
      )
    }

    // ── Sidebar panel icon ───────────────────────────────────────────────

    function PanelIcon({ size }) {
      const dimension = typeof size === 'number' ? size : 16
      return h('svg', {
        width: dimension,
        height: dimension,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 1.25, y: 6.25, width: 4, height: 3.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { x: 10.75, y: 1.75, width: 4, height: 3.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { x: 10.75, y: 10.75, width: 4, height: 3.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M5.25 8h2.25v-4.5h3.25M7.5 8v4.5h3.25', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      )
    }

    // ── Registration ─────────────────────────────────────────────────────

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'requirement-map: dictionaries')

      // 1. Document preview for requirement ledgers.
      ctx.effect(() => ctx.documentPreviews.register({
        id: DOC_ID,
        extensions: ['reqmap.json'],
        priority: 'external',
        title: () => t('viewer.label'),
        loading: 'text-pages',
        wrap: false,
      }), 'requirement-map: document metadata')
      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
        name: 'sidebar.right.tab.document',
        key: DOC_ID,
        locale: NS,
      }, DocumentBody)), 'requirement-map: document body')

      // 2. Global page: discover ledgers instead of asking for a path.
      const listSessions = () => ctx.sessions.list.getSnapshot()
      const subscribeSessions = (listener) => ctx.sessions.list.subscribe(listener)
      const retainedBy = (id) => {
        try {
          return ctx.sessions.retainInfo(id).getSnapshot()?.retainedBy?.mainView ?? 0
        } catch {
          return 0
        }
      }

      /** Read one ledger as text, following pages until `eof`. */
      const readLedger = async (sessionId, path) => {
        let offset = 1
        let text = ''
        for (let page = 0; page < 40; page++) {
          const result = await ctx.remote.workspaceFiles.read(sessionId, path, { offset, limit: READ_PAGE_LINES })
          if (!result?.ok) throw new Error(result?.error?.message ?? 'read failed')
          const value = result.value ?? {}
          const chunk = typeof value.text === 'string' ? value.text : ''
          text = text.length === 0 ? chunk : `${text}\n${chunk}`
          if (value.eof || chunk.length === 0) return text
          offset += typeof value.lines === 'number' && value.lines > 0 ? value.lines : READ_PAGE_LINES
        }
        return text
      }

      /** Find requirement ledgers in one session's workspace, validated by schema. */
      const searchLedgers = async (sessionId) => {
        const candidates = new Set()
        for (const query of SCAN_QUERIES) {
          let result
          try {
            result = await ctx.remote.workspaceFiles.search(sessionId, {
              query,
              excludedPaths: SCAN_EXCLUDES,
              includeHidden: false,
              respectGitignore: true,
            })
          } catch {
            continue
          }
          if (!result?.ok) continue
          for (const match of result.value?.matches ?? []) {
            if (match.type !== 'file') continue
            const path = String(match.path)
            if (!/\.json$/i.test(path)) continue
            candidates.add(path)
            if (candidates.size >= SCAN_MAX_CANDIDATES) break
          }
          if (candidates.size >= SCAN_MAX_CANDIDATES) break
        }
        const found = []
        for (const path of [...candidates].sort()) {
          try {
            const data = JSON.parse(await readLedger(sessionId, path))
            if (!isLedger(data)) continue
            const title = typeof data.meta.title === 'string' && data.meta.title.trim() ? data.meta.title.trim() : path
            found.push({ path, title })
          } catch {
            // Unreadable or not JSON; not a ledger.
          }
        }
        return found
      }

      const watchLedger = (sessionId, path, onChange) => {
        let disposed = false
        let handle
        try {
          handle = ctx.remote.workspaceFiles.changes(sessionId, path)
        } catch {
          return () => {}
        }
        const run = async () => {
          try {
            for await (const frame of handle) {
              if (disposed) break
              if (frame?.kind === 'change') onChange()
            }
          } catch {
            // A watch failure only means no automatic refresh; the manual button remains.
          }
        }
        void run()
        return () => {
          disposed = true
          try {
            handle.dispose()
          } catch {
            // Already terminated.
          }
        }
      }

      const face = { listSessions, subscribeSessions, retainedBy, searchLedgers, readLedger, watchLedger }

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => face,
      }, Page)), 'requirement-map: page')
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 10,
        label: () => t('panel'),
        locale: NS,
      }, PanelIcon)), 'requirement-map: panel icon')

      // 3. Right Sidebar page: the same map as a dockable tab, opened from the
      //    panel's add control (`guide`) or the conversation header button.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: SIDE_ID,
        kind: SIDE_KIND,
        priority: 'extension',
        title: () => t('panel'),
        guide: [{
          id: 'requirement-map',
          order: 30,
          title: () => t('panel'),
          description: () => t('page.subtitle'),
        }],
      }), 'requirement-map: side tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: SIDE_ID,
      }, (slotProps) => {
        const info = slotProps?.useTabInfo?.()
        const sessionId = slotProps?.sessionId || info?.tab?.navigation?.params?.sessionId || ''
        return h(Page, { ...face, t, sessionId, compact: true })
      })), 'requirement-map: side tab body')
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'requirement-map-open',
        order: -3,
      }, () => h('button', {
        type: 'button',
        className: 'reqmap-header-btn',
        title: t('panel'),
        'aria-label': t('panel'),
        onClick: () => ctx.sidebarRight.openTab(SIDE_KIND),
      }, h(PanelIcon, { size: 16 })))), 'requirement-map: header button')
    }

    exports.apply = apply
    exports.inject = [
      'documentPreviews', 'slots', 'locale', 'remote', 'remote.workspaceFiles', 'sessions',
      'sidebarRightTabs', 'sidebarRight',
    ]
    return module.exports
  },
})
