// Resolve the harness packages from the *running DSH installation*, not from this
// package: a second copy of @deepseek-ai/cordis (or dsh-tools) would create foreign
// Service classes and break the Agent scope we must register into.
//
// Discovery order: $DSH_INSTALL_ROOT, the running CLI entry (process.argv[1]),
// then a plain local resolve (works when the plugin is installed with peers).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Walk up from a file to the @deepseek-ai/dsh package root (its node_modules carries the peers). */
function dshPackageRoot(file) {
  let current
  try {
    current = dirname(realpathSync(file))
  } catch {
    return undefined
  }
  for (let hops = 0; hops < 10; hops += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') return current
      } catch {
        // keep walking
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

const bases = []
if (process.env.DSH_INSTALL_ROOT) bases.push(process.env.DSH_INSTALL_ROOT)
const argvEntry = process.argv[1]
if (argvEntry) {
  const root = dshPackageRoot(argvEntry)
  if (root) bases.push(root)
  bases.push(dirname(argvEntry), dirname(dirname(argvEntry)))
}
try {
  const onPath = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  if (onPath) {
    const root = dshPackageRoot(onPath)
    if (root) bases.push(root)
  }
} catch {
  // no dsh on PATH: keep the other bases
}

function resolveSpec(spec) {
  for (const base of bases) {
    try {
      return require.resolve(spec, { paths: [base] })
    } catch {
      // try the next base
    }
  }
  try {
    return require.resolve(spec)
  } catch (error) {
    throw error
  }
}

const load = (spec) => import(pathToFileURL(resolveSpec(spec)).href)

const cordis = await load('@deepseek-ai/cordis')
export const Service = cordis.Service

const schemastery = await load('@deepseek-ai/schemastery')
export const z = schemastery.default ?? schemastery

const llm = await load('@deepseek-ai/dsh-llm')
export const { HarnessError, createUserMessage } = llm

const subagentInternal = await load('@deepseek-ai/dsh-subagent/internal')
export const { steerHostSubagentPrompt } = subagentInternal

const subagent = await load('@deepseek-ai/dsh-subagent')
export const { foldSubagentDescriptor } = subagent

const brand = await load('@deepseek-ai/dsh-brand')
export const { brandString } = brand

const zod = await load('zod')
export const z$1 = zod.z ?? zod.default?.z

const tools = await load('@deepseek-ai/dsh-tools')
export const { defineTool } = tools

const scope = await load('@deepseek-ai/dsh-scope')
export const { scopeOf, scopeChainOf } = scope
