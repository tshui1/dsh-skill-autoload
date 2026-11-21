# Changelog

## 0.2.2

- 安全修复（市场维护者 fkysly 反馈）：`/skill-autoload/state` 路由现在先调用 DSH 的 `ctx.connection.requestRejection()`，执行 Host/Origin 围栏与浏览器登录校验；未登录或跨站请求返回 401/403。该服务不可用时按 fail-closed 拒绝，`sameOrigin` 作为纵深防御保留。
- 因此浏览器里任意网页不再能调用本插件的状态接口。

## 0.2.1

- 修复完整重启 DSH 后面板报 `Unexpected end of JSON input`：`webServer` 与 `tools` 服务可能晚于插件就绪，改为 `ctx.inject(['webServer'])` / `ctx.inject(['tools'])` 的 reactive 注册，冷启动与 HMR 热重载都能正确挂载路由与工具。
- 修复面板只列出内置技能（`diagnose-windows-sandbox-acl`、`office` 等）而看不到用户自装技能：技能列表改为按 agent 作用域读取，并缓存最近一次 `agent/pre-step` 的作用域。

## 0.2.0

- 新增右侧栏「技能自动加载」面板：列出全部已装技能，直接勾选启用哪些；composer 下方常驻 ⚙ 入口。
- 新增 `skill_autoload` 工具：`list` / `enable` / `disable` / `enable_all` / `disable_all`。
- 新增 `GET/POST /skill-autoload/state` HTTP 接口，面板与工具共用同一份状态；原子写 `<DSH_HOME>/skill-autoload/state.json`。
- 新增「未勾选先询问」：命中未勾选的技能时不注入正文，改为注入询问提示，由模型用 `ask_user_question` 询问；`askOnUnchecked`、`askCooldownMs`（默认 24h）可配。
- 修复数量词误触发：「画一张」不再把「一张」当成技能关键词。
- `package.json` 增加 `./client` 导出、`dsh.client` 声明与客户端侧 peer 依赖。

## 0.1.0

- 首个版本。
- 监听 `agent/pre-step`，按用户消息自动注入匹配技能的说明，无需触发词。
- 自动关键词：从 `ctx.skills.list()` 的技能名、`description`、`whenToUse` 抽取，装新技能即生效。
- 可选别名表 JSON，支持中文口语关键词与热更新。
- 中文匹配容忍口语虚词（「画个流程图」可命中「流程图」）。
- 三种注入模式：`auto`（短技能全文 / 长技能摘要）、`digest`、`full`。
- 去重：显式 `/技能名`、同会话已注入、上下文压缩后补注入。
- 全部逻辑有 Node 单元测试，异常静默降级不影响会话。