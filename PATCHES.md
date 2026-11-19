# 与上游的差异

基线：`deepseek-ai/deepseek-harness` @ `dsh-v0.2.2-rc.1`

- 域：`packages/experimental/agent-team/lib/index.js` → `lib/team-domain.mjs`
- 工具：`packages/experimental/tool-agent-team/lib/index.js` → `lib/team-tools.mjs`

## 1. 域：创建队友时透传预设与路由（`spawnAdmitted`）

```diff
  request: {
    prompt: request.prompt,
    parent: root,
+   ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
+   ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
+   ...(request.cwd === undefined ? {} : { cwd: request.cwd })
  },
```

这是官方实现"每个队友都是同一个预设"的唯一原因：请求里没带 `agentPreset`。

## 2. 工具：`spawn_teammate` 增加参数

`agent_preset`、`provider`、`model`、`reasoning_effort`、`cwd`；`provider`/`model` 必须成对给出。
`context: "fork"` 时忽略预设与路由（fork 继承 Lead 的组合）。

## 3. 工具：`send_message` 改为群发

参数从 `target` 改成 `targets: string[]`（单个也传数组），逐个投递，返回
`{ delivered: [...], failed: [...] }`；全部失败才抛错。

## 4. 工具：`team:identity` 提示重写

改为：名字、父级 agent id、其他组员名单、`send_message({ targets: [...] })` 契约、
共享工作空间但拿不到对话/工具输出/推理、发送不结束本轮、不必回"收到"。

## 5. 模块解析

`lib/deps.mjs` 从**正在运行的 DSH 安装**解析 `@deepseek-ai/*`（`$DSH_INSTALL_ROOT` →
`process.argv[1]` → 本地解析）。不能从本包的 node_modules 解析：第二份 `@deepseek-ai/cordis`
会产生不同的 `Service` 基类，服务注册会失效。

## 未改动

五个 `team_task_*` 工具、`wait_agent`、`interrupt_agent`、`list_agents`、roster/journal/
projection、任务板 CAS 与依赖 DAG，均为官方原样。

## 6. legacy 子代理兼容（混用两套）

官方团队工具只认"团队成员"，而 `subagent` 派出的子代理不是成员，于是根会话
`list_agents` 看不到它、`send_message` 也发不进去。本 fork 补齐：

* `send_message({ targets })`：先按成员名解析；不是成员就把该值当 agent id，
  走**同根会话**投递（由目标的直接父级经 `steerHostSubagentPrompt` 授权，消息 source
  保留真实发送者）。
* `list_agents`：返回团队成员 + `ctx.subagents.listDescendants()` 里的 legacy 子代理
  （`role: "child"`，`target` 即 agent id）。
* `interrupt_agent`：成员按名字；其余按 agent id，走 `ctx.subagents.interrupt`。
* 工具插件 inject 增加 `subagents`。

因此两套可以并存：团队通道（名字、群发、任务板、wait_agent）与 legacy 通道
（`subagent` + `agent_id`)都能用。

## 7. `list_agents` 增加可选 `scope`

* `scope: "all"`（默认）：团队成员 + 整棵 legacy 子代理树；
* `scope: "children"`：团队成员 + 仅直接子代理（`depth === 1`）。

两者都用 `ctx.subagents.listDescendants()` 的投影条目（形状统一：kind/parentId/depth/activity），
`children` 只是按 depth 过滤；`listChildren()` 返回的是原始 catalog 条目（没有 kind/depth），
不宜直接混用。

## 8. 委派深度（maxDepth）

`team` 域的 `startActivation` 原本完全不传 `maxDepth`，等于绕过了宿主/工具层的深度上限。
现在：

* 域：`spawnAdmitted` 里取 `request.maxDepth ?? ctx.subagents.resolveMaxDepth(undefined)`，
  随激活请求下发；
* 工具：`spawn_teammate` 新增可选 `max_depth`（绝对深度上限，省略则用宿主
  `@deepseek-ai/dsh-subagent` 的 `maxDepth` 配置，默认 1）。

真正的"能派几层"由**发起方**的 `tool-subagent` 行配置或宿主 `subagent` 行配置决定：
`resolveMaxDepth(configured)` = 行配置 ?? 宿主配置（默认 1）。宿主配置可在 profile 补丁里改：

```yaml
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxDepth: 3
```

另：投递到某代理需要它的**直接父级在场**；父级已结束时先唤醒父级，再由它转给自己的子代理。

## 9. 父级已结束时的自动中转（不再直接报错）

投递必须由目标的直接父级授权，而父级可能已结算。现在改为：

1. 沿 `sessionQuery` 的会话头**上溯到根**（祖先可以已结算），仍然校验同根；
2. 若目标的直接父级不在场：先给它发一条**通知**（"我即将给你的子代理 X 发消息，你无需转发"），
   这会唤醒父级；随后由本插件**直接投递**给目标子代理（此时父级已在场，授权成立）；
3. 只有唤醒失败时才退回"请父级转交"的老办法，并用 `relayed: [target]` 标注。

父级若也不在场，会继续上溯一层（最多 4 跳），最终落在根会话（永远在场）。
注意中转是**模型执行**的：父级必须照说明转发，不能保证目标一定处理。

## 10. `send_message` 也装给非成员（legacy 子代理）

团队工具原来只装在成员 scope，legacy 子代理（`subagent` 派出的）只有预设自带的
`send_message({agent_id})`，只能找父级——于是深层子代理无法直接回报根会话。
现在：所有 agent 都装 `send_message`（成员装整套工具，非成员只装这一个），参数同时接受
`targets: string[]` 与 `agent_id`（后者兼容运行时给子代理追加的回报指引），
非成员调用时按"同根会话 + 需要时中转"的路径投递。

同时 `deliverUnderRoot` 的发送者根会话解析也改为沿会话存储上溯，祖先已结算也能判定。

## 11. 工具改为显式声明（与内置插件同一开关形状）

原来的 bundle 在宿主挂一次，然后把团队工具塞进每个 agent。现在拆成两层，和
`tool-subagent-control` 这类内置行的用法一致：

* **bundle**（`@y916/dsh-lineage-teams`）只挂域服务 `TeamService`（名册/任务板/journal）；
* **工具** 是独立插件 `@y916/dsh-lineage-teams/tools`，预设要在自己的 `plugins` 里
  显式写一行才会加载：

```yaml
- id: lineage-team-tools
  name: "@y916/dsh-lineage-teams/tools"
  config: { interrupt: true }
```

* 插件按作用域过滤：只给**挂载该行的预设**所组合出的 agent 安装（`scopeOf(ctx)` 的
  子树），其他预设的 agent 完全不受影响。未声明 = 没有团队工具、没有 `team:policy` /
  `team:identity`。
* 三件套 `send_message` / `list_agents` / `interrupt_agent` **不在这个插件里**：它们由
  bundle 的宿主级替换器（`lineage-team-replacements`）负责——只要某个 agent 的组合
  **已经声明**了同名工具，就换成 fork 版本；没声明就一个也不加。因此没挂
  `@y916/dsh-lineage-teams/tools` 的预设（例如 `cordis`、`minimal`）也会得到修改版的
  三件套（前提是它自己声明了 `tool-subagent-control`），但拿不到团队专用工具。
* 其余 6 个团队专用工具（`spawn_teammate`、`wait_agent`、`team_task_*`）与两段提示只装给
  **成员**，且只在挂了该行的预设里生效。
* legacy 子代理（`subagent` 派出的）沿用父级预设：三件套随宿主替换生效，团队专用工具
  不生效。

## 12. 非团队子代理的交流指引、别名与列表修复

### 12.1 子代理 runtime context（`lineage:subagent-guidance`）

宿主级替换器在安装三件套时，给**非团队、且有父级**的 agent 额外注册一段
`systemPrompt.context`（order 取 `SUBAGENT_DELEGATION`，每步重算）：

* 父级 agent id（`session.header.parentSession`）；
* `list_agents` 能看到哪些智能体、`scope` 的含义；
* `send_message` 的 `"parent"` / `"lead"` 别名与多目标群发；
* 共享工作空间但不共享对话/工具输出/推理；发送不结束本轮；最终结果仍作为回复返回。

只在该 agent 的预设**确实声明**了 `send_message` / `list_agents` 时注入，避免提示里出现
它没有的工具；`interrupt_agent` 同理。这样也补上了上游"adjacent send_message"注入在
fork 替换后失效的问题（替换版没有打内部标记，标准引导不会追加）。

### 12.2 别名

`send_message` 的 `targets` 现在接受：

* `"lead"`：团队成员 → Team 服务按 `lead` 解析；非成员 → 上溯到根会话 id；
* `"parent"`：队友 → Team Lead（`lead`）；非成员 → 直接父级 id；Lead/根会话调用报错。

其余值仍按成员名（成员）或 agent id（同根投递）解析。

### 12.3 `list_agents` 修复

* 成员：名册 + 整棵根会话子代理树（`scope: "children"` 时只保留 `parentId === caller.id`）；
* 非成员：父链（最近优先，反转后展示）+ 根会话下的整棵树，排除自己与祖先；
* 状态改用投影条目的 `activity`（原来误读 `entry.status`，永远 `inactive`）；
* 根目录读不到时回退到自己的子树，而不是直接抛错。

### 12.4 `interrupt_agent`

* 描述改为"Lead 按名字中断队友 / 任何成员按 id 中断自己的子代理"，不再对所有人宣称 Lead only；
* 非 Lead 按名字中断队友会明确报错，而不是落到 `subagents.interrupt("名字")`；
* 支持 `agent_id` 简写；团队路径返回值统一为 `{ accepted, target, previousStatus? }`。

### 12.5 `team:identity` 文案

队友：可联系父级、任意组员**或其他智能体**（同根子代理），`"lead"`/`"parent"` 都指父级，
也可以直接写组员名或 agent id。Lead（根会话）使用单独的文案，不再声称"父级是它自己"。
成员列表改为"含你共 N 人"，并说明名单会变化、以 `list_agents` 为准。
