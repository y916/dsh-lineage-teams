# dsh-lineage-teams

DSH Agent Teams 的**薄增量插件**（0.2.2-rc.2 起，含 rc.5）。

0.2.2-rc.2 把 AgentTeam 统一成了「具名、多层的 subagent 树」：`spawn_teammate`、Team 专属的
`send_message` / `list_agents` / `interrupt_agent`、`ctx.agentTeams` 的创建/通信/名册 API 全部移除，
命名、多层协作、任务板、`wait_agent` 都由上游提供。因此本插件不再 vendor 任何域代码，只保留三件
上游没有的事：

1. **群发 `send_message`**：在保留上游单目标 `agent` 契约的同时接受 `targets: string[]`，
   逐个投递并返回 `{ delivered, failed }`；`targets` 里可以用 agent 名字、Session id、
   `"parent"`（直接父级）与 `"lead"`（根会话）。
2. **联系人 + 完成即汇报提示**：每个被派出的 agent 都会收到一段提示，写明父级是谁、需要时怎么联系，
   以及完成任务时怎么汇报——详情报文走 `send_message`，最终回复只写一句话。
3. **子代理预算**：全局禁用 `subagent_fork`；`subagent` 增加一条复用规则，并在调用时强制执行。
   规则原文（写入 `subagent` 的工具描述）：

   ```text
   如果空闲的子代理数量达到整体的一半及以上，请使用send_message向空闲的子代理派发任务，不允许建立新的子代理。
   ```

```text
你的父级代理是「lead」，根会话（团队负责人）是「lead」。
需要补充信息、纠偏，或发现会影响别人结论的事实时，直接联系：send_message({ agent: "<父级名字>", message: "..." })。
任务一完成就直接向父代理汇报：用 send_message 给父级发一条消息，详细说明结论、证据（命令原文、文件路径与行号）与未完成项，
并给出交付物路径——这条消息就是你的正式汇报，不要指望父级从你的最终回复里读细节。
汇报之后，最终回复只写一句话——「已经汇报完毕。」；不要把汇报内容再贴一遍。
```

## 子代理预算

### 全局禁用 `subagent_fork`

- 对**每个 Agent 的 scope** 调用 `ctx.tools.restrict({ deny: ['subagent_fork'] })`：工具从模型可见列表里消失，
  模型无法选择它；后代 scope 沿 scope 链继承该限制。
- 另注册一个**全局 guard**（`ctx.tools.guard`）：即使调用绕过可见性（PTC、直接 dispatch），也会被拒绝并返回
  `subagent_fork is disabled in this profile. Delegate with subagent, and reuse idle subagents through send_message.`
- fork 工具由独立插件行（`tool-subagent-fork`）注册，可能晚于本插件加载；`tools/change` 后会重试，
  agent 创建时也会补上。

### `subagent` 的空闲复用规则

本插件在该 Agent 的 scope 里注册同名 `subagent` 遮蔽上游定义（schema、output、presenter、并发标记全部沿用），
描述末尾追加规则原文；`execute` 先做预算检查，命中规则就直接抛错，不建立子代理。

计数口径（实现固定为下面这一种，避免歧义）：

| 项 | 口径 |
| --- | --- |
| 「子代理」 | 调用者**直接创建**的、模式为 `continuable` 的子代理（`listDescendants(caller.id)` 中 `depth === 1` 且 `mode === 'continuable'`） |
| 「整体」 | 上面这些子代理的**总数** |
| 「空闲」 | 状态不是 `running` 的子代理（`idle`、未驻留/可再次唤醒的都算空闲） |
| 判定 | `total > 0 && idle * 2 >= total`（即空闲数达到一半及以上） |
| 首次派发 | `total === 0` 时永远允许 |
| 不可继续的子代理 | 不计入：`send_message` 无法向它们派发任务，计入只会把调用者逼进死路 |
| 检查失败 | 读不到子代理目录时**放行**并记 warning，不把「无法判断」变成拒绝 |

命中时抛出的错误（模型可见）会带计数与可派发的空闲子代理名字，例如：

```text
拒绝新建子代理：你现有的 2 个可继续子代理中有 2 个空闲（2 / 2 ≥ 一半）。
如果空闲的子代理数量达到整体的一半及以上，请使用send_message向空闲的子代理派发任务，不允许建立新的子代理。
空闲子代理：reviewer、tester。请调用 send_message({ agent: "<名字>", message: "..." }) 向它们派发任务。
```

只在 `send_message` 对该 Agent 可见时安装这条规则：没有 `send_message` 时，拒绝新建子代理等于断掉它唯一的
委派方式，所以此时保持上游行为不变。

### 委派提示

上游的委派建议（「一次消息里并行发起多个委派」等）绑定在它自己的工具定义身份上；定义被遮蔽后会静默消失。
本插件用 `lineage:delegation` section 复述这段提示（只保留 `subagent`，不再提 `subagent_fork`），
仅在当前 Agent 看到的 `subagent` 正是本插件的遮蔽定义时输出。

## 安装

```sh
dsh plugin --profile web add github:y916/dsh-lineage-teams
```

bundle 只挂一行宿主插件（`lineage-teams`）。它**不注入任何工具**：只在该 Agent 的预设已经声明
`send_message` 时，用同名定义遮蔽它、并用同名定义遮蔽 `subagent`；没有声明 `send_message` 的预设不受影响。
`subagent_fork` 的禁用按 Agent scope 逐一生效。

## 要求

- DSH >= `0.2.2-rc.2`（`0.2.2-rc.1` 及更早的 `@deepseek-ai/dsh-subagent/internal` 与
  `ctx.agentTeams` 体系与本插件不兼容，请用 0.2.x 分支的旧版本）。
- 不需要在预设里挂任何额外工具行；团队工具由上游 `agent-team` / `tool-agent-team` 提供。

## 测试

```sh
node test/smoke.mjs
# 或对着某份 DSH 安装测试：
DSH_INSTALL_ROOT=/path/to/dsh-install node test/smoke.mjs
```

## 与旧版本的关系

0.2.x 的 fork 曾 vendor 上游 `agent-team` 与 `tool-agent-team`（约 2900 行），并替换三件套工具。
那套实现依赖 `@deepseek-ai/dsh-subagent/internal`（`steerHostSubagentPrompt`）与
`ctx.agentTeams` 的创建/通信 API，在 0.2.2-rc.2 起全部消失。0.3.0 起改成本插件只做增量；
0.4.0 加入子代理预算。旧补丁清单已归档到 git 历史，迁移说明见 [PATCHES.md](./PATCHES.md)。
