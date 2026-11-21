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
