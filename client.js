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
      'page.none': '这个工作区里还没有需求台账。',
      'page.hint': '让 agent 用 requirement_map 工具生成台账后，这里会自动出现；也可以把台账保存为 *.reqmap.json 后在右侧文件树中打开。',
      'page.noSession': '当前没有可用会话；请先在左侧打开一个工作区。',
      'page.error': '读取失败',
      'page.generate': '生成需求导图',
      'page.generatingShort': '生成中…',
      'page.generating': '正在后台生成台账，请稍候…',
      'page.generated': '已生成 {count} 项需求：{path}（项目：{project}）',
      'page.generateFailed': '生成失败',
      'page.pause': '暂停',
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
      'page.none': 'No requirement ledger in this workspace yet.',
      'page.hint': 'Ask the agent to create one with the requirement_map tool and it appears here; or save a ledger as *.reqmap.json and open it from the file tree.',
      'page.noSession': 'No session is available; open a workspace on the left first.',
      'page.error': 'Read failed',
      'page.generate': 'Generate map',
      'page.generatingShort': 'Generating…',
      'page.generating': 'Generating the ledger in the background…',
      'page.generated': 'Generated {count} requirements: {path} (project: {project})',
      'page.generateFailed': 'Generation failed',
      'page.pause': 'Pause',
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
.reqmap-head{padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.reqmap-title{margin:0 0 4px;font-size:19px;font-weight:650;letter-spacing:.2px}
.reqmap-context{margin:2px 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.reqmap-toolbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 20px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2)}
.reqmap-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.reqmap-input,.reqmap-select{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 9px;min-height:30px}
.reqmap-input{width:240px;max-width:100%}
.reqmap-input-path{flex:1 1 320px;min-width:200px}
.reqmap-btn{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 11px;min-height:30px;cursor:pointer}
.reqmap-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.reqmap-btn:disabled{opacity:.5;cursor:default}
.reqmap-btn-primary{background:var(--dsw-alias-state-business-primary,#2457c5);border-color:transparent;color:var(--dsw-alias-label-on-color,#fff)}
.reqmap-btn-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-state-business-primary,#2457c5)}
.reqmap-btn-danger{background:var(--dsw-alias-state-error-primary,#a33f3f);border-color:transparent;color:var(--dsw-alias-label-on-color,#fff)}
.reqmap-btn-danger:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-state-error-primary,#a33f3f)}
.reqmap-input:focus-visible,.reqmap-select:focus-visible,.reqmap-btn:focus-visible,.reqmap-group-summary:focus-visible,.reqmap-req-summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.reqmap-counter{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}
.reqmap-legend{display:flex;flex-wrap:wrap;gap:14px;padding:8px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.reqmap-legend-item::before{content:"";display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:2px;vertical-align:baseline}
.reqmap-legend-current::before{background:var(--dsw-alias-state-success-primary,#216744)}
.reqmap-legend-old::before{background:var(--dsw-alias-state-error-primary,#a33f3f)}
.reqmap-main{flex:1;overflow:auto;padding:16px 20px 28px}
.reqmap-page-body{flex:1;overflow:auto;padding:0}
.reqmap-page-form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.reqmap-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start}
.reqmap-branch{min-width:0}
.reqmap-branch-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;padding:9px 13px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.reqmap-branch-title{margin:0;font-size:14px;font-weight:650}
.reqmap-branch-count{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.reqmap-group{margin:0 0 8px}
.reqmap-group-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer;font-weight:560;list-style:none}
.reqmap-group-summary::-webkit-details-marker{display:none}
.reqmap-group-summary::before{content:"▸";color:var(--dsw-alias-label-tertiary);font-size:11px;transition:transform .12s}
.reqmap-group[open]>.reqmap-group-summary::before{transform:rotate(90deg)}
.reqmap-group-name{flex:1}
.reqmap-group-count{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.reqmap-reqs{display:flex;flex-direction:column;gap:6px;padding:6px 0 2px 12px}
.reqmap-req{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden}
.reqmap-req-summary{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;list-style:none}
.reqmap-req-summary::-webkit-details-marker{display:none}
.reqmap-req-summary::before{content:"▸";color:var(--dsw-alias-label-tertiary);font-size:10px;transition:transform .12s}
.reqmap-req[open]>.reqmap-req-summary::before{transform:rotate(90deg)}
.reqmap-rid{font-family:var(--dsw-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.reqmap-req-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reqmap-badge{flex:none;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.5;white-space:nowrap;border:1px solid transparent}
.reqmap-badge.live{color:var(--dsw-alias-state-success-primary,#216744);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#216744) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#216744) 34%,transparent)}
.reqmap-badge.open{color:var(--dsw-alias-state-warn-primary,#9a5b00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#9a5b00) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#9a5b00) 34%,transparent)}
.reqmap-badge.hold{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.reqmap-badge.done{color:var(--dsw-alias-state-business-primary,#2457c5);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2457c5) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2457c5) 30%,transparent)}
.reqmap-compare{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:2px 10px 8px}
.reqmap-compare.single{grid-template-columns:1fr}
.reqmap-version{padding:7px 10px;border-left:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:0 5px 5px 0}
.reqmap-version strong{display:block;margin-bottom:2px;font-size:11px;font-weight:600}
.reqmap-version p{margin:0;white-space:pre-wrap;word-break:break-word}
.reqmap-current{border-left-color:var(--dsw-alias-state-success-primary,#216744)}
.reqmap-current strong{color:var(--dsw-alias-state-success-primary,#216744)}
.reqmap-old{border-left-color:var(--dsw-alias-state-error-primary,#a33f3f)}
.reqmap-old strong{color:var(--dsw-alias-state-error-primary,#a33f3f)}
.reqmap-hide-old .reqmap-old{display:none}
.reqmap-hide-old .reqmap-compare{grid-template-columns:1fr}
.reqmap-notes{padding:0 10px 9px;color:var(--dsw-alias-label-secondary);font-size:12px}
.reqmap-notes p{margin:2px 0}
.reqmap-source{word-break:break-all}
.reqmap-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.reqmap-error{margin:16px 20px;padding:10px 12px;border-radius:6px;color:var(--dsw-alias-state-error-primary,#a33f3f);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#a33f3f) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#a33f3f) 30%,transparent);white-space:pre-wrap;word-break:break-word}
.reqmap-foot{padding:10px 20px 16px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px}
.reqmap-foot p{margin:3px 0}
.reqmap-generate{margin:10px 0 6px;padding:8px 18px;font-size:13px}
.reqmap-notice{margin:8px 0 0;color:var(--dsw-alias-state-business-primary,#2457c5);font-size:12px}
.reqmap-hint{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.reqmap-header-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.reqmap-header-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.reqmap-header-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
@media (max-width:720px){.reqmap-grid{grid-template-columns:1fr}.reqmap-compare{grid-template-columns:1fr}.reqmap-input{width:100%}}
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

    function RequirementMap({ data, t }) {
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [showOld, setShowOld] = React.useState(true)
      const [openGroups, setOpenGroups] = React.useState(() => new Set())
      const [openReqs, setOpenReqs] = React.useState(() => new Set())

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

      const toggleGroup = (key) => setOpenGroups((previous) => {
        const next = new Set(previous)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      const toggleReq = (key) => setOpenReqs((previous) => {
        const next = new Set(previous)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
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

      return h('div', { className: 'reqmap-root' },
        h('style', null, CSS),
        h('header', { className: 'reqmap-head' },
          h('h1', { className: 'reqmap-title' }, meta.title || t('page.title')),
          h('p', { className: 'reqmap-context' }, t('context', {
            date: meta.date || '—',
            branch: meta.branch || '—',
            head: meta.head || '—',
            count: String(rows.length),
          })),
          h('p', { className: 'reqmap-context' }, t('legend.note')),
        ),
        h('div', { className: 'reqmap-toolbar' },
          h('label', { className: 'reqmap-label', htmlFor: 'reqmap-search' }, t('search.label')),
          h('input', {
            id: 'reqmap-search',
            className: 'reqmap-input',
            type: 'search',
            value: query,
            placeholder: t('search.placeholder'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('label', { className: 'reqmap-label', htmlFor: 'reqmap-filter' }, t('filter.label')),
          h('select', {
            id: 'reqmap-filter',
            className: 'reqmap-select',
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          },
            h('option', { value: 'all' }, t('filter.all')),
            h('option', { value: '__unfinished__' }, t('filter.unfinished')),
            statusNames.map((name) => h('option', { key: name, value: name }, name)),
          ),
          h('button', { className: 'reqmap-btn', type: 'button', onClick: expandAll }, t('expand')),
          h('button', { className: 'reqmap-btn', type: 'button', onClick: collapseAll }, t('collapse')),
          h('button', {
            className: 'reqmap-btn',
            type: 'button',
            'aria-pressed': String(showOld),
            onClick: () => setShowOld((value) => !value),
          }, showOld ? t('hideOld') : t('showOld')),
          h('button', { className: 'reqmap-btn', type: 'button', onClick: () => window.print() }, t('print')),
          h('span', { className: 'reqmap-counter' }, t('counter', {
            shown: String(visible.length),
            total: String(rows.length),
          })),
        ),
        h('div', { className: 'reqmap-legend' },
          h('span', { className: 'reqmap-legend-item reqmap-legend-current' }, t('legend.current')),
          h('span', { className: 'reqmap-legend-item reqmap-legend-old' }, t('legend.old')),
        ),
        h('main', { className: 'reqmap-main' + (showOld ? '' : ' reqmap-hide-old') },
          h('div', { className: 'reqmap-grid' },
            [...groupsByRoot].map(([root, groupMap]) => {
              const rootCount = [...groupMap.values()].reduce((sum, list) => sum + list.length, 0)
              if (rootCount === 0) return null
              return h('section', { className: 'reqmap-branch', key: root },
                h('div', { className: 'reqmap-branch-head' },
                  h('h2', { className: 'reqmap-branch-title' }, root),
                  h('small', { className: 'reqmap-branch-count' }, rootCount + ' 项'),
                ),
                [...groupMap].map(([group, list]) => {
                  const groupKey = root + '::' + group
                  return h('details', { className: 'reqmap-group', key: groupKey, open: openGroups.has(groupKey) },
                    h('summary', {
                      className: 'reqmap-group-summary',
                      onClick: (event) => {
                        event.preventDefault()
                        toggleGroup(groupKey)
                      },
                    },
                      h('span', { className: 'reqmap-group-name' }, group),
                      h('span', { className: 'reqmap-group-count' }, String(list.length)),
                    ),
                    h('div', { className: 'reqmap-reqs' },
                      list.map((row) => h('details', {
                        className: 'reqmap-req',
                        key: row.id,
                        open: openReqs.has(row.id),
                      },
                        h('summary', {
                          className: 'reqmap-req-summary',
                          onClick: (event) => {
                            event.preventDefault()
                            toggleReq(row.id)
                          },
                        },
                          h('span', { className: 'reqmap-rid' }, row.id + ' '),
                          h('span', { className: 'reqmap-req-title' }, row.title),
                          h('span', { className: 'reqmap-badge ' + statusTone(row.status) }, row.status),
                        ),
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
                      )),
                    ),
                  )
                }),
              )
            }),
          ),
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
            setSelected((previous) => (previous && found.some((item) => item.path === previous) ? previous : (found[0]?.path ?? '')))
            if (found.length === 0) setState({ kind: 'none' })
          })
          .catch((error) => {
            if (!cancelled) setState({ kind: 'error', message: String(error?.message ?? error) })
          })
        return () => { cancelled = true }
      }, [sessionId, token])

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
            setProject((previous) => (previous && items.some((item) => item.path === previous) ? previous : (items[0]?.path ?? '')))
          })
          .catch(() => {})
        return () => { cancelled = true }
      }, [sessionId])

      // Adopt an existing Host job when the page mounts or the Session changes,
      // so switching away and back keeps showing the same generation.
      React.useEffect(() => {
        if (!sessionId) return undefined
        let cancelled = false
        fetch(`${STATUS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((result) => { if (!cancelled && result) setJob(result) })
          .catch(() => {})
        return () => { cancelled = true }
      }, [sessionId])

      // Poll while the Host job runs; a finished job refreshes the map.
      React.useEffect(() => {
        if (job.state !== 'running' || !sessionId) return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const response = await fetch(`${STATUS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
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
      }, [job.state, sessionId])

      const generate = async () => {
        if (!sessionId || job.state === 'running') return
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
            body: JSON.stringify({ sessionId }),
          })
          setJob({ state: 'cancelled' })
        } catch {
          // The next poll reflects the Host state.
        }
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
        compact
          ? null
          : h('header', { className: 'reqmap-head' },
            h('h1', { className: 'reqmap-title' }, t('page.title')),
            h('p', { className: 'reqmap-context' }, t('page.subtitle')),
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
          projects.length > 1 ? h('label', { className: 'reqmap-label', htmlFor: 'reqmap-project' }, t('page.project')) : null,
          projects.length > 1
            ? h('select', {
              id: 'reqmap-project',
              className: 'reqmap-select reqmap-input-path',
              value: project,
              onChange: (event) => setProject(event.target.value),
            }, projects.map((item) => h('option', { key: item.path, value: item.path }, item.name || item.path)))
            : null,
          ledgers.length > 1 ? h('label', { className: 'reqmap-label', htmlFor: 'reqmap-ledger' }, t('page.ledger')) : null,
          ledgers.length > 1
            ? h('select', {
              id: 'reqmap-ledger',
              className: 'reqmap-select reqmap-input-path',
              value: selected,
              onChange: (event) => setSelected(event.target.value),
            }, ledgers.map((ledger) => h('option', { key: ledger.path, value: ledger.path }, ledger.title)))
            : null,
          h('button', {
            className: 'reqmap-btn',
            type: 'button',
            onClick: () => setToken((value) => value + 1),
          }, t('page.rescan')),
          h('button', {
            className: 'reqmap-btn',
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
              disabled: !sessionId,
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
                  disabled: !sessionId,
                  onClick: generate,
                }, t('page.generate')),
              notice ? h('p', { className: 'reqmap-notice' }, notice) : null,
              running ? h('p', { className: 'reqmap-notice' }, t('page.generating')) : null,
              h('p', { className: 'reqmap-hint' }, t('page.hint')),
            )
            : null,
          state.kind === 'loading' ? h('p', { className: 'reqmap-empty' }, t('page.loading')) : null,
          state.kind === 'error' ? h('div', { className: 'reqmap-error' }, t('page.error') + '：' + state.message) : null,
          state.kind === 'ok' ? h(RequirementMap, { data: state.data, t }) : null,
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
