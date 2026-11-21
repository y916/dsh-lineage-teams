// dsh-lineage-teams — thin increment over the 0.2.2-rc.2+ Agent Teams model.
//
// Upstream now ships everything the old fork vendored (named, multi-level
// subagents; team task board; wait_agent; interrupt_agent). What is still worth
// keeping is a single behavioural increment:
//
//   1. `send_message` accepts `targets: string[]` (broadcast) on top of the
//      upstream single-target `agent` contract;
//   2. every delegated agent is told who its parent is, reminded to make contact
//      when needed, and told how to report completion: a detailed report goes to
//      the parent through send_message, and the final reply is one line.
//
// Nothing is injected: an Agent Preset that declares no `send_message` keeps
// exactly none, and the replacement only shadows the definition that preset
// already mounted.
import { defineTool, scopeOf, ROOT_AGENT_NAME } from './deps.mjs'

export const name = 'lineage-teams'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

const SEND_MESSAGE = 'send_message'

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

	const install = (agent) => {
		if (ours.has(agent)) return
		const scope = scopeOf(agent.ctx)
		if (scope === undefined) return
		// Never inject: only shadow a send_message the composition already declares.
		if (ctx.tools.get(SEND_MESSAGE, scope) === undefined) return
		const definition = buildSendMessage(ctx, agent)
		agent.ctx.tools.register(definition)
		ours.set(agent, definition)
	}

	for (const agent of ctx.agents.list()) {
		try {
			install(agent)
		} catch (error) {
			ctx.logger?.warn?.(`lineage-teams: cannot install send_message for agent "${agent.id}": ${String(error)}`)
		}
	}
	ctx.on('agent/created', ({ agent }) => {
		try {
			install(agent)
		} catch (error) {
			ctx.logger?.warn?.(`lineage-teams: cannot install send_message for agent "${agent.id}": ${String(error)}`)
		}
	})
	ctx.on('agent/disposed', ({ agent }) => {
		ours.delete(agent)
	})

	ctx.systemPrompt.context({
		name: 'lineage:completion',
		order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
		required: true,
		text: (context) => guidanceText(ctx, ours, context),
	})
}

export default { name, inject, apply }

// Narrow, side-effect-free surface for the smoke test.
export const __test = { buildSendMessage, describeTargets, guidanceText, resolveTarget, SEND_MESSAGE }
