# dsh-skill-autoload

> 让 DeepSeek Harness 根据你的消息自动加载匹配技能的说明，**不需要任何触发词**。

插件在每一轮模型调用前检查用户消息，命中某个已安装技能时，把该技能的正文（或摘要）作为一条 `skill-invocation` 消息注入到本轮上下文。模型“看见”消息的那一刻，技能就已经在手里了。

0.2 起还带一个右侧栏面板：直接勾选哪些技能可以自动加载；没勾选的技能被命中时，模型会先问你一句要不要启用。

## 它解决什么

DSH 的技能默认需要显式触发：

- 输入 `/技能名` 手势，或
- 模型自己判断需要时调用 `skill` 工具。

问题是：模型不一定想到去调用。你装了「图片去水印」，发一句“这张图右下角有字帮我清掉”，模型可能直接开始写代码，而不是先加载那个技能里的成熟流程。

本插件把“想起来”这一步去掉：**消息里出现技能相关词，技能就自动到场。**

## 特性

- **零配置生效**：从每个技能的 `name` / `description` / `whenToUse` 自动抽取关键词，装新技能立即识别，无需编辑任何列表。
- **可选别名表**：给中文技能补口语化触发词（“抠图”“去水印”“画个流程图”），按文件 mtime 热更新。
- **省 token**：`auto` 模式下短技能注入全文、长技能注入摘要（章节 + 首段），比整篇注入小一个数量级。
- **不重复**：本轮已有 `/技能名` 显式注入则跳过；同一会话已注入过则跳过；上下文压缩隐藏后会自动补回。
- **可关闭、可排除**：`autoKeywords: false` 只认别名表；`exclude` 排除个别技能。
- **勾选式面板**：右侧栏「技能自动加载」列出全部已装技能，取消勾选即不再自动注入；composer 下方常驻入口。
- **未勾选先询问**：命中未勾选的技能时，模型会先用 `ask_user_question` 问你「要不要启用它」，不会擅自加载；同一技能 24 小时内不重复问。
- **工具与 HTTP**：`skill_autoload` 工具支持 list / enable / disable / enable_all / disable_all；面板通过 `/skill-autoload/state` 读写同一份状态，该路由带 DSH 访问检查。
- **零副作用**：只读技能目录与一个 JSON 文件；不联网、不执行命令；任何异常都静默返回原流程，绝不影响会话。

## 安装

### 从插件市场

在 DSH 的插件市场搜索 `dsh-skill-autoload` 安装。

### 本地目录（开发 / 手动）

1. 把本仓库放到任意目录，例如 `D:\plugins\dsh-skill-autoload`。
2. 打开 DSH 的 Plugins 面板，选择 **Add plugin**，指向该目录；或手工在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: skill-autoload
      name: dsh-skill-autoload
      config:
        mode: auto
        maxSkills: 1
```

3. 重启 DeepSeek Harness。

### 从 GitHub Release

下载 tarball 后在 Plugins 面板选择本地安装。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto`＝短技能全文 / 长技能摘要；`digest`＝一律摘要；`full`＝一律全文 |
| `maxSkills` | `1` | 每轮最多注入几个技能 |
| `digestChars` | `900` | 摘要目标字符数 |
| `maxBodyChars` | `12000` | 全文注入的正文上限 |
| `fullThreshold` | `1500` | `auto` 模式下正文不超过该长度就注入全文 |
| `minScore` | `10` | 任何命中的最低分 |
| `autoMinScore` | `10` | 自动关键词命中的最低分（防止误触发） |
| `autoKeywords` | `true` | 关闭后只使用别名表 |
| `exclude` | `[]` | 不参与自动加载的技能名 |
| `aliasesPath` | `""` | 别名表 JSON 路径；留空则只用自动关键词 |
| `logPath` | `""` | 调试日志路径；留空不写 |
| `statePath` | `<DSH_HOME>/skill-autoload/state.json` | 勾选状态文件；删除即恢复「全部启用」 |
| `askOnUnchecked` | `true` | 命中未勾选技能时是否注入询问提示 |
| `askCooldownMs` | `86400000` | 同一技能两次询问的最小间隔（默认 24h） |
| `webServerPrefix` | `/skill-autoload` | 面板使用的 HTTP 路由前缀 |

## 别名表

给中文技能补关键词。文件是 `{ "技能名": ["关键词", ...] }`，以下划线开头的键被忽略：

```json
{
  "_comment": "技能名 -> 触发关键词；子串匹配，大小写不敏感",
  "image-assets": ["抠图", "透明背景", "压缩图片", "webp"],
  "image-watermark-remover": ["去水印", "消除水印", "水印"],
  "pptx-diagram": ["画图", "流程图", "示意图"]
}
```

改了立刻生效（按 mtime 缓存），不用重启。

## 勾选面板与「先问一句」

右侧栏有「技能自动加载」页，列出所有已装技能与它们的启用开关；composer 下方还有一个 ⚙ 按钮可以直接打开它。

- **勾选 = 允许自动注入**；取消勾选后，消息再命中它也不会自动加载。
- 第一次使用（状态文件不存在）等价于「全部启用」。
- 状态存在 `<DSH_HOME>/skill-autoload/state.json`，形如：

```json
{
  "version": 1,
  "enabled": null,
  "dismissed": {},
  "updatedAt": "2026-11-19T00:00:00.000Z"
}
```

`enabled: null` 表示全部启用；写成数组则只启用数组里的技能。`dismissed` 记录每个技能上次被询问的时间，用来做 24h 去抖。

**未勾选时会发生什么**：插件照常匹配，但把结果分流成「已启用」和「待确认」。待确认的技能不会注入正文，而是注入一条询问提示，让模型用 `ask_user_question` 问你：

> 检测到你的消息与技能「xxx」相关，但它没有启用自动加载。要启用吗？

你回答「启用」后，模型调用 `skill_autoload` 工具把它加进 `enabled` 列表（下次生效）；回答「不用」则本轮跳过，且 24h 内不再为它打扰你。

模型侧也可以直接用工具管理列表，不用打开面板：

| action | 说明 |
| --- | --- |
| `list` | 列出技能与启用状态 |
| `enable` / `disable` | 传入 `name`，开关单个技能 |
| `enable_all` / `disable_all` | 全部启用 / 全部禁用 |

## 它是怎么省 token 的

`auto` 模式下，长技能不会整篇注入。以一份实测环境为例：

| 技能 | 全文 | 摘要 |
| --- | --- | --- |
| ziwei-doushu | 8,893 字符 | 484 字符 |
| image-watermark-remover | 6,984 字符 | 585 字符 |
| pptx-diagram | 3,063 字符 | 388 字符 |
| huashu-nuwa | 19,063 字符 | 417 字符 |

摘要包含：技能名、用途、章节目录、首段。模型需要细节时会按提示用 `read` 打开技能文件，或调用 `skill` 工具加载全文。短技能（≤ `fullThreshold`）仍然注入全文，保证小技能不丢信息。

## 触发规则

1. 读取本轮用户消息的文本；
2. 取 `ctx.skills.list()` 中可被模型调用的技能，按 `name` / `description` / `whenToUse` 生成自动关键词（60 秒缓存）；
3. 合并别名表，对消息做子串匹配，中文会先删除“个 / 的 / 了 / 这 / 那”等口语虚词再比较，容忍“画**个**流程图”这类插入；
4. 打分：命中词权重求和 + 最长命中词长度；别名词权重高于自动词；低于阈值丢弃；
5. 去重后注入，`source.kind = "skill-invocation"`；
6. 按勾选状态分流：已启用的注入正文/摘要；未启用的改注入询问提示（同一技能 24h 内只问一次）。

## 安全

- HTTP 路由 `/skill-autoload/state` 在做任何读写前，先调用 DSH 提供的 `ctx.connection.requestRejection()`：它执行 Host / Origin 围栏与浏览器登录 cookie 校验，未通过时直接返回 `401` / `403`。浏览器里任意网页因此无法调用本插件的接口。
- 该服务不可用或判决本身抛错时按 **fail-closed** 拒绝，绝不放行。
- 额外保留同源检查（Origin 与 Host 一致）作为纵深防御。
- 除这条面板路由外不监听任何端口；插件不联网、不执行命令，只读写 `<DSH_HOME>/skill-autoload/state.json`。

## 兼容性

- 要求 DSH `>= 0.2.0-rc.2`；已在 `0.2.2-rc.5` 上验证。
- 依赖内核提供的 `ctx.skills`、`agent/pre-step`、`createUserMessage`，与 `dsh-tool-skill` 使用同一条注入通道。
- 右侧栏面板与 composer 入口需要 DSH Web 客户端；纯终端 / CLI 会话下只有自动注入与 `skill_autoload` 工具可用。

## 开发

```bash
node --test test-logic.mjs
```

`logic.js` 不依赖 DSH 内核，所有关键词抽取、匹配、摘要、勾选状态逻辑都可以用普通 Node 测试。`client.js` 是手写的浏览器侧 bundle（`window.__ModuleLoader__.load`），不需要额外构建步骤。

## License

MIT