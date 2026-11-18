/**
 * Web Client half of dsh-skill-autoload.
 *
 * Seats:
 *   - `sidebar.right.pane.tab`  the settings page listing every installed skill
 *     with a checkbox that controls automatic loading;
 *   - `conversation.composer.dock`  a small entry button that opens that page.
 *
 * The page talks to the host half over `/skill-autoload/state` (GET/POST),
 * registered by `index.js` on the harness web server.
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-autoload',
  factory: function (require) {
    'use strict'

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var TAB_ID = 'skill-autoload'
    var TAB_KIND = 'skill-autoload'
    var API = '/skill-autoload'

    // ── 极简样式（不依赖主题变量，跟随文字颜色） ─────────────────────────
    var S = {
      page: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', height: '100%', overflow: 'auto', boxSizing: 'border-box', fontSize: '13px' },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      muted: { opacity: 0.65, fontSize: '12px', lineHeight: 1.5, margin: 0 },
      bar: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      button: { cursor: 'pointer', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', borderRadius: '6px', padding: '4px 10px', fontSize: '12px' },
      list: { display: 'flex', flexDirection: 'column', gap: '2px', margin: 0, padding: 0, listStyle: 'none' },
      row: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '7px 6px', borderRadius: '6px', cursor: 'pointer' },
      rowHover: { background: 'rgba(128,128,128,0.10)' },
      check: { marginTop: '2px', cursor: 'pointer', flex: '0 0 auto' },
      name: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px' },
      desc: { opacity: 0.6, fontSize: '11px', lineHeight: 1.45, margin: '2px 0 0' },
      error: { color: '#e05252', fontSize: '12px', margin: 0 },
      footer: { marginTop: 'auto', paddingTop: '8px', opacity: 0.55, fontSize: '11px', lineHeight: 1.5 },
      entry: { cursor: 'pointer', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: '2px 10px', fontSize: '11px', margin: '4px 0 4px 8px' },
    }

    function jsonRequest(method, url, body) {
      return fetch(url, {
        method: method,
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || data === null || data.ok === false) {
            throw new Error((data && data.error) || ('HTTP ' + response.status))
          }
          return data
        })
      })
    }

    // ── 右侧栏设置页 ──────────────────────────────────────────────────────
    function SkillAutoloadPanel() {
      var state = useState({ loading: true, error: '', view: null, busy: '' })
      var current = state[0]
      var setState = state[1]

      var load = useCallback(function () {
        setState(function (previous) { return { loading: !previous.view, error: '', view: previous.view, busy: '' } })
        jsonRequest('GET', API + '/state').then(function (data) {
          setState({ loading: false, error: '', view: data, busy: '' })
        }).catch(function (error) {
          setState(function (previous) { return { loading: false, error: String(error && error.message ? error.message : error), view: previous.view, busy: '' } })
        })
      }, [])

      useEffect(function () {
        load()
      }, [load])

      var save = useCallback(function (next) {
        setState(function (previous) { return { loading: previous.loading, error: '', view: previous.view, busy: 'save' } })
        jsonRequest('POST', API + '/state', next).then(function (data) {
          setState({ loading: false, error: '', view: data, busy: '' })
        }).catch(function (error) {
          setState(function (previous) { return { loading: false, error: String(error && error.message ? error.message : error), view: previous.view, busy: '' } })
        })
      }, [])

      var toggle = useCallback(function (skill) {
        save({ name: skill.name, enabled: !skill.enabled })
      }, [save])

      var view = current.view
      var skills = view !== null && Array.isArray(view.skills) ? view.skills : []
      var enabledCount = 0
      for (var index = 0; index < skills.length; index += 1) {
        if (skills[index].enabled) enabledCount += 1
      }

      return h('div', { style: S.page },
        h('div', { style: S.head },
          h('div', null,
            h('h2', { style: S.title }, '技能自动加载'),
            h('p', { style: S.muted },
              '勾选的技能会被自动注入到相关对话里，不需要触发词。',
              h('br'),
              '没勾选的技能被命中时，会先问你一句。'
            )
          ),
          h('button', { style: S.button, onClick: load, disabled: current.busy === 'save' }, '刷新')
        ),
        h('div', { style: S.bar },
          h('button', { style: S.button, disabled: skills.length === 0 || current.busy === 'save', onClick: function () { save({ all: true }) } }, '全部启用'),
          h('button', { style: S.button, disabled: skills.length === 0 || current.busy === 'save', onClick: function () { save({ all: false }) } }, '全部禁用')
        ),
        view !== null && view.allEnabled ? h('p', { style: S.muted }, '当前：全部启用（新装的技能默认也启用）') : null,
        view !== null && !view.allEnabled ? h('p', { style: S.muted }, '当前：已启用 ' + String(enabledCount) + ' / ' + String(skills.length) + ' 个（新装的技能默认不启用）') : null,
        current.error !== '' ? h('p', { style: S.error }, '读取或保存失败：' + current.error) : null,
        current.loading ? h('p', { style: S.muted }, '加载中…') : null,
        h('ul', { style: S.list },
          skills.map(function (skill) {
            return h('li', { key: skill.name },
              h('label', { style: S.row },
                h('input', {
                  type: 'checkbox',
                  style: S.check,
                  checked: skill.enabled,
                  disabled: current.busy === 'save',
                  onChange: function () { toggle(skill) },
                }),
                h('span', { style: { flex: '1 1 auto', minWidth: 0 } },
                  h('span', { style: S.name }, skill.name),
                  skill.description !== '' ? h('p', { style: S.desc }, skill.description) : null
                )
              )
            )
          })
        ),
        skills.length === 0 && !current.loading && current.error === ''
          ? h('p', { style: S.muted }, '没有读到技能列表。确认已安装技能后点「刷新」。') : null,
        h('p', { style: S.footer },
          '状态文件：~/.dsh/skill-autoload/state.json',
          h('br'),
          '也可以用工具 skill_autoload 让模型自己开关。'
        )
      )
    }

    // ── composer 下方的入口按钮 ──────────────────────────────────────────
    function makeEntryButton(openTab) {
      return function SkillAutoloadEntry() {
        return h('button', {
          type: 'button',
          style: S.entry,
          title: '打开「技能自动加载」设置',
          onClick: function () {
            try {
              openTab()
            } catch {
              // 面板打不开时不打断输入
            }
          },
        }, '⚙ 技能自动加载')
      }
    }

    function definition() {
      return {
        id: TAB_ID,
        kind: TAB_KIND,
        title: function () { return '技能自动加载' },
      }
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply: function (ctx) {
        var pluginCtx = ctx

        function openTab() {
          var sidebarRight = pluginCtx.sidebarRight
          if (sidebarRight === undefined || sidebarRight === null) {
            sidebarRight = typeof pluginCtx.get === 'function' ? pluginCtx.get('sidebarRight') : undefined
          }
          if (sidebarRight !== undefined && sidebarRight !== null && typeof sidebarRight.openTab === 'function') {
            sidebarRight.openTab(TAB_KIND)
            return
          }
          // 兜底：类型已注册时，右键栏的打开动作也可以直接走注册表。
          var tabs = pluginCtx.sidebarRightTabs
          if (tabs !== undefined && tabs !== null && typeof tabs.open === 'function') tabs.open(TAB_KIND)
        }

        function mount(slot, registration, component) {
          ctx.effect(function () {
            var dispose = ctx.slots.inject(slot, function () {
              return ctx.slots.register(registration, component)
            })
            return function () {
              if (typeof dispose === 'function') dispose()
            }
          })
        }

        ctx.effect(function () {
          return ctx.sidebarRightTabs.register(definition())
        }, 'skill-autoload: tab type')

        mount(
          'sidebar.right.pane.tab',
          { name: 'sidebar.right.pane.tab', key: TAB_ID },
          SkillAutoloadPanel
        )

        mount(
          'conversation.composer.dock',
          { name: 'conversation.composer.dock', id: 'skill-autoload-entry', order: 20 },
          makeEntryButton(openTab)
        )
      },
    }
  },
})