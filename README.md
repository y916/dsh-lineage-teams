# dsh-lineage-teams

Agent Teams 的 fork：保留官方全部能力（耐久名册、共享任务板、`wait_agent`），补上三件事：

1. `spawn_teammate` 可以指定 **agent 预设**、LLM `provider` / `model` / `reasoning_effort`、`cwd`；
2. `send_message({ targets: ["a", "b"], message })` 支持群发（单个也传数组）；
3. 注入给队友/Lead 的 `team:identity` 提示写明：名字、父级 id、组员名单与 `targets` 契约；
4. 兼容 legacy 子代理：`targets` 里可以直接写 agent id（`subagent` 派出的子代理），
   `list_agents` 会把它们以 `role: "child"` 一并列出（默认整棵树，可用 `scope: "children"` 只看直接子代理）；
5. **非团队子代理也有交流指引**：`subagent` / `workflow` / 队友派出的子代理，每步都会注入
   一段 runtime context——父级 agent id、`list_agents` 的用法、`send_message` 的别名约定；
6. `send_message` 支持 `"lead"` / `"parent"` 别名：`"parent"` 是你（或你所在子树的）直接父级，
   `"lead"` 是根会话/团队负责人；非成员也可以用它们在不知道任何 id 的情况下回报。
7. **完成即汇报**：队友与非团队子代理的提示里都写明——任务一完成就直接给父代理/队长发一条消息，
   正文只写一句话「已经汇报完毕。」，详细结论仍放在最终回复里（不重复长汇报）。

## 安装

```sh
dsh plugin --profile web add github:y916/dsh-lineage-teams
```

或本地目录：

```sh
dsh plugin --profile web add /path/to/dsh-lineage-teams
```

bundle 只挂 **域服务**（名册、任务板、journal）。模型可见的团队工具是独立插件
`@y916/dsh-lineage-teams/tools`，**由预设显式声明**——和内置的 `tool-subagent-control`
等行同样的开关语义：

```yaml
- id: lineage-team-tools
  name: "@y916/dsh-lineage-teams/tools"
  config:
    interrupt: true          # 可选，默认 true
```

声明了这一行的预设：成员 agent 拿到 6 个团队专用工具 + 两段团队提示；**没有声明该行的
预设，一个团队专用工具、一段团队提示都没有。**

三件套 `send_message` / `list_agents` / `interrupt_agent` 不在这行开关里：它们由 bundle
的宿主级替换器负责，**任何预设只要自己声明了这三个工具，拿到的就是本 fork 的版本**
（`targets` 群发、整棵可达树、同根投递），无需挂 `.../tools`。

## 子代理（非团队成员）的提示与可达性

非团队成员没有名册，fork 会给它们补一套等价能力：

* **每步注入的 runtime context**（`lineage:subagent-guidance`，仅当该 agent
  声明了 `send_message` / `list_agents` 时）：

  ```
  你是子代理，父级智能体（parent agent）是「<parent session id>」。
  你可以用 list_agents 查看同一根会话下的智能体：父级、兄弟子代理与同组队友（若有），…
  你可以用 send_message 与父级、兄弟子代理或同组队友（若有）交流：…
  - 任务一完成就直接向父代理汇报：用 send_message 给父级发一条消息，正文只写一句话——「已经汇报完毕。」；
    详细结论、证据与未完成项仍放在你的最终回复里，不要重复贴进这条消息。
  ```

  它跟着 `subagent:delegation` 同一 order 渲染，**每步重算**，不写进创建时的任务消息，
  因此不会污染任务本身，也不会被 compaction 挤掉。
* **`list_agents`（非成员）**：父链（根为 `role: "lead"`，其余 `role: "parent"`）+
  同一根会话下的整棵子代理树（`role: "child"`，`target` 即 agent id）；
  `scope: "children"` 只保留自己的直接子代理。状态取自投影条目的 `activity`
  （旧实现读 `entry.status`，永远显示 `inactive`）。
* **`send_message`**：成员沿用团队名册；非成员按 agent id 走同根投递。两种身份都接受
  `"parent"` / `"lead"` 别名（见上）。广播会逐个投递，`failed` 里保留失败原因。
* **`interrupt_agent`**：Lead 按名字中断队友（其他成员按名字调用会被拒绝），任何成员都可以
  用 agent id 中断自己的直接子代理/后代；支持 `agent_id` 简写。

## 与上游的差异

见 [PATCHES.md](./PATCHES.md)。基线：`deepseek-harness` @ `dsh-v0.2.2-rc.1`。

## 注意

- vendored 的是上游**编译产物**（npm 包里没有源码），改动处已标注；
- 升级 DSH 后需要按新 tag 重新 vendor 并重放补丁；
- 依赖正在运行的 DSH 安装提供 `@deepseek-ai/*`，因此不要在本包内安装同名依赖。
