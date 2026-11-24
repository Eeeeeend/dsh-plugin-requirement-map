/**
 * Host half of dsh-plugin-requirement-map.
 *
 * Registers one model-facing tool, `requirement_map`, over a JSON ledger file
 * (`*.reqmap.json`), plus the background generation routes the browser page
 * calls to build a ledger without starting a Session turn.
 *
 * Generation is a Host-side job keyed by Session: starting it returns
 * immediately, a status route reports progress, and a cancel route pauses it.
 * Switching Session in the browser therefore neither cancels nor loses it.
 *
 * Actions: init, validate, summary, search, show, add, update.
 * Paths resolve against the Host process working directory, so pass an absolute
 * path when the session workspace differs from it.
 *
 * This entry declares the tool with plain JSON Schema instead of importing
 * `defineTool`, so a local directory bundle resolves nothing from the dsh
 * installation.
 */
import { resolve } from 'node:path'
import { run, setStatus } from './ledger.js'
import { cancelGeneration, generationStatus, listProjects, resolveWorkspaceRoot, startGeneration } from './generate.js'

/** JSON Schema for the tool's arguments. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      description: 'One of: init, validate, summary, search, show, add, update.',
    },
    path: {
      type: 'string',
      description: 'Path to the *.reqmap.json ledger; relative paths resolve against the Host working directory.',
    },
    query: { type: 'string', description: 'Search keyword for action=search.' },
    limit: { type: 'integer', description: 'Maximum results for action=search (default 8).' },
    id: { type: 'string', description: 'Requirement ID for action=show/update, or the new ID for action=add.' },
    root: { type: 'string', description: 'Top-level branch for action=add/update.' },
    group: { type: 'string', description: 'Group inside the branch for action=add/update.' },
    title: { type: 'string', description: 'Short requirement title for action=add/update, or the ledger title for action=init.' },
    current: { type: 'string', description: 'Current (authoritative) requirement text.' },
    old: { type: 'string', description: 'Replaced/historical requirement text; keep it for traceability.' },
    status: { type: 'string', description: 'One of the keys in meta.statuses.' },
    source: { type: 'string', description: 'Evidence path or user instruction this requirement comes from.' },
    note: { type: 'string', description: 'Boundary, open question, or remaining work.' },
  },
  required: ['action', 'path'],
}

/** The tool definition consumed by `ctx.tools.register`. */
const DEFINITION = {
  name: 'requirement_map',
  description:
    'Read and maintain a project requirement mind-map ledger (a *.reqmap.json file). '
    + 'The ledger is the single source of truth: meta (title/date/branch/head/scope/statuses/roots) '
    + 'plus requirements[] (id/root/group/title/current/old/status/source/note). '
    + 'The DSH Web UI renders the same file as an interactive mind map.',
  parameters: PARAMETERS,
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute(args) {
    const value = await run(args)
    return JSON.stringify(value, null, 2)
  },
}

/** Largest accepted request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read one request body as UTF-8 text, refusing an oversized body. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse one JSON request body, or undefined when it is not an object. */
async function readJsonBody(req) {
  try {
    const value = JSON.parse(await readBody(req))
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/** The project selection a request names in its query string. */
function projectOf(url) {
  try {
    return new URL(url ?? '/', 'http://localhost').searchParams.get('project') ?? ''
  } catch {
    return ''
  }
}

/** The Session id a request names, from its body or query string. */
function sessionIdOf(body, url) {
  const fromBody = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (fromBody) return fromBody
  try {
    return new URL(url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
  } catch {
    return ''
  }
}

/** Services this plugin needs before it activates. */
export const inject = ['tools']

/** Host plugin body. */
export function apply(ctx) {
  ctx.tools.register(DEFINITION)

  // Background generation routes. Raw handlers are required because the
  // resource form only answers GET and HEAD.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/requirement-map/generate',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, error: 'invalid request body' })
          return
        }
        try {
          const result = startGeneration(scope, {
            sessionId: sessionIdOf(body, req.url),
            path: typeof body.path === 'string' ? body.path : '',
            project: typeof body.project === 'string' ? body.project : '',
          })
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'requirement-map: generate route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/requirement-map/status',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, error: 'invalid request body' })
          return
        }
        try {
          const root = await resolveWorkspaceRoot(scope, body.sessionId)
          const target = resolve(root, String(body.path ?? ''))
          if (target !== root && !target.startsWith(root + '/')) {
            throw new Error('ledger path is outside the workspace')
          }
          sendJson(res, 200, await setStatus(target, String(body.id ?? ''), String(body.status ?? '')))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'requirement-map: status route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/requirement-map/generate/projects',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        try {
          const result = await listProjects(scope, { sessionId: sessionIdOf(undefined, req.url) })
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'requirement-map: projects route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/requirement-map/generate/status',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        sendJson(res, 200, generationStatus(sessionIdOf(undefined, req.url), projectOf(req.url)))
      },
    }), 'requirement-map: generate status route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/requirement-map/generate/cancel',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, error: 'invalid request body' })
          return
        }
        sendJson(res, 200, cancelGeneration(
          sessionIdOf(body, req.url),
          typeof body.project === 'string' ? body.project : projectOf(req.url),
        ))
      },
    }), 'requirement-map: generate cancel route')
  })
}
