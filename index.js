/**
 * skill-autoload —— 按用户消息自动加载匹配技能的说明，无需触发词。
 *
 * 监听 agent/pre-step，在模型看到这一步之前追加一条 user 消息，
 * 内容是命中技能的正文（或摘要），source.kind = "skill-invocation"。
 *
 * 关键词来源：
 *   1. 技能名 / description / whenToUse 自动抽取（装新技能即生效）；
 *   2. 可选别名表 JSON，用于给中文技能补口语化触发词。
 *
 * 勾选控制：
 *   - 状态文件记录用户勾选了哪些技能可自动加载（默认全部启用）；
 *   - 命中未勾选的技能时，按 24h 冷却注入一条询问提示，让模型问用户；
 *   - 右侧栏面板通过 /skill-autoload/state 读写同一状态；
 *   - 模型也可用 skill_autoload 工具读写。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import Schema from '@deepseek-ai/schemastery'

import {
  DEFAULT_ASK_COOLDOWN_MS,
  buildAskText,
  buildAutoEntries,
  buildDigest,
  markAsked,
  matchSkills,
  normalizeState,
  readAliases,
  resolveEnabled,
  setAllEnabled,
  setSkillEnabled,
  shouldAsk,
  splitHits,
  stateSnapshot,
  truncateBody,
} from './logic.js'

export const name = 'skill-autoload'
export const inject = ['agents', 'skills', 'workingDirectory']

const DEFAULT_MAX_SKILLS = 1
const DEFAULT_MIN_SCORE = 10
const DEFAULT_AUTO_MIN_SCORE = 10
const DEFAULT_DIGEST_CHARS = 900
const DEFAULT_FULL_MAX_CHARS = 12000
const DEFAULT_FULL_THRESHOLD = 1500
const DEFAULT_LOG_PATH = ''
const DEFAULT_WEB_PREFIX = '/skill-autoload'
/** 代码修订标记：写进 apply 日志，便于确认 HMR 是否加载到最新代码。 */
const CODE_REV = 'r3'
const CATALOG_TTL_MS = 60_000
const MAX_ASK_SKILLS = 3

export const Config = Schema.object({
  /** 别名表：{ "<技能名>": ["关键词", ...] }，下划线开头的键视为注释。 */
  aliasesPath: Schema.string().default(''),
  /** auto = 短技能注入全文、长技能注入摘要；digest = 一律摘要；full = 一律全文。 */
  mode: Schema.union(['auto', 'digest', 'full']).default('auto'),
  /** 每轮最多注入几个技能。 */
  maxSkills: Schema.number().default(DEFAULT_MAX_SKILLS),
  /** digest 摘要的目标字符数。 */
  digestChars: Schema.number().default(DEFAULT_DIGEST_CHARS),
  /** full 模式与 auto 模式短技能的正文上限。 */
  maxBodyChars: Schema.number().default(DEFAULT_FULL_MAX_CHARS),
  /** auto 模式下正文不超过该长度就注入全文，否则注入摘要。 */
  fullThreshold: Schema.number().default(DEFAULT_FULL_THRESHOLD),
  /** 任何命中的最低分。 */
  minScore: Schema.number().default(DEFAULT_MIN_SCORE),
  /** 自动关键词（非别名）命中的最低分，防止误触发。 */
  autoMinScore: Schema.number().default(DEFAULT_AUTO_MIN_SCORE),
  /** 自动关键词总开关：关闭后只认别名表。 */
  autoKeywords: Schema.boolean().default(true),
  /** 不参与自动加载的技能名。 */
  exclude: Schema.array(Schema.string()).default([]),
  /** 日志文件；空串表示不写日志。 */
  logPath: Schema.string().default(DEFAULT_LOG_PATH),
  /** 状态文件路径；空串表示 <dshHome>/skill-autoload/state.json。 */
  statePath: Schema.string().default(''),
  /** 命中未勾选技能时是否注入询问提示。 */
  askOnUnchecked: Schema.boolean().default(true),
  /** 同一技能的询问冷却毫秒。 */
  askCooldownMs: Schema.number().default(DEFAULT_ASK_COOLDOWN_MS),
  /** 右侧栏面板读取状态的 HTTP 前缀；空串表示不注册路由。 */
  webServerPrefix: Schema.string().default(DEFAULT_WEB_PREFIX),
})

/** 追加一行 JSON 日志；任何异常都吞掉，日志不能影响会话。 */
function logLine(logPath, data) {
  if (logPath === '') return
  try {
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...data })}\n`, 'utf8')
  } catch {
    // 忽略
  }
}

/** 从本步消息里取用户输入文本（合并多条 text part）。 */
function userPromptText(messages) {
  const parts = []
  for (const message of messages ?? []) {
    if (message?.source?.kind !== 'user') continue
    for (const part of message.content ?? []) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('\n')
}

/** 该技能是否已在本步 messages 里显式出现（如用户手动 /name）。 */
function alreadyPresent(messages, name) {
  for (const message of messages ?? []) {
    const source = message?.source
    if (source?.kind === 'skill-invocation' && source.name === name) return true
  }
  return false
}

/**
 * 该技能是否已经在会话可见历史里注入过。
 * 上下文压缩后这段历史会被隐藏，此时允许重新注入。
 */
function visibleInjected(agent, name) {
  try {
    const session = agent?.session
    if (session === undefined) return false
    const visible = new Set(session.surface?.nodes ?? [])
    for (let index = session.seq - 1; index >= 0; index -= 1) {
      const event = session.eventAt(SessionSeq(index))
      if (event === undefined) break
      if (event.type !== 'user/message') continue
      const source = event.data?.source
      if (source?.kind === 'skill-invocation' && source.name === name && visible.has(event.seq)) return true
    }
  } catch {
    // 结构变化时保守返回 false，宁可重复注入也不丢技能
  }
  return false
}

/** 注入正文：说明来源与用法，再拼技能内容。 */
function injectionText(skill, hit, body, form, path) {
  const modeHint = form === 'digest'
    ? `以下是该技能的摘要（章节 + 首段）。需要细节时用 read 打开 ${path ?? '对应技能文件'}，或调用 skill 工具加载完整正文。`
    : '以下是该技能的说明正文，请直接按它执行，不必再调用 skill 工具。'
  return [
    '<system-reminder>',
    `skill-autoload 根据你的消息自动匹配到技能「${skill.name}」（命中词：${hit.matched.join('、')}；匹配方式：${hit.kind === 'alias' ? '别名表' : '自动关键词'}）。`,
    modeHint,
    '如果与本轮任务无关，请忽略下面的技能内容。',
    '',
    body,
    '</system-reminder>',
  ].join('\n')
}

/** 发一个 JSON 响应。 */
function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {
      // 忽略
    }
  }
}

/** 只接受同源请求（浏览器面板）；无 Origin 的本地请求（curl）放行。 */
function sameOrigin(request) {
  const origin = request?.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    const parsed = new URL(origin)
    const host = String(request?.headers?.host ?? '')
    return host === '' || parsed.host === host
  } catch {
    return false
  }
}

/** 读取 JSON 请求体（上限 64 KiB）。 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        try {
          request.destroy()
        } catch {
          // 忽略
        }
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

export function apply(ctx, config) {
  const aliasesPath = config.aliasesPath ?? ''
  const mode = config.mode ?? 'auto'
  const maxSkills = Math.max(1, Math.trunc(config.maxSkills ?? DEFAULT_MAX_SKILLS))
  const digestChars = Math.max(200, Math.trunc(config.digestChars ?? DEFAULT_DIGEST_CHARS))
  const maxBodyChars = Math.max(500, Math.trunc(config.maxBodyChars ?? DEFAULT_FULL_MAX_CHARS))
  const fullThreshold = Math.max(0, Math.trunc(config.fullThreshold ?? DEFAULT_FULL_THRESHOLD))
  const minScore = config.minScore ?? DEFAULT_MIN_SCORE
  const autoMinScore = config.autoMinScore ?? DEFAULT_AUTO_MIN_SCORE
  const exclude = new Set((config.exclude ?? []).map((item) => String(item).toLowerCase()))
  const logPath = config.logPath ?? DEFAULT_LOG_PATH
  const askOnUnchecked = config.askOnUnchecked !== false
  const askCooldownMs = Math.max(60_000, Math.trunc(config.askCooldownMs ?? DEFAULT_ASK_COOLDOWN_MS))
  const webPrefixRaw = String(config.webServerPrefix ?? DEFAULT_WEB_PREFIX).trim()
  const webPrefix = webPrefixRaw === '' ? '' : (webPrefixRaw.startsWith('/') ? webPrefixRaw : `/${webPrefixRaw}`)
  const statePathRaw = String(config.statePath ?? '').trim()
  const statePath = statePathRaw !== '' ? statePathRaw : join(homedir(), '.dsh', 'skill-autoload', 'state.json')

  logLine(logPath, {
    event: 'apply',
    aliasesPath,
    mode,
    maxSkills,
    digestChars,
    maxBodyChars,
    minScore,
    autoMinScore,
    statePath,
    askOnUnchecked,
    webPrefix,
    code: CODE_REV,
  })

  /** 别名表按 mtime 缓存，改文件即生效。 */
  let aliasCache = { mtime: -1, entries: [] }
  function loadAliasEntries() {
    if (aliasesPath === '') return []
    try {
      const mtime = statSync(aliasesPath).mtimeMs
      if (aliasCache.mtime !== mtime) aliasCache = { mtime, entries: readAliases(aliasesPath) }
      return aliasCache.entries
    } catch (error) {
      logLine(logPath, { event: 'error', stage: 'aliases', message: String(error) })
      return []
    }
  }

  /** 技能目录按工作目录缓存，避免每步都枚举。 */
  const catalogCache = new Map()
  async function listSkills(cwd, signal, agent) {
    const key = cwd ?? ''
    const cached = catalogCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.items
    const items = await ctx.skills.list({ cwd, signal, scope: agent })
    const filtered = (items ?? []).filter((item) => isModelInvocable(item))
    catalogCache.set(key, { at: Date.now(), items: filtered })
    return filtered
  }

  // ── 勾选状态 ────────────────────────────────────────────────────────────
  let stateCache = { mtime: -1, state: normalizeState(null) }
  function loadState() {
    try {
      const mtime = statSync(statePath).mtimeMs
      if (stateCache.mtime === mtime) return stateCache.state
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      stateCache = { mtime, state: normalizeState(parsed) }
      return stateCache.state
    } catch (error) {
      if (error?.code === 'ENOENT') {
        stateCache = { mtime: -1, state: normalizeState(null) }
        return stateCache.state
      }
      logLine(logPath, { event: 'error', stage: 'state-read', message: String(error) })
      return stateCache.state
    }
  }

  function saveState(next) {
    const state = normalizeState(next)
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      const tmp = `${statePath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(tmp, statePath)
      try {
        stateCache = { mtime: statSync(statePath).mtimeMs, state }
      } catch {
        stateCache = { mtime: -1, state }
      }
      logLine(logPath, { event: 'state-save', enabled: state.enabled, allEnabled: state.enabled === null })
      return state
    } catch (error) {
      logLine(logPath, { event: 'error', stage: 'state-write', message: String(error) })
      return state
    }
  }

  /** 最近一次 pre-step 的 agent 与 cwd：面板/工具没有 session 上下文时借它取技能列表。 */
  let lastView = { agent: undefined, cwd: undefined }

  /** 用户技能注册在 agent 作用域层；没有活跃 agent 时只能看到全局层的内置技能。 */
  function pickScope() {
    if (lastView.agent !== undefined) return lastView.agent
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const agents = typeof registry?.list === 'function' ? registry.list() : []
      return agents.length > 0 ? agents[agents.length - 1] : undefined
    } catch {
      return undefined
    }
  }

  /** HTTP / 工具共用的完整技能列表（不带 scope 只能看到全局层的内置技能）。 */
  async function listForUi() {
    try {
      const cwd = lastView.cwd ?? process.cwd()
      const scope = pickScope()
      const items = scope === undefined
        ? await ctx.skills.list({ cwd })
        : await ctx.skills.list({ cwd, scope })
      return (items ?? []).filter((item) => isModelInvocable(item))
    } catch (error) {
      logLine(logPath, { event: 'error', stage: 'list-ui', message: String(error) })
      return []
    }
  }

  async function snapshot() {
    const catalog = await listForUi()
    return { catalog, view: stateSnapshot(catalog, loadState()) }
  }

  // ── HTTP：右侧栏面板读写状态 ────────────────────────────────────────────
  // webServer 可能晚于本插件就绪（尤其完整重启后）：用 reactive inject 等它就绪再注册，
  // 否则 ctx.get('webServer') 为空会静默丢掉面板路由（面板报 Unexpected end of JSON input）。
  if (webPrefix !== '') {
    ctx.inject(['webServer'], (httpCtx) => {
      const webServer = httpCtx.webServer ?? (typeof httpCtx.get === 'function' ? httpCtx.get('webServer') : undefined)
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
      const handler = async (request, response) => {
        try {
          if (!sameOrigin(request)) return sendJson(response, 403, { ok: false, error: 'forbidden' })
          const method = String(request?.method ?? 'GET').toUpperCase()
          const url = new URL(String(request?.url ?? '/'), 'http://localhost')
          const rest = url.pathname.startsWith(webPrefix)
            ? url.pathname.slice(webPrefix.length) || '/'
            : url.pathname

          if (rest === '/state' && method === 'GET') {
            const { view } = await snapshot()
            return sendJson(response, 200, { ok: true, ...view })
          }

          if (rest === '/state' && method === 'POST') {
            let body
            try {
              body = await readBody(request)
            } catch {
              return sendJson(response, 400, { ok: false, error: 'bad json' })
            }
            const catalog = await listForUi()
            const names = catalog.map((skill) => skill.name)
            const byLower = new Map(names.map((name) => [name.toLowerCase(), name]))
            let state = loadState()

            if (body !== null && typeof body === 'object' && typeof body.all === 'boolean') {
              state = setAllEnabled(state, body.all)
            } else if (body !== null && typeof body === 'object' && Array.isArray(body.enabled)) {
              const picked = []
              for (const raw of body.enabled) {
                const name = byLower.get(String(raw).toLowerCase())
                if (name !== undefined && !picked.includes(name)) picked.push(name)
              }
              state = normalizeState({ enabled: picked, dismissed: state.dismissed, updatedAt: Date.now() })
            } else if (body !== null && typeof body === 'object' && typeof body.name === 'string') {
              if (typeof body.enabled !== 'boolean') return sendJson(response, 400, { ok: false, error: 'enabled required' })
              const name = byLower.get(body.name.toLowerCase())
              if (name === undefined) return sendJson(response, 400, { ok: false, error: 'unknown skill', name: body.name })
              state = setSkillEnabled(state, names, name, body.enabled)
            } else {
              return sendJson(response, 400, { ok: false, error: 'nothing to change' })
            }

            state = saveState(state)
            return sendJson(response, 200, { ok: true, ...stateSnapshot(catalog, state) })
          }

          return sendJson(response, 404, { ok: false, error: 'no route' })
        } catch (error) {
          logLine(logPath, { event: 'error', stage: 'web', message: String(error) })
          return sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
        }
      }
      httpCtx.effect(() => {
        const dispose = webServer.register({ kind: 'prefix', path: webPrefix, handler })
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, 'skill-autoload: state routes')
    })
  }

  // ── 工具：模型读写勾选状态 ──────────────────────────────────────────────
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.tools ?? (typeof toolCtx.get === 'function' ? toolCtx.get('tools') : undefined)
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return
    toolCtx.effect(() => {
      const dispose = tools.register(
        {
          name: 'skill_autoload',
          description:
            'Read or change which installed skills skill-autoload may inject automatically. '
            + 'Use action "list" to see every skill and whether it is enabled; '
            + '"enable"/"disable" with a skill name; "enable_all"/"disable_all" for everything. '
            + 'Call this after the user agrees to enable a skill that was matched but not checked.',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['list', 'enable', 'disable', 'enable_all', 'disable_all'],
                description: 'list shows the current selection; enable/disable need "name".',
              },
              name: { type: 'string', description: 'Exact installed skill name for enable/disable.' },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' }, allEnabled: { type: 'boolean' }, enabled: { type: 'array', items: { type: 'string' } } },
              additionalProperties: true,
            },
            render: (args) => [{ type: 'text', text: `skill_autoload: ${args?.ok === true ? 'ok' : 'failed'}` }],
          },
          async execute(args) {
            const action = String(args?.action ?? 'list')
            const catalog = await listForUi()
            const names = catalog.map((skill) => skill.name)
            let state = loadState()
            if (action === 'enable' || action === 'disable') {
              const name = String(args?.name ?? '').trim()
              if (name === '') return { ok: false, error: 'name required' }
              const known = names.find((item) => item.toLowerCase() === name.toLowerCase())
              if (known === undefined) return { ok: false, error: 'unknown skill', name }
              state = saveState(setSkillEnabled(state, names, known, action === 'enable'))
            } else if (action === 'enable_all' || action === 'disable_all') {
              state = saveState(setAllEnabled(state, action === 'enable_all'))
            }
            const view = stateSnapshot(catalog, state)
            return {
              ok: true,
              allEnabled: view.allEnabled,
              enabled: view.skills.filter((skill) => skill.enabled).map((skill) => skill.name),
              skills: view.skills.map((skill) => ({ name: skill.name, enabled: skill.enabled })),
            }
          },
        },
        {},
      )
      return typeof dispose === 'function' ? dispose : () => {}
    }, 'skill-autoload: state tool')
  })

  // ── 主流程：pre-step 匹配并注入 ─────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision === undefined || decision.kind === 'reject') return decision

    let prompt = ''
    let hits = []
    let catalog = []
    let cwd
    try {
      prompt = userPromptText(messages)
      if (prompt.trim() === '') return decision
      cwd = await ctx.workingDirectory.ensure(agent, signal)
      signal.throwIfAborted()
      catalog = await listSkills(cwd, signal, agent)
      lastView = { agent, cwd }
      const aliases = loadAliasEntries()
      const auto = config.autoKeywords === false ? [] : buildAutoEntries(catalog, { exclude: [...exclude] })
      const all = [...aliases, ...auto]
      if (all.length === 0) return decision
      hits = matchSkills(prompt, all, maxSkills * 2, minScore).filter(
        (hit) => hit.kind === 'alias' || hit.score >= autoMinScore,
      )
      logLine(logPath, {
        event: 'seen',
        length: prompt.length,
        catalog: catalog.length,
        hits: hits.map((hit) => `${hit.skill}:${hit.kind}:${hit.score}`),
        prompt: prompt.slice(0, 120),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      logLine(logPath, { event: 'error', stage: 'match', message: String(error) })
      return decision
    }
    if (hits.length === 0) return decision

    try {
      const state = loadState()
      const enabledSet = resolveEnabled(catalog.map((skill) => skill.name), state)
      const { active, pending } = splitHits(hits, enabledSet)
      logLine(logPath, {
        event: 'split',
        active: active.map((hit) => hit.skill),
        pending: pending.map((hit) => hit.skill),
        allEnabled: state.enabled === null,
      })

      const lookup = { cwd, signal, scope: agent }
      const injections = []
      for (const hit of active.slice(0, maxSkills)) {
        if (alreadyPresent(decision.messages, hit.skill)) continue
        if (visibleInjected(agent, hit.skill)) continue
        const skill = await ctx.skills.get(hit.skill, lookup)
        signal.throwIfAborted()
        if (skill === undefined || !isModelInvocable(skill)) continue

        const full = mode === 'full' || (mode === 'auto' && skill.content.length <= fullThreshold)
        const body = full
          ? truncateBody(skill.content ?? '', maxBodyChars)
          : buildDigest(skill, digestChars)
        const form = full ? 'full' : 'digest'
        logLine(logPath, { event: 'inject', skill: skill.name, form, chars: body.length, score: hit.score })
        injections.push(createUserMessage({
          content: [{ type: 'text', text: injectionText(skill, hit, body, form, skill.path) }],
          source: { kind: 'skill-invocation', name: skill.name, form: 'instructions' },
        }))
      }

      // 未勾选的命中：按冷却注一条询问提示，让模型自己问用户。
      let askedNames = []
      if (askOnUnchecked && pending.length > 0) {
        const now = Date.now()
        const askable = pending.filter((hit) => shouldAsk(hit.skill, state, now, askCooldownMs)).slice(0, MAX_ASK_SKILLS)
        const askText = buildAskText(askable)
        if (askText !== '') {
          injections.push(createUserMessage({
            content: [{ type: 'text', text: askText }],
            source: { kind: 'skill-invocation', name: '__skill_autoload_ask__', form: 'instructions' },
          }))
          askedNames = askable.map((hit) => hit.skill)
          logLine(logPath, { event: 'ask', skills: askedNames })
        }
      }

      if (injections.length === 0) return decision
      if (askedNames.length > 0) saveState(markAsked(loadState(), askedNames))
      return { ...decision, messages: [...decision.messages, ...injections] }
    } catch (error) {
      if (signal?.aborted) throw error
      logLine(logPath, { event: 'error', stage: 'inject', message: String(error) })
      return decision
    }
  })
}