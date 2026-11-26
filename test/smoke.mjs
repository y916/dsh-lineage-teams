#!/usr/bin/env node
// Self-contained smoke test for the 0.3 line (DSH >= 0.2.2-rc.2).
//
// It loads the real @deepseek-ai/cordis, dsh-tools, dsh-scope and dsh-subagent
// packages from the running DSH installation (see lib/deps.mjs), then exercises
// the plugin's own logic with fake Agents and a fake context. No dsh process, no
// Session store, no network.
//
// Run from the repository root:  node test/smoke.mjs
// Against a scratch build:       DSH_INSTALL_ROOT=/path/to/dsh-install node test/smoke.mjs
import assert from 'node:assert/strict'
import { __test, apply } from '../lib/index.mjs'

const {
  describeTargets,
  resolveTarget,
  buildSendMessage,
  buildSubagent,
  forkGuard,
  guidanceText,
  idleBudgetViolation,
  isSubagentShadow,
  subagentLoad,
  IDLE_REUSE_RULE,
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
// 5. apply(): completion context + delegation section + fork guard
// ---------------------------------------------------------------------------

{
  const contexts = []
  const sections = []
  const guards = []
  const listeners = []
  const cleanups = []
  const ctx = {
    agents: { list: () => [] },
    tools: {
      get: () => undefined,
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
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].name, 'lineage:completion')
  assert.equal(contexts[0].order, 42)
  assert.equal(contexts[0].required, true)
  assert.equal(contexts[0].text({ agent: undefined }), '')

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'lineage:delegation')
  assert.equal(sections[0].order, 7)
  assert.equal(sections[0].text({ agent: {}, scope: {}, toolSet: undefined }), '', 'not our shadow: stay silent')

  assert.equal(guards.length, 1)
  assert.match(guards[0]({ name: 'subagent_fork' }).reason, /subagent_fork is disabled/)
  assert.equal(guards[0]({ name: 'subagent' }), undefined)

  assert.deepEqual(listeners.sort(), ['agent/created', 'agent/disposed', 'tools/change'])
  assert.equal(cleanups.length, 1)
  assert.equal(typeof cleanups[0], 'function')
  console.log('ok 5 plugin wiring')
}

// ---------------------------------------------------------------------------
// 6. idle/reuse counting: continuable direct children only, idle = not running
// ---------------------------------------------------------------------------

{
  const caller = { id: 'parent-1' }
  const entries = [
    { kind: 'child', id: 'c1', depth: 1, mode: 'continuable', path: 'reviewer', label: 'review' },
    { kind: 'child', id: 'c2', depth: 1, mode: 'continuable', path: 'tester', label: 'test' },
    { kind: 'child', id: 'c3', depth: 1, mode: 'one-shot', path: 'one-shot' },
    { kind: 'child', id: 'g1', depth: 2, mode: 'continuable', path: 'reviewer/checker' },
    { kind: 'diagnostic', id: 'd1', depth: 1, reason: 'corrupt' },
  ]
  const statuses = { c1: 'running', c2: 'idle' }
  const seen = []
  const ctx = {
    subagents: {
      listDescendants: async (id, signal) => {
        seen.push(id)
        assert.equal(signal, undefined)
        return entries
      },
    },
    agents: { get: (id) => (statuses[id] === undefined ? undefined : { status: statuses[id] }) },
  }
  assert.deepEqual(await subagentLoad(ctx, caller, undefined), {
    total: 2,
    idle: 1,
    idleNames: ['tester'],
  })
  assert.deepEqual(seen, ['parent-1'])
  console.log('ok 6 idle counting')
}

// ---------------------------------------------------------------------------
// 7. Reuse rule boundary: blocked at idle >= total/2, never on an empty set
// ---------------------------------------------------------------------------

{
  assert.equal(IDLE_REUSE_RULE, '如果空闲的子代理数量达到整体的一半及以上，请使用send_message向空闲的子代理派发任务，不允许建立新的子代理。')
  const idle = (total, count) => ({ total, idle: count, idleNames: Array.from({ length: count }, (_, i) => `a${i}`) })
  assert.equal(idleBudgetViolation(idle(0, 0)), undefined, 'no children: first delegation allowed')
  assert.equal(idleBudgetViolation(idle(1, 0)), undefined, 'only child is busy')
  assert.match(idleBudgetViolation(idle(1, 1)), /1 \/ 1 ≥ 一半/)
  assert.match(idleBudgetViolation(idle(2, 1)), /1 \/ 2 ≥ 一半/)
  assert.equal(idleBudgetViolation(idle(3, 1)), undefined, 'one third idle is below half')
  assert.match(idleBudgetViolation(idle(3, 2)), /2 \/ 3 ≥ 一半/)
  assert.match(idleBudgetViolation(idle(4, 2)), /2 \/ 4 ≥ 一半/)
  const text = idleBudgetViolation(idle(2, 2))
  assert.match(text, /拒绝新建子代理/)
  assert.match(text, /如果空闲的子代理数量达到整体的一半及以上/)
  assert.match(text, /send_message\(\{ agent: "<名字>"/)
  assert.match(text, /空闲子代理：a0、a1/)
  console.log('ok 7 reuse rule boundary')
}

// ---------------------------------------------------------------------------
// 8. subagent shadow: rule in description, refusal at call time
// ---------------------------------------------------------------------------

{
  const current = {
    name: 'subagent',
    description: 'Delegate a task.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    isConcurrencySafe: () => true,
    async execute() {
      return { kind: 'activation', name: 'agent-1' }
    },
  }

  const loadEntries = []
  const warnings = []
  const statuses = {}
  const ctx = {
    subagents: { listDescendants: async () => loadEntries },
    agents: { get: (id) => (statuses[id] === undefined ? undefined : { status: statuses[id] }) },
    logger: { warn: (message) => warnings.push(message) },
  }

  const definition = buildSubagent(ctx, current)
  assert.equal(definition.name, 'subagent')
  assert.ok(definition.description.startsWith('Delegate a task.\n\n'))
  assert.ok(definition.description.includes(IDLE_REUSE_RULE))
  assert.equal(definition.parameters, current.parameters)
  assert.equal(definition.output, current.output)
  assert.equal(definition.isConcurrencySafe(), true)
  assert.equal(isSubagentShadow(definition), true)
  assert.equal(isSubagentShadow(current), false)

  // No children: delegate.
  assert.deepEqual(
    await definition.execute({ prompt: 'x' }, { agent: { id: 'p' }, signal: new AbortController().signal }),
    { kind: 'activation', name: 'agent-1' },
  )

  // One idle child out of one: refuse and name it.
  loadEntries.push({ kind: 'child', id: 'c1', depth: 1, mode: 'continuable', path: 'reviewer' })
  statuses.c1 = 'idle'
  await assert.rejects(
    () => definition.execute({ prompt: 'x' }, { agent: { id: 'p' }, signal: new AbortController().signal }),
    /拒绝新建子代理：你现有的 1 个可继续子代理中有 1 个空闲/,
  )

  // Same set, but the child is busy: delegate.
  statuses.c1 = 'running'
  assert.equal(
    (await definition.execute({ prompt: 'x' }, { agent: { id: 'p' }, signal: new AbortController().signal })).name,
    'agent-1',
  )

  // Inspection failure fails open, with a warning.
  ctx.subagents.listDescendants = async () => {
    throw new Error('catalog unavailable')
  }
  assert.equal(
    (await definition.execute({ prompt: 'x' }, { agent: { id: 'p' }, signal: new AbortController().signal })).name,
    'agent-1',
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot inspect subagent load/)

  // A cancelled call keeps its cancellation.
  const controller = new AbortController()
  controller.abort()
  ctx.subagents.listDescendants = async () => {
    throw new Error('cancelled')
  }
  await assert.rejects(
    () => definition.execute({ prompt: 'x' }, { agent: { id: 'p' }, signal: controller.signal }),
    /cancelled/,
  )

  // No caller: leave the decision to upstream.
  assert.equal(
    (await definition.execute({ prompt: 'x' }, { agent: undefined, signal: new AbortController().signal })).name,
    'agent-1',
  )
  console.log('ok 8 subagent shadow')
}

// ---------------------------------------------------------------------------
// 9. subagent_fork guard
// ---------------------------------------------------------------------------

{
  const denial = forkGuard({ name: 'subagent_fork' })
  assert.match(denial.reason, /subagent_fork is disabled/)
  assert.match(denial.reason, /send_message/)
  assert.equal(forkGuard({ name: 'subagent' }), undefined)
  assert.equal(forkGuard({ name: 'send_message' }), undefined)
  console.log('ok 9 fork guard')
}

console.log('SMOKE TEST PASSED')
