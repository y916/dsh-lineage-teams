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

const { describeTargets, resolveTarget, buildSendMessage, guidanceText } = __test

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
// 5. apply(): one prompt context, order follows SUBAGENT_DELEGATION
// ---------------------------------------------------------------------------

{
  const contexts = []
  const ctx = {
    agents: { list: () => [] },
    tools: { get: () => undefined },
    subagents: { namesOf: () => ({ self: 'lead' }) },
    logger: { warn: () => {} },
    on: () => {},
    systemPrompt: {
      getContextOrder: (name) => (name === 'SUBAGENT_DELEGATION' ? 42 : 0),
      context: (entry) => {
        contexts.push(entry)
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
  console.log('ok 5 plugin wiring')
}

console.log('SMOKE TEST PASSED')
