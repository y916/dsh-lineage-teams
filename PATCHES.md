# 0.5.0：可配置的子代理创建规则 + 浏览器设置卡

基线：`deepseek-ai/deepseek-harness` @ `dsh-v0.2.2-rc.5`（验证版本 `0.2.2-rc.5`）。

## 改了什么

| 能力 | 实现点 |
| --- | --- |
| `subagent` 描述改为固定指令 | 追加「在调用此工具之前，先调用list_agents确认子代理情况，优先使用send_message向空闲的子代理派发任务，而不是建立新的子代理。」 |
| 两个可配置上限 | `Config.idleRatioLimit`（0–100，默认 50）与 `Config.idleCountLimit`（0–10，默认 3），**必须同时满足**才允许新建；比较为含等号（`idle*100 <= total*ratio`、`idle <= count`） |
| 三个差异豁免 | `allowDifferentPreset` / `allowDifferentModel` / `allowDifferentCwd`（默认全关）：只在超过两个上限时生效；命中条件是对应请求值**显式给出**且空闲代理中确实没有 |
| 冷子代理元数据 | 驻留的空闲代理读 live Agent；冷代理从 `sessionQuery` 观察 header（`agentPreset`、`cwd`）与 `subagent/descriptor`（provider/model）；读不到就不授予该维度豁免（保守） |
| 规则上下文 | `lineage:subagent-rule` system prompt context：当前数值 + 计数口径 + 豁免状态；每步重新组装，设置变化后的下一步加一行「（子代理创建规则已更新，以下为当前规则）」 |
| 浏览器设置卡 | `client.js`（`dsh.client`，无构建）注册 `plugins.bundle.config`（key 为 bundle 名）与 `plugins.row.config`（key `@y916/dsh-lineage-teams#lineage-teams`），用 `configForms` 读写 `lineage-teams` 命名空间；2 滑动条 + 3 开关 + 保存/恢复默认 |
| 热生效 | 5 个 Config 字段全部 `volatile()`：保存后同一插件实例内即时生效，无需重启或重开对话 |

## 判定顺序

1. 统计调用者**直接创建、continuable** 的子代理（`depth === 1`），空闲 = 状态不是 `running`。
2. `total === 0` 或两个上限同时满足 → 允许。
3. 否则，任一**开启**的豁免维度满足「请求值显式给出 + 空闲代理中没有该值」→ 允许。
4. 否则拒绝，错误里给出失败的上限、当前计数、三个豁免的判定与空闲代理清单。
5. 读不到子代理目录（非取消）时放行并 warning；调用被取消时保留取消。

豁免的值比较：预设取 `session.header.agentPreset`；模型只比较 `provider + model`（`reasoning_effort` 不参与）；
目录取当前工作目录（`workingDirectory` 服务，回退 header）。省略的参数不触发豁免。

## 为什么用 volatile Config

设置要能“保存后下一步生效”，而且不能因为改一个数字就重挂插件、重建所有 Agent 的遮蔽定义。
Schemastery 的 `volatile()` 字段由 Loader 原地更新，插件在每次 `subagent` 调用与每次 system prompt
组装时读取 `.get()`，所以规则与上下文始终是当前值；`dsh-settings` 会把该行暴露成 `lineage-teams`
命名空间，浏览器卡通过 `configForms` 写 user 层。

## 客户端半体

`client.js` 是 `window.__ModuleLoader__.load` 工厂，`require('react')`，无构建步骤；`dsh.client.platform`
为 `web`。卡片同时注册到 bundle 详情页与行配置子页；非 Web 环境没有这张卡，Host 规则仍按默认值运行。

## 验证

- `node test/smoke.mjs`：设置归一化、两个上限边界、三种豁免（命中/未命中/未知）、显式参数、
  冷元数据补读、拒绝文案、规则上下文与更新标记、遮蔽定义执行路径、fork guard、遗留定义识别。
- 真机：更新 web profile 后确认设置卡出现、滑动条/开关可写、保存后 `subagent` 错误里的数值与
  规则上下文同步变化。

# 0.4.0：子代理预算（禁用 subagent_fork + 空闲复用规则）

基线：`deepseek-ai/deepseek-harness` @ `dsh-v0.2.2-rc.5`（验证版本 `0.2.2-rc.5`）。

## 改了什么

| 能力 | 实现点 | 作用域 |
| --- | --- | --- |
| 全局禁用 `subagent_fork` | 每个 Agent scope 调 `ctx.tools.restrict({ deny: ['subagent_fork'] })` | 该 Agent 及其后代 scope |
| 兜底拒绝 fork 调用 | 根 context 注册 `ctx.tools.guard`（`tools.guard` 在根上即全局 guard） | 所有 Agent（含 PTC / 直接 dispatch） |
| `subagent` 新规则 | 每个 Agent scope 注册同名遮蔽定义，描述追加规则原文，`execute` 前置检查 | 该 Agent |
| 委派提示不被遮蔽吞掉 | `lineage:delegation` section，仅当可见的 `subagent` 是本插件的遮蔽定义时输出 | 该 Agent |
| 卸载清理 | `ctx.effect` 统一释放本实例注册的工具与 scope 限制 | 插件 fiber |

### 规则原文（写入 `subagent` description）

```text
如果空闲的子代理数量达到整体的一半及以上，请使用send_message向空闲的子代理派发任务，不允许建立新的子代理。
```

### 判定口径

- 子代理：调用者直接创建、`mode === 'continuable'` 的子代理；`listDescendants(caller.id)` 里取
  `kind === 'child' && depth === 1`。不可继续的子代理不计入（`send_message` 无法向它们派发）。
- 空闲：`ctx.agents.get(id)?.status !== 'running'`；未驻留（冷）的可继续子代理也算空闲。
- 整体：上述子代理总数。
- 命中条件：`total > 0 && idle * 2 >= total`；`total === 0` 时始终允许首次派发。
- 命中直接在 `execute` 抛错，错误里给出 `total / idle`、规则原文与可派发的空闲子代理名字
  （`entry.path ?? entry.name ?? entry.id`）。
- 目录读取失败（非取消）时放行并 `logger.warn`，不把「无法判断」变成拒绝；调用被取消时保留取消。
- 只在 `send_message` 对该 Agent 可见时安装：否则拒绝新建会断掉唯一委派路径。

### 为什么要遮蔽 `subagent`

`defineTool` 产出的定义对象带执行/展示闭包，直接改 `description` 或包 `execute` 会污染上游定义；
Cordis 的 scoped tool 就近遮蔽才是受支持的做法（与 0.3.0 的 `send_message` 相同）。
遮蔽会带来一个上游副作用：`tool-subagent` 的 `tool:subagent` section 按定义身份判定，遮蔽后不再输出
委派建议；本版用 `lineage:delegation` 复述同等内容（去掉 `subagent_fork`）。

### 热更新迁移（0.3.0 → 0.4.0）

0.3.0 注册 `send_message` 遮蔽时没有登记卸载 disposer，热更新会把它留在已有 Agent 的 scope 里，
且其函数体闭包着已停用的插件 context（调用时报 `cannot get required service "subagents" in inactive context`）。
0.4.0 识别这种遗留定义（同名 broadcast `send_message`）后就地换入新实例的实现并接管；
0.4.0 起自己的注册会在卸载时释放，后续升级不再留下残骸。仍建议升级后重启 profile 以重建 scope。

### 验证

- `node test/smoke.mjs`（新增 idle 计数、边界、遮蔽描述与拒绝、fork guard、wiring 断言）。
- 真机：更新 web profile 后确认 `subagent_fork` 不再出现在工具列表、`subagent` 描述含规则原文、
  直接调用 fork 被 guard 拒绝。

# 0.3.0：从 vendored fork 改为薄增量

基线：`deepseek-ai/deepseek-harness` @ `dsh-v0.2.2-rc.5`（改动起点 `dsh-v0.2.2-rc.2`）。

## 为什么重写

`0.2.2-rc.2` 把 AgentTeam 并入统一 subagent 树（官方迁移文档：
`docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents`、`subagent-service-methods`、
`subagent-activation-options`、`v0.2.2-alpha.3/subagent-names`）。0.2.x 的 fork vendor 了
上游 `agent-team` / `tool-agent-team` 并替换三件套工具，依赖的这些东西在 rc.2 起全部消失：

| 0.2.x 依赖 | rc.2+ 现状 |
| --- | --- |
| `@deepseek-ai/dsh-subagent/internal`（`steerHostSubagentPrompt`） | 子路径与实现删除 |
| `ctx.agentTeams` 的 `spawnTeammate` / `sendMessage` / `interrupt` / 名册 / `waitForChange` | 只剩任务板；通信与名册归 `ctx.subagents` |
| `ctx.subagents.drainChildren()` | 删除（改 `drainDescendants(parents)`） |
| `startActivation({ request })` | `request` 包裹层移除，字段上提 |
| `list_agents` 行 `{kind,id,label,parent,depth}` | 改为 `{name,status,description}`，名字是 `reviewer/checker` 路径 |
| `spawn_teammate` | 工具删除；`tool-subagent` 原生支持 `agentPreset` / `maxDepth` / `modelSelection` |
| Team 专属 `send_message` / `list_agents` / `interrupt_agent` | 删除；控制工具改由 `tool-subagent-control` 提供，`send_message({ agent, message })` |
| 自建 `agentTeams` 服务 | 上游 `agent-team` 在 base 中无条件挂载；再提供一个同名服务会 `service "agentTeams" has been registered` |

结论：vendored 域代码（`lib/team-domain.mjs`、`lib/team-tools.mjs`，约 2900 行）作废，删除。

## 现在的增量

### 1. 群发 `send_message`

在 Agent 自己的 scope 注册同名工具，遮蔽预设已经声明的那一份（Cordis 的 scoped tool 就近遮蔽）。
schema 是上游契约的超集，所以上游提示里的 `send_message({ agent, message })` 写法仍然有效：

| 参数 | 说明 |
| --- | --- |
| `agent` | 单目标：名字或 Session id；与 `targets` 可同时给 |
| `targets` | 一个或多个目标，逐个投递；接受名字、Session id、`"parent"`、`"lead"` |
| `message` | 必填，原文投递 |

- 返回 `{ delivered: string[], failed: string[] }`；全部失败才抛错（沿用 0.2.x 语义）。
- `"parent"` 用 `ctx.subagents.namesOf(agent).parent` 解析；`"lead"` 就是根的名字。
- 投递走 `ctx.subagents.sendMessage(sender, targetId, content, { signal })`。

**不注入工具**：只有在 `ctx.tools.get('send_message', scope)` 已有定义时才注册替换；没有声明该工具的
预设保持没有。

### 2. 联系人 + 完成即汇报（`lineage:completion`）

`systemPrompt.context`，order 取 `SUBAGENT_DELEGATION`，`required: true`，只在同时满足时输出：

- agent 在 subagent 树里有 parent（根会话不输出）；
- 它看到的 `send_message` 正是本插件注册的那一份（避免与上游单目标契约打架）。

内容（每条一行）：父级名字与根名字、需要时的联系写法（含 `targets` 群发与 `"parent"`/`"lead"`）、
完成即汇报（详情报文走 `send_message`，含结论/证据/未完成项/交付物路径）、最终回复只写
「已经汇报完毕。」一句。

## 升级到 0.3.0 的操作要点

1. 先升级 DSH 到 >= `0.2.2-rc.2`（本版针对 `0.2.2-rc.5` 验证），否则 `@deepseek-ai/dsh-subagent`
   的 `./internal` 子路径与 `ctx.agentTeams` 旧 API 会让 0.2.x 版本直接加载失败；
2. 预设里如果有 `@y916/dsh-lineage-teams/tools` 行，删掉——0.3.0 不再导出该子路径，也没有团队
   专用工具需要按预设挂载；
3. `dsh plugin --profile web add github:y916/dsh-lineage-teams#<sha>` 更新依赖后重启 profile；
4. 验证：`send_message({ targets: ["lead"], message: "..." })` 能群发，子代理的提示里能看到
   联系人段落与「已经汇报完毕。」规则。
