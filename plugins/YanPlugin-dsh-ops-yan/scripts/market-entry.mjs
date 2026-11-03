#!/usr/bin/env node
/**
 * Build a Yan official-market catalog entry for this package.
 *
 * The market validates entries with a strict schema and reinstalls by fetching
 * `https://raw.githubusercontent.com/<repository>/<revision>/<path>`, so the
 * repository root must be the plugin root and every shipped file must be listed
 * with its sha256.
 *
 * Usage:
 *   node scripts/market-entry.mjs --repository owner/YanPlugin-dsh-ops-yan \
 *     [--revision <40-hex>] [--category developer-tools] [--allow-noncompliant]
 *
 * Requires a local Yan installation because the manifest defaults and the
 * package digest are produced by Yan's own code.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const appRoot = process.env.YAN_APP_ROOT || 'C:\\Program Files\\Yan Agent'
const pluginsLib = path.join(appRoot, 'resources', 'app.asar.unpacked', 'lib', 'plugins')

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const allowNoncompliant = process.argv.includes('--allow-noncompliant')

const requireFromYan = createRequire(path.join(pluginsLib, 'manifest.js'))
const { readManifest, inventory } = requireFromYan('./manifest.js')

const manifest = readManifest(packageRoot)
const pack = inventory(packageRoot)
const category = argument('category', 'developer-tools')
const repository = argument('repository', `owner/${manifest.id}`)
const revision = argument('revision', (() => {
  try {
    return execFileSync('git', ['-C', packageRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
})())

const problems = []
if (!/^YanPlugin-[a-z0-9-]{1,39}$/.test(manifest.id)) problems.push(`manifest.id "${manifest.id}" must match ^YanPlugin-[a-z0-9-]{1,39}$`)
if (!/^[a-zA-Z0-9_.-]+\/YanPlugin-[a-z0-9-]+$/.test(repository)) problems.push(`repository "${repository}" must look like owner/YanPlugin-<slug>`)
if (repository.split('/')[1] !== manifest.id) problems.push('repository name must equal manifest.id')
if (!/^[a-f0-9]{40}$/.test(revision)) problems.push(`revision "${revision || '(empty)'}" must be a 40-character commit SHA`)
if (!['productivity', 'creativity', 'developer-tools'].includes(category)) problems.push(`category "${category}" is not one of productivity/creativity/developer-tools`)
if (!pack.files.some((file) => file.path === 'yan-plugin.json')) problems.push('package must contain yan-plugin.json at its root')
if (pack.files.length > 1000) problems.push(`package has ${pack.files.length} files (market limit 1000)`)
if (pack.bytes > 64 * 1024 * 1024) problems.push(`package is ${pack.bytes} bytes (market limit 64 MB)`)
for (const file of pack.files) {
  if (file.bytes > 8 * 1024 * 1024) problems.push(`file too large for market: ${file.path} (${file.bytes} bytes)`)
  if (!/^[a-zA-Z0-9_. /-]+$/.test(file.path) || file.path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    problems.push(`unsafe market path: ${file.path}`)
  }
}

if (problems.length) {
  console.error('Cannot build a compliant market entry:')
  for (const problem of problems) console.error(`  - ${problem}`)
  if (!allowNoncompliant) process.exit(1)
  console.error('Continuing because --allow-noncompliant was passed; the result will be rejected by the market.\n')
}

const entry = {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  category,
  repository,
  revision,
  digest: pack.digest,
  download: true,
  manifest,
  files: pack.files
}

process.stdout.write(JSON.stringify(entry, null, 2) + '\n')
