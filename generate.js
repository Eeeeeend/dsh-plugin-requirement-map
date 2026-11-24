/**
 * Background ledger generation for dsh-plugin-requirement-map.
 *
 * Reads the workspace's requirement-bearing documents, asks the deployment's
 * default model for a ledger document, validates it, and writes it. Nothing
 * here touches a Session turn: the browser calls the registered web route and
 * the plugin does the work on the Host.
 */
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

/** Document extensions worth feeding the extractor. */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt'])
/** Directories that never hold requirement prose. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv',
  'target', 'out', '.turbo', '.cache', '__pycache__',
])
/** Total document bytes sent to the model. */
const DOC_BUDGET = 60_000
/** Files read at most. */
const DOC_MAX_FILES = 40
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
  '你是需求台账提取器。阅读用户给的仓库文档，输出一份需求台账 JSON。',
  '只输出 JSON 对象本身：第一个字符是 {，最后一个字符是 }。',
  '不要复述任务，不要分析，不要解释，不要代码围栏。',
  '只提取文档中真实存在的需求，不要编造。',
].join('\n')

/** Rank documents by how likely they hold requirement prose. */
function docPriority(path) {
  const lower = path.toLowerCase()
  if (/requirements?|需求/.test(lower)) return 0
  if (/(^|\/)(readme|agents|changelog|contributing)\.(md|mdx|txt)$/.test(lower)) return 1
  if (lower.startsWith('docs/')) return 2
  return 3
}

/** Walk one root and return candidate document paths, then read them by priority. */
async function collectDocs(root) {
  const candidates = []

  const walk = async (dir, depth) => {
    if (depth > DOC_MAX_DEPTH || candidates.length >= 400) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (candidates.length >= 400) return
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
      candidates.push({ path: relative(root, full).split('\\').join('/'), full })
    }
  }

  await walk(root, 0)
  candidates.sort((left, right) => docPriority(left.path) - docPriority(right.path) || left.path.localeCompare(right.path))

  const files = []
  let used = 0
  for (const candidate of candidates) {
    if (used >= DOC_BUDGET || files.length >= DOC_MAX_FILES) break
    try {
      const info = await stat(candidate.full)
      if (info.size > 200_000) continue
      const text = await readFile(candidate.full, 'utf8')
      const slice = text.slice(0, Math.max(0, DOC_BUDGET - used))
      if (slice.length === 0) continue
      used += slice.length
      files.push({ path: candidate.path, text: slice })
    } catch {
      // Unreadable file; skip it.
    }
  }
  return files
}

/**
 * Build the user prompt: documents first, instructions last.
 *
 * Recency matters — a model that reads a long document dump tends to narrate
 * instead of answering, so the hard "only JSON" instruction is the last thing
 * it sees.
 */
function buildPrompt(docs, targetPath, projectRoot) {
  const body = docs.map((doc) => `===== ${doc.path} =====\n${doc.text}`)
  return [
    `项目根目录：${projectRoot}`,
    '',
    '以下是该项目的文档：',
    '',
    ...body,
    '',
    '-----',
    '任务：根据以上文档，为这个项目输出一份需求台账 JSON。',
    `目标路径（仅作记录）：${targetPath}`,
    '',
    '硬性要求：',
    '1. 你的整个回复必须是一个 JSON 对象，第一个字符是 {，最后一个字符是 }。',
    '2. 不要复述任务、不要分析、不要解释、不要代码围栏、不要任何前后缀。',
    '3. 只提取文档中真实存在的需求，不要编造；文档没写的字段留空字符串。',
    '4. roots 是顶层分类（2-6 个），group 是 roots 下的分组，id 用 <前缀>-<两位数字> 且唯一。',
    `5. status 只能取 statuses 的键；statuses 固定为：${Object.keys(STATUS_TEMPLATE).join('、')}。`,
    '6. current 写当前要求；被替代的口径写进 old；未确认事项写进 note；source 写文档相对路径。',
    '',
    '结构：',
    '{"meta":{"title":string,"date":"YYYY-MM-DD","branch":string,"head":string,"scope":string,"image_note":string,"statuses":{string:string},"roots":string[]},"requirements":[{"id":string,"root":string,"group":string,"title":string,"current":string,"old":string,"status":string,"source":string,"note":string}]}',
  ].join('\n')
}

/** Project manifests that mark a directory as a project root. */
const MANIFEST_NAMES = [
  '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'composer.json', 'requirements.txt',
]

/** Whether one directory holds a project manifest. */
async function hasManifest(dir) {
  for (const name of MANIFEST_NAMES) {
    try {
      await stat(join(dir, name))
      return true
    } catch {
      // Not present.
    }
  }
  return false
}

/** Score one directory by requirement-doc density (bounded walk). */
async function requirementScore(dir) {
  let score = 0
  const walk = async (current, depth) => {
    if (depth > 2) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (/requirements?|需求/iu.test(entry.name)) score += 3
      if (/\.(md|mdx)$/iu.test(entry.name)) score += 1
    }
  }
  await walk(dir, 0)
  return score
}

/**
 * Pick one project root to generate against.
 *
 * A workspace can be a dumping ground of unrelated projects; generating from
 * all of them confuses the model. Prefer the workspace itself when it is a
 * project, otherwise the immediate child project with the most requirement
 * documents.
 */
async function detectProjectRoot(root) {
  if (await hasManifest(root)) return { root, reason: 'workspace' }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { root, reason: 'fallback' }
  }
  const scored = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(root, entry.name)
    if (!(await hasManifest(full))) continue
    scored.push({ root: full, score: await requirementScore(full) })
  }
  scored.sort((left, right) => right.score - left.score || left.root.localeCompare(right.root))
  if (scored.length === 0) return { root, reason: 'fallback' }
  return {
    root: scored[0].root,
    reason: 'child',
    alternatives: scored.slice(0, 5).map((item) => item.root),
  }
}

/**
 * Find the first balanced JSON object in a model response.
 *
 * Models often wrap JSON in prose or fences, so a naive first-brace/last-brace
 * slice is unreliable; this scans balanced braces while respecting strings.
 */
function findJsonObject(text) {
  const source = String(text ?? '')
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < source.length; index++) {
      const ch = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, index + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
}

/** Extract one ledger-shaped object, or fail with a diagnostic snippet. */
function extractJson(text) {
  const value = findJsonObject(text)
  if (value !== undefined) return value
  const snippet = String(text ?? '').trim().slice(0, 200)
  throw new Error(snippet ? `model returned no JSON object; got: ${snippet}` : 'model returned an empty response')
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
const MAX_OUTPUT_TOKENS = 16384
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
        // temperature belongs to the prepared controls: mutating it after
        // prepareCall fails the adapter's "config changed" check.
        const next = { ...controls, maxTokens: cap, temperature: 0 }
        return effort === undefined ? next : { ...next, reasoningEffort: effort }
      },
    )
    return call && typeof call.stream === 'function' ? call : null
  } catch {
    return null
  }
}

/**
 * Stream one model call and return its joined text, plus reasoning as a
 * fallback when the model emits no visible text.
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
      : { provider: selection.provider, model: selection.model, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0 }
    // Only what the prepared config does not carry may be added here; changing
    // provider/model/reasoningEffort/temperature/maxTokens/stop fails dispatch.
    const options = {
      ...config,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    }
    const iterable = call ? call.stream(options) : llm.stream(options)
    let text = ''
    let reasoning = ''
    let finish
    for await (const chunk of iterable) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
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
    return { text, reasoning }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * List candidate project roots for one Session's workspace.
 *
 * A workspace may contain many unrelated projects; the page lets the user pick
 * one so the generated ledger describes a single project.
 */
export async function listProjects(ctx, options = {}) {
  const root = await resolveWorkspaceRoot(ctx, options.sessionId)
  if (!root) return { ok: false, error: 'cannot resolve the workspace root for this session' }
  const items = []
  if (await hasManifest(root)) items.push({ path: '.', name: basename(root) || '.', score: await requirementScore(root) })
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // Unreadable workspace; fall through.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(root, entry.name)
    if (!(await hasManifest(full))) continue
    items.push({ path: entry.name, name: entry.name, score: await requirementScore(full) })
  }
  items.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  if (items.length === 0) items.push({ path: '.', name: basename(root) || '.', score: 0 })
  return { ok: true, root, projects: items.slice(0, 30) }
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

  const selected = typeof options.project === 'string' && options.project !== '' && options.project !== '.' ? options.project : ''
  let project
  if (selected) {
    const candidate = resolve(root, selected)
    if (candidate !== root && !candidate.startsWith(root + '/')) {
      throw new Error('selected project is outside the workspace')
    }
    project = { root: candidate, reason: 'selected' }
  } else {
    project = await detectProjectRoot(root)
  }
  const docs = await collectDocs(project.root)
  if (docs.length === 0) throw new Error('no requirement documents found in this workspace')

  const projectLabel = relative(root, project.root).split('\\').join('/') || '.'
  const basePrompt = buildPrompt(docs, targetPath, projectLabel)
  const correction = '\n\n注意：上一次输出不是合法 JSON。请重新输出，只输出一个 JSON 对象，'
    + '以 { 开头、} 结尾，不要任何解释、前后缀或代码围栏。'

  let lastError
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1 ? basePrompt : basePrompt + correction
    const { text, reasoning } = await callModel(llm, selection, prompt, signal)
    // A reasoning model can put the whole answer in reasoning and leave text empty.
    const raw = text.trim().length > 0 ? text : reasoning
    try {
      const ledger = normalizeLedger(extractJson(raw))
      if (ledger.requirements.length === 0) throw new Error('the model extracted no requirements')
      await mkdir(dirname(absoluteTarget), { recursive: true })
      await writeFile(absoluteTarget, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
      return {
        ok: true,
        path: targetPath,
        absolutePath: absoluteTarget,
        project: projectLabel,
        projectReason: project.reason,
        alternatives: project.alternatives?.map((item) => relative(root, item).split('\\').join('/')) ?? [],
        count: ledger.requirements.length,
        docs: docs.length,
        attempts: attempt,
      }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`generation failed after 2 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
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
