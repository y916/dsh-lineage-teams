# dsh-lineage-teams

Agent Teams 的 fork：保留官方全部能力（耐久名册、共享任务板、`wait_agent`），补上三件事：

1. `spawn_teammate` 可以指定 **agent 预设**、LLM `provider` / `model` / `reasoning_effort`、`cwd`；
2. `send_message({ targets: ["a", "b"], message })` 支持群发（单个也传数组）；
3. 注入给队友/Lead 的 `team:identity` 提示写明：名字、父级 id、组员名单与 `targets` 契约；
4. 兼容 legacy 子代理：`targets` 里可以直接写 agent id（`subagent` 派出的子代理），
   `list_agents` 会把它们以 `role: "child"` 一并列出（默认整棵树，可用 `scope: "children"` 只看直接子代理）。

## 安装

```sh
dsh plugin --profile web add github:y916/dsh-lineage-teams
```

或本地目录：

```sh
dsh plugin --profile web add /path/to/dsh-lineage-teams
```

安装后每个根会话即隐式 Team Lead；用 `spawn_teammate` 建队友，用 `send_message({targets})` 互通。

## 与上游的差异

见 [PATCHES.md](./PATCHES.md)。基线：`deepseek-harness` @ `dsh-v0.2.2-rc.1`。

## 注意

- vendored 的是上游**编译产物**（npm 包里没有源码），改动处已标注；
- 升级 DSH 后需要按新 tag 重新 vendor 并重放补丁；
- 依赖正在运行的 DSH 安装提供 `@deepseek-ai/*`，因此不要在本包内安装同名依赖。
