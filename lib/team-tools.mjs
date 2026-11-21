// FORK HEADER — 来源：deepseek-ai/deepseek-harness @ dsh-v0.2.2-rc.1
// packages/experimental/tool-agent-team/lib/index.js（编译产物），改动见仓库 PATCHES.md。
import { z, defineTool, createUserMessage, scopeChainOf, scopeOf, steerHostSubagentPrompt } from "./deps.mjs";
import { TeamTaskId } from "./team-domain.mjs";
//#region lib/types/index.js
/** Scoped model-facing tools for the opt-in Agent Teams runtime. */
/** Cordis plugin name. */
const name = "tool-agent-team";
/** Services required by the Team tool plugin. */
const inject = [
	"agents",
	"agentTeams",
	"tools",
	"systemPrompt",
	"subagents"
];
/** Loader schema for the opt-in Team tool plugin. */
const Config = z.object({
	interrupt: z.boolean().default(true),
	freshProvider: z.string().default("spawn"),
	forkProvider: z.string().default("fork")
});
/** Model-facing collaboration guidance shared by Lead and teammates. */
function teamPolicy(interrupt) {
	return `Agent Teams is available in this session

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message${interrupt ? " and interrupt_agent" : ""}, or as owner when assigning or filtering shared tasks. send_message also reaches any other agent under the same root session by agent id (parent, sibling, or subagent), and accepts the aliases "lead" (the Team Lead/root) and "parent" (the direct parent). send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A peer message starts with its sender name. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`;
}
const ACTIVE_WAIT_STATUSES = new Set(["running", "provisioning"]);
const NO_ACTIVE_PEER_MESSAGE = "No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.";
/**
* One model-facing roster row. The Lead pseudo-row omits the
* teammate-only provisioning fields, so only identity, role, status, and
* diagnostics are required.
*/
const MEMBER_VIEW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		target: {
			type: "string",
			required: true
		},
		role: {
			type: "string",
			required: true,
			enum: ["lead", "teammate", "parent", "child"]
		},
		status: {
			type: "string",
			required: true,
			enum: [
				"running",
				"inactive",
				"provisioning",
				"failed"
			]
		},
		description: { type: "string" },
		provider: { type: "string" },
		context: {
			type: "string",
			enum: ["fresh", "fork"]
		},
		model: { type: "string" },
		diagnostics: {
			type: "array",
			required: true,
			items: { type: "string" }
		}
	}
};
/** Expose the member name as its model-facing target. */
function modelMember(member) {
	const { id: _id, name, ...details } = member;
	return {
		target: name,
		...details
	};
}
/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		revision: {
			type: "integer",
			required: true
		},
		subject: {
			type: "string",
			required: true
		},
		description: {
			type: "string",
			required: true
		},
		status: {
			type: "string",
			required: true,
			enum: [
				"pending",
				"in_progress",
				"completed",
				"deleted"
			]
		},
		ownerName: { type: "string" },
		blockedBy: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		writeScopes: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		ready: {
			type: "boolean",
			required: true
		},
		writeScopeWarnings: {
			type: "array",
			required: true,
			items: { type: "string" }
		}
	}
};
const SPAWN_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { member: {
		...MEMBER_VIEW_SCHEMA,
		required: true
	} }
};
const MEMBER_LIST_VALUE_SCHEMA = {
	type: "array",
	items: MEMBER_VIEW_SCHEMA
};
const SEND_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		delivered: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		relayed: {
			type: "array",
			items: { type: "string" }
		},
		failed: {
			type: "array",
			required: true,
			items: { type: "string" }
		}
	}
};
/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		timedOut: {
			type: "boolean",
			required: true
		},
		noProgress: {
			type: "object",
			additionalProperties: false,
			properties: {
				reason: {
					type: "string",
					required: true,
					const: "no-active-peer"
				},
				message: {
					type: "string",
					required: true
				}
			}
		}
	}
};
const INTERRUPT_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		previousStatus: {
			type: "string",
			enum: ["running", "inactive"]
		},
		accepted: { type: "boolean" },
		target: { type: "string" }
	}
};
const TASK_LIST_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		tasks: {
			type: "array",
			required: true,
			items: TASK_VIEW_SCHEMA
		},
		nextCursor: { type: "integer" }
	}
};
/**
* Declare one canonical output schema with compact model-facing JSON. Every
* Team result is a fixed record, so the declared schema is what makes the
* compiler check `execute` against the value the model is promised.
* @param schema - canonical value schema for one tool.
* @returns the `output` declaration accepted by {@link defineTool}.
*/
function jsonOutput(schema) {
	return {
		schema,
		render: (_args, value) => [{
			type: "text",
			text: JSON.stringify(value)
		}]
	};
}
/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent, toolName) {
	/* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
	if (agent === void 0) throw new Error(`${toolName} requires a calling Agent`);
	return agent;
}
/** Walk parentSession to the root session id; undefined when an ancestor is not live. */
function rootOf(agents, agent) {
	let current = agent;
	for (let hops = 0; hops < 64; hops += 1) {
		const parentId = current.session.header.parentSession;
		if (parentId === undefined) return current.id;
		const parent = agents.get(parentId);
		if (parent === undefined) return undefined;
		current = parent;
	}
	return undefined;
}

/** Resolve the root session id for an agent id, walking stored ancestors when needed. */
async function rootOfId(ctx, agentId, signal) {
	let current = agentId;
	for (let hops = 0; hops < 64; hops += 1) {
		const live = ctx.agents.get(current);
		if (live !== undefined) return rootOf(ctx.agents, live);
		const query = ctx.get("sessionQuery");
		if (query === undefined) return undefined;
		let header;
		try {
			header = (await query.observeSession(current, { signal }))?.header;
		} catch {
			return undefined;
		}
		if (header === undefined) return undefined;
		const parentId = header.parentSession;
		if (parentId === undefined) return current;
		current = parentId;
	}
	return undefined;
}

/** Resolve a live agent, or read a stored session header for a cold one. */
async function resolveTargetAgent(ctx, agentId, signal) {
	const live = ctx.agents.get(agentId);
	if (live !== undefined) return {
		live,
		parentId: live.session.header.parentSession
	};
	const query = ctx.get("sessionQuery");
	if (query === undefined) return undefined;
	try {
		const observation = await query.observeSession(agentId, { signal });
		const header = observation?.header;
		if (header === undefined) return undefined;
		return {
			live: undefined,
			parentId: header.parentSession
		};
	} catch {
		return undefined;
	}
}

/**
 * Walk the live-or-stored parent chain above one agent.
 *
 * Non-Team subagents have no roster, so this is how they discover the parent
 * they must answer and the root session that owns every reachable agent. Rows
 * come back nearest-first; the row whose own header has no `parentSession` is
 * the root and is named `lead`, every other row is a `parent`.
 * @param ctx - context carrying the live Agent registry and Session query.
 * @param agent - exact live caller whose ancestry is requested.
 * @param signal - cancellation forwarded to stored-session reads.
 * @returns model-facing roster rows, nearest first, empty for a root session.
 */
async function ancestorRows(ctx, agent, signal) {
	const rows = [];
	const seen = new Set([agent.id]);
	let nextId = agent.session.header.parentSession;
	for (let hops = 0; nextId !== undefined && hops < 64; hops += 1) {
		if (seen.has(nextId)) break;
		seen.add(nextId);
		const live = ctx.agents.get(nextId);
		let parentId;
		if (live !== undefined) parentId = live.session.header.parentSession;
		else {
			const stored = await resolveTargetAgent(ctx, nextId, signal);
			if (stored === undefined) break;
			parentId = stored.parentId;
		}
		rows.push({
			target: nextId,
			role: parentId === undefined ? "lead" : "parent",
			status: live?.status === "running" ? "running" : "inactive",
			diagnostics: []
		});
		if (parentId === undefined) break;
		nextId = parentId;
	}
	return rows;
}

/**
 * Resolve the "lead" / "parent" aliases for `send_message`.
 *
 * Team members keep routing "lead" through the Team service (it resolves the
 * Lead by name), while "parent" means the Lead to a teammate and is an error
 * for the Lead itself. Non-members resolve "parent" to their direct parent id
 * and "lead" to the root session id, so a subagent can answer without knowing
 * any raw session id in advance.
 * @param ctx - context carrying the Agent registry.
 * @param caller - exact live sending Agent.
 * @param membership - Team membership of the caller, or undefined.
 * @param target - trimmed model-supplied target.
 * @param signal - cancellation forwarded to stored-session reads.
 * @returns the member name or agent id to deliver to.
 */
async function resolveSendTarget(ctx, caller, membership, target, signal) {
	if (target !== "lead" && target !== "parent") return target;
	if (membership !== undefined) {
		if (target === "lead") return "lead";
		if (membership.role === "lead") throw new Error("this session is the Team Lead and has no parent agent; use a teammate name or an agent id");
		return "lead";
	}
	if (target === "parent") {
		const parentId = caller.session.header.parentSession;
		if (parentId === undefined) throw new Error("this session is a root session and has no parent agent");
		return parentId;
	}
	const rootId = await rootOfId(ctx, caller.id, signal);
	if (rootId === undefined) throw new Error("cannot resolve the root agent for \"lead\"");
	if (rootId === caller.id) throw new Error("this session is the root agent; address another agent by id instead of \"lead\"");
	return rootId;
}

/**
 * Compose the collaboration guidance injected into a non-Team subagent.
 *
 * Registered as a runtime-context contribution (never appended to the task
 * message), so it is re-rendered on every step and names the exact parent the
 * child must answer. Mentions only tools the child really declares.
 * @param parentId - durable session id of the delegating parent.
 * @param available - which sibling tools the child's composition declares.
 * @returns model-facing guidance text.
 */
function subagentGuidanceText(parentId, { listAgents, sendMessage, interrupt }) {
	const lines = [`你是子代理，父级智能体（parent agent）是「${parentId}」。`];
	if (listAgents) lines.push("你可以用 list_agents 查看同一根会话下的智能体：父级、兄弟子代理与同组队友（若有），以及它们当前的状态（scope=all 是整棵树，scope=children 只看直接子代理）。");
	if (sendMessage) {
		lines.push(
			"你可以用 send_message 与父级、兄弟子代理或同组队友（若有）交流：send_message({ targets: [\"parent\"], message: \"<自包含的消息>\" })",
			"- targets 至少给一个：\"parent\" 指直接父级，\"lead\" 指根会话（团队负责人），也可以直接写对方的 agent id；多个即群发。",
			"- 对方正在运行时会在下一步读到你的消息，空闲时会被唤醒；送达不等于已被处理。",
			"- 其他智能体与你共享工作空间，但不会自动获得你的对话记录、工具输出或推理过程——需要对方知道的事实、结论与证据，请写进消息正文。",
			"- 发送消息不会结束你这一轮。",
			"- 任务一完成就直接向父代理汇报：用 send_message 给父级发一条消息，详细说明结论、证据（命令原文、文件路径与行号）与未完成项，并给出交付物路径——这条消息就是你的正式汇报，不要指望父级从你的最终回复里读细节。",
			"- 汇报之后，最终回复只写一句话——「已经汇报完毕。」；不要把汇报内容再贴一遍。"
		);
	}
	if (interrupt) lines.push("必要时可以用 interrupt_agent({ target: \"<agent id>\" }) 停止同一根会话下某个子代理的当前回合。");
	return lines.join("\n");
}

/**
 * Deliver to any agent under the same root session (legacy subagents included) by
 * authorizing through that agent's direct parent — the same host-only path the
 * Team domain uses for teammates.
 */
async function deliverUnderRoot(ctx, sender, targetId, text, signal, relayBudget = 4) {
	if (targetId === sender.id) throw new Error("an agent cannot message itself");
	const target = await resolveTargetAgent(ctx, targetId, signal);
	if (target === undefined) throw new Error(`agent "${targetId}" is unknown, archived, or has no durable session to resume`);
	const senderRoot = await rootOfId(ctx, sender.id, signal);
	let targetRoot;
	if (target.live !== undefined) targetRoot = rootOf(ctx.agents, target.live);
	else if (target.parentId === undefined) throw new Error(`agent "${targetId}" is a stored root session that is not running`);
	else {
		// 祖先可能已结算：沿会话存储上溯，而不是只看在场的 agent
		const parent = ctx.agents.get(target.parentId);
		targetRoot = parent === undefined
			? await rootOfId(ctx, target.parentId, signal)
			: rootOf(ctx.agents, parent);
	}
	if (senderRoot === undefined || targetRoot === undefined) throw new Error(`cannot verify that "${targetId}" shares your root session`);
	if (senderRoot !== targetRoot) throw new Error(`agent "${targetId}" belongs to a different root session "${targetRoot}"`);
	const content = [{
		type: "text",
		text: `Agent ${sender.id} sent a message: `
	}, {
		type: "text",
		text
	}];
	const source = {
		kind: "agent-message",
		form: "relay",
		senderSessionId: sender.id
	};
	if (target.parentId === undefined) {
		const root = target.live;
		if (root === undefined) throw new Error(`root session "${targetId}" is not live`);
		const message = createUserMessage({ content, source });
		root.steer(message);
		return {
			messageId: message.id,
			mode: "direct"
		};
	}
	let parent = ctx.agents.get(target.parentId);
	if (parent === undefined) {
		// 父级不在场：先发一条"告知"把它唤醒（不需要它转发），然后自己直投给目标。
		if (relayBudget <= 0) throw new Error(`cannot reach "${targetId}": the relay chain is broken above "${target.parentId}"`);
		const notice = `通知（无需处理）：Agent ${String(sender.id)} 即将给你的子代理「${targetId}」发送一条消息；你的链路已被唤醒，不需要你转发，也不需要回复。`;
		await deliverUnderRoot(ctx, sender, target.parentId, notice, signal, relayBudget - 1);
		parent = ctx.agents.get(target.parentId);
		if (parent === undefined) {
			// 唤醒失败（极少见）：退回到"请父级转交"的老办法
			const relayText = `Agent ${String(sender.id)} 想联系你的子代理「${targetId}」，但投递必须由它的直接父级（也就是你）授权。请把下面的原文转交给它：\n  - 若你的 send_message 用 targets 参数：send_message({ targets: ["${targetId}"], message: "<原文>" })\n  - 若只有 agent_id：send_message({ agent_id: "${targetId}", message: "<原文>" })\n\n--- 原文 ---\n${text}`;
			const hop = await deliverUnderRoot(ctx, sender, target.parentId, relayText, signal, relayBudget - 1);
			return {
				messageId: hop.messageId,
				mode: "relayed",
				via: target.parentId
			};
		}
		return {
			messageId: await steerHostSubagentPrompt(ctx.subagents, parent, targetId, content, source, signal),
			mode: "direct",
			wokeParent: target.parentId
		};
	}
	const messageId = await steerHostSubagentPrompt(ctx.subagents, parent, targetId, content, source, signal);
	return {
		messageId,
		mode: "direct"
	};
}

/** Register the complete Team tool set in one exact Agent scope. */
function buildSendMessage(ctx) {
	return defineTool({
			name: "send_message",
			description: "Send one message to one or more agents under the same root session (Team members, your parent, or any subagent), broadcast when several. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn. Returns which targets accepted the message.",
			parameters: {
				targets: {
					type: "array",
					items: { type: "string" },
					description: "One or more targets: teammate names, \"lead\" (root/Team Lead), \"parent\" (your direct parent), or raw agent ids of agents under the same root session. Several targets = broadcast."
				},
				agent_id: {
					type: "string",
					description: "Single-target shorthand kept for the stock send_message contract."
				},
				message: {
					type: "string",
					required: true,
					description: "Self-contained message for every target."
				}
			},
			output: jsonOutput(SEND_VALUE_SCHEMA),
			async execute(args, exec) {
				const caller = callingAgent(exec.agent, "send_message");
				const rawTargets = [
					...(Array.isArray(args.targets) ? args.targets : []),
					...(args.agent_id === undefined ? [] : [args.agent_id])
				].map((target) => target.trim()).filter((target) => target.length > 0);
				if (rawTargets.length === 0) throw new Error("send_message: give targets (one or more) or agent_id");
				const delivered = [];
				const relayed = [];
				const failed = [];
				const seen = new Set();
				// 成员列表只对团队成员可用；非成员（legacy 子代理）没有团队名册
				const membership = ctx.agentTeams.tryMembership(caller);
				const members = membership === void 0 ? [] : ctx.agentTeams.listMembers(caller);
				for (const rawTarget of rawTargets) {
					if (seen.has(rawTarget)) continue;
					seen.add(rawTarget);
					let target = rawTarget;
					try {
						target = await resolveSendTarget(ctx, caller, membership, rawTarget, exec.signal);
						if (members.some((member) => member.name === target)) {
							await ctx.agentTeams.sendMessage(caller, {
								target,
								content: [{
									type: "text",
									text: args.message
								}],
								signal: exec.signal
							});
						} else if (target === caller.id) {
							throw new Error("an agent cannot message itself");
						} else {
							// 不是团队成员：当成 agent id，按同根会话投递（兼容 legacy subagent 子代理）
							const outcome = await deliverUnderRoot(ctx, caller, target, args.message, exec.signal);
							if (outcome.mode === "relayed") relayed.push(target);
						}
						delivered.push(rawTarget);
					} catch (error) {
						failed.push(`${rawTarget}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				if (delivered.length === 0) throw new Error(`send_message failed for every target: ${failed.join("; ")}`);
				return {
					delivered,
					failed,
					...(relayed.length === 0 ? {} : { relayed })
				};
			}
		});
}

/**
 * Whether the Agent's own composition already declares a tool name.
 * Scopes chain preset → agent, so a name registered in the preset or above is
 * visible here before this scope registers anything: the fork can then replace
 * that definition, while a name the preset never declared stays absent.
 * @param ctx - Team tool plugin context owning the tool registry.
 * @param agent - exact live Agent whose visible tools are read.
 * @param name - tool name to look up.
 * @returns true when the name resolves from an outer scope.
 */
function declaresTool(ctx, agent, name) {
	return ctx.tools.get(name, agent) !== void 0;
}

/** One model-facing roster row for a legacy (non-Team) subagent. */
function descendantRow(entry) {
	const row = {
		target: entry.id,
		role: "child",
		status: entry.activity === "running" ? "running" : "inactive",
		diagnostics: []
	};
	if (typeof entry.label === "string" && entry.label.length > 0) row.description = entry.label;
	return row;
}

/** Roster view shared by Team members and by non-Team subagents. */
function buildListAgents(ctx) {
	return defineTool({
		name: "list_agents",
		description: "List the agents you can address under this root session: Team members (Lead and named teammates) and, for a non-Team subagent, its parent chain plus every sibling and descendant. running means a turn is executing; inactive means none is, which says nothing about the task result. scope=all (default) lists the whole reachable tree; scope=children lists direct subagents only.",
		parameters: { scope: {
			type: "string",
			enum: ["all", "children"],
			description: "all (default) lists parent chain, teammates, and the whole subagent tree; children lists the parent chain plus direct subagents."
		} },
		output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
		async execute(args, exec) {
			const caller = callingAgent(exec.agent, "list_agents");
			const membership = ctx.agentTeams.tryMembership(caller);
			if (membership !== void 0) {
				const members = ctx.agentTeams.listMembers(caller);
				const rows = members.map(modelMember);
				const known = new Set(members.map((member) => member.id));
				// 合并 legacy 子代理（不在团队成员里的那些）：整棵树，或只看自己的直接子代理。
				let leaves = [];
				try {
					const all = await ctx.subagents.listDescendants(membership.root.id, exec.signal);
					leaves = args.scope === "children" ? all.filter((entry) => entry.parentId === caller.id) : all;
				} catch (error) {
					try {
						const own = await ctx.subagents.listDescendants(caller.id, exec.signal);
						leaves = args.scope === "children" ? own.filter((entry) => entry.parentId === caller.id) : own;
					} catch {
						throw new Error(`list_agents(${args.scope ?? "all"}): ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				for (const entry of leaves) {
					if (entry.kind !== "child" || known.has(entry.id)) continue;
					rows.push(descendantRow(entry));
				}
				return rows;
			}
			// 非团队成员（legacy 子代理）：没有名册，用父链 + 同一根会话下的整棵树代替，
			// 这样它既能找到要回消息的父级/组长，也能看到兄弟与其他子代理。
			const ancestors = (await ancestorRows(ctx, caller, exec.signal)).reverse();
			const rows = [...ancestors];
			const seen = new Set([caller.id, ...ancestors.map((row) => row.target)]);
			let entries = [];
			try {
				const rootId = ancestors.length === 0 ? caller.id : ancestors[0].target;
				entries = await ctx.subagents.listDescendants(rootId, exec.signal);
				// depth 相对 root，不是相对 caller；直接子代理按 parentId 判定。
				if (args.scope === "children") entries = entries.filter((entry) => entry.parentId === caller.id);
			} catch (error) {
				try {
					entries = await ctx.subagents.listDescendants(caller.id, exec.signal);
					if (args.scope === "children") entries = entries.filter((entry) => entry.parentId === caller.id);
				} catch {
					entries = [];
				}
			}
			for (const entry of entries) {
				if (entry.kind !== "child" || seen.has(entry.id)) continue;
				if (args.scope === "children" && entry.parentId !== caller.id) continue;
				rows.push(descendantRow(entry));
			}
			return rows;
		}
	});
}

/** Interrupt a teammate by name, or any reachable same-root agent by id. */
function buildInterruptAgent(ctx) {
	return defineTool({
		name: "interrupt_agent",
		description: "Ask an agent to stop its current work. A Team Lead may interrupt a named teammate; any member may interrupt one of its own subagents by agent id. This call returns without waiting for the target to stop.",
		parameters: {
			target: {
				type: "string",
				description: "Teammate name from spawn_teammate/list_agents (Lead only), or the agent id of one of your direct children or deeper descendants."
			},
			agent_id: { type: "string", description: "Single-target shorthand for an agent id." }
		},
		output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
		execute(args, exec) {
			const caller = callingAgent(exec.agent, "interrupt_agent");
			const target = (args.target ?? args.agent_id ?? "").trim();
			if (target.length === 0) throw new Error("interrupt_agent: give target (teammate name or agent id)");
			// 非团队成员没有名册；成员按名字，其余按 agent id 中断（legacy subagent 语义）。
			const membership = ctx.agentTeams.tryMembership(caller);
			if (membership !== void 0 && ctx.agentTeams.listMembers(caller).some((member) => member.name === target)) {
				if (membership.role !== "lead") throw new Error(`interrupt_agent: only the Team Lead can interrupt teammate "${target}"`);
				return Promise.resolve(ctx.agentTeams.interrupt(caller, target)).then((result) => ({
					accepted: true,
					target,
					...(result?.previousStatus === undefined ? {} : { previousStatus: result.previousStatus })
				}));
			}
			ctx.subagents.interrupt(target, {
				kind: "ancestor",
				agent: caller
			});
			return Promise.resolve({ accepted: true, target: args.target });
		}
	});
}

/**
 * Model-facing identity and collaboration block for one Team member.
 *
 * Rendered as a runtime-context contribution on every step, so the peer list
 * and the status hint stay current. The Lead has no parent of its own, so it
 * gets a variant that does not claim one. Members can message the parent, any
 * teammate, or any other agent under the same root session (subagents included).
 * @param ctx - Team tool context carrying the Agent Teams service.
 * @param agent - exact live member whose block is rendered.
 * @returns the rendered block, or '' when the agent has no live membership.
 */
function teamIdentityText(ctx, agent) {
	try {
		return renderTeamIdentityText(ctx, agent);
	} catch {
		return "";
	}
}

/** Render the identity block; callers treat a disposed Team as an empty block. */
function renderTeamIdentityText(ctx, agent) {
	const membership = ctx.agentTeams.tryMembership?.(agent);
	if (membership === undefined) return "";
	const { role, name, root } = membership;
	const members = ctx.agentTeams.listMembers(agent);
	const others = members.filter((member) => member.id !== agent.id).map((member) => member.name);
	const peerList = others.length === 0 ? "（暂无）" : others.map((peer) => `「${peer}」`).join("、");
	const reachable = role === "lead" ? "本组成员与同一根会话下的其他子代理" : "本组成员、父级与同一根会话下的其他子代理";
	const who = role === "lead" ? `你是团队负责人「${name}」。` : `你是「${name}」，父级智能体（parent agent）是「${root.id}」。`;
	const targets = role === "lead"
		? `  send_message({ targets: ["<组员名>"], message: "<自包含的消息>" })
- targets 至少给一个：组员名，或同一根会话里其他智能体的 agent id；多个即群发。`
		: `  send_message({ targets: ["lead"], message: "<自包含的消息>" })
  send_message({ targets: ["<组员名>", "<agent id>"], message: "..." })   // 多个即群发
- targets 至少给一个：组员名、"lead"/"parent"（父级/组长）、或同一根会话里其他智能体的 agent id。`;
	return `${who}
本组其他成员：${peerList}（含你共 ${members.length} 人）。名单会变化，用 list_agents 查看最新成员与状态。

你可以用 list_agents 查看所有智能体（${reachable}），用 send_message 与${role === "lead" ? "任意组员或其他智能体" : "父级、任意组员或其他智能体"}交流：
${targets}
- 对方正在运行时会在下一步读到你的消息，空闲时会被唤醒；送达不等于已被处理。
- 其他智能体与你共享工作空间，但不会自动获得你的对话记录、工具输出或推理过程——
  需要对方知道的事实、结论与证据，请写进消息正文。
- 发送消息不会结束你这一轮；不必为「收到」「好的」回发消息。${role === "lead" ? "" : `
- 任务一完成就直接向队长（父代理）汇报：用 send_message({ targets: ["lead"], message: "<自包含的汇报>" }) 详细说明结论、证据（命令原文、文件路径与行号）与未完成项，并给出交付物路径——这条消息就是你的正式汇报。
- 汇报之后，最终回复只写一句话——「已经汇报完毕。」；不要把汇报内容再贴一遍。`}`;
}

function install(agent, ctx, config) {
	const scoped = agent.ctx;
	const disposers = [];
	const register = (disposer) => {
		disposers.push(disposer);
	};
	try {
		register(scoped.systemPrompt.section({
			name: "team:policy",
			order: scoped.systemPrompt.getSectionOrder("TEAM_POLICY"),
			text: teamPolicy(config.interrupt)
		}));
		register(scoped.systemPrompt.context({
			name: "team:identity",
			order: scoped.systemPrompt.getContextOrder("TEAM_IDENTITY"),
			required: true,
			text: () => teamIdentityText(ctx, agent)
		}));
		register(scoped.tools.register(defineTool({
			name: "spawn_teammate",
			description: "Create one named, durable teammate. Only the Team Lead may call this tool.",
			parameters: {
				name: {
					type: "string",
					required: true,
					description: "Unique lower-kebab-case teammate name."
				},
				description: {
					type: "string",
					required: true,
					description: "Short description of the delegated responsibility."
				},
				prompt: {
					type: "string",
					required: true,
					description: "Complete initial task for the teammate."
				},
				context: {
					type: "string",
					enum: ["fresh", "fork"],
					description: "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh."
				},
				agent_preset: {
					type: "string",
					description: "Agent preset id for the teammate (for example simplified, minimal, standard, cordis). Defaults to the Lead's own preset."
				},
				provider: {
					type: "string",
					description: "LLM provider id for the teammate. Supply together with model."
				},
				model: {
					type: "string",
					description: "Model id within provider. Supply together with provider."
				},
				reasoning_effort: {
					type: "string",
					description: "Reasoning effort id for the chosen model; only meaningful with provider and model."
				},
				cwd: {
					type: "string",
					description: "Initial working directory for the teammate; omitted inherits the Lead's."
				},
				max_depth: {
					type: "integer",
					description: "Absolute delegation-depth cap stamped on this teammate; omitted uses the host's subagent maxDepth setting."
				}
			},
			output: jsonOutput(SPAWN_VALUE_SCHEMA),
			async execute(args, exec) {
				const agent = callingAgent(exec.agent, "spawn_teammate");
				const context = args.context ?? "fresh";
				if ((args.provider === undefined) !== (args.model === undefined)) {
					throw new Error("spawn_teammate: supply provider and model together");
				}
				const agentOptions = args.provider === undefined ? undefined : {
					provider: args.provider,
					model: args.model,
					...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort })
				};
				return { member: modelMember((await ctx.agentTeams.spawnTeammate(agent, {
					name: args.name,
					description: args.description,
					prompt: [{
						type: "text",
						text: args.prompt
					}],
					context,
					provider: context === "fork" ? config.forkProvider : config.freshProvider,
					...(context === "fork" || args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }),
					...(context === "fork" || agentOptions === undefined ? {} : { agentOptions }),
					...(args.cwd === undefined ? {} : { cwd: args.cwd }),
					...(args.max_depth === undefined ? {} : { maxDepth: args.max_depth }),
					signal: exec.signal
				})).member) };
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "wait_agent",
			description: "Wait for the next teammate status, message, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.",
			parameters: { timeout_ms: {
				type: "integer",
				description: "Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000."
			} },
			output: jsonOutput(WAIT_VALUE_SCHEMA),
			async execute(args, exec) {
				const caller = callingAgent(exec.agent, "wait_agent");
				const timeoutMs = args.timeout_ms ?? 3e4;
				if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1e4 || timeoutMs > 36e5) return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal);
				if (!ctx.agentTeams.listMembers(caller).some((member) => member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))) return {
					timedOut: false,
					noProgress: {
						reason: "no-active-peer",
						message: NO_ACTIVE_PEER_MESSAGE
					}
				};
				return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal);
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_create",
			description: "Create one unowned pending task on the shared Team task board.",
			parameters: {
				subject: {
					type: "string",
					required: true,
					description: "Concise task title."
				},
				description: {
					type: "string",
					required: true,
					description: "Complete task details and acceptance criteria."
				},
				blocked_by: {
					type: "array",
					items: { type: "string" },
					description: "Task ids that must complete first."
				},
				write_scopes: {
					type: "array",
					items: { type: "string" },
					description: "Advisory workspace-relative file or directory prefixes this task expects to modify."
				}
			},
			output: jsonOutput(TASK_VIEW_SCHEMA),
			async execute(args, exec) {
				return await ctx.agentTeams.createTask(callingAgent(exec.agent, "team_task_create"), {
					subject: args.subject,
					description: args.description,
					...args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
					...args.write_scopes === void 0 ? {} : { writeScopes: args.write_scopes }
				});
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_list",
			description: "List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.",
			parameters: {
				status: {
					type: "string",
					enum: [
						"pending",
						"in_progress",
						"completed"
					],
					description: "Optional exact status filter."
				},
				owner: {
					type: "string",
					description: "Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner."
				},
				ready: {
					type: "boolean",
					description: "Optional readiness filter."
				},
				cursor: {
					type: "integer",
					description: "Zero-based result offset. Defaults to 0."
				},
				limit: {
					type: "integer",
					description: "Number of rows, 1 through 100. Defaults to 50."
				}
			},
			output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
			execute(args, exec) {
				const status = args.status;
				const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, "team_task_list")).filter((task) => (status === void 0 || task.status === status) && (args.owner === void 0 || (args.owner === "unowned" ? task.ownerName === void 0 : task.ownerName === args.owner)) && (args.ready === void 0 || task.ready === args.ready));
				const cursor = args.cursor ?? 0;
				const limit = args.limit ?? 50;
				if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative safe integer");
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 through 100");
				return Promise.resolve({
					tasks: filtered.slice(cursor, cursor + limit),
					...cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}
				});
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_get",
			description: "Read the complete latest value of one shared task before changing or executing it.",
			parameters: { task_id: {
				type: "string",
				required: true,
				description: "Shared task id."
			} },
			output: jsonOutput(TASK_VIEW_SCHEMA),
			async execute(args, exec) {
				return Promise.resolve(ctx.agentTeams.getTask(callingAgent(exec.agent, "team_task_get"), TeamTaskId(args.task_id)));
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_update",
			description: "Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.",
			parameters: {
				task_id: {
					type: "string",
					required: true,
					description: "Shared task id."
				},
				expected_revision: {
					type: "integer",
					required: true,
					description: "Current task revision used as the CAS precondition."
				},
				action: {
					type: "string",
					required: true,
					enum: [
						"claim",
						"release",
						"edit",
						"set_dependencies",
						"complete",
						"reopen",
						"reassign",
						"delete"
					],
					description: "Task transition to apply."
				},
				subject: {
					type: "string",
					description: "Replacement title for edit."
				},
				description: {
					type: "string",
					description: "Replacement details for edit."
				},
				blocked_by: {
					type: "array",
					items: { type: "string" },
					description: "Complete blocker list for set_dependencies."
				},
				write_scopes: {
					type: "array",
					items: { type: "string" },
					description: "Replacement advisory write scopes for edit."
				},
				owner: {
					type: "string",
					description: "Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign."
				}
			},
			output: jsonOutput(TASK_VIEW_SCHEMA),
			async execute(args, exec) {
				return await ctx.agentTeams.updateTask(callingAgent(exec.agent, "team_task_update"), {
					taskId: TeamTaskId(args.task_id),
					expectedRevision: args.expected_revision,
					action: args.action,
					...args.subject === void 0 ? {} : { subject: args.subject },
					...args.description === void 0 ? {} : { description: args.description },
					...args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
					...args.write_scopes === void 0 ? {} : { writeScopes: args.write_scopes },
					...args.owner === void 0 ? {} : { owner: args.owner }
				});
			}
		})));
	} catch (error) {
		for (const dispose of disposers.reverse()) dispose();
		throw error;
	}
	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}
/**
 * Whether this Agent is a non-Team subagent that should carry the parent
 * guidance: it has a durable parent, no Team membership, and declares at least
 * one of the messaging tools the guidance names.
 * @param ctx - context carrying the Agent registry and Team service.
 * @param agent - candidate Agent.
 * @returns the guidance text, or undefined when the block does not apply.
 */
function subagentGuidanceFor(ctx, agent) {
	if (ctx.agentTeams.tryMembership?.(agent) !== undefined) return undefined;
	const parentId = agent.session.header.parentSession;
	if (parentId === undefined) return undefined;
	const listAgents = declaresTool(ctx, agent, "list_agents");
	const sendMessage = declaresTool(ctx, agent, "send_message");
	if (!listAgents && !sendMessage) return undefined;
	return subagentGuidanceText(parentId, {
		listAgents,
		sendMessage,
		interrupt: declaresTool(ctx, agent, "interrupt_agent")
	});
}

/**
 * Replace the built-in messaging tools wherever an Agent's composition declares
 * them, and give non-Team subagents the parent/communication guidance.
 * Never injects a tool: a preset that mounts no `send_message` / `list_agents` /
 * `interrupt_agent` keeps exactly none. Mounted by the Host bundle, so every
 * preset gets the fork semantics — `targets` broadcast, the whole reachable
 * tree, and same-root delivery — without opting into the Team tools themselves.
 * @param ctx - Host context that owns the replacement registrations.
 * @param config - interrupt switch, mirroring the retired tool-row option.
 */
function applyReplacements(ctx, config = {}) {
	const interrupt = config.interrupt ?? true;
	const installed = /* @__PURE__ */ new Map();
	const replacementFor = (agent, name) => {
		if (name === "send_message") return buildSendMessage(ctx);
		if (name === "list_agents") return buildListAgents(ctx);
		return buildInterruptAgent(ctx);
	};
	const install = (agent) => {
		if (installed.has(agent)) return;
		const disposers = [];
		try {
			for (const name of ["send_message", "list_agents", "interrupt_agent"]) {
				// 未声明就保持没有：替换器绝不注入新工具。
				if (name === "interrupt_agent" && !interrupt) continue;
				if (!declaresTool(ctx, agent, name)) continue;
				disposers.push(agent.ctx.tools.register(replacementFor(agent, name)));
			}
			// 非团队子代理（subagent / workflow / 队友派出的子代理）：每步注入父级与交流说明。
			// 单独 try：提示注册失败不能连带丢掉上面已装好的工具替换。
			try {
				const guidance = subagentGuidanceFor(ctx, agent);
				if (guidance !== void 0) disposers.push(agent.ctx.systemPrompt.context({
					name: "lineage:subagent-guidance",
					order: agent.ctx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION"),
					required: true,
					text: guidance
				}));
			} catch (error) {
				ctx.logger?.warn?.(`lineage-teams: cannot add subagent guidance for agent "${agent.id}": ${String(error)}`);
			}
		} catch (error) {
			for (const dispose of disposers.reverse()) dispose();
			ctx.logger?.warn?.(`lineage-teams: cannot replace messaging tools for agent "${agent.id}": ${String(error)}`);
			return;
		}
		if (disposers.length > 0) installed.set(agent, () => {
			for (const dispose of disposers) dispose();
		});
	};
	for (const agent of ctx.agents.list()) install(agent);
	ctx.on("agent/created", ({ agent }) => {
		install(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		installed.get(agent)?.();
		installed.delete(agent);
	});
	ctx.effect(() => () => {
		for (const dispose of installed.values()) dispose();
		installed.clear();
	}, "lineage-teams.replacements()");
}

/**
 * Install Team tools for the Agents composed from this plugin's own scope.
 * Mount it inside one Agent Preset, like any built-in delegation-tool row: the
 * explicit row is the opt-in, so presets that do not declare it get no Team
 * tools and no Team prompt sections at all. An unscoped (Host) mount covers
 * every Agent and is kept only as a compatibility escape hatch.
 * @param ctx - context of this mount, carrying the enclosing scope tag.
 * @param config - interrupt switch and the fresh/fork delegation providers.
 */
function apply(ctx, config = {}) {
	const resolved = {
		interrupt: config.interrupt ?? true,
		freshProvider: config.freshProvider ?? "spawn",
		forkProvider: config.forkProvider ?? "fork"
	};
	const ownScope = scopeOf(ctx);
	const covers = (agent) => ownScope === void 0 || scopeChainOf(scopeOf(agent.ctx)).includes(ownScope);
	const installed = /* @__PURE__ */ new Map();
	const maybeInstall = (agent) => {
		if (installed.has(agent)) return;
		// 非成员没有名册与任务板，团队专用工具对它们没有意义。
		if (ctx.agentTeams.tryMembership(agent) === void 0) return;
		installed.set(agent, install(agent, ctx, resolved));
	};
	for (const agent of ctx.agents.list()) if (covers(agent)) maybeInstall(agent);
	ctx.on("agent/created", ({ agent }) => {
		if (covers(agent)) maybeInstall(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		installed.get(agent)?.();
		installed.delete(agent);
	});
	ctx.effect(() => () => {
		for (const dispose of installed.values()) dispose();
		installed.clear();
	}, "tool-team.scopedTools()");
}
//#endregion
export { Config, apply, applyReplacements, inject, name };
/** Internal seams exercised by `test/smoke.mjs`; not part of the plugin contract. */
export const __test = { buildSendMessage, buildListAgents, buildInterruptAgent, subagentGuidanceText, subagentGuidanceFor, teamIdentityText, resolveSendTarget, ancestorRows };
