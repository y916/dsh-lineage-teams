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

Use the target returned by spawn_teammate or list_agents for send_message${interrupt ? " and interrupt_agent" : ""}, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A peer message starts with its sender name. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`;
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
			enum: ["lead", "teammate", "child"]
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
			description: "Send one message to one or more Team members (broadcast when several). A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn. Returns which targets accepted the message.",
			parameters: {
				targets: {
					type: "array",
					items: { type: "string" },
					description: "One or more targets: teammate names, \"lead\", or raw agent ids (same root session). Several targets = broadcast."
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
				];
				if (rawTargets.length === 0) throw new Error("send_message: give targets (one or more) or agent_id");
				const delivered = [];
				const relayed = [];
				const failed = [];
				const seen = new Set();
				// 成员列表只对团队成员可用；非成员（legacy 子代理）没有团队名册
				const members = ctx.agentTeams.tryMembership(caller) === void 0 ? [] : ctx.agentTeams.listMembers(caller);
				for (const target of rawTargets) {
					if (seen.has(target)) continue;
					seen.add(target);
					try {
						if (members.some((member) => member.name === target)) {
							await ctx.agentTeams.sendMessage(caller, {
								target,
								content: [{
									type: "text",
									text: args.message
								}],
								signal: exec.signal
							});
						} else {
							// 不是团队成员：当成 agent id，按同根会话投递（兼容 legacy subagent 子代理）
							const outcome = await deliverUnderRoot(ctx, caller, target, args.message, exec.signal);
							if (outcome.mode === "relayed") relayed.push(target);
						}
						delivered.push(target);
					} catch (error) {
						failed.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
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

/** Roster view shared by members and by legacy subagents that only see themselves. */
function buildListAgents(ctx) {
	return defineTool({
		name: "list_agents",
		description: "List the Lead, every durable teammate, and (optionally narrowed) the subagents reachable under this root. inactive means no turn is executing, not a task result. provisioning and failed describe member creation. scope=all (default) lists every descendant; scope=children lists only direct children.",
		parameters: { scope: {
			type: "string",
			enum: ["all", "children"],
			description: "all (default) lists team members plus the whole legacy subagent tree; children lists team members plus direct children only."
		} },
		output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
		async execute(args, exec) {
			const caller = callingAgent(exec.agent, "list_agents");
			// 非团队成员（legacy 子代理）没有名册，只看到自己的子树。
			const members = ctx.agentTeams.tryMembership(caller) === void 0 ? [] : ctx.agentTeams.listMembers(caller);
			const rows = members.map(modelMember);
			const known = new Set(members.map((member) => member.id));
			// 合并 legacy 子代理（不在团队成员里的那些），这样 subagent 派出的子代理仍可见
			let leaves = [];
			try {
				// listDescendants 的条目形状统一（kind/parentId/depth/activity），
				// 比 listChildren 的原始 catalog 条目更好用；children 只是按 depth 过滤。
				const all = await ctx.subagents.listDescendants(caller.id, exec.signal);
				leaves = args.scope === "children" ? all.filter((entry) => entry.depth === 1) : all;
			} catch (error) {
				throw new Error(`list_agents(${args.scope ?? "all"}): ${error instanceof Error ? error.message : String(error)}`);
			}
			for (const entry of leaves) {
				if (entry.kind !== "child" || known.has(entry.id)) continue;
				const row = {
					target: entry.id,
					role: "child",
					status: entry.status === "running" ? "running" : "inactive",
					diagnostics: []
				};
				if (typeof entry.label === "string" && entry.label.length > 0) row.description = entry.label;
				rows.push(row);
			}
			return rows;
		}
	});
}

/** Interrupt a teammate by name, or any reachable same-root agent by id. */
function buildInterruptAgent(ctx) {
	return defineTool({
		name: "interrupt_agent",
		description: "Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.",
		parameters: { target: {
			type: "string",
			required: true,
			description: "Teammate target returned by spawn_teammate or list_agents."
		} },
		output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
		execute(args, exec) {
			const caller = callingAgent(exec.agent, "interrupt_agent");
			// 非团队成员没有名册；成员按名字，其余按 agent id 中断（legacy subagent 语义）。
			if (ctx.agentTeams.tryMembership(caller) !== void 0 && ctx.agentTeams.listMembers(caller).some((member) => member.name === args.target)) {
				return Promise.resolve(ctx.agentTeams.interrupt(caller, args.target));
			}
			ctx.subagents.interrupt(args.target, {
				kind: "ancestor",
				agent: caller
			});
			return Promise.resolve({ accepted: true, target: args.target });
		}
	});
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
			text: () => {
				const { role, name, root } = ctx.agentTeams.membership(agent);
				const members = ctx.agentTeams.listMembers(agent);
				const others = members.filter((member) => member.id !== agent.id).map((member) => member.name);
				const peerList = others.length === 0 ? "（暂无）" : others.map((peer) => `「${peer}」`).join("、");
				const who = role === "lead" ? `你是团队负责人「${name}」` : `你是「${name}」`;
				return `${who}，父级智能体（parent agent）是「${root.id}」。
本组其他成员：${peerList}（共 ${members.length} 人）。名单可能变化，用 list_agents 查看最新成员与状态。

在结束任务前，你可以用 send_message 与父级或任意组员交流：
  send_message({ targets: ["lead"], message: "<自包含的消息>" })
- targets 至少给一个：组员名，"lead" 指父级/组长；多个即群发。
- 对方正在运行时会在下一步读到你的消息，空闲时会被唤醒；送达不等于已被处理。
- 其他智能体与你共享工作空间，但不会自动获得你的对话记录、工具输出或推理过程——
  需要对方知道的事实、结论与证据，请写进消息正文。
- 发送消息不会结束你这一轮；不必为「收到」「好的」回发消息。`;
			}
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
 * Replace the built-in messaging tools wherever an Agent's composition declares them.
 * Never injects: a preset that mounts no `send_message` / `list_agents` /
 * `interrupt_agent` keeps exactly none. Mounted by the Host bundle, so every preset
 * gets the fork semantics — `targets` broadcast, the whole reachable tree, and
 * same-root delivery — without opting into the Team tools themselves.
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
