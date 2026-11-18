/**
 * 纯逻辑：关键词表读取、技能自动关键词、消息匹配、正文摘要与截断。
 * 本文件不得 import DSH 内核包，便于用普通 Node 做单元测试。
 */
import { readFileSync } from 'node:fs'

/** 英文停用词：技能名分词与描述取词时跳过。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'use', 'when', 'this', 'that', 'from', 'into', 'your',
  'you', 'are', 'not', 'all', 'can', 'may', 'will', 'has', 'have', 'how', 'what',
  'skill', 'skills', 'tool', 'tools', 'task', 'user', 'users', 'then', 'than', 'also',
])

/** 触发词引导语：其后一段文本按分隔符切成关键词。 */
const TRIGGER_HINTS = ['触发词', '触发', 'triggers on', 'trigger', 'use when', 'when to use', '用于', '适用于']

/** 引号包裹的短语（中英文引号）。 */
const QUOTED = /[「“"'『]([^」”"'』]{2,32})[」”"'』]/g

/** 中文片段做关键词时的停用词与开头虚词。 */
const CN_STOP = new Set([
  '用于', '适用于', '支持', '可以', '能够', '需要', '以及', '或者', '例如', '包括',
  '进行', '通过', '使用', '帮助', '提供', '生成', '处理', '这个', '一个', '我们', '你的',
])
const CN_LEAD = /^[用把将在为对给和与或及等能可的了着过]/

/** 中文动作词：从“动词+宾语”的片段里切出真正可说的宾语（如“绘制流程图”→“流程图”）。 */
const CN_VERB = /(?:绘制|画|做|生成|制作|处理|转换|去除|移除|添加|创建|编辑|读取|渲染|导出|导入|压缩|裁剪|缩放|翻译|总结|分析|搜索|安装|配置|修复|调试|测试|部署|打包|发布|上传|下载|删除|重命名|合并|拆分|替换|检查|验证|计算|统计|排序|筛选|过滤|清理|美化|优化|识别|提取|补全|分割|合成)/g

/** 中文虚词 / 量词 / 代词：匹配前删掉，容忍“画个流程图”这类口语插入。 */
const CN_FILLER = /[个的了着过一下这那我你他她它们张条次些点就还要想帮请把给能吗呢吧啊很非常最更]/g

/** 数量词前缀（一张、两个、三次、这份……）：动作词切分后的副产物，不能当技能关键词。 */
const CN_QUANT_PREFIX = /^[一二两三四五六七八九十百千万几半数每这那]+[张个条次些点份套块把只部首篇页行字秒分时天周年月周遍趟下回种样批组件台辆架门槛颗片页]/

function hasChinese(text) {
  return /[\u4e00-\u9fa5]/.test(String(text ?? ''))
}

/** 删掉口语虚词后的中文文本，仅用于匹配比较。 */
function cnNormalize(text) {
  return String(text ?? '').replace(CN_FILLER, '')
}

/** 判断中文片段是否像一个可说的关键词。 */
function cnKeyword(piece) {
  const raw = piece.replace(/[^\u4e00-\u9fa5]/g, '')
  // 「一张图」「这张图」这类带数量词的片段：剥掉前缀再判定，剩下的名词才可能是关键词。
  const cn = raw.replace(CN_QUANT_PREFIX, '')
  if (cn.length < 2 || cn.length > 10) return undefined
  if (CN_STOP.has(cn) || CN_LEAD.test(cn)) return undefined
  return cn
}

/** 读取别名表：{ "<skill-name>": ["关键词", ...] }，以下划线开头的键视为注释。 */
export function readAliases(path) {
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  return Object.entries(parsed)
    .filter(([skill, words]) => !skill.startsWith('_') && Array.isArray(words))
    .map(([skill, words]) => ({
      skill,
      words: words
        .filter((word) => typeof word === 'string' && word.trim() !== '')
        .map((word) => word.toLowerCase()),
    }))
    .filter((entry) => entry.words.length > 0)
}

/** 从技能名拆出英文词：image-watermark-remover -> image / watermark / remover。 */
function nameWords(name) {
  return String(name)
    .toLowerCase()
    .split(/[-_/.\s]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word) && /^[a-z][a-z0-9]*$/.test(word))
}

/** 从描述 / whenToUse 里提取短语：引号内容优先，其次“触发词”引导的列举。 */
function descriptionWords(text) {
  const out = []
  const source = String(text ?? '')
  for (const match of source.matchAll(QUOTED)) out.push(match[1].trim())

  const lower = source.toLowerCase()
  for (const hint of TRIGGER_HINTS) {
    const at = lower.indexOf(hint)
    if (at < 0) continue
    const tail = source.slice(at + hint.length, at + hint.length + 260)
    for (const piece of tail.split(/[,，、;；/|。\n]/)) {
      const word = piece.trim().replace(/^[:：\s-]+/, '')
      if (word.length >= 2 && word.length <= 24) out.push(word)
    }
  }
  for (const match of source.matchAll(/\b([a-z][a-z-]{3,20})\b/gi)) {
    const word = match[1].toLowerCase()
    if (!STOPWORDS.has(word)) out.push(word)
  }
  // 中文短语：按标点切开，短而干净的片段才收（长句由触发词/引号覆盖）。
  for (const piece of source.split(/[,，、;；。\n]+/)) {
    const cleaned = piece.trim().replace(/^[:：\s-]+/, '')
    const keyword = cnKeyword(cleaned)
    if (keyword !== undefined) out.push(keyword)
    // “用原生形状绘制流程图”：整段太长时按动作词切，取宾语部分。
    for (const part of cleaned.split(CN_VERB)) {
      const sub = cnKeyword(part)
      if (sub !== undefined) out.push(sub)
    }
  }
  return out
}

/**
 * 由 ctx.skills.list() 的结果生成自动关键词表——装了新技能无需手工配置即可命中。
 * @param {{name: string, description?: string, whenToUse?: string}[]} catalog
 * @param {{exclude?: string[]}} options
 * @returns {{skill: string, kind: 'auto', words: string[]}[]}
 */
export function buildAutoEntries(catalog, options = {}) {
  const exclude = new Set((options.exclude ?? []).map((name) => String(name).toLowerCase()))
  const entries = []
  for (const skill of catalog ?? []) {
    if (skill === null || typeof skill !== 'object' || typeof skill.name !== 'string') continue
    if (exclude.has(skill.name.toLowerCase())) continue
    const words = new Set([
      ...nameWords(skill.name),
      ...descriptionWords(`${skill.description ?? ''}\n${skill.whenToUse ?? ''}`),
    ])
    const cleaned = [...words]
      .map((word) => word.toLowerCase())
      .filter((word) => word.length >= 2 && word.length <= 32)
    if (cleaned.length > 0) entries.push({ skill: skill.name, kind: 'auto', words: cleaned })
  }
  return entries
}

/** 统一关键词形态：字符串 => 别名权重 10；{word, weight} 原样保留。 */
function normalizeEntries(entries) {
  const out = []
  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.skill !== 'string') continue
    const kind = entry.kind === 'auto' ? 'auto' : 'alias'
    const words = []
    for (const item of entry.words ?? []) {
      if (typeof item === 'string' && item.trim() !== '') words.push({ word: item.toLowerCase(), weight: kind === 'auto' ? 8 : 10 })
      else if (item !== null && typeof item === 'object' && typeof item.word === 'string' && item.word.trim() !== '') {
        words.push({ word: item.word.toLowerCase(), weight: Number.isFinite(item.weight) ? item.weight : 10 })
      }
    }
    if (words.length > 0) out.push({ skill: entry.skill, kind, words })
  }
  return out
}

/**
 * 把用户消息文本与关键词表匹配。
 * score = Σ 命中词权重 + 最长命中词长度；低于 minScore 不采用。
 * @param {string} prompt 用户消息
 * @param {object[]} entries readAliases() / buildAutoEntries() 的结果
 * @param {number} maxSkills 最多返回几个技能
 * @param {number} minScore 分数下限
 * @returns {{skill: string, kind: 'alias'|'auto', score: number, matched: string[]}[]}
 */
export function matchSkills(prompt, entries, maxSkills = 2, minScore = 10) {
  const text = String(prompt).toLowerCase()
  if (text.trim() === '') return []
  const normalized = cnNormalize(text)
  // 同一技能可能同时出现在别名表与自动词表里：合并成一个技能，同词只按最高权重计一次。
  const bySkill = new Map()
  for (const entry of normalizeEntries(entries)) {
    const existing = bySkill.get(entry.skill)
    if (existing === undefined) bySkill.set(entry.skill, { skill: entry.skill, kind: entry.kind, words: new Map(entry.words.map((item) => [item.word, item.weight])) })
    else {
      if (entry.kind === 'alias') existing.kind = 'alias'
      for (const { word, weight } of entry.words) {
        const previous = existing.words.get(word)
        if (previous === undefined || weight > previous) existing.words.set(word, weight)
      }
    }
  }
  const hits = []
  for (const entry of bySkill.values()) {
    let score = 0
    let longest = 0
    const matched = []
    for (const [word, weight] of entry.words) {
      const hit = text.includes(word) || (hasChinese(word) && normalized.includes(cnNormalize(word)))
      if (!hit) continue
      score += weight
      longest = Math.max(longest, word.length)
      matched.push(word)
    }
    if (matched.length === 0) continue
    const total = score + longest
    if (total < minScore) continue
    hits.push({ skill: entry.skill, kind: entry.kind, score: total, matched })
  }
  hits.sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill))
  return hits.slice(0, Math.max(1, Math.trunc(maxSkills)))
}

/** 去掉 YAML frontmatter，只留正文。 */
export function stripFrontmatter(content) {
  const text = String(content ?? '')
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  const after = text.indexOf('\n', end + 4)
  return after < 0 ? '' : text.slice(after + 1)
}

/** 截断到 maxChars，加省略号。 */
function clip(text, maxChars) {
  const value = String(text ?? '').trim()
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 1)}…`
}

/**
 * 生成技能摘要（省 token 的默认注入形态）：用途 + 章节目录 + 首段。
 * 模型按需用 read 打开原文件读取细节，避免每轮背整篇正文。
 */
export function buildDigest(skill, maxChars = 900) {
  const body = stripFrontmatter(skill?.content ?? '')
  const headings = [...body.matchAll(/^(#{1,3})\s+(.+)$/gm)]
    .map((match) => `${match[1]} ${match[2].trim()}`)
    .slice(0, 14)
  const paragraphs = body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('#') && !part.startsWith('```') && !part.startsWith('|'))
  const lead = paragraphs.length > 0 ? clip(paragraphs[0], 260) : ''

  const lines = [`技能：${skill?.name ?? ''}`]
  if (skill?.description) lines.push(`用途：${clip(skill.description, 200)}`)
  if (headings.length > 0) {
    lines.push('章节：')
    for (const heading of headings) lines.push(`- ${heading}`)
  }
  if (lead !== '') lines.push('', lead)
  return clip(lines.join('\n'), maxChars)
}

/** 按上限截断技能正文，保留可识别的前缀与截断说明。 */
export function truncateBody(content, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || content.length <= maxChars) return content
  return `${content.slice(0, Math.trunc(maxChars))}\n\n…（正文超出 ${Math.trunc(maxChars)} 字符已截断；需要完整内容请调用 skill 工具）`
}

// ── 勾选状态（右侧栏面板 / 未勾选时询问） ────────────────────────────────

/** 状态文件格式版本。 */
export const STATE_VERSION = 1

/** 同一技能的询问冷却时间：24 小时。 */
export const DEFAULT_ASK_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * 规范状态对象。
 * enabled === null 表示“全部启用”（尚未做过任何勾选），[] 表示“全部禁用”。
 * @param {unknown} raw 磁盘上的 JSON 或 undefined
 * @returns {{version: number, enabled: string[]|null, dismissed: Record<string, number>, updatedAt: number}}
 */
export function normalizeState(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const enabled = Array.isArray(value.enabled)
    ? [...new Set(value.enabled.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim()))]
    : null
  const dismissed = {}
  if (value.dismissed !== null && typeof value.dismissed === 'object' && !Array.isArray(value.dismissed)) {
    for (const [name, at] of Object.entries(value.dismissed)) {
      if (typeof name === 'string' && Number.isFinite(at)) dismissed[name] = at
    }
  }
  return {
    version: STATE_VERSION,
    enabled,
    dismissed,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  }
}

/**
 * 由当前技能目录 + 状态算出“已勾选”的技能名集合（小写比较）。
 * 状态里已卸载的技能自动忽略。
 * @param {string[]} catalogNames 当前可用技能名
 * @param {object} state normalizeState() 的结果
 * @returns {Set<string>}
 */
export function resolveEnabled(catalogNames, state) {
  const all = (catalogNames ?? []).map((name) => String(name).toLowerCase())
  if (state?.enabled === null || state?.enabled === undefined) return new Set(all)
  const allowed = new Set(all)
  return new Set(state.enabled.map((name) => String(name).toLowerCase()).filter((name) => allowed.has(name)))
}

/**
 * 把命中拆成“已勾选（直接注入）”与“未勾选（需要询问）”两组。
 * @param {{skill: string}[]} hits matchSkills() 的结果
 * @param {Set<string>} enabledSet resolveEnabled() 的结果
 * @returns {{active: object[], pending: object[]}}
 */
export function splitHits(hits, enabledSet) {
  const active = []
  const pending = []
  for (const hit of hits ?? []) {
    if (enabledSet.has(String(hit.skill).toLowerCase())) active.push(hit)
    else pending.push(hit)
  }
  return { active, pending }
}

/**
 * 该技能是否该再次询问（冷却期内不重复打扰）。
 * @param {string} skillName 技能名
 * @param {object} state normalizeState() 的结果
 * @param {number} now 当前时间戳
 * @param {number} cooldownMs 冷却毫秒
 * @returns {boolean}
 */
export function shouldAsk(skillName, state, now = Date.now(), cooldownMs = DEFAULT_ASK_COOLDOWN_MS) {
  const last = state?.dismissed?.[skillName]
  return !(Number.isFinite(last) && now - last < cooldownMs)
}

/**
 * 把状态里的 enabled 集合落成“目录里的原名”，避免大小写错位。
 * @param {string[]} catalogNames
 * @param {Set<string>} set 小写名字集合
 * @returns {string[]}
 */
function canonicalNames(catalogNames, set) {
  const names = (catalogNames ?? []).map((name) => String(name))
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]))
  return [...set].map((name) => byLower.get(String(name).toLowerCase()) ?? String(name))
}

/**
 * 勾选 / 取消勾选一个技能。
 * @param {object} state normalizeState() 的结果
 * @param {string[]} catalogNames 当前可用技能名
 * @param {string} skillName 目标技能
 * @param {boolean} enabled true = 勾选（允许自动加载），false = 取消
 * @param {number} now 时间戳
 * @returns {object} 新状态
 */
export function setSkillEnabled(state, catalogNames, skillName, enabled, now = Date.now()) {
  const current = normalizeState(state)
  const set = resolveEnabled(catalogNames, current)
  const key = String(skillName).toLowerCase()
  if (enabled) set.add(key)
  else set.delete(key)
  const dismissed = { ...current.dismissed }
  delete dismissed[skillName]
  return {
    version: STATE_VERSION,
    enabled: canonicalNames(catalogNames, set),
    dismissed,
    updatedAt: now,
  }
}

/**
 * 全部启用 / 全部禁用。
 * @param {object} state normalizeState() 的结果
 * @param {boolean} enabled true = 全部启用（enabled 记为 null）
 * @param {number} now 时间戳
 * @returns {object} 新状态
 */
export function setAllEnabled(state, enabled, now = Date.now()) {
  const current = normalizeState(state)
  return {
    version: STATE_VERSION,
    enabled: enabled ? null : [],
    dismissed: enabled ? {} : { ...current.dismissed },
    updatedAt: now,
  }
}

/**
 * 记录一次“已询问”，用于冷却。
 * @param {object} state normalizeState() 的结果
 * @param {string[]} skillNames 本次询问的技能
 * @param {number} now 时间戳
 * @returns {object} 新状态
 */
export function markAsked(state, skillNames, now = Date.now()) {
  const current = normalizeState(state)
  const dismissed = { ...current.dismissed }
  for (const name of skillNames ?? []) dismissed[String(name)] = now
  return { ...current, dismissed, updatedAt: now }
}

/**
 * 生成“命中未勾选技能”的询问提示正文。
 * @param {{skill: string, matched: string[]}[]} pending
 * @param {{max?: number}} options
 * @returns {string}
 */
export function buildAskText(pending, options = {}) {
  const max = Math.max(1, Math.trunc(options.max ?? 3))
  const items = (pending ?? []).slice(0, max).map((hit) => {
    const words = (hit.matched ?? []).slice(0, 3).join('、')
    return `「${hit.skill}」${words === '' ? '' : `（命中词：${words}）`}`
  })
  if (items.length === 0) return ''
  const omitted = (pending ?? []).length > items.length ? `，另有 ${(pending ?? []).length - items.length} 个技能未列出` : ''
  return [
    '<system-reminder>',
    `skill-autoload 发现本轮消息命中了未勾选的技能：${items.join('、')}${omitted}。`,
    '如果其中一个与用户当前任务明显相关，请在开始工作前用 ask_user_question 询问用户是否启用该技能的自动加载；',
    '用户同意后调用工具 skill_autoload（action: "enable", name: "<技能名>"），或请用户到右侧栏「技能自动加载」面板勾选。',
    '若与本轮任务无关，直接忽略本条，不要向用户提及。',
    '</system-reminder>',
  ].join('\n')
}

/**
 * 给右侧栏面板 / HTTP GET 用的快照。
 * @param {{name: string, description?: string, whenToUse?: string, path?: string}[]} catalog
 * @param {object} state normalizeState() 的结果
 * @returns {{version: number, allEnabled: boolean, updatedAt: number, skills: object[]}}
 */
export function stateSnapshot(catalog, state) {
  const current = normalizeState(state)
  const names = (catalog ?? []).map((skill) => skill.name)
  const enabledSet = resolveEnabled(names, current)
  return {
    version: current.version,
    allEnabled: current.enabled === null,
    updatedAt: current.updatedAt,
    skills: (catalog ?? []).map((skill) => ({
      name: skill.name,
      description: String(skill.description ?? ''),
      whenToUse: String(skill.whenToUse ?? ''),
      path: String(skill.path ?? ''),
      enabled: enabledSet.has(String(skill.name).toLowerCase()),
    })),
  }
}