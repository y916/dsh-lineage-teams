// Entry: mounts the vendored Team domain (and its journal) as the one Host singleton.
// The model-facing tools are NOT installed here: they live in `@y916/dsh-lineage-teams/tools`,
// a separate plugin each Agent Preset mounts explicitly — the same opt-in shape the built-in
// delegation rows use. See PATCHES.md for the exact upstream changes.
import TeamService from './team-domain.mjs'

export const name = 'lineage-teams'
export const inject = []

export function apply(ctx, config = {}) {
  ctx.plugin(TeamService, {
    maxMembers: config.maxMembers ?? 16,
    maxTasks: config.maxTasks ?? 256,
    maxMessageBytes: config.maxMessageBytes ?? 65536,
    disposalTimeoutMs: config.disposalTimeoutMs ?? 5000,
  })
}

export default { name, inject, apply }
