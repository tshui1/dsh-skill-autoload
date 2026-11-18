/**
 * 单元测试：node --test test-logic.mjs
 * 只覆盖纯逻辑（logic.js），不加载 DSH 内核。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAskText,
  buildAutoEntries,
  buildDigest,
  markAsked,
  matchSkills,
  normalizeState,
  resolveEnabled,
  setAllEnabled,
  setSkillEnabled,
  shouldAsk,
  splitHits,
  stateSnapshot,
  stripFrontmatter,
  truncateBody,
} from './logic.js'

const CATALOG = [
  {
    name: 'pptx-diagram',
    description: '用 PowerPoint 原生形状绘制流程图、示意图。触发词：画图、流程图、示意图、一图流。',
  },
  {
    name: 'image-watermark-remover',
    description: 'Remove watermark logos from images. Triggers on: 去水印, 去除水印, watermark.',
  },
  {
    name: 'grill-me',
    description: 'Interview the user relentlessly about a plan. Use when user mentions "grill me".',
  },
]

test('buildAutoEntries 从名称与描述提取关键词', () => {
  const entries = buildAutoEntries(CATALOG)
  const names = entries.map((entry) => entry.skill)
  assert.deepEqual(names.sort(), ['grill-me', 'image-watermark-remover', 'pptx-diagram'])

  const pptx = entries.find((entry) => entry.skill === 'pptx-diagram')
  assert.ok(pptx.words.includes('流程图'))
  assert.ok(pptx.words.includes('画图'))

  const image = entries.find((entry) => entry.skill === 'image-watermark-remover')
  assert.ok(image.words.includes('watermark'))
  assert.ok(image.words.includes('image'))
})

test('buildAutoEntries 遵守 exclude', () => {
  const entries = buildAutoEntries(CATALOG, { exclude: ['grill-me'] })
  assert.equal(entries.some((entry) => entry.skill === 'grill-me'), false)
})

test('matchSkills 命中自动关键词', () => {
  const entries = buildAutoEntries(CATALOG)
  const hits = matchSkills('帮我画个流程图说明机制', entries, 2, 10)
  assert.equal(hits[0].skill, 'pptx-diagram')
  assert.equal(hits[0].kind, 'auto')
  assert.ok(hits[0].score >= 10)
})

test('matchSkills 别名词权重更高，压过自动词', () => {
  const auto = buildAutoEntries([{ name: 'grill-me', description: 'grill me' }])
  const alias = [{ skill: 'grill-me', words: ['拷问', 'grill me'] }]
  const aliasHit = matchSkills('grill me 一下这个方案', [...auto, ...alias], 1, 10)[0]
  assert.equal(aliasHit.kind, 'alias')
})

test('matchSkills 无命中返回空数组', () => {
  const entries = buildAutoEntries(CATALOG)
  assert.deepEqual(matchSkills('今天天气怎么样', entries, 1, 10), [])
})

test('matchSkills 按分数取前 N 个', () => {
  const entries = [
    { skill: 'a', words: ['甲', '乙', '丙'] },
    { skill: 'b', words: ['甲'] },
  ]
  const hits = matchSkills('甲乙丙', entries, 1, 10)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].skill, 'a')
})

test('stripFrontmatter 去掉 YAML 头', () => {
  const content = '---\nname: demo\ndescription: 示例\n---\n\n# 标题\n\n正文'
  assert.equal(stripFrontmatter(content).trim(), '# 标题\n\n正文')
})

test('buildDigest 只保留用途、章节与首段', () => {
  const skill = {
    name: 'demo',
    description: '一个演示技能',
    content: '---\nname: demo\n---\n\n# 演示\n\n第一段说明文字。\n\n## 用法\n\n细节一。\n\n## 注意\n\n细节二。',
  }
  const digest = buildDigest(skill, 300)
  assert.ok(digest.includes('技能：demo'))
  assert.ok(digest.includes('用途：一个演示技能'))
  assert.ok(digest.includes('# 演示'))
  assert.ok(digest.includes('## 用法'))
  assert.ok(digest.includes('第一段说明文字'))
  assert.equal(digest.includes('细节一'), false)
  assert.ok(digest.length <= 300)
})

test('truncateBody 超长才截断', () => {
  assert.equal(truncateBody('短文本', 100), '短文本')
  const long = 'x'.repeat(50)
  const cut = truncateBody(long, 10)
  assert.ok(cut.startsWith('x'.repeat(10)))
  assert.ok(cut.includes('已截断'))
})

test('同一技能 alias+auto 合并为一处，词不重复计分', () => {
  const entries = [
    { skill: 'demo', kind: 'alias', words: ['女娲'] },
    { skill: 'demo', kind: 'auto', words: ['女娲', '造人'] },
  ]
  const hits = matchSkills('用女娲造一个视角', entries, 2, 10)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, 'alias')
  assert.deepEqual(hits[0].matched, ['女娲'])
})

test('口语虚词不妨碍中文命中', () => {
  const entries = [{ skill: 'diagram', kind: 'auto', words: ['流程图'] }]
  assert.equal(matchSkills('画个流程图', entries, 1, 10).length, 1)
  assert.equal(matchSkills('帮我画一张流程图看看', entries, 1, 10).length, 1)
})

// ── 数量词误触发 ────────────────────────────────────────────────────────
test('数量词不会被当成技能关键词', () => {
  const entries = buildAutoEntries([{ name: 'local-imagegen', description: '画一张图、来张图、出图。' }])
  const words = entries[0].words
  assert.equal(words.includes('一张'), false)
  assert.equal(words.includes('一张图'), false)
  // 「这张图」这类消息只提到已有图片，不应命中出图技能
  assert.deepEqual(matchSkills('帮我看看这张图', entries, 1, 10), [])
})

// ── 勾选状态 ────────────────────────────────────────────────────────────
test('normalizeState 默认全部启用', () => {
  assert.equal(normalizeState(undefined).enabled, null)
  assert.equal(normalizeState({}).version, 1)
  assert.deepEqual(normalizeState({ enabled: ['a', 'a', ''], dismissed: { a: 5, b: 'x' } }).enabled, ['a'])
  assert.deepEqual(normalizeState({ dismissed: { a: 5, b: 'x' } }).dismissed, { a: 5 })
  assert.deepEqual(normalizeState({ enabled: [] }).enabled, [])
})

test('resolveEnabled：null = 全部，白名单忽略已卸载技能', () => {
  const catalog = ['pptx-diagram', 'grill-me']
  assert.deepEqual([...resolveEnabled(catalog, normalizeState(null))], ['pptx-diagram', 'grill-me'])
  assert.deepEqual([...resolveEnabled(catalog, normalizeState({ enabled: ['grill-me', 'gone'] }))], ['grill-me'])
  assert.deepEqual([...resolveEnabled(catalog, normalizeState({ enabled: [] }))], [])
})

test('splitHits 把命中拆成已勾选与未勾选', () => {
  const hits = [{ skill: 'a' }, { skill: 'b' }]
  const { active, pending } = splitHits(hits, new Set(['a']))
  assert.deepEqual(active.map((hit) => hit.skill), ['a'])
  assert.deepEqual(pending.map((hit) => hit.skill), ['b'])
})

test('setSkillEnabled 勾选 / 取消，保留目录里的原名', () => {
  const catalog = ['pptx-diagram', 'Grill-Me']
  let state = normalizeState(null)
  state = setSkillEnabled(state, catalog, 'pptx-diagram', false, 100)
  assert.deepEqual(state.enabled, ['Grill-Me'])
  assert.equal(state.updatedAt, 100)
  state = setSkillEnabled(state, catalog, 'pptx-diagram', true, 200)
  assert.deepEqual(state.enabled.sort(), ['Grill-Me', 'pptx-diagram'])
})

test('setAllEnabled 全部启用回到 null', () => {
  const off = setAllEnabled(normalizeState(null), false)
  assert.deepEqual(off.enabled, [])
  const on = setAllEnabled(off, true)
  assert.equal(on.enabled, null)
})

test('shouldAsk 遵守冷却，markAsked 记录询问时间', () => {
  const now = 1_000_000
  assert.equal(shouldAsk('a', normalizeState(null), now), true)
  const asked = markAsked(normalizeState(null), ['a'], now)
  assert.equal(shouldAsk('a', asked, now + 1000), false)
  assert.equal(shouldAsk('a', asked, now + 25 * 60 * 60 * 1000), true)
})

test('buildAskText 生成询问提示', () => {
  const text = buildAskText([{ skill: 'ziwei-doushu', matched: ['紫微', '排盘'] }])
  assert.ok(text.includes('<system-reminder>'))
  assert.ok(text.includes('ziwei-doushu'))
  assert.ok(text.includes('紫微、排盘'))
  assert.ok(text.includes('ask_user_question'))
  assert.equal(buildAskText([]), '')
})

test('stateSnapshot 给出面板所需结构', () => {
  const catalog = [
    { name: 'a', description: '甲', whenToUse: 'use a' },
    { name: 'b', description: '乙' },
  ]
  const view = stateSnapshot(catalog, normalizeState({ enabled: ['a'] }))
  assert.equal(view.allEnabled, false)
  assert.deepEqual(view.skills.map((skill) => [skill.name, skill.enabled]), [['a', true], ['b', false]])
  assert.equal(stateSnapshot(catalog, normalizeState(null)).allEnabled, true)
})
