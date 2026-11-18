// Entry: mounts the vendored Team domain and the patched Team tools as one bundle.
// See PATCHES.md for the exact upstream changes.
import TeamService from './team-domain.mjs'
import { apply as applyTools, inject as injectTools, name as toolsName } from './team-tools.mjs'

export const name = 'lineage-teams'
export const inject = []

export function apply(ctx, config = {}) {
  ctx.plugin(TeamService, {
    maxMembers: config.maxMembers ?? 16,
    maxTasks: config.maxTasks ?? 256,
    maxMessageBytes: config.maxMessageBytes ?? 65536,
    disposalTimeoutMs: config.disposalTimeoutMs ?? 5000,
  })
  ctx.plugin({ name: toolsName, inject: injectTools, apply: applyTools }, {
    interrupt: config.interrupt ?? true,
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
  })
}

export default { name, inject, apply }
