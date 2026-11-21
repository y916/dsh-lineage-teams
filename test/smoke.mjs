#!/usr/bin/env node
// Self-contained smoke test for the lineage-teams tool layer.
//
// No dsh process, no network, no real Session store: fake Agents and a fake
// context carry exactly the services the tools read. Run with
//   node test/smoke.mjs
// from the repository root (deps.mjs resolves the harness from `dsh` on PATH).
import assert from 'node:assert/strict'
import { __test, applyReplacements } from '../lib/team-tools.mjs'

const {
  buildInterruptAgent,
  buildListAgents,
  buildSendMessage,
  subagentGuidanceFor,
  subagentGuidanceText,
  teamIdentityText,
} = __test

// ---------------------------------------------------------------------------
// Fake harness primitives
// ---------------------------------------------------------------------------

function makeAgent(id, { parent, status = 'inactive' } = {}) {
  return {
    id,
    status,
    session: { header: { id, ...(parent === undefined ? {} : { parentSession: parent }) } },
    steered: [],
    steer(message) {
      this.steered.push(message)
      return message.id
    },
    ctx: undefined,
  }
}

function makeCtx({
  agents,
  declared = new Map(),
  memberships = new Map(),
  memberRows = new Map(),
  descendants = new Map(),
  sendCalls = [],
  interruptCalls = [],
  deliveries = [],
  contexts = [],
  registered = [],
  warn = [],
}) {
  const ctx = {
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    },
    tools: {
      get: (name, agent) => (declared.get(agent)?.has(name) ? { name } : undefined),
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section: (entry) => {
        contexts.push({ kind: 'section', entry })
        return () => {}
      },
      context: (entry) => {
        contexts.push({ kind: 'context', entry })
        return () => {}
      },
      getContextOrder: (key) => ({ TEAM_IDENTITY: 10, SUBAGENT_DELEGATION: 20 })[key] ?? 50,
      getSectionOrder: (key) => ({ TEAM_POLICY: 10 })[key] ?? 50,
    },
    agentTeams: {
      tryMembership: (agent) => memberships.get(agent),
      membership: (agent) => {
        const membership = memberships.get(agent)
        if (membership === undefined) throw new Error('not a member')
        return membership
      },
      listMembers: (agent) => memberRows.get(agent) ?? [],
      sendMessage: async (caller, request) => {
        sendCalls.push({ caller, target: request.target })
        return 'team-message-id'
      },
      interrupt: (caller, name) => {
        interruptCalls.push({ kind: 'team', caller, target: name })
        return { previousStatus: 'running' }
      },
    },
    subagents: {
      listDescendants: async (id) => {
        const entries = descendants.get(id)
        if (entries instanceof Error) throw entries
        return entries ?? []
      },
      interrupt: (id, authority) => {
        interruptCalls.push({ kind: 'subagent', id, authority })
      },
      [Symbol.for('dsh.subagent.deliverPrompt')]: async (parent, childId) => {
        deliveries.push({ parent: parent.id, childId })
        return 'subagent-message-id'
      },
    },
    logger: { warn: (message) => warn.push(message) },
    get: (name) => (name === 'sessionQuery' ? { observeSession: async () => ({ header: {} }) } : undefined),
    on: () => {},
    effect: (run) => run(),
  }
  return { ctx, contexts, registered, sendCalls, interruptCalls, deliveries, warn }
}

function execute(definition, agent, args) {
  return definition.execute(args, { agent, signal: new AbortController().signal })
}

function memberRow(name, role, status = 'running') {
  return { id: `id-${name}`, name, role, status, diagnostics: [] }
}

// ---------------------------------------------------------------------------
// 1. Guidance text: parent, list_agents, send_message, aliases
// ---------------------------------------------------------------------------

const guidance = subagentGuidanceText('parent-9', { listAgents: true, sendMessage: true, interrupt: true })
assert.match(guidance, /你是子代理，父级智能体（parent agent）是「parent-9」/)
assert.match(guidance, /list_agents/)
assert.match(guidance, /send_message\(\{ targets: \["parent"\]/)
assert.match(guidance, /"lead" 指根会话/)
assert.match(guidance, /interrupt_agent/)
assert.match(guidance, /归属|共享工作空间/)
assert.match(guidance, /任务一完成就直接向父代理汇报/)
assert.match(guidance, /详细说明结论、证据（命令原文、文件路径与行号）与未完成项/)
assert.match(guidance, /最终回复只写一句话——「已经汇报完毕。」/)
const sendOnly = subagentGuidanceText('p', { listAgents: false, sendMessage: true, interrupt: false })
assert.doesNotMatch(sendOnly, /list_agents/)
assert.doesNotMatch(sendOnly, /interrupt_agent/)
assert.match(sendOnly, /send_message/)
assert.match(sendOnly, /最终回复只写一句话——「已经汇报完毕。」/)
const noSend = subagentGuidanceText('p', { listAgents: true, sendMessage: false, interrupt: false })
assert.doesNotMatch(noSend, /已经汇报完毕。/, '没有 send_message 的子代理不该被要求发汇报消息')
console.log('ok 1 subagent guidance text')

// ---------------------------------------------------------------------------
// 2. Team identity text: teammate names parent, Lead does not
// ---------------------------------------------------------------------------

{
  const root = makeAgent('root-1', { status: 'running' })
  const mate = makeAgent('mate-1', { parent: 'root-1', status: 'running' })
  const memberships = new Map([
    [root, { root, id: 'root-1', role: 'lead', name: 'lead' }],
    [mate, { root, id: 'mate-1', role: 'teammate', name: 'alice' }],
  ])
  const memberRows = new Map([[root, [memberRow('lead', 'lead'), memberRow('alice', 'teammate')]]])
  memberRows.set(mate, memberRows.get(root))
  const fakes = makeCtx({ agents: new Map([['root-1', root], ['mate-1', mate]]), memberships, memberRows })

  const teammate = teamIdentityText(fakes.ctx, mate)
  assert.match(teammate, /你是「alice」，父级智能体（parent agent）是「root-1」/)
  assert.match(teammate, /其他智能体/)
  assert.match(teammate, /"parent"/)
  assert.match(teammate, /list_agents/)
  assert.match(teammate, /任务一完成就直接向队长（父代理）汇报/)
  assert.match(teammate, /详细说明结论、证据（命令原文、文件路径与行号）与未完成项/)
  assert.match(teammate, /最终回复只写一句话——「已经汇报完毕。」/)

  const lead = teamIdentityText(fakes.ctx, root)
  assert.match(lead, /团队负责人「lead」/)
  assert.doesNotMatch(lead, /父级智能体（parent agent）是/)
  assert.match(lead, /任意组员或其他智能体/)
  assert.doesNotMatch(lead, /已经汇报完毕。/, 'Lead 没有父级，不该被要求发汇报消息')
  console.log('ok 2 team identity text')
}

// ---------------------------------------------------------------------------
// 3. send_message: aliases, Team routing, self/root errors
// ---------------------------------------------------------------------------

{
  const root = makeAgent('root-1', { status: 'running' })
  const lead = makeAgent('lead-1', { status: 'running' })
  const mate = makeAgent('mate-1', { parent: 'lead-1', status: 'running' })
  const sub = makeAgent('sub-1', { parent: 'root-1', status: 'running' })
  const grandchild = makeAgent('sub-2', { parent: 'sub-1', status: 'running' })
  const agents = new Map([['root-1', root], ['lead-1', lead], ['mate-1', mate], ['sub-1', sub], ['sub-2', grandchild]])
  const memberships = new Map([
    [lead, { root: lead, id: 'lead-1', role: 'lead', name: 'lead' }],
    [mate, { root: lead, id: 'mate-1', role: 'teammate', name: 'alice' }],
  ])
  const memberRows = new Map([[lead, [memberRow('lead', 'lead'), memberRow('alice', 'teammate')]]])
  memberRows.set(mate, memberRows.get(lead))
  const fakes = makeCtx({ agents, memberships, memberRows })
  const send = buildSendMessage(fakes.ctx)

  // teammate: "parent" and "lead" both go through the Team service as "lead"
  await execute(send, mate, { targets: ['parent'], message: 'hi' })
  await execute(send, mate, { targets: ['lead'], message: 'hi' })
  assert.deepEqual(fakes.sendCalls.map((call) => call.target), ['lead', 'lead'])

  // teammate -> another teammate by name still uses the Team service
  await execute(send, mate, { agent_id: 'lead', message: 'hi' })
  assert.deepEqual(fakes.sendCalls.map((call) => call.target), ['lead', 'lead', 'lead'])

  // Lead has no parent of its own
  await assert.rejects(() => execute(send, lead, { targets: ['parent'], message: 'hi' }), /has no parent agent/)

  // subagent: "parent" delivers to its direct parent; a root parent is steered directly
  assert.deepEqual(fakes.deliveries, [])
  await execute(send, sub, { targets: ['parent'], message: 'done' })
  assert.equal(root.steered.length, 1)
  assert.deepEqual(fakes.deliveries, [])

  // subagent: "lead" resolves to the root session
  await execute(send, sub, { targets: ['lead'], message: 'done' })
  assert.equal(root.steered.length, 2)

  // nested subagent: "parent" steers through the live direct parent
  await execute(send, grandchild, { targets: ['parent'], message: 'done' })
  assert.deepEqual(fakes.deliveries.at(-1), { parent: 'root-1', childId: 'sub-1' })

  // self-message is rejected
  await assert.rejects(() => execute(send, sub, { targets: ['sub-1'], message: 'x' }), /cannot message itself/)

  // broadcast collects the failures instead of dropping them
  const broadcast = await execute(send, sub, { targets: ['lead', 'sub-1'], message: 'x' })
  assert.deepEqual(broadcast.delivered, ['lead'])
  assert.equal(broadcast.failed.length, 1)
  console.log('ok 3 send_message aliases and routing')
}

// ---------------------------------------------------------------------------
// 4. list_agents: non-member sees root, parent, siblings; status from activity
// ---------------------------------------------------------------------------

{
  const root = makeAgent('root-1', { status: 'running' })
  const sub = makeAgent('sub-1', { parent: 'root-1', status: 'running' })
  const sibling = makeAgent('sub-2', { parent: 'root-1', status: 'inactive' })
  const uncle = makeAgent('sub-3', { parent: 'root-1', status: 'inactive' })
  const cousin = makeAgent('sub-4', { parent: 'sub-3', status: 'running' })
  const agents = new Map([
    ['root-1', root],
    ['sub-1', sub],
    ['sub-2', sibling],
    ['sub-3', uncle],
    ['sub-4', cousin],
  ])
  const entry = (id, parentId, depth, activity, label) => ({
    kind: 'child',
    id,
    parentId,
    depth,
    activity,
    mode: 'continuable',
    label,
  })
  const descendants = new Map([
    ['root-1', [
      entry('sub-1', 'root-1', 1, 'running', 'first'),
      entry('sub-2', 'root-1', 1, 'inactive', 'sibling'),
      entry('sub-3', 'root-1', 1, 'inactive', 'uncle'),
      entry('sub-4', 'sub-3', 2, 'running', 'cousin'),
      entry('sub-9', 'sub-1', 2, 'inactive', 'direct child'),
    ]],
    ['sub-1', [entry('sub-9', 'sub-1', 1, 'inactive', 'direct child')]],
  ])
  const fakes = makeCtx({ agents, descendants })
  const list = buildListAgents(fakes.ctx)

  const all = await execute(list, sub, {})
  const byTarget = new Map(all.map((row) => [row.target, row]))
  assert.equal(byTarget.get('root-1')?.role, 'lead')
  assert.equal(byTarget.get('root-1')?.status, 'running')
  assert.equal(byTarget.get('sub-2')?.role, 'child')
  assert.equal(byTarget.get('sub-2')?.status, 'inactive')
  assert.equal(byTarget.get('sub-4')?.status, 'running', 'activity must drive status, not entry.status')
  assert.equal(byTarget.has('sub-1'), false, 'self must be excluded')
  assert.equal(byTarget.get('sub-2')?.description, 'sibling')

  const children = await execute(list, sub, { scope: 'children' })
  assert.deepEqual(children.map((row) => row.target), ['root-1', 'sub-9'])

  // fallback when the root catalog cannot be read
  const broken = makeCtx({ agents, descendants: new Map([['root-1', new Error('catalog unreadable')], ['sub-1', [entry('sub-9', 'sub-1', 1, 'inactive', 'direct child')]]]) })
  const fallback = await execute(buildListAgents(broken.ctx), sub, {})
  assert.deepEqual(fallback.map((row) => row.target), ['root-1', 'sub-9'])
  console.log('ok 4 list_agents for non-members')
}

// ---------------------------------------------------------------------------
// 5. list_agents: member roster + descendants, model-visible targets only
// ---------------------------------------------------------------------------

{
  const lead = makeAgent('lead-1', { status: 'running' })
  const mate = makeAgent('mate-1', { parent: 'lead-1', status: 'running' })
  const child = makeAgent('child-1', { parent: 'mate-1', status: 'running' })
  const agents = new Map([['lead-1', lead], ['mate-1', mate], ['child-1', child]])
  const memberRowWithId = (id, name, role, status) => ({ id, name, role, status, diagnostics: [] })
  const roster = [memberRowWithId('lead-1', 'lead', 'lead', 'running'), memberRowWithId('mate-1', 'alice', 'teammate', 'running')]
  const memberships = new Map([
    [lead, { root: lead, id: 'lead-1', role: 'lead', name: 'lead' }],
    [mate, { root: lead, id: 'mate-1', role: 'teammate', name: 'alice' }],
  ])
  const memberRows = new Map([[lead, roster], [mate, roster]])
  const descendants = new Map([
    ['lead-1', [
      { kind: 'child', id: 'mate-1', parentId: 'lead-1', depth: 1, activity: 'running', mode: 'continuable', label: 'alice teammate' },
      { kind: 'child', id: 'child-1', parentId: 'mate-1', depth: 2, activity: 'running', mode: 'continuable', label: 'legacy child' },
    ]],
    ['mate-1', [{ kind: 'child', id: 'child-1', parentId: 'mate-1', depth: 1, activity: 'running', mode: 'continuable', label: 'legacy child' }]],
  ])
  const fakes = makeCtx({ agents, memberships, memberRows, descendants })
  const rows = await execute(buildListAgents(fakes.ctx), mate, {})
  assert.deepEqual(rows.map((row) => row.target), ['lead', 'alice', 'child-1'])
  assert.equal(rows[1].role, 'teammate')
  assert.equal(rows[2].status, 'running')
  assert.equal('id' in rows[1], false, 'ids stay server-side')
  console.log('ok 5 list_agents for members')
}

// ---------------------------------------------------------------------------
// 6. interrupt_agent: Lead-only teammate interrupt, id interrupt for the rest
// ---------------------------------------------------------------------------

{
  const lead = makeAgent('lead-1', { status: 'running' })
  const mate = makeAgent('mate-1', { parent: 'lead-1', status: 'running' })
  const sub = makeAgent('sub-1', { parent: 'lead-1', status: 'running' })
  const grandchild = makeAgent('sub-2', { parent: 'sub-1', status: 'running' })
  const agents = new Map([['lead-1', lead], ['mate-1', mate], ['sub-1', sub], ['sub-2', grandchild]])
  const memberships = new Map([
    [lead, { root: lead, id: 'lead-1', role: 'lead', name: 'lead' }],
    [mate, { root: lead, id: 'mate-1', role: 'teammate', name: 'alice' }],
  ])
  const memberRows = new Map([[lead, [memberRow('lead', 'lead'), memberRow('alice', 'teammate')]]])
  memberRows.set(mate, memberRows.get(lead))
  const fakes = makeCtx({ agents, memberships, memberRows })
  const interrupt = buildInterruptAgent(fakes.ctx)

  const accepted = await execute(interrupt, lead, { target: 'alice' })
  assert.deepEqual(accepted, { accepted: true, target: 'alice', previousStatus: 'running' })
  assert.equal(fakes.interruptCalls.at(-1).kind, 'team')

  await assert.rejects(() => execute(interrupt, mate, { target: 'alice' }), /only the Team Lead/)

  await execute(interrupt, sub, { agent_id: 'sub-2' })
  assert.equal(fakes.interruptCalls.at(-1).kind, 'subagent')
  assert.equal(fakes.interruptCalls.at(-1).id, 'sub-2')

  await assert.rejects(() => execute(interrupt, sub, {}), /give target/)
  console.log('ok 6 interrupt_agent')
}

// ---------------------------------------------------------------------------
// 7. applyReplacements: guidance only for non-Team subagents
// ---------------------------------------------------------------------------

{
  const lead = makeAgent('lead-1', { status: 'running' })
  const mate = makeAgent('mate-1', { parent: 'lead-1', status: 'running' })
  const sub = makeAgent('sub-5', { parent: 'lead-1', status: 'running' })
  const none = makeAgent('none-1', { status: 'running' })
  const agents = new Map([['lead-1', lead], ['mate-1', mate], ['sub-5', sub], ['none-1', none]])
  const memberships = new Map([
    [lead, { root: lead, id: 'lead-1', role: 'lead', name: 'lead' }],
    [mate, { root: lead, id: 'mate-1', role: 'teammate', name: 'alice' }],
  ])
  const declared = new Map([
    [lead, new Set(['send_message', 'list_agents', 'interrupt_agent'])],
    [mate, new Set(['send_message', 'list_agents', 'interrupt_agent'])],
    [sub, new Set(['send_message', 'list_agents', 'interrupt_agent'])],
  ])
  const fakes = makeCtx({ agents, memberships, declared })
  for (const agent of agents.values()) agent.ctx = fakes.ctx

  applyReplacements(fakes.ctx)

  const guidanceEntries = fakes.contexts
    .filter((entry) => entry.kind === 'context' && entry.entry.name === 'lineage:subagent-guidance')
  assert.equal(guidanceEntries.length, 1, 'exactly the non-Team subagent gets the block')
  assert.equal(guidanceEntries[0].entry.order, 20)
  assert.match(guidanceEntries[0].entry.text, /父级智能体（parent agent）是「lead-1」/)
  assert.match(guidanceEntries[0].entry.text, /list_agents/)
  assert.match(guidanceEntries[0].entry.text, /send_message/)

  assert.equal(subagentGuidanceFor(fakes.ctx, sub) === undefined, false)
  assert.equal(subagentGuidanceFor(fakes.ctx, lead), undefined)
  assert.equal(subagentGuidanceFor(fakes.ctx, mate), undefined)
  assert.equal(subagentGuidanceFor(fakes.ctx, none), undefined)

  // Replacement never creates a tool the composition did not declare.
  assert.deepEqual(fakes.registered.map((tool) => tool.name).sort(), [
    'interrupt_agent', 'interrupt_agent', 'interrupt_agent',
    'list_agents', 'list_agents', 'list_agents',
    'send_message', 'send_message', 'send_message',
  ])
  console.log('ok 7 applyReplacements guidance gating')
}

console.log('SMOKE TEST PASSED')
