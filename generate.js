/**
 * Background ledger generation for dsh-plugin-requirement-map.
 *
 * Reads the workspace's requirement-bearing documents, asks the deployment's
 * default model for a ledger document, validates it, and writes it. Nothing
 * here touches a Session turn: the browser calls the registered web route and
 * the plugin does the work on the Host.
 */
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

/** Document extensions worth feeding the extractor. */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt'])
/** Directories that never hold requirement prose. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv',
  'target', 'out', '.turbo', '.cache', '__pycache__',
])
/** Total document bytes sent to the model. */
const DOC_BUDGET = 120_000
/** Files read at most. */
const DOC_MAX_FILES = 80
/** Directory depth walked from the workspace root. */
const DOC_MAX_DEPTH = 4

const STATUS_TEMPLATE = {
  未完成: '已有明确未完成或失败证据。',
  部分完成: '已有实现，但此项明确仍有未完成部分。',
  待核实: '需要补专项验收或核对实际交付，不能直接打勾。',
  暂缓: '用户明确暂不做，或正式启用前置条件未满足。',
  已上线: '有本机或服务器生效证据；不等于最新安装包已包含。',
}

const SYSTEM_PROMPT = [
  '你是需求台账提取器。阅读给定仓库文档，输出一份需求台账 JSON。',
  '只输出 JSON，不要 Markdown 代码围栏，不要解释。',
  'JSON 结构：',
  '{"meta":{"title":string,"date":"YYYY-MM-DD","branch":string,"head":string,"scope":string,',
  '"image_note":string,"statuses":{string:string},"roots":string[]},',
  '"requirements":[{"id":string,"root":string,"group":string,"title":string,',
  '"current":string,"old":string,"status":string,"source":string,"note":string}]}',
  '规则：',
  '1. 只提取文档中真实存在的需求，不要编造；文档没写的字段留空字符串。',
  '2. roots 是顶层分类（2-6 个），group 是 roots 下的分组，id 用 <前缀>-<两位数字> 且唯一。',
  '3. status 只能取 statuses 的键；statuses 固定为：' + Object.keys(STATUS_TEMPLATE).join('、') + '。',
  '4. current 写当前要求；被替代的口径写进 old；未确认事项写进 note；source 写文档相对路径。',
].join('\n')

/** Recursively read requirement-bearing documents under one root. */
async function collectDocs(root) {
  const files = []
  let used = 0

  const walk = async (dir, depth) => {
    if (depth > DOC_MAX_DEPTH || used >= DOC_BUDGET || files.length >= DOC_MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (used >= DOC_BUDGET || files.length >= DOC_MAX_FILES) return
      if (entry.name.startsWith('.') && entry.name !== '.agents') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const dot = entry.name.lastIndexOf('.')
      const extension = dot === -1 ? '' : entry.name.slice(dot)
      if (!DOC_EXTENSIONS.has(extension) && entry.name !== 'package.json') continue
      try {
        const info = await stat(full)
        if (info.size > 200_000) continue
        const text = await readFile(full, 'utf8')
        const slice = text.slice(0, Math.max(0, DOC_BUDGET - used))
        if (slice.length === 0) continue
        used += slice.length
        files.push({ path: relative(root, full).split('\\').join('/'), text: slice })
      } catch {
        // Unreadable file; skip it.
      }
    }
  }

  await walk(root, 0)
  return files
}

/** Build the user prompt from the collected documents. */
function buildPrompt(docs, targetPath) {
  const header = [
    `目标台账路径：${targetPath}`,
    `文档数量：${docs.length}`,
    '',
    '以下是仓库文档，按路径分隔：',
    '',
  ]
  const body = docs.map((doc) => `===== ${doc.path} =====\n${doc.text}`)
  return [...header, ...body].join('\n')
}

/** Strip code fences and isolate the outermost JSON object. */
function extractJson(text) {
  let value = String(text ?? '').trim()
  const fence = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) value = fence[1].trim()
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('model returned no JSON object')
  return JSON.parse(value.slice(start, end + 1))
}

/** Normalize a model-produced ledger into the canonical shape. */
function normalizeLedger(raw) {
  const meta = raw && typeof raw.meta === 'object' && raw.meta !== null ? raw.meta : {}
  const rows = Array.isArray(raw?.requirements) ? raw.requirements : []
  const statuses = meta.statuses && typeof meta.statuses === 'object' && !Array.isArray(meta.statuses) && Object.keys(meta.statuses).length > 0
    ? meta.statuses
    : { ...STATUS_TEMPLATE }
  const statusNames = Object.keys(statuses)
  const requirements = rows
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row, index) => ({
      id: typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `REQ-${String(index + 1).padStart(2, '0')}`,
      root: typeof row.root === 'string' && row.root.trim() ? row.root.trim() : '未分类',
      group: typeof row.group === 'string' && row.group.trim() ? row.group.trim() : '未分组',
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : `需求 ${index + 1}`,
      current: typeof row.current === 'string' ? row.current : '',
      old: typeof row.old === 'string' ? row.old : '',
      status: statusNames.includes(row.status) ? row.status : (statusNames[0] ?? '未完成'),
      source: typeof row.source === 'string' ? row.source : '',
      note: typeof row.note === 'string' ? row.note : '',
    }))
  const roots = Array.isArray(meta.roots) && meta.roots.length > 0
    ? meta.roots.filter((root) => typeof root === 'string' && root.trim())
    : [...new Set(requirements.map((row) => row.root))]
  return {
    meta: {
      title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : '项目需求导图',
      date: typeof meta.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.date) ? meta.date : new Date().toISOString().slice(0, 10),
      branch: typeof meta.branch === 'string' ? meta.branch : '',
      head: typeof meta.head === 'string' ? meta.head : '',
      scope: typeof meta.scope === 'string' && meta.scope.trim() ? meta.scope.trim() : '由插件从仓库文档自动提取；请人工复核。',
      image_note: typeof meta.image_note === 'string' ? meta.image_note : '',
      statuses,
      roots: roots.length > 0 ? roots : ['未分类'],
    },
    requirements,
  }
}

/** Output cap for one extraction call. */
const MAX_OUTPUT_TOKENS = 8192
/** Deadline for one extraction call. */
const TIMEOUT_MS = 120_000

/**
 * Prepare one call, picking the selected reasoning effort (or the model's least
 * effort) and a sane output cap. Falls back to a plain stream when the adapter
 * has no `prepareCall`.
 */
async function prepareCall(llm, selection, signal) {
  if (typeof llm.prepareCall !== 'function') return null
  try {
    const call = await llm.prepareCall(
      { provider: selection.provider, model: selection.model },
      signal,
      (controls, modelInfo) => {
        const effort = selection.reasoningEffort ?? modelInfo?.reasoning?.efforts?.[0]?.id
        const modelDefault = Number(modelInfo?.defaultMaxTokens)
        const cap = Number.isFinite(modelDefault) && modelDefault > 0
          ? Math.min(MAX_OUTPUT_TOKENS, modelDefault)
          : MAX_OUTPUT_TOKENS
        const next = { ...controls, maxTokens: cap }
        return effort === undefined ? next : { ...next, reasoningEffort: effort }
      },
    )
    return call && typeof call.stream === 'function' ? call : null
  } catch {
    return null
  }
}

/**
 * Stream one model call and return its joined text.
 *
 * `finish.reason` is an object (`{ kind }`), not a string: a stream that ends
 * without one, or ends in `aborted`/`error`, is a failure rather than an empty
 * answer.
 */
async function callModel(llm, selection, prompt, signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('model call timed out')), TIMEOUT_MS)
  try {
    const call = await prepareCall(llm, selection, controller.signal)
    const config = call
      ? { ...call.config }
      : { provider: selection.provider, model: selection.model, maxTokens: MAX_OUTPUT_TOKENS }
    const options = {
      ...config,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    }
    const iterable = call ? call.stream(options) : llm.stream(options)
    let text = ''
    let finish
    for await (const chunk of iterable) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish') {
        finish = chunk.reason
        break
      }
    }
    if (!finish) throw new Error('model stream ended without a terminal finish')
    if (finish.kind === 'aborted') throw new Error('model call aborted')
    if (finish.kind === 'error') {
      throw new Error(`model call failed: ${finish.failure?.code ?? 'UNKNOWN'}`)
    }
    return text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Generate one ledger in the background.
 * @param ctx - Host plugin context with `llm`, `agentDefaultModel`, and `sessions`.
 * @param options - session identity, target path, and cancellation.
 * @returns the written path and requirement count.
 */
export async function generateLedger(ctx, options) {
  const { sessionId, path, signal } = options
  const llm = ctx.get('llm')
  if (!llm) throw new Error('llm service is not mounted in this profile')
  const defaults = ctx.get('agentDefaultModel')
  const selection = defaults?.currentSelection?.()
  if (!selection?.provider || !selection?.model) {
    throw new Error('no default model is configured (agentDefaultModel)')
  }

  const root = await resolveWorkspaceRoot(ctx, sessionId)
  if (!root) throw new Error('cannot resolve the workspace root for this session')

  const targetPath = path && typeof path === 'string' ? path : 'docs/requirements/requirements.reqmap.json'
  const absoluteTarget = resolve(root, targetPath)

  const docs = await collectDocs(root)
  if (docs.length === 0) throw new Error('no requirement documents found in this workspace')

  const text = await callModel(llm, selection, buildPrompt(docs, targetPath), signal)
  const ledger = normalizeLedger(extractJson(text))
  if (ledger.requirements.length === 0) throw new Error('the model extracted no requirements')

  await mkdir(dirname(absoluteTarget), { recursive: true })
  await writeFile(absoluteTarget, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  return { ok: true, path: targetPath, absolutePath: absoluteTarget, count: ledger.requirements.length, docs: docs.length }
}

/** Resolve one session's workspace root, live or persisted. */
async function resolveWorkspaceRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return process.cwd()
  try {
    const live = ctx.get('sessions')?.get?.(sessionId)?.header?.cwd
    if (typeof live === 'string' && live.length > 0) return live
  } catch {
    // Fall through to persistence.
  }
  try {
    const stored = await ctx.get('sessionPersistence')?.stat?.(sessionId)
    const cwd = stored?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  } catch {
    // No persistence provider.
  }
  return process.cwd()
}

// ── Background jobs ─────────────────────────────────────────────────────
//
// One generation per Session. The job lives on the Host, so switching Session
// in the browser neither cancels it nor loses its result; the page polls the
// status route instead of owning the request.

/** Finished jobs are dropped after this long. */
const JOB_TTL_MS = 10 * 60 * 1000
/** Running and recently finished jobs, keyed by Session id. */
const jobs = new Map()

/** The job key for one Session. */
function jobKey(sessionId) {
  return String(sessionId ?? '')
}

/** Detached job state for the wire (never the controller). */
function snapshot(job) {
  return {
    ok: job.state !== 'error',
    state: job.state,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    error: job.error ?? null,
    result: job.result ?? null,
  }
}

/** Drop finished jobs past their retention window. */
function prune(now = Date.now()) {
  for (const [key, job] of jobs) {
    if (job.state !== 'running' && job.finishedAt !== null && now - job.finishedAt > JOB_TTL_MS) jobs.delete(key)
  }
}

/**
 * Start one background generation, or return the running one.
 * @returns the detached job state.
 */
export function startGeneration(ctx, { sessionId, path }) {
  const key = jobKey(sessionId)
  const existing = jobs.get(key)
  if (existing?.state === 'running') return snapshot(existing)
  const controller = new AbortController()
  const job = {
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    result: null,
    controller,
  }
  jobs.set(key, job)
  generateLedger(ctx, { sessionId, path, signal: controller.signal })
    .then((result) => {
      job.state = 'done'
      job.result = result
      job.finishedAt = Date.now()
    })
    .catch((error) => {
      job.state = controller.signal.aborted ? 'cancelled' : 'error'
      job.error = error instanceof Error ? error.message : String(error)
      job.finishedAt = Date.now()
    })
  prune()
  return snapshot(job)
}

/** Read one Session's job state. */
export function generationStatus(sessionId) {
  prune()
  const job = jobs.get(jobKey(sessionId))
  return job
    ? snapshot(job)
    : { ok: true, state: 'idle', startedAt: null, finishedAt: null, error: null, result: null }
}

/** Cancel one running generation. */
export function cancelGeneration(sessionId) {
  const job = jobs.get(jobKey(sessionId))
  if (job?.state === 'running') {
    job.state = 'cancelled'
    job.error = 'cancelled'
    job.finishedAt = Date.now()
    job.controller.abort(new Error('cancelled by user'))
  }
  return generationStatus(sessionId)
}
