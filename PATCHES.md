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
