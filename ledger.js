/**
 * Pure ledger operations for dsh-plugin-requirement-map.
 *
 * Kept separate from the tool registration so the behavior can be exercised
 * without a Cordis context. Every function works on one `*.reqmap.json` file.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const STATUS_TEMPLATE = {
  未完成: '已有明确未完成或失败证据。',
  部分完成: '已有实现，但此项明确仍有未完成部分。',
  待核实: '需要补专项验收或核对实际交付，不能直接打勾。',
  暂缓: '用户明确暂不做，或正式启用前置条件未满足。',
  已上线: '有本机或服务器生效证据；不等于最新安装包已包含。',
}

const REQUIRED_FIELDS = ['id', 'root', 'group', 'title', 'current', 'status']
const OPTIONAL_FIELDS = ['old', 'source', 'note', 'created', 'updated', 'old_date']

/** A fresh ledger with the generic schema. */
export function skeleton() {
  return {
    meta: {
      title: '项目需求导图',
      date: new Date().toISOString().slice(0, 10),
      branch: '',
      head: '',
      scope: '本会话已下发需求＋仓库方案/实施记录；新要求覆盖旧要求。',
      image_note: '',
      statuses: { ...STATUS_TEMPLATE },
      roots: ['待补充'],
    },
    requirements: [],
  }
}

/** Resolve a caller-supplied path against the Host working directory. */
export function ledgerPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path must be a non-empty string')
  return resolve(process.cwd(), input)
}

/** Read and parse one ledger file. */
export async function readLedger(path) {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Write one ledger file, creating the parent directory. */
export async function writeLedger(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/** Structural validation; returns human-readable errors. */
export function validateLedger(data) {
  const errors = []
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['ledger must be a JSON object']
  const meta = data.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    errors.push('meta must be an object')
  } else {
    if (typeof meta.title !== 'string' || !meta.title.trim()) errors.push('meta.title must be a non-empty string')
    if (!Array.isArray(meta.roots) || meta.roots.length === 0) errors.push('meta.roots must be a non-empty array')
    else if (meta.roots.some((root) => typeof root !== 'string' || !root.trim())) errors.push('meta.roots entries must be non-empty strings')
    if (!meta.statuses || typeof meta.statuses !== 'object' || Array.isArray(meta.statuses)) {
      errors.push('meta.statuses must be an object')
    }
  }
  if (!Array.isArray(data.requirements)) {
    errors.push('requirements must be an array')
    return errors
  }
  const roots = Array.isArray(meta?.roots) ? meta.roots : []
  const statuses = meta?.statuses && typeof meta.statuses === 'object' ? Object.keys(meta.statuses) : []
  const ids = new Set()
  data.requirements.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`requirements[${index}] must be an object`)
      return
    }
    for (const field of REQUIRED_FIELDS) {
      if (typeof row[field] !== 'string' || !row[field].trim()) {
        errors.push(`requirements[${index}].${field} must be a non-empty string`)
      }
    }
    if (typeof row.id === 'string') {
      if (ids.has(row.id)) errors.push(`duplicate id: ${row.id}`)
      ids.add(row.id)
    }
    if (roots.length > 0 && typeof row.root === 'string' && !roots.includes(row.root)) {
      errors.push(`requirements[${index}].root "${row.root}" is not in meta.roots`)
    }
    if (statuses.length > 0 && typeof row.status === 'string' && !statuses.includes(row.status)) {
      errors.push(`requirements[${index}].status "${row.status}" is not in meta.statuses`)
    }
  })
  return errors
}

/** Count rows by one string field, preserving first-seen order. */
export function countBy(rows, field) {
  const counts = {}
  for (const row of rows) {
    const key = row[field] ?? ''
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** The searchable text of one requirement. */
export function searchable(row) {
  return [row.id, row.title, row.current, row.old, row.note, row.group, row.root]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
}

/**
 * Set one requirement's status in a ledger file.
 * @param path - absolute ledger path.
 * @param id - requirement id.
 * @param status - one key of `meta.statuses`.
 * @returns the applied status.
 */
export async function setStatus(path, id, status) {
  const data = await readLedger(path)
  if (!Array.isArray(data.requirements)) throw new Error('ledger has no requirements array')
  const row = data.requirements.find((item) => item && item.id === id)
  if (!row) throw new Error(`requirement not found: ${id}`)
  const statuses = Object.keys(data.meta?.statuses ?? {})
  if (statuses.length > 0 && !statuses.includes(status)) throw new Error(`unknown status: ${status}`)
  row.status = status
  await writeLedger(path, data)
  return { ok: true, id, status, title: row.title ?? '' }
}

/** Apply one action; returns the JSON-serializable value rendered to the model. */
export async function run(args) {
  const action = String(args.action ?? '').trim()
  const path = ledgerPath(args.path)

  if (action === 'init') {
    const data = skeleton()
    if (typeof args.title === 'string' && args.title.trim()) data.meta.title = args.title.trim()
    if (Array.isArray(args.roots) && args.roots.length > 0) {
      data.meta.roots = args.roots.map((root) => String(root).trim()).filter(Boolean)
    }
    await writeLedger(path, data)
    return { ok: true, action, path, ledger: data }
  }

  const data = await readLedger(path)

  if (action === 'validate') {
    const errors = validateLedger(data)
    return { ok: errors.length === 0, action, path, errors, count: Array.isArray(data.requirements) ? data.requirements.length : 0 }
  }

  if (action === 'summary') {
    const rows = Array.isArray(data.requirements) ? data.requirements : []
    return {
      ok: true,
      action,
      path,
      title: data.meta?.title ?? '',
      date: data.meta?.date ?? '',
      roots: data.meta?.roots ?? [],
      count: rows.length,
      byRoot: countBy(rows, 'root'),
      byStatus: countBy(rows, 'status'),
    }
  }

  if (action === 'search') {
    const query = String(args.query ?? '').trim().toLowerCase()
    if (!query) throw new Error('search requires a non-empty query')
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 8
    const rows = (Array.isArray(data.requirements) ? data.requirements : [])
      .filter((row) => searchable(row).includes(query))
    return { ok: true, action, path, query, total: rows.length, returned: Math.min(rows.length, limit), requirements: rows.slice(0, limit) }
  }

  if (action === 'show') {
    const id = String(args.id ?? '').trim()
    if (!id) throw new Error('show requires id')
    const row = (Array.isArray(data.requirements) ? data.requirements : []).find((item) => item.id === id)
    if (!row) throw new Error(`requirement not found: ${id}`)
    return { ok: true, action, path, requirement: row }
  }

  if (action === 'add') {
    const rows = Array.isArray(data.requirements) ? data.requirements : []
    const row = {}
    for (const field of REQUIRED_FIELDS) {
      const value = args[field]
      if (typeof value !== 'string' || !value.trim()) throw new Error(`add requires ${field}`)
      row[field] = value.trim()
    }
    for (const field of OPTIONAL_FIELDS) {
      row[field] = typeof args[field] === 'string' ? args[field] : ''
    }
    if (rows.some((item) => item.id === row.id)) throw new Error(`duplicate id: ${row.id}`)
    rows.push(row)
    data.requirements = rows
    const errors = validateLedger(data)
    if (errors.length > 0) throw new Error(`ledger is invalid after add: ${errors.join('; ')}`)
    await writeLedger(path, data)
    return { ok: true, action, path, requirement: row, count: rows.length }
  }

  if (action === 'update') {
    const id = String(args.id ?? '').trim()
    if (!id) throw new Error('update requires id')
    const rows = Array.isArray(data.requirements) ? data.requirements : []
    const row = rows.find((item) => item.id === id)
    if (!row) throw new Error(`requirement not found: ${id}`)
    for (const field of ['root', 'group', 'title', 'current', ...OPTIONAL_FIELDS, 'status']) {
      if (typeof args[field] === 'string') row[field] = args[field]
    }
    const errors = validateLedger(data)
    if (errors.length > 0) throw new Error(`ledger is invalid after update: ${errors.join('; ')}`)
    await writeLedger(path, data)
    return { ok: true, action, path, requirement: row, count: rows.length }
  }

  throw new Error(`unknown action: ${action || '(missing)'}`)
}
