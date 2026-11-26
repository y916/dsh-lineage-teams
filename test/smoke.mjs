#!/usr/bin/env node
// Self-contained smoke test for the 0.5 line (DSH >= 0.2.2-rc.2).
//
// It loads the real @deepseek-ai/cordis, dsh-tools, dsh-scope, dsh-subagent and
// schemastery packages from the running DSH installation (see lib/deps.mjs),
// then exercises the plugin's own logic with fake Agents and a fake context. No
// dsh process, no Session store, no network.
//
// Run from the repository root:  node test/smoke.mjs
// Against a scratch build:       DSH_INSTALL_ROOT=/path/to/dsh-install node test/smoke.mjs
import assert from 'node:assert/strict'
import { resolve as resolvePath } from 'node:path'
import plugin, { __test, apply } from '../lib/index.mjs'

const {
  buildRuleText,
  buildSendMessage,
  buildSubagent,
  describeTargets,
  evaluateCreation,
  enrichIdleMembers,
  forkGuard,
  guidanceText,
  isLegacySendMessage,
  isSubagentShadow,
  liveValue,
  normalizeSettings,
  refusalMessage,
  requestedCwd,
  requestedPreset,
  requestedRoute,
  resolveTarget,
  sameRoute,
  subagentLoad,
  Config,
  DEFAULT_SETTINGS,
  NEW_SUBAGENT_RULE,
} = __test

// ---------------------------------------------------------------------------
// 1. Target merging: `agent` and `targets` both accepted, empty entries dropped
// ---------------------------------------------------------------------------

assert.deepEqual(describeTargets({ message: 'x' }), [])
assert.deepEqual(describeTargets({ targets: ['a', ' b ', '', '  '] }), ['a', 'b'])
assert.deepEqual(describeTargets({ agent: 'p', targets: ['x'] }), ['p', 'x'])
assert.deepEqual(describeTargets({ agent: 'a', targets: [] }), ['a'])
console.log('ok 1 target merging')

// ---------------------------------------------------------------------------
// 2. Target resolution: names, "parent", "lead"
// ---------------------------------------------------------------------------

{
  const kid = { id: 'kid-1' }
  const ctx = {
    subagents: {
      namesOf: () => ({ self: 'reviewer', parent: 'lead' }),
      resolveName: async (_caller, name) => `id:${name}`,
    },
  }
  assert.deepEqual(await resolveTarget(ctx, kid, 'lead', undefined), { id: 'id:lead', label: 'lead' })
  assert.deepEqual(await resolveTarget(ctx, kid, 'reviewer/checker', undefined), { id: 'id:reviewer/checker', label: 'reviewer/checker' })
  assert.deepEqual(await resolveTarget(ctx, kid, 'parent', undefined), { id: 'id:lead', label: 'lead' })

  const root = { id: 'root-1' }
  const rootCtx = {
    subagents: {
      namesOf: () => ({ self: 'lead' }),
      resolveName: async (_caller, name) => `id:${name}`,
    },
  }
  await assert.rejects(() => resolveTarget(rootCtx, root, 'parent', undefined), /no parent/)
  console.log('ok 2 target resolution')
}

// ---------------------------------------------------------------------------
// 3. Broadcast delivery: per-target success/failure, all-failed throws
// ---------------------------------------------------------------------------

{
  const kid = { id: 'kid-1' }
  const sent = []
  const ctx = {
    subagents: {
      namesOf: () => ({ self: 'kid', parent: 'lead' }),
      resolveName: async (_caller, name) => {
        if (name === 'bogus') throw new Error('no agent named "bogus"')
        return `id:${name}`
      },
      sendMessage: async (_sender, targetId, content) => {
        sent.push({ targetId, text: content[0].text })
        return `msg-${targetId}`
      },
    },
  }
  const definition = buildSendMessage(ctx, kid)
  assert.equal(definition.name, 'send_message')
  const result = await definition.execute(
    { targets: ['reviewer', 'bogus', 'parent'], message: 'done: see work/x.md' },
    { agent: kid, signal: undefined },
  )
  assert.deepEqual(result.delivered, ['reviewer', 'lead'])
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0], /^bogus: /)
  assert.deepEqual(sent.map((entry) => entry.targetId), ['id:reviewer', 'id:lead'])

  await assert.rejects(
    () => definition.execute({ targets: ['bogus'], message: 'x' }, { agent: kid, signal: undefined }),
    /failed for every target/,
  )
  await assert.rejects(
    () => definition.execute({ message: 'x' }, { agent: kid, signal: undefined }),
    /give an `agent` or one or more `targets`/,
  )
  console.log('ok 3 broadcast delivery')
}

// ---------------------------------------------------------------------------
// 4. Guidance: parent/contact + completion rule; root and foreign tools silent
// ---------------------------------------------------------------------------

{
  const kid = { id: 'kid-1' }
  const root = { id: 'root-1' }
  const definition = { name: 'send_message' }
  const ours = new WeakMap([[kid, definition]])

  const ctx = {
    subagents: {
      namesOf: (agent) => (agent === root ? { self: 'lead' } : { self: 'kid', parent: 'lead' }),
    },
    tools: { get: () => definition },
  }
  const text = guidanceText(ctx, ours, { agent: kid, scope: {}, toolSet: undefined })
  assert.match(text, /父级代理是「lead」/)
  assert.match(text, /send_message\(\{ agent: "<父级名字>"/)
  assert.match(text, /targets/)
  assert.match(text, /任务一完成就直接向父代理汇报/)
  assert.match(text, /详细说明结论、证据/)
  assert.match(text, /最终回复只写一句话——「已经汇报完毕。」/)

  assert.equal(guidanceText(ctx, ours, { agent: root, scope: {}, toolSet: undefined }), '', '根会话没有父级')
  assert.equal(guidanceText({ ...ctx, tools: { get: () => ({ name: 'send_message' }) } }, ours, { agent: kid, scope: {}, toolSet: undefined }), '', '不是本插件替换的 send_message 时不注入')
  assert.equal(guidanceText({ subagents: { namesOf: () => { throw new Error('not in tree') } }, tools: { get: () => definition } }, ours, { agent: kid, scope: {}, toolSet: undefined }), '', '不在树中时不注入')
  console.log('ok 4 completion guidance')
}

// ---------------------------------------------------------------------------
// 5. apply(): two contexts, one section, one guard, listener set
// ---------------------------------------------------------------------------

{
  const contexts = []
  const sections = []
  const guards = []
  const listeners = []
  const cleanups = []
  let shadow
  const ctx = {
    agents: { list: () => [] },
    tools: {
      get: (name) => (name === 'subagent' && shadow !== undefined ? shadow : undefined),
      guard: (guard) => {
        guards.push(guard)
        return () => {}
      },
    },
    subagents: { namesOf: () => ({ self: 'lead' }) },
    logger: { warn: () => {} },
    on: (event, listener) => {
      listeners.push(event)
      return () => {}
    },
    effect: (callback) => {
      const cleanup = callback()
      cleanups.push(cleanup)
      return () => {}
    },
    systemPrompt: {
      getContextOrder: (name) => (name === 'SUBAGENT_DELEGATION' ? 42 : 0),
      getSectionOrder: (name) => (name === 'TOOL_SUBAGENT' ? 7 : 0),
      context: (entry) => {
        contexts.push(entry)
        return () => {}
      },
      section: (entry) => {
        sections.push(entry)
        return () => {}
      },
    },
  }
  apply(ctx, {})
  assert.equal(contexts.length, 2)
  assert.equal(contexts[0].name, 'lineage:completion')
  assert.equal(contexts[0].order, 42)
  assert.equal(contexts[0].required, true)
  assert.equal(contexts[0].text({ agent: undefined }), '')
  assert.equal(contexts[1].name, 'lineage:subagent-rule')
  assert.equal(contexts[1].order, 42)
  assert.equal(contexts[1].required, true)
  assert.equal(contexts[1].text({ agent: { id: 'a' }, scope: undefined, toolSet: undefined }), '', 'no shadow: no rule context')
  assert.equal(sections[0].text({ agent: {}, scope: {}, toolSet: undefined }), '', 'no shadow: no delegation guidance')

  shadow = buildSubagent({ tools: { get: () => undefined }, logger: {} }, {
    name: 'subagent',
    description: 'Delegate.',
    parameters: {},
    output: { schema: {}, render: () => [] },
    async execute() { return { kind: 'activation', name: 'x' } },
  }, {})
  const rule = contexts[1].text({ agent: { id: 'a' }, scope: undefined, toolSet: undefined })
  assert.match(rule, /【子代理创建规则（当前设置）】/)
  assert.match(rule, /空闲子代理比例 ≤ 50%/)
  assert.match(rule, /空闲子代理数量 ≤ 3/)

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'lineage:delegation')
  assert.equal(sections[0].order, 7)
  assert.match(sections[0].text({ agent: {}, scope: {}, toolSet: undefined }), /Start independent delegations/)

  assert.equal(guards.length, 1)
  assert.match(guards[0]({ name: 'subagent_fork' }).reason, /subagent_fork is disabled/)
  assert.equal(guards[0]({ name: 'subagent' }), undefined)

  assert.deepEqual(listeners.sort(), ['agent/created', 'agent/disposed', 'tools/change'])
  assert.equal(cleanups.length, 1)
  assert.equal(typeof cleanups[0], 'function')
  console.log('ok 5 plugin wiring')
}

// ---------------------------------------------------------------------------
// 6. Settings normalization: defaults, Volatile fields, clamping
// ---------------------------------------------------------------------------

{
  assert.deepEqual(DEFAULT_SETTINGS, { ratio: 50, count: 3, preset: false, model: false, cwd: false })
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({
    idleRatioLimit: { get: () => 30 },
    idleCountLimit: { get: () => 1 },
    allowDifferentPreset: { get: () => true },
    allowDifferentModel: { get: () => false },
    allowDifferentCwd: { get: () => true },
  }), { ratio: 30, count: 1, preset: true, model: false, cwd: true })
  assert.deepEqual(normalizeSettings({ idleRatioLimit: 500, idleCountLimit: 99 }), { ratio: 100, count: 10, preset: false, model: false, cwd: false })
  assert.deepEqual(normalizeSettings({ idleRatioLimit: 'x', idleCountLimit: null }).ratio, 50)
  assert.deepEqual(normalizeSettings({ idleRatioLimit: undefined }).count, 3)
  assert.equal(liveValue({ get: () => 7 }, 1), 7)
  assert.equal(liveValue({ get: () => { throw new Error('closed') } }, 9), 9)
  assert.equal(liveValue(undefined, 9), 9)

  const resolved = Config({})
  assert.deepEqual(normalizeSettings(resolved), DEFAULT_SETTINGS, 'Config defaults match the browser card')
    assert.equal(plugin.Config, Config, 'the Loader reads the default export, so it must carry Config')
console.log('ok 6 settings normalization')
}

// ---------------------------------------------------------------------------
// 7. subagentLoad: continuable direct children only, live metadata
// ---------------------------------------------------------------------------

{
  const caller = { id: 'parent-1' }
  const entries = [
    { kind: 'child', id: 'c1', depth: 1, mode: 'continuable', path: 'reviewer' },
    { kind: 'child', id: 'c2', depth: 1, mode: 'continuable', path: 'tester' },
    { kind: 'child', id: 'c3', depth: 1, mode: 'one-shot', path: 'one-shot' },
    { kind: 'child', id: 'g1', depth: 2, mode: 'continuable', path: 'reviewer/checker' },
    { kind: 'diagnostic', id: 'd1', depth: 1, reason: 'corrupt' },
  ]
  const agents = {
    c1: { status: 'running', options: { provider: 'p', model: 'm' }, session: { header: { agentPreset: 'assistant', cwd: '/a' } } },
    c2: { status: 'idle', options: { provider: 'p', model: 'x' }, session: { header: { agentPreset: 'director', cwd: '/b' } } },
  }
  const ctx = {
    subagents: { listDescendants: async (id) => { assert.equal(id, 'parent-1'); return entries } },
    agents: { get: (id) => agents[id] },
  }
  const load = await subagentLoad(ctx, caller, undefined)
  assert.equal(load.total, 2)
  assert.equal(load.idle, 1)
  assert.deepEqual(load.idleMembers, [{
    id: 'c2',
    name: 'tester',
    running: false,
    preset: 'director',
    route: { provider: 'p', model: 'x' },
    cwd: '/b',
  }])
  console.log('ok 7 subagent load')
}

// ---------------------------------------------------------------------------
// 8. enrichIdleMembers: header + descriptor fill cold metadata, then dispose
// ---------------------------------------------------------------------------

{
  let observed = 0
  let disposed = 0
  const member = { id: 'cold-1', preset: undefined, route: undefined, cwd: undefined }
  const ctx = {
    get: (name) => (name === 'sessionQuery' ? {
      observeSession: async (id, options) => {
        assert.equal(id, 'cold-1')
        assert.equal(options.projectionMode, 'none')
        observed += 1
        return {
          header: { agentPreset: 'doc-assistant', cwd: '/work' },
          events: [{ type: 'subagent/descriptor', data: { agentProvider: 'p', agentModel: 'm', agentReasoningEffort: 'high' } }],
          [Symbol.dispose]: () => { disposed += 1 },
        }
      },
    } : undefined),
  }
  await enrichIdleMembers(ctx, [member], { preset: false, model: false, cwd: true, ratio: 50, count: 3 }, new AbortController().signal)
  assert.deepEqual(member, {
    id: 'cold-1',
    preset: 'doc-assistant',
    route: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    cwd: '/work',
  })
  assert.equal(observed, 1)
  assert.equal(disposed, 1)

  // Switches off: no session reads at all.
  let reads = 0
  await enrichIdleMembers({
    get: () => ({ observeSession: async () => { reads += 1 } }),
  }, [{ id: 'x' }], { preset: false, model: false, cwd: false, ratio: 50, count: 3 }, undefined)
  assert.equal(reads, 0)

  // Unreadable log: fields stay unknown, no throw.
  const unknown = { id: 'bad', preset: undefined, route: undefined, cwd: undefined }
  await enrichIdleMembers({
    get: () => ({ observeSession: async () => { throw new Error('unavailable') } }),
  }, [unknown], { preset: true, model: true, cwd: true, ratio: 50, count: 3 }, undefined)
  assert.deepEqual(unknown, { id: 'bad', preset: undefined, route: undefined, cwd: undefined })
  console.log('ok 8 cold metadata')
}

// ---------------------------------------------------------------------------
// 9. evaluateCreation: budgets, boundaries, exceptions, conservative unknown
// ---------------------------------------------------------------------------

{
  const off = { ratio: 50, count: 3, preset: false, model: false, cwd: false }
  const allOn = { ratio: 50, count: 3, preset: true, model: true, cwd: true }
  const member = (overrides = {}) => ({ name: 'm', preset: 'assistant', route: { provider: 'p', model: 'm' }, cwd: '/w', ...overrides })
  const load = (total, idleMembers) => ({ total, idle: idleMembers.length, idleMembers })
  const request = (overrides = {}) => ({ preset: undefined, route: undefined, cwd: undefined, ...overrides })
  // Three idle of four: 75% fails the ratio limit, so the exceptions are reachable.
  const fail = (members) => load(4, members)

  // Budget passes, including the 50% ratio boundary, the count boundary, and zero.
  assert.equal(evaluateCreation(load(0, []), request(), off).allow, true)
  assert.equal(evaluateCreation(load(4, [member()]), request(), off).allow, true, '1/4 is under both limits')
  assert.equal(evaluateCreation(load(2, [member()]), request(), off).allow, true, '1/2 is exactly 50%, inclusive')
  assert.equal(evaluateCreation(load(2, [member({ preset: 'assistant' })]), request({ preset: 'assistant' }), off).allow, true, 'budget passes before any exception')
  assert.equal(evaluateCreation(load(10, [member(), member(), member()]), request(), { ...off, ratio: 100 }).allow, true, 'count=3 is inclusive')

  // Ratio fails at 75%; count passes at 3.
  const overRatio = evaluateCreation(fail([member(), member(), member()]), request(), off)
  assert.equal(overRatio.allow, false)
  assert.equal(overRatio.ratioOk, false)
  assert.equal(overRatio.countOk, true)

  // Count fails at 4 even at 100% ratio.
  const overCount = evaluateCreation(load(10, [member(), member(), member(), member()]), request(), { ...off, ratio: 100 })
  assert.equal(overCount.allow, false)
  assert.equal(overCount.ratioOk, true)
  assert.equal(overCount.countOk, false)

  // Ratio boundary at 49% is exclusive by arithmetic.
  const ratio49 = evaluateCreation(load(2, [member()]), request(), { ...off, ratio: 49 })
  assert.equal(ratio49.allow, false)
  assert.equal(ratio49.ratioOk, false)
  assert.equal(ratio49.countOk, true)

  // Preset exception: only when the requested preset is explicit and absent
  // from every idle member; a match or unknown metadata withholds it.
  assert.equal(evaluateCreation(fail([member({ preset: 'director' }), member({ preset: 'director' }), member({ preset: 'director' })]), request({ preset: 'assistant' }), allOn).allow, true)
  assert.equal(evaluateCreation(fail([member({ preset: 'assistant' }), member({ preset: 'assistant' }), member({ preset: 'assistant' })]), request({ preset: 'assistant' }), allOn).allow, false)
  assert.equal(evaluateCreation(fail([member({ preset: undefined }), member({ preset: undefined }), member({ preset: undefined })]), request({ preset: 'assistant' }), allOn).allow, false)
  assert.equal(evaluateCreation(fail([member({ preset: 'director' }), member({ preset: 'director' }), member({ preset: 'director' })]), request({ preset: 'assistant' }), { ...allOn, preset: false }).allow, false)
  assert.equal(evaluateCreation(fail([member({ preset: 'director' }), member({ preset: 'director' }), member({ preset: 'director' })]), request(), allOn).allow, false, 'omitted preset never grants')

  // Model exception: provider+model only; effort is not compared.
  assert.equal(evaluateCreation(fail([member({ route: { provider: 'p', model: 'x' } }), member({ route: { provider: 'p', model: 'y' } }), member({ route: { provider: 'p', model: 'z' } })]), request({ route: { provider: 'p', model: 'm' } }), allOn).allow, true)
  assert.equal(evaluateCreation(fail([member({ route: { provider: 'p', model: 'x' } }), member({ route: { provider: 'p', model: 'm' } }), member({ route: { provider: 'p', model: 'z' } })]), request({ route: { provider: 'p', model: 'm' } }), allOn).allow, false)
  assert.equal(evaluateCreation(fail([member({ route: undefined }), member({ route: undefined }), member({ route: undefined })]), request({ route: { provider: 'p', model: 'm' } }), allOn).allow, false)
  assert.equal(evaluateCreation(fail([member({ route: { provider: 'p', model: 'x' } }), member({ route: { provider: 'p', model: 'y' } }), member({ route: { provider: 'p', model: 'z' } })]), request({ route: { provider: 'p', model: 'm' } }), { ...allOn, model: false }).allow, false)

  // CWD exception.
  assert.equal(evaluateCreation(fail([member({ cwd: '/a' }), member({ cwd: '/b' }), member({ cwd: '/c' })]), request({ cwd: '/w' }), allOn).allow, true)
  assert.equal(evaluateCreation(fail([member({ cwd: '/a' }), member({ cwd: '/w' }), member({ cwd: '/c' })]), request({ cwd: '/w' }), allOn).allow, false)
  assert.equal(evaluateCreation(fail([member({ cwd: undefined }), member({ cwd: undefined }), member({ cwd: undefined })]), request({ cwd: '/w' }), allOn).allow, false)
  assert.equal(evaluateCreation(fail([member({ cwd: '/a' }), member({ cwd: '/b' }), member({ cwd: '/c' })]), request({ cwd: '/w' }), { ...allOn, cwd: false }).allow, false)
  assert.equal(evaluateCreation(fail([member({ cwd: '/a' }), member({ cwd: '/b' }), member({ cwd: '/c' })]), request(), allOn).allow, false, 'omitted cwd never grants')

  // Any one enabled dimension can grant while another is matched.
  assert.equal(evaluateCreation(fail([
    member({ preset: 'assistant', cwd: '/w', route: { provider: 'p', model: 'x' } }),
    member({ preset: 'assistant', cwd: '/w', route: { provider: 'p', model: 'y' } }),
    member({ preset: 'assistant', cwd: '/w', route: { provider: 'p', model: 'z' } }),
  ]), request({ preset: 'assistant', cwd: '/w', route: { provider: 'p', model: 'm' } }), allOn).allow, true)

  // Omitted/off dimensions are reported but never grant.
  const details = evaluateCreation(fail([member(), member(), member()]), request(), { ...off, preset: true }).details
  assert.deepEqual(details, { preset: 'not-requested', model: 'off', cwd: 'off' })
  console.log('ok 9 creation evaluation')
}

// ---------------------------------------------------------------------------
// 10. Refusal text: failing limits, both limits, exceptions, idle members
// ---------------------------------------------------------------------------

{
  const settings = { ratio: 50, count: 3, preset: true, model: false, cwd: true }
  const idle = [
    { name: 'reviewer', preset: 'assistant', route: { provider: 'p', model: 'm' }, cwd: '/w' },
    { name: 'tester', preset: 'assistant', route: { provider: 'p', model: 'x' }, cwd: '/w' },
    { name: 'scribe', preset: 'doc-assistant', route: { provider: 'p', model: 'y' }, cwd: '/d' },
  ]
  const load = { total: 4, idle: 3, idleMembers: idle }
  const request = { preset: 'assistant', route: undefined, cwd: '/w' }
  const decision = evaluateCreation(load, request, settings)
  assert.equal(decision.allow, false)
  const text = refusalMessage(load, request, settings, decision)
  assert.match(text, /拒绝新建子代理：空闲比例 75%（3\/4）超过上限 50%/)
  assert.match(text, /当前规则：空闲比例 ≤ 50%，空闲数量 ≤ 3/)
  assert.match(text, /预设不同=开（空闲中已有 assistant）/)
  assert.match(text, /模型不同=关（开关关闭）/)
  assert.match(text, /工作目录不同=开（空闲中已有 \/w）/)
  assert.match(text, /空闲子代理：reviewer（assistant \/ p\/m \/ \/w）/)
  assert.match(text, /list_agents/)
  assert.match(text, /显式传入 agent_preset \/ provider\+model \/ cwd/)

  const bothSettings = { ...settings, ratio: 30, preset: false, cwd: false }
  const bothLoad = { total: 10, idle: 4, idleMembers: idle.slice(0, 4) }
  const bothRequest = { preset: undefined, route: undefined, cwd: undefined }
  const both = evaluateCreation(bothLoad, bothRequest, bothSettings)
  assert.equal(both.ratioOk, false)
  assert.equal(both.countOk, false)
  const bothText = refusalMessage(bothLoad, bothRequest, bothSettings, both)
  assert.match(bothText, /空闲比例 40%（4\/10）超过上限 30%/)
  assert.match(bothText, /空闲数量 4 超过上限 3/)
  console.log('ok 10 refusal text')
}

// ---------------------------------------------------------------------------
// 11. subagent shadow: exact description, delegate/refuse/exception paths
// ---------------------------------------------------------------------------

{
  const entries = []
  const agents = {}
  const warnings = []
  const ctx = {
    subagents: { listDescendants: async () => entries },
    agents: { get: (id) => agents[id] },
    logger: { warn: (message) => warnings.push(message) },
  }
  let delegated = 0
  const current = {
    name: 'subagent',
    description: 'Delegate a task.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    isConcurrencySafe: () => true,
    async execute() {
      delegated += 1
      return { kind: 'activation', name: 'agent-1' }
    },
  }

  const definition = buildSubagent(ctx, current, {})
  assert.equal(definition.name, 'subagent')
  assert.ok(definition.description.startsWith('Delegate a task.\n\n'))
  assert.ok(definition.description.endsWith(NEW_SUBAGENT_RULE))
  assert.equal(definition.description.includes('如果空闲的子代理数量达到整体的一半及以上'), false)
  assert.equal(definition.parameters, current.parameters)
  assert.equal(definition.output, current.output)
  assert.equal(definition.isConcurrencySafe(), true)
  assert.equal(isSubagentShadow(definition), true)
  assert.equal(isSubagentShadow(current), false)

  const exec = (signal = new AbortController().signal) => ({ agent: { id: 'p', session: { header: { cwd: '/base' } } }, signal })

  // No children: delegate.
  assert.deepEqual(await definition.execute({ prompt: 'x' }, exec()), { kind: 'activation', name: 'agent-1' })
  assert.equal(delegated, 1)

  // One idle child out of one (100%): defaults refuse and name it.
  entries.push({ kind: 'child', id: 'c1', depth: 1, mode: 'continuable', path: 'reviewer' })
  agents.c1 = { status: 'idle', options: { provider: 'p', model: 'm' }, session: { header: { agentPreset: 'director', cwd: '/w' } } }
  await assert.rejects(() => definition.execute({ prompt: 'x' }, exec()), /拒绝新建子代理：空闲比例 100%（1\/1）超过上限 50%/)
  assert.equal(delegated, 1, 'refused calls never delegate')

  // Preset exception: switch on, requested preset absent from idle members.
  const excepting = buildSubagent(ctx, current, { allowDifferentPreset: true })
  assert.deepEqual(
    await excepting.execute({ prompt: 'x', agent_preset: 'assistant' }, exec()),
    { kind: 'activation', name: 'agent-1' },
  )
  assert.equal(delegated, 2)
  // Same preset as the idle member: no exception.
  await assert.rejects(
    () => excepting.execute({ prompt: 'x', agent_preset: 'director' }, exec()),
    /拒绝新建子代理/,
  )

  // Live Volatile fields are read at call time.
  const live = buildSubagent(ctx, current, {
    idleRatioLimit: { get: () => 100 },
    idleCountLimit: { get: () => 3 },
    allowDifferentPreset: { get: () => false },
  })
  assert.deepEqual(await live.execute({ prompt: 'x' }, exec()), { kind: 'activation', name: 'agent-1' })

  // Inspection failure fails open, with a warning.
  ctx.subagents.listDescendants = async () => { throw new Error('catalog unavailable') }
  const beforeWarnings = warnings.length
  assert.equal((await definition.execute({ prompt: 'x' }, exec())).name, 'agent-1')
  assert.equal(warnings.length, beforeWarnings + 1)
  assert.match(warnings.at(-1), /cannot inspect subagent load/)

  // A cancelled call keeps its cancellation.
  const controller = new AbortController()
  controller.abort()
  ctx.subagents.listDescendants = async () => { throw new Error('cancelled') }
  await assert.rejects(() => definition.execute({ prompt: 'x' }, exec(controller.signal)), /cancelled/)

  // No caller: leave the decision to upstream.
  assert.equal((await definition.execute({ prompt: 'x' }, { agent: undefined, signal: new AbortController().signal })).name, 'agent-1')
  console.log('ok 11 subagent shadow')
}

// ---------------------------------------------------------------------------
// 12. Rule context: current values and the one-step update marker
// ---------------------------------------------------------------------------

{
  const base = normalizeSettings({})
  const text = buildRuleText(base, false)
  assert.match(text, /【子代理创建规则（当前设置）】/)
  assert.match(text, /空闲子代理比例 ≤ 50%/)
  assert.match(text, /空闲子代理数量 ≤ 3/)
  assert.match(text, /预设不同（关/)
  assert.match(text, /模型不同（关/)
  assert.match(text, /工作目录不同（关/)
  assert.match(text, /本段数值随设置实时更新/)

  const changed = buildRuleText(normalizeSettings({ idleRatioLimit: 30, allowDifferentPreset: true }), true)
  assert.ok(changed.startsWith('（子代理创建规则已更新，以下为当前规则）\n'))
  assert.match(changed, /空闲子代理比例 ≤ 30%/)
  assert.match(changed, /预设不同（开/)
  console.log('ok 12 rule context')
}

// ---------------------------------------------------------------------------
// 13. Requested values: explicit only; route ignores reasoning effort
// ---------------------------------------------------------------------------

{
  assert.equal(requestedPreset({ agent_preset: 'assistant' }), 'assistant')
  assert.equal(requestedPreset({ agent_preset: '' }), undefined)
  assert.equal(requestedPreset({}), undefined)

  assert.deepEqual(requestedRoute({ provider: 'p', model: 'm', reasoning_effort: 'high' }), { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(requestedRoute({ provider: 'p' }), undefined)
  assert.equal(requestedRoute({ model: 'm' }), undefined)
  assert.equal(requestedRoute({}), undefined)
  assert.equal(sameRoute({ provider: 'p', model: 'm', reasoningEffort: 'low' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }), true)
  assert.equal(sameRoute({ provider: 'p', model: 'm' }, { provider: 'p', model: 'x' }), false)
  assert.equal(sameRoute(undefined, { provider: 'p', model: 'm' }), false)

  const ctx = { get: (name) => (name === 'workingDirectory' ? { get: () => '/base' } : undefined) }
  const caller = { id: 'p', session: { header: { cwd: '/base' } } }
  assert.equal(requestedCwd(ctx, caller, { cwd: 'child' }), resolvePath('/base', 'child'))
  assert.equal(requestedCwd(ctx, caller, { cwd: '/absolute' }), '/absolute')
  assert.equal(requestedCwd(ctx, caller, {}), undefined)
  console.log('ok 13 requested values')
}

// ---------------------------------------------------------------------------
// 14. subagent_fork guard
// ---------------------------------------------------------------------------

{
  const denial = forkGuard({ name: 'subagent_fork' })
  assert.match(denial.reason, /subagent_fork is disabled/)
  assert.match(denial.reason, /send_message/)
  assert.equal(forkGuard({ name: 'subagent' }), undefined)
  assert.equal(forkGuard({ name: 'send_message' }), undefined)
  console.log('ok 14 fork guard')
}

// ---------------------------------------------------------------------------
// 15. Legacy send_message shadow detection (hot update from 0.3.0)
// ---------------------------------------------------------------------------

{
  const legacy = {
    name: 'send_message',
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string' }, targets: { type: 'array' }, message: { type: 'string' } },
      required: ['message'],
    },
  }
  const upstream = {
    name: 'send_message',
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string' }, message: { type: 'string' } },
      required: ['agent', 'message'],
    },
  }
  assert.equal(isLegacySendMessage(legacy), true)
  assert.equal(isLegacySendMessage(upstream), false, 'upstream single-target contract is never adopted')
  assert.equal(isLegacySendMessage({ name: 'subagent', parameters: legacy.parameters }), false)
  assert.equal(isLegacySendMessage(undefined), false)
  assert.equal(isLegacySendMessage({ name: 'send_message', parameters: {} }), false)
  console.log('ok 15 legacy shadow detection')
}

console.log('SMOKE TEST PASSED')
