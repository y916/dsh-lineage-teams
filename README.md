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
3. **可配置的子代理创建规则**：全局禁用 `subagent_fork`；`subagent` 描述追加：

   ```text
   在调用此工具之前，先调用list_agents确认子代理情况，优先使用send_message向空闲的子代理派发任务，而不是建立新的子代理。
   ```

   调用时按 5 个设置（2 个上限 + 3 个差异豁免）强制执行，规则上下文随设置实时更新。

```text
你的父级代理是「lead」，根会话（团队负责人）是「lead」。
需要补充信息、纠偏，或发现会影响别人结论的事实时，直接联系：send_message({ agent: "<父级名字>", message: "..." })。
任务一完成就直接向父代理汇报：用 send_message 给父级发一条消息，详细说明结论、证据（命令原文、文件路径与行号）与未完成项，
并给出交付物路径——这条消息就是你的正式汇报，不要指望父级从你的最终回复里读细节。
汇报之后，最终回复只写一句话——「已经汇报完毕。」；不要把汇报内容再贴一遍。
```

## 子代理创建规则与设置

### 5 个设置项

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `idleRatioLimit` | 0–100 滑动条 | `50` | 允许新建的最大空闲子代理**比例**（%） |
| `idleCountLimit` | 0–10 滑动条 | `3` | 允许新建的最大空闲子代理**数量** |
| `allowDifferentPreset` | 开关 | `false` | 超过两个上限时，空闲代理中没有所请求的 `agent_preset` 就放行 |
| `allowDifferentModel` | 开关 | `false` | 超过两个上限时，空闲代理中没有所请求的 `provider+model` 就放行 |
| `allowDifferentCwd` | 开关 | `false` | 超过两个上限时，空闲代理中没有所请求的 `cwd` 就放行 |

前两项**必须同时满足**才允许新建：

- 空闲比例 `idle * 100 <= total * idleRatioLimit`；
- 空闲数量 `idle <= idleCountLimit`；
- `total === 0` 时两项天然满足，允许第一次派发。

超过上限时，只有命中**已开启**的差异豁免才放行；三个豁免**只在超限时**起作用，未超限时不同预设 /
模型 / 目录本来就可以直接建。豁免只认**显式传入**的参数：`agent_preset`、完整的 `provider`+`model`、
`cwd`；省略的参数不触发豁免，错误信息会提示“要豁免就显式写出来”。

口径（实现固定，避免歧义）：

| 项 | 口径 |
| --- | --- |
| 「子代理」 | 调用者**直接创建**的、模式为 `continuable` 的子代理（`listDescendants(caller.id)` 中 `depth === 1` 且 `mode === 'continuable'`） |
| 「整体」 | 上面这些子代理的**总数** |
| 「空闲」 | 状态不是 `running` 的子代理（`idle`、未驻留/可再次唤醒的都算空闲） |
| 不可继续的子代理 | 不计入：`send_message` 无法向它们派发 |
| 检查失败 | 读不到子代理目录时**放行**并记 warning，不把「无法判断」变成拒绝 |

差异判定用空闲子代理的以下信息：

- **预设**：`session.header.agentPreset`；
- **模型**：`provider + model`（`reasoning_effort` 视为调参，不参与比较）；
- **目录**：该 agent 当前工作目录（`workingDirectory` 服务，回退 `session.header.cwd`）。

仍在驻留的空闲代理直接读 live Agent；已冷处理的空闲代理从会话日志补读 header 与
`subagent/descriptor`（provider/model）。某个维度信息读不到时**保守拒绝**该维度的豁免，
不猜测“空闲里没有”。

拒绝时抛出的错误（模型可见）会带失败的上限、当前计数、三个豁免的判定与空闲代理清单，例如：

```text
拒绝新建子代理：空闲比例 75%（3/4）超过上限 50%。两个上限必须同时满足。
当前规则：空闲比例 ≤ 50%，空闲数量 ≤ 3。
差异豁免：预设不同=开（空闲中已有 assistant）；模型不同=关（开关关闭）；工作目录不同=开（空闲中已有 /w）。
空闲子代理：reviewer（assistant / p/m / /w）；tester（assistant / p/x / /w）；scribe（doc-assistant / p/y / /d）。
请先调用 list_agents 确认子代理情况；优先用 send_message 向空闲子代理派发任务。若确实需要不同预设/模型/目录，请在调用时显式传入 agent_preset / provider+model / cwd，并确认对应开关已开启。
```

只在 `send_message` 对该 Agent 可见时安装这条规则：没有 `send_message` 时，拒绝新建子代理等于断掉它唯一的
委派方式，所以此时保持上游行为不变。

### 规则上下文（随设置更新）

每个能看到本插件 `subagent` 遮蔽定义的 Agent 都会收到 `lineage:subagent-rule` 系统提示上下文，写明
当前两个上限、三个开关状态、计数口径与“先 list_agents、优先 send_message”的要求。

system prompt 每步重新组装，5 个字段都是 **volatile** 设置：保存后下一步就生效，不需要重启或重开对话。
检测到某个 Agent 的规则数值发生变化时，变化后的下一步会在该段前加一行
`（子代理创建规则已更新，以下为当前规则）`，让模型明确知道规则变了；再下一步自动清除。

### 设置界面

设置 → 插件 → 已安装 → `@y916/dsh-lineage-teams` 详情页里的「子代理创建规则」卡：2 个滑动条 +
3 个开关 + 保存 / 恢复默认。同一个卡也挂在插件详情页的行配置子页
（`@y916/dsh-lineage-teams#lineage-teams`）。

- 设置存进 profile 里该行的 user 配置层（`~/.dsh/profiles/<name>/cordis.patch.yml`），
  **profile 全局**，所有能用 `subagent` 的 agent 共用。
- 浏览器端是 `client.js`（`dsh.client`，无构建步骤），通过 DSH 的 `configForms` 读写
  `lineage-teams` 命名空间并即时生效；非 Web 环境仍使用同样的默认值，只是没有设置卡。
- 升级插件后刷新一次页面，让新的客户端模块加载。

### 全局禁用 `subagent_fork`

- 对**每个 Agent 的 scope** 调用 `ctx.tools.restrict({ deny: ['subagent_fork'] })`：工具从模型可见列表里消失，
  模型无法选择它；后代 scope 沿 scope 链继承该限制。
- 另注册一个**全局 guard**（`ctx.tools.guard`）：即使调用绕过可见性（PTC、直接 dispatch），也会被拒绝并返回
  `subagent_fork is disabled in this profile. Delegate with subagent, and reuse idle subagents through send_message.`
- fork 工具由独立插件行（`tool-subagent-fork`）注册，可能晚于本插件加载；`tools/change` 后会重试，
  agent 创建时也会补上。

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
`subagent_fork` 的禁用与创建规则按 Agent scope 逐一生效。

热更新（0.3.0 → 0.4.0）时，0.3.0 留下的 `send_message` 遮蔽定义会被 0.4.0 就地接管；仍建议升级后重启
profile 或开新会话，以重建已有 Agent 的 scope。0.5.0 新增浏览器设置卡，升级后刷新页面。

## 要求

- DSH >= `0.2.2-rc.2`（`0.2.2-rc.1` 及更早的 `@deepseek-ai/dsh-subagent/internal` 与
  `ctx.agentTeams` 体系与本插件不兼容，请用 0.2.x 分支的旧版本）。
- 设置卡需要 Web profile（`@deepseek-ai/dsh-web-app`）；Host 侧规则在无界面环境按默认值生效。
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
0.4.0 加入固定一半阈值的子代理预算；0.5.0 改为可配置的两个上限 + 三个差异豁免，并加入浏览器设置卡。
旧补丁清单已归档到 git 历史，迁移说明见 [PATCHES.md](./PATCHES.md)。
