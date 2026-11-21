# dsh-lineage-teams

DSH Agent Teams 的**薄增量插件**（0.2.2-rc.2 起，含 rc.5）。

0.2.2-rc.2 把 AgentTeam 统一成了「具名、多层的 subagent 树」：`spawn_teammate`、Team 专属的
`send_message` / `list_agents` / `interrupt_agent`、`ctx.agentTeams` 的创建/通信/名册 API 全部移除，
命名、多层协作、任务板、`wait_agent` 都由上游提供。因此本插件不再 vendor 任何域代码，只保留两件
上游没有的事：

1. **群发 `send_message`**：在保留上游单目标 `agent` 契约的同时接受 `targets: string[]`，
   逐个投递并返回 `{ delivered, failed }`；`targets` 里可以用 agent 名字、Session id、
   `"parent"`（直接父级）与 `"lead"`（根会话）。
2. **联系人 + 完成即汇报提示**：每个被派出的 agent 都会收到一段提示，写明父级是谁、需要时怎么联系，
   以及完成任务时怎么汇报——详情报文走 `send_message`，最终回复只写一句话。

```text
你的父级代理是「lead」，根会话（团队负责人）是「lead」。
需要补充信息、纠偏，或发现会影响别人结论的事实时，直接联系：send_message({ agent: "<父级名字>", message: "..." })。
任务一完成就直接向父代理汇报：用 send_message 给父级发一条消息，详细说明结论、证据（命令原文、文件路径与行号）与未完成项，
并给出交付物路径——这条消息就是你的正式汇报，不要指望父级从你的最终回复里读细节。
汇报之后，最终回复只写一句话——「已经汇报完毕。」；不要把汇报内容再贴一遍。
```

## 安装

```sh
dsh plugin --profile web add github:y916/dsh-lineage-teams
```

bundle 只挂一行宿主插件（`lineage-teams`）。它**不注入任何工具**：只在该 Agent 的预设已经声明
`send_message` 时，用同名定义遮蔽它；没有声明 `send_message` 的预设不受影响。

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
旧补丁清单已归档到 git 历史，迁移说明见 [PATCHES.md](./PATCHES.md)。
