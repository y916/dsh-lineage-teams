// dsh-lineage-teams — thin increment over the 0.2.2-rc.2+ Agent Teams model.
//
// Upstream ships named, multi-level subagents, shared tasks, `send_message`,
// `list_agents`, `wait_agent`, and `interrupt_agent`. This plugin keeps three
// behavioural increments on top of that model:
//
//   1. `send_message` accepts `targets: string[]` (broadcast) on top of the
//      upstream single-target `agent` contract;
//   2. every delegated agent is told who its parent is, reminded to make contact
//      when needed, and told how to report completion: a detailed report goes to
//      the parent through send_message, and the final reply is one line;
//   3. delegation is budgeted: `subagent_fork` is blocked everywhere, and
//      `subagent` refuses to create a new child once at least half of the
//      caller's continuable subagents are idle — the caller must dispatch to an
//      idle subagent through send_message instead.
//
// Nothing is injected: an Agent Preset that declares no `send_message` keeps
// exactly none, the `subagent` rewrite only shadows the delegation tool the
// composition already mounts, and the reuse rule is only enforced where the
// caller can actually reach idle subagents through send_message.
import { defineTool, scopeOf, ROOT_AGENT_NAME } from './deps.mjs'

export const name = 'lineage-teams'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

const SEND_MESSAGE = 'send_message'
const SUBAGENT = 'subagent'
const SUBAGENT_FORK = 'subagent_fork'

/** Exact model-facing rule, as requested: reuse idle subagents before spawning. */
const IDLE_REUSE_RULE = '如果空闲的子代理数量达到整体的一半及以上，请使用send_message向空闲的子代理派发任务，不允许建立新的子代理。'

/** Marks the per-Agent `subagent` shadow this plugin registers (shared across reloads). */
const SUBAGENT_SHADOW = Symbol.for('@y916/dsh-lineage-teams/subagent-shadow')

/** Model-facing refusal when a call reaches a disabled tool. */
const FORK_DENIED =
  'subagent_fork is disabled in this profile. Delegate with subagent, and reuse idle subagents through send_message.'

/** Replacement for the delegation guidance upstream drops when its own definition is shadowed. */
const DELEGATION_GUIDANCE = 'Start independent delegations with `subagent` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn. Collect the subagent results required to complete the task before giving the user a final answer.\n\nBash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly. The agent integrating the work must review the final diff and run relevant tests.'

function describeTargets(args) {
	const raw = Array.isArray(args.targets) ? args.targets : []
	const single = typeof args.agent === 'string' ? [args.agent] : []
	return [...single, ...raw].map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
}

/**
 * Resolve one target token against the caller's subagent tree.
 * `"parent"` maps to the caller's direct parent name; `"lead"` is the root name.
 */
async function resolveTarget(ctx, caller, token, signal) {
	if (token === 'parent') {
		const names = ctx.subagents.namesOf(caller)
		if (names?.parent === undefined) throw new Error('this agent has no parent (it is the root)')
		return { id: await ctx.subagents.resolveName(caller, names.parent, signal), label: names.parent }
	}
	const id = await ctx.subagents.resolveName(caller, token, signal)
	return { id, label: token }
}

/** Build the broadcast-capable replacement for one agent. */
function buildSendMessage(ctx, caller) {
	return defineTool({
		name: SEND_MESSAGE,
		description: 'Send a message to one or more agents. A working agent receives it at its next step; an idle agent starts a new turn with it. Accepts a single `agent` (upstream contract) or `targets` to broadcast, plus the aliases "parent" and "lead".',
		parameters: {
			agent: {
				type: 'string',
				description: 'One target: an agent name or Session id. Optional when `targets` is given.',
			},
			targets: {
				type: 'array',
				items: { type: 'string' },
				description: 'One or more targets (names, Session ids, "parent", or "lead"). Multiple targets are delivered one by one.',
			},
			message: {
				type: 'string',
				required: true,
				description: 'The message to deliver. Keep it self-contained: the recipient does not see your conversation.',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					delivered: { type: 'array', items: { type: 'string' }, required: true },
					failed: { type: 'array', items: { type: 'string' }, required: true },
				},
			},
			render: (args, value) => {
				const lines = []
				if (value.delivered.length > 0) lines.push(`delivered to ${value.delivered.join(', ')}`)
				if (value.failed.length > 0) lines.push(`failed: ${value.failed.join('; ')}`)
				return [{ type: 'text', text: lines.join('\n') || 'no target delivered' }]
			},
		},
		async execute(args, exec) {
			const sender = exec.agent
			if (!sender) throw new Error(`${SEND_MESSAGE} requires a calling agent (exec.agent was undefined)`)
			const tokens = describeTargets(args)
			if (tokens.length === 0) throw new Error(`${SEND_MESSAGE}: give an \`agent\` or one or more \`targets\``)
			const content = [{ type: 'text', text: args.message }]
			const delivered = []
			const failed = []
			for (const token of tokens) {
				try {
					const target = await resolveTarget(ctx, sender, token, exec.signal)
					await ctx.subagents.sendMessage(sender, target.id, content, { signal: exec.signal })
					delivered.push(target.label)
				} catch (error) {
					failed.push(`${token}: ${error instanceof Error ? error.message : String(error)}`)
				}
			}
			if (delivered.length === 0) throw new Error(`${SEND_MESSAGE} failed for every target: ${failed.join('; ')}`)
			return { delivered, failed }
		},
	})
}

/** Whether `definition` is the `subagent` shadow this plugin registered. */
function isSubagentShadow(definition) {
	return typeof definition === 'object' && definition !== null && definition[SUBAGENT_SHADOW] === true
}

/**
 * Count the caller's own continuable direct children and how many are idle.
 * Only continuable children count: send_message can dispatch to those, so the
 * rule never points at a child that cannot accept a task.
 * @param ctx - context carrying the subagent and live-agent services.
 * @param caller - exact live Agent whose direct children are counted.
 * @param signal - cancellation forwarded to the catalog reads.
 * @returns `{ total, idle, idleNames }` for the caller's direct children.
 */
async function subagentLoad(ctx, caller, signal) {
	const entries = await ctx.subagents.listDescendants(caller.id, signal)
	const children = entries.filter((entry) =>
		entry.kind === 'child' && entry.depth === 1 && entry.mode === 'continuable')
	const idle = children.filter((entry) => ctx.agents.get(entry.id)?.status !== 'running')
	return {
		total: children.length,
		idle: idle.length,
		idleNames: idle.map((entry) => entry.path ?? entry.name ?? entry.id),
	}
}

/**
 * Apply the reuse rule to one load snapshot.
 * Blocked when a non-empty set has idle children at or above half of the total.
 * @param load - `{ total, idle, idleNames }` from {@link subagentLoad}.
 * @returns the model-facing refusal, or undefined when a new child is allowed.
 */
function idleBudgetViolation({ total, idle, idleNames }) {
	if (total === 0 || idle * 2 < total) return undefined
	return [
		`拒绝新建子代理：你现有的 ${total} 个可继续子代理中有 ${idle} 个空闲（${idle} / ${total} ≥ 一半）。`,
		IDLE_REUSE_RULE,
		`空闲子代理：${idleNames.join('、')}。请调用 send_message({ agent: "<名字>", message: "..." }) 向它们派发任务。`,
	].join('\n')
}

/**
 * Build the `subagent` replacement for one agent: same schema, same output, same
 * presentation, plus the reuse rule in the description and the call-time check.
 * @param ctx - plugin context used for live counting and logging.
 * @param current - the delegation definition this call will shadow.
 * @returns a registry-ready definition that delegates to `current`.
 */
function buildSubagent(ctx, current) {
	const definition = {
		name: SUBAGENT,
		description: `${current.description}\n\n${IDLE_REUSE_RULE}`,
		parameters: current.parameters,
		output: current.output,
		...(current.deferLoading === true ? { deferLoading: true } : {}),
		...(current.timeoutMs !== undefined ? { timeoutMs: current.timeoutMs } : {}),
		...(current.projectContent !== undefined ? { projectContent: current.projectContent } : {}),
		...(current.finalizeContent !== undefined ? { finalizeContent: current.finalizeContent } : {}),
		...(current.presentCall !== undefined ? { presentCall: current.presentCall } : {}),
		...(current.presentResult !== undefined ? { presentResult: current.presentResult } : {}),
		...(current.isConcurrencySafe !== undefined ? { isConcurrencySafe: current.isConcurrencySafe } : {}),
		async execute(args, exec) {
			const caller = exec.agent
			if (caller !== undefined) {
				let load
				try {
					load = await subagentLoad(ctx, caller, exec.signal)
				} catch (error) {
					if (exec.signal.aborted) throw error
					// The rule cannot be evaluated; do not turn an inspection failure into a refusal.
					ctx.logger?.warn?.(`lineage-teams: cannot inspect subagent load, delegation is allowed: ${String(error)}`)
				}
				const violation = load === undefined ? undefined : idleBudgetViolation(load)
				if (violation !== undefined) throw new Error(violation)
			}
			return current.execute(args, exec)
		},
	}
	definition[SUBAGENT_SHADOW] = true
	return definition
}

/** Global guard: `subagent_fork` is disabled for every agent. */
function forkGuard(exec) {
	return exec.name === SUBAGENT_FORK ? { reason: FORK_DENIED } : undefined
}

/**
 * Completion/contact guidance for delegated agents (never for the root).
 * Returns '' unless this plugin's own send_message is the one the agent sees.
 */
function guidanceText(ctx, ours, { agent, scope, toolSet }) {
	if (agent === undefined) return ''
	let names
	try {
		names = ctx.subagents.namesOf(agent)
	} catch {
		return ''
	}
	if (names?.parent === undefined) return ''
	if (ctx.tools.get(SEND_MESSAGE, scope, toolSet) !== ours.get(agent)) return ''
	return [
		`你的父级代理是「${names.parent}」，根会话（团队负责人）是「${ROOT_AGENT_NAME}」。`,
		'需要补充信息、纠偏，或发现会影响别人结论的事实时，直接联系：send_message({ agent: "<父级名字>", message: "..." })。要同时通知多个代理用 targets：send_message({ targets: ["a", "b"], message: "..." })；targets 也接受 "parent" 与 "lead"。',
		'任务一完成就直接向父代理汇报：用 send_message 给父级发一条消息，详细说明结论、证据（命令原文、文件路径与行号）与未完成项，并给出交付物路径——这条消息就是你的正式汇报，不要指望父级从你的最终回复里读细节。',
		'汇报之后，最终回复只写一句话——「已经汇报完毕。」；不要把汇报内容再贴一遍。',
	].join('\n')
}

export function apply(ctx, config = {}) {
	// agent -> the definition this plugin registered for it.
	const ours = new WeakMap()
	// Disposers owned by this plugin instance (tools + restrictions), run on unload.
	const disposers = new Set()
	// agent -> the restriction disposer that hides subagent_fork in its scope.
	const restricted = new Map()
	let disposed = false
	let scheduled = false

	const track = (dispose) => {
		disposers.add(dispose)
		return dispose
	}

	const installSendMessage = (agent) => {
		if (ours.has(agent)) return
		const scope = scopeOf(agent.ctx)
		if (scope === undefined) return
		// Never inject: only shadow a send_message the composition already declares.
		if (ctx.tools.get(SEND_MESSAGE, scope) === undefined) return
		const definition = buildSendMessage(ctx, agent)
		track(agent.ctx.tools.register(definition))
		ours.set(agent, definition)
	}

	const installSubagent = (agent) => {
		const scope = scopeOf(agent.ctx)
		if (scope === undefined) return
		// The refusal tells the caller to use send_message; without it the rule
		// would only remove the caller's only way to delegate.
		if (ctx.tools.get(SEND_MESSAGE, scope) === undefined) return
		const current = ctx.tools.get(SUBAGENT, scope)
		if (current === undefined || isSubagentShadow(current)) return
		track(agent.ctx.tools.register(buildSubagent(ctx, current)))
	}

	const installForkDeny = (agent) => {
		if (restricted.has(agent)) return
		const scope = scopeOf(agent.ctx)
		if (scope === undefined) return
		// Registered by a separate plugin row; it may appear after this plugin
		// loads, so skip until it is visible in this agent's scope (tools/change
		// retries). Asking per scope also covers a preset-scoped fork row.
		if (ctx.tools.get(SUBAGENT_FORK, scope) === undefined) return
		try {
			restricted.set(agent, agent.ctx.tools.restrict({ deny: [SUBAGENT_FORK] }))
		} catch (error) {
			ctx.logger?.warn?.(`lineage-teams: cannot hide ${SUBAGENT_FORK} for agent "${agent.id}": ${String(error)}`)
		}
	}

	const reconcileAgent = (agent) => {
		try {
			installSendMessage(agent)
		} catch (error) {
			ctx.logger?.warn?.(`lineage-teams: cannot install ${SEND_MESSAGE} for agent "${agent.id}": ${String(error)}`)
		}
		try {
			installSubagent(agent)
		} catch (error) {
			ctx.logger?.warn?.(`lineage-teams: cannot install ${SUBAGENT} for agent "${agent.id}": ${String(error)}`)
		}
		try {
			installForkDeny(agent)
		} catch (error) {
			ctx.logger?.warn?.(`lineage-teams: cannot hide ${SUBAGENT_FORK} for agent "${agent.id}": ${String(error)}`)
		}
	}

	const reconcileAll = () => {
		if (disposed) return
		for (const agent of ctx.agents.list()) reconcileAgent(agent)
	}

	for (const agent of ctx.agents.list()) reconcileAgent(agent)
	ctx.on('agent/created', ({ agent }) => {
		if (disposed) return
		reconcileAgent(agent)
	})
	ctx.on('agent/disposed', ({ agent }) => {
		ours.delete(agent)
		restricted.delete(agent)
	})
	// Tool rows mount in their own order; retry once the registry settles.
	ctx.on('tools/change', () => {
		if (disposed || scheduled) return
		scheduled = true
		queueMicrotask(() => {
			scheduled = false
			try {
				reconcileAll()
			} catch (error) {
				ctx.logger?.warn?.(`lineage-teams: cannot reconcile agents: ${String(error)}`)
			}
		})
	})
	ctx.effect(() => () => {
		disposed = true
		for (const dispose of [...disposers].reverse()) {
			try {
				dispose()
			} catch {
				// The owning scope may already be gone.
			}
		}
		disposers.clear()
		for (const dispose of restricted.values()) {
			try {
				dispose()
			} catch {
				// The owning scope may already be gone.
			}
		}
		restricted.clear()
	})

	// Block the tool for calls that bypass hiding (PTC, direct dispatch).
	ctx.tools.guard(forkGuard)

	ctx.systemPrompt.context({
		name: 'lineage:completion',
		order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
		required: true,
		text: (context) => guidanceText(ctx, ours, context),
	})

	// Upstream keys its delegation guidance to its own definition identity, so a
	// shadow would silently drop it; restate it while our shadow is visible.
	ctx.systemPrompt.section({
		name: 'lineage:delegation',
		order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
		text: ({ agent, scope, toolSet }) => {
			if (agent === undefined) return ''
			return isSubagentShadow(ctx.tools.get(SUBAGENT, scope, toolSet)) ? DELEGATION_GUIDANCE : ''
		},
	})
}

export default { name, inject, apply }

// Narrow, side-effect-free surface for the smoke test.
export const __test = {
	buildSendMessage,
	buildSubagent,
	describeTargets,
	forkGuard,
	guidanceText,
	idleBudgetViolation,
	isSubagentShadow,
	resolveTarget,
	subagentLoad,
	IDLE_REUSE_RULE,
	SEND_MESSAGE,
	SUBAGENT,
	SUBAGENT_FORK,
}
