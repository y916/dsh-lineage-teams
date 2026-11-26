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
//      `subagent` refuses to create a new child until the caller's idle
//      subagents satisfy two live limits (idle ratio and idle count) — or one
//      enabled difference exception (preset / model / working directory) —
//      and otherwise points the caller at send_message.
//
// The two limits and the three exceptions are plugin Config fields, marked
// volatile so a browser settings card can change them without remounting the
// plugin. The live rule is restated as a system-prompt context for every agent
// that sees the `subagent` shadow, and a changed setting adds a one-step
// "rule updated" marker on the next assembly.
//
// Nothing is injected: an Agent Preset that declares no `send_message` keeps
// exactly none, the `subagent` rewrite only shadows the delegation tool the
// composition already mounts, and the creation rule is only enforced where the
// caller can actually reach idle subagents through send_message.
import { resolve as resolvePath } from 'node:path'
import { defineTool, scopeOf, ROOT_AGENT_NAME, z } from './deps.mjs'

export const name = 'lineage-teams'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

/** Live-editable budget for creating subagents. */
export const Config = z.object({
	idleRatioLimit: z.number().min(0).max(100).step(1).default(50).volatile()
		.description('允许新建子代理的最大空闲子代理比例（%）；与数量上限必须同时满足。'),
	idleCountLimit: z.number().min(0).max(10).step(1).default(3).volatile()
		.description('允许新建子代理的最大空闲子代理数量；与比例上限必须同时满足。'),
	allowDifferentPreset: z.boolean().default(false).volatile()
		.description('超过两个上限时，若空闲子代理中没有所请求的 agent_preset，允许新建。'),
	allowDifferentModel: z.boolean().default(false).volatile()
		.description('超过两个上限时，若空闲子代理中没有所请求的 provider+model，允许新建。'),
	allowDifferentCwd: z.boolean().default(false).volatile()
		.description('超过两个上限时，若空闲子代理中没有所请求的 cwd，允许新建。'),
})

/** Defaults used when a field is absent (also mirrored by the browser card). */
export const DEFAULT_SETTINGS = Object.freeze({ ratio: 50, count: 3, preset: false, model: false, cwd: false })

const SEND_MESSAGE = 'send_message'
const SUBAGENT = 'subagent'
const SUBAGENT_FORK = 'subagent_fork'

/** Exact model-facing instruction appended to the subagent tool description. */
const NEW_SUBAGENT_RULE = '在调用此工具之前，先调用list_agents确认子代理情况，优先使用send_message向空闲的子代理派发任务，而不是建立新的子代理。'

/** Opening line of the dynamic creation-rule context. */
const RULE_HEADER = '【子代理创建规则（当前设置）】'

/** Marks the per-Agent `subagent` shadow this plugin registers (shared across reloads). */
const SUBAGENT_SHADOW = Symbol.for('@y916/dsh-lineage-teams/subagent-shadow')

/** Marks an adopted `send_message` shadow left by an earlier plugin instance. */
const SEND_MESSAGE_SHADOW = Symbol.for('@y916/dsh-lineage-teams/send-message-shadow')

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
 * Whether `definition` is a broadcast `send_message` shadow left by an earlier
 * version of this plugin. 0.3.0 registered it without an unload disposer, so a
 * live update leaves it in every existing Agent scope and its body closes over
 * the retired plugin context.
 * @param definition - a visible tool definition.
 * @returns true only for the shape this plugin's own send_message replacement has.
 */
function isLegacySendMessage(definition) {
	if (typeof definition !== 'object' || definition === null) return false
	if (definition.name !== SEND_MESSAGE) return false
	const properties = definition.parameters?.properties
	if (typeof properties !== 'object' || properties === null) return false
	return Object.hasOwn(properties, 'targets') && Object.hasOwn(properties, 'agent')
}

/** Read one config field that may be a live `Volatile` or a plain test value. */
function liveValue(field, fallback) {
	if (field === undefined || field === null) return fallback
	if (typeof field === 'object' && typeof field.get === 'function') {
		try {
			return field.get()
		} catch {
			return fallback
		}
	}
	return field
}

/** Normalize the five live settings into one plain record. */
function normalizeSettings(config = {}) {
	const ratio = Number(liveValue(config.idleRatioLimit, DEFAULT_SETTINGS.ratio))
	const count = Number(liveValue(config.idleCountLimit, DEFAULT_SETTINGS.count))
	return {
		ratio: Number.isFinite(ratio) ? Math.min(100, Math.max(0, Math.round(ratio))) : DEFAULT_SETTINGS.ratio,
		count: Number.isFinite(count) ? Math.min(10, Math.max(0, Math.round(count))) : DEFAULT_SETTINGS.count,
		preset: liveValue(config.allowDifferentPreset, DEFAULT_SETTINGS.preset) === true,
		model: liveValue(config.allowDifferentModel, DEFAULT_SETTINGS.model) === true,
		cwd: liveValue(config.allowDifferentCwd, DEFAULT_SETTINGS.cwd) === true,
	}
}

/** Session header of one live agent. */
function headerOf(agent) {
	return agent?.session?.header
}

/** Agent preset id recorded on the session header. */
function presetOf(agent) {
	const preset = headerOf(agent)?.agentPreset
	return typeof preset === 'string' && preset.length > 0 ? preset : undefined
}

/** Resolved provider/model route of one live agent. */
function routeOf(agent) {
	const options = agent?.options
	if (typeof options?.provider !== 'string' || typeof options?.model !== 'string') return undefined
	return {
		provider: options.provider,
		model: options.model,
		...(typeof options.reasoningEffort === 'string' ? { reasoningEffort: options.reasoningEffort } : {}),
	}
}

/** Effective working directory: the live service when mounted, else the header. */
function workingDirectoryOf(ctx, agent) {
	if (agent === undefined) return undefined
	const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
	if (service !== undefined) {
		try {
			const directory = service.get(agent.session)
			if (typeof directory === 'string' && directory.length > 0) return directory
		} catch {
			// Fall back to the durable header.
		}
	}
	const cwd = headerOf(agent)?.cwd
	return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** Explicit `agent_preset` from the call arguments, if any. */
function requestedPreset(args) {
	const preset = args?.agent_preset
	return typeof preset === 'string' && preset.length > 0 ? preset : undefined
}

/** Explicit complete `provider`+`model` route from the call arguments. */
function requestedRoute(args) {
	const provider = args?.provider
	const model = args?.model
	if (typeof provider !== 'string' || provider.length === 0) return undefined
	if (typeof model !== 'string' || model.length === 0) return undefined
	const effort = args?.reasoning_effort
	return {
		provider,
		model,
		...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
	}
}

/** Compare the model identity only: provider + model (reasoning effort excluded). */
function sameRoute(left, right) {
	return left !== undefined && right !== undefined
		&& left.provider === right.provider && left.model === right.model
}

/** Explicit `cwd`, resolved against the caller's working directory. */
function requestedCwd(ctx, caller, args) {
	const cwd = args?.cwd
	if (typeof cwd !== 'string' || cwd.length === 0) return undefined
	const base = workingDirectoryOf(ctx, caller)
	if (base === undefined) return undefined
	try {
		return resolvePath(base, cwd)
	} catch {
		return undefined
	}
}

/**
 * Snapshot the caller's own continuable direct children. Metadata is read from
 * the live agent when it is loaded; inactive members keep unknown fields for
 * {@link enrichIdleMembers} to resolve from their session log.
 * @param ctx - context carrying the subagent and live-agent services.
 * @param caller - exact live Agent whose direct children are snapshotted.
 * @param signal - cancellation forwarded to the catalog reads.
 * @returns `{ total, idle, idleMembers }` for the caller's direct children.
 */
async function subagentLoad(ctx, caller, signal) {
	const entries = await ctx.subagents.listDescendants(caller.id, signal)
	const children = entries.filter((entry) =>
		entry.kind === 'child' && entry.depth === 1 && entry.mode === 'continuable')
	const members = children.map((entry) => {
		const agent = ctx.agents.get(entry.id)
		return {
			id: entry.id,
			name: entry.path ?? entry.name ?? entry.id,
			running: agent?.status === 'running',
			preset: agent === undefined ? undefined : presetOf(agent),
			route: agent === undefined ? undefined : routeOf(agent),
			cwd: agent === undefined ? undefined : workingDirectoryOf(ctx, agent),
		}
	})
	const idleMembers = members.filter((member) => !member.running)
	return { total: members.length, idle: idleMembers.length, idleMembers }
}

/**
 * Fill metadata for inactive idle members from their session log: the header
 * carries the preset and cwd, the descriptor event carries the model route.
 * Runs only when an exception switch is enabled and the budget already failed.
 * Unreadable fields stay undefined and withhold that dimension's exception.
 * @param ctx - context that may carry the session query service.
 * @param idleMembers - idle members from {@link subagentLoad}; mutated in place.
 * @param settings - normalized live settings.
 * @param signal - cancellation forwarded to the session observation.
 */
async function enrichIdleMembers(ctx, idleMembers, settings, signal) {
	if (!settings.preset && !settings.model && !settings.cwd) return
	const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
	if (query === undefined) return
	for (const member of idleMembers) {
		const missing = (settings.preset && member.preset === undefined)
			|| (settings.model && member.route === undefined)
			|| (settings.cwd && member.cwd === undefined)
		if (!missing) continue
		let observation
		try {
			observation = await query.observeSession(member.id, { signal, projectionMode: 'none' })
			const header = observation.header
			if (settings.preset && member.preset === undefined && typeof header.agentPreset === 'string' && header.agentPreset.length > 0) {
				member.preset = header.agentPreset
			}
			if (settings.cwd && member.cwd === undefined && typeof header.cwd === 'string' && header.cwd.length > 0) {
				member.cwd = header.cwd
			}
			if (settings.model && member.route === undefined) {
				for (const event of observation.events) {
					if (event.type !== 'subagent/descriptor') continue
					const data = event.data
					if (typeof data.agentProvider === 'string' && typeof data.agentModel === 'string') {
						member.route = {
							provider: data.agentProvider,
							model: data.agentModel,
							...(typeof data.agentReasoningEffort === 'string' ? { reasoningEffort: data.agentReasoningEffort } : {}),
						}
					}
					break
				}
			}
		} catch {
			// Unknown stays unknown; the exception for that dimension is withheld.
		} finally {
			try {
				observation?.[Symbol.dispose]?.()
			} catch {
				// The observation may already be released.
			}
		}
	}
}

/** Render a route for model-facing text. */
function routeLabel(route) {
	return route === undefined ? '模型未知' : `${route.provider}/${route.model}`
}

/** Render one idle member for the refusal text. */
function describeMember(member) {
	return `${member.name}（${member.preset ?? '预设未知'} / ${routeLabel(member.route)} / ${member.cwd ?? '目录未知'}）`
}

/** Explain one exception dimension outcome inside the refusal text. */
function exceptionDetail(kind, requestLabel) {
	switch (kind) {
		case 'off': return '（开关关闭）'
		case 'not-requested': return '（未显式提供请求值）'
		case 'matched': return `（空闲中已有 ${requestLabel}）`
		case 'unknown': return '（部分空闲代理信息无法确认，保守拒绝）'
		case 'free': return '（空闲中没有，命中）'
		default: return ''
	}
}

/**
 * Decide one creation against the two limits and the enabled exceptions.
 * Both limits must pass; otherwise an enabled dimension whose requested value
 * is absent from every idle member grants creation. Unknown metadata withholds
 * that dimension (conservative).
 * @param load - snapshot from {@link subagentLoad}.
 * @param request - explicit preset/route/cwd from the call.
 * @param settings - normalized live settings.
 * @returns `{ allow, ratioOk, countOk, via, details }`.
 */
function evaluateCreation(load, request, settings) {
	const ratioOk = load.total === 0 || load.idle * 100 <= load.total * settings.ratio
	const countOk = load.idle <= settings.count
	if (ratioOk && countOk) return { allow: true, ratioOk, countOk, via: 'budget', details: {} }
	const idle = load.idleMembers
	const details = {}
	let allow = false
	if (settings.preset && request.preset !== undefined) {
		const matched = idle.some((member) => member.preset === request.preset)
		const unknown = idle.some((member) => member.preset === undefined)
		details.preset = matched ? 'matched' : unknown ? 'unknown' : 'free'
		if (!matched && !unknown) allow = true
	} else {
		details.preset = settings.preset ? 'not-requested' : 'off'
	}
	if (settings.model && request.route !== undefined) {
		const matched = idle.some((member) => sameRoute(member.route, request.route))
		const unknown = idle.some((member) => member.route === undefined)
		details.model = matched ? 'matched' : unknown ? 'unknown' : 'free'
		if (!matched && !unknown) allow = true
	} else {
		details.model = settings.model ? 'not-requested' : 'off'
	}
	if (settings.cwd && request.cwd !== undefined) {
		const matched = idle.some((member) => member.cwd === request.cwd)
		const unknown = idle.some((member) => member.cwd === undefined)
		details.cwd = matched ? 'matched' : unknown ? 'unknown' : 'free'
		if (!matched && !unknown) allow = true
	} else {
		details.cwd = settings.cwd ? 'not-requested' : 'off'
	}
	return { allow, ratioOk, countOk, via: allow ? 'exception' : undefined, details }
}

/** Build the model-facing refusal for one rejected creation. */
function refusalMessage(load, request, settings, decision) {
	const percent = load.total === 0 ? 0 : Math.round((load.idle * 100) / load.total)
	const failures = []
	if (!decision.ratioOk) failures.push(`空闲比例 ${percent}%（${load.idle}/${load.total}）超过上限 ${settings.ratio}%`)
	if (!decision.countOk) failures.push(`空闲数量 ${load.idle} 超过上限 ${settings.count}`)
	return [
		`拒绝新建子代理：${failures.join('；')}。两个上限必须同时满足。`,
		`当前规则：空闲比例 ≤ ${settings.ratio}%，空闲数量 ≤ ${settings.count}。`,
		`差异豁免：预设不同=${settings.preset ? '开' : '关'}${exceptionDetail(decision.details.preset, request.preset ?? '')}；模型不同=${settings.model ? '开' : '关'}${exceptionDetail(decision.details.model, routeLabel(request.route))}；工作目录不同=${settings.cwd ? '开' : '关'}${exceptionDetail(decision.details.cwd, request.cwd ?? '')}。`,
		`空闲子代理：${load.idleMembers.map(describeMember).join('；') || '无'}。`,
		'请先调用 list_agents 确认子代理情况；优先用 send_message 向空闲子代理派发任务。若确实需要不同预设/模型/目录，请在调用时显式传入 agent_preset / provider+model / cwd，并确认对应开关已开启。',
	].join('\n')
}

/** Render the live creation-rule context, with a one-step update marker. */
function buildRuleText(settings, changed = false) {
	const onOff = (value) => (value ? '开' : '关')
	return `${changed ? '（子代理创建规则已更新，以下为当前规则）\n' : ''}${[
		RULE_HEADER,
		'- 调用 subagent 之前，先调用 list_agents 确认子代理情况；优先用 send_message 向空闲的子代理派发任务，而不是建立新的子代理。',
		`- 两个上限必须同时满足才允许新建：空闲子代理比例 ≤ ${settings.ratio}%，空闲子代理数量 ≤ ${settings.count}。`,
		'- 计数口径：你自己直接创建、可继续（continuable）的子代理；workflow 派出的也算；孙子代理不算；空闲 = 当前不在运行；总数为 0 时允许。',
		`- 超过上限时，只有命中已开启的差异豁免才允许新建：预设不同（${onOff(settings.preset)}：空闲代理中没有请求的 agent_preset）、模型不同（${onOff(settings.model)}：空闲代理中没有请求的 provider/model）、工作目录不同（${onOff(settings.cwd)}：空闲代理中没有请求的 cwd）。省略的参数不触发豁免；需要豁免时请显式写出。`,
		'- 模型差异只比较 provider/model（reasoning_effort 不参与）；本段数值随设置实时更新。',
	].join('\n')}`
}

/**
 * Build the `subagent` replacement for one agent: same schema, same output, same
 * presentation, plus the new pre-call instruction and the configurable check.
 * @param ctx - plugin context used for live counting and logging.
 * @param current - the delegation definition this call will shadow.
 * @param config - live plugin Config (fields may be Volatile).
 * @returns a registry-ready definition that delegates to `current`.
 */
function buildSubagent(ctx, current, config = {}) {
	const definition = {
		name: SUBAGENT,
		description: `${current.description}\n\n${NEW_SUBAGENT_RULE}`,
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
				const settings = normalizeSettings(config)
				const request = {
					preset: requestedPreset(args),
					route: requestedRoute(args),
					cwd: requestedCwd(ctx, caller, args),
				}
				let load
				try {
					load = await subagentLoad(ctx, caller, exec.signal)
				} catch (error) {
					if (exec.signal.aborted) throw error
					// The rule cannot be evaluated; do not turn an inspection failure into a refusal.
					ctx.logger?.warn?.(`lineage-teams: cannot inspect subagent load, delegation is allowed: ${String(error)}`)
				}
				if (load !== undefined) {
					let decision = evaluateCreation(load, request, settings)
					if (!decision.allow && (settings.preset || settings.model || settings.cwd)) {
						try {
							await enrichIdleMembers(ctx, load.idleMembers, settings, exec.signal)
						} catch (error) {
							if (exec.signal.aborted) throw error
						}
						decision = evaluateCreation(load, request, settings)
					}
					if (!decision.allow) throw new Error(refusalMessage(load, request, settings, decision))
				}
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
		const visible = ctx.tools.get(SEND_MESSAGE, scope)
		if (visible === undefined) return
		const definition = buildSendMessage(ctx, agent)
		try {
			track(agent.ctx.tools.register(definition))
			ours.set(agent, definition)
		} catch (error) {
			// A pre-0.4 instance left its shadow registered here and it closes over
			// a retired context. Re-registering the name fails, so take the leftover
			// definition over by swapping in this instance's working body.
			if (!isLegacySendMessage(visible)) throw error
			Object.assign(visible, definition)
			visible[SEND_MESSAGE_SHADOW] = true
			ours.set(agent, visible)
			ctx.logger?.warn?.(`lineage-teams: adopted the ${SEND_MESSAGE} shadow left in agent "${agent.id}" by a previous version`)
		}
	}

	const installSubagent = (agent) => {
		const scope = scopeOf(agent.ctx)
		if (scope === undefined) return
		// The refusal tells the caller to use send_message; without it the rule
		// would only remove the caller's only way to delegate.
		if (ctx.tools.get(SEND_MESSAGE, scope) === undefined) return
		const current = ctx.tools.get(SUBAGENT, scope)
		if (current === undefined || isSubagentShadow(current)) return
		track(agent.ctx.tools.register(buildSubagent(ctx, current, config)))
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

	// Per-agent last-rendered rule signature: a settings change adds a one-step
	// "updated" marker to the next assembly, then the marker clears itself.
	const ruleSignatures = new WeakMap()

	ctx.systemPrompt.context({
		name: 'lineage:completion',
		order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
		required: true,
		text: (context) => guidanceText(ctx, ours, context),
	})

	ctx.systemPrompt.context({
		name: 'lineage:subagent-rule',
		order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
		required: true,
		text: (context) => {
			if (context.agent === undefined) return ''
			if (!isSubagentShadow(ctx.tools.get(SUBAGENT, context.scope, context.toolSet))) return ''
			const settings = normalizeSettings(config)
			const signature = JSON.stringify(settings)
			const previous = ruleSignatures.get(context.agent)
			ruleSignatures.set(context.agent, signature)
			return buildRuleText(settings, previous !== undefined && previous !== signature)
		},
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

// The Loader normalizes `exports.default ?? exports`, so the default plugin
// object must carry Config; a named-only export would run without its schema.
export default { name, inject, Config, apply }

// Narrow, side-effect-free surface for the smoke test.
export const __test = {
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
	SEND_MESSAGE,
	SUBAGENT,
	SUBAGENT_FORK,
}
