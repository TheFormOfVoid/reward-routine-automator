// Assemble a self-contained Home Assistant add-on folder: ha-addon/ plus the
// Dockerfile at its root and the sources it builds from, in the same layout
// as the repository (so docker/Dockerfile works unchanged).
//
//   node docker/make-ha-addon.mjs \\homeassistant.local\addons\reward_routine
//
// The target can be any folder; copy it into the Home Assistant "addons"
// share and the add-on shows up under Local add-ons.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = process.argv[2]
if (!dest) {
  console.error('usage: node docker/make-ha-addon.mjs <target folder>')
  process.exit(2)
}

const SKIP = new Set(['node_modules', 'dist', 'tests', '.git'])
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const a = path.join(from, entry.name)
    const b = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

// Replace the generated parts, keep nothing stale.
for (const sub of ['docker', 'src-gingerbread', 'src-gingerbread.tar.gz']) fs.rmSync(path.join(dest, sub), { recursive: true, force: true })
copyDir(path.join(root, 'ha-addon'), dest)
copyDir(path.join(root, 'docker'), path.join(dest, 'docker'))

// The extension source travels as one tarball: Home Assistant's Samba share
// vetoes names matching "icon?" by default (so src-gingerbread/icons cannot
// be created there), and one file copies far faster than hundreds.
const tarball = path.join(dest, 'src-gingerbread.tar.gz')
const tar = spawnSync('tar', ['-czf', tarball, ...[...SKIP].flatMap((s) => ['--exclude', s]), '-C', path.join(root, 'src-gingerbread'), '.'], { stdio: 'inherit' })
if (tar.status !== 0) { console.error('tar failed'); process.exit(1) }

const dockerfile = fs.readFileSync(path.join(root, 'docker', 'Dockerfile'), 'utf8')
const from = 'COPY src-gingerbread/package.json src-gingerbread/package-lock.json ./\nRUN npm ci --no-audit --no-fund\nCOPY src-gingerbread/ ./\n'
if (!dockerfile.replace(/\r\n/g, '\n').includes(from)) { console.error('Dockerfile layout changed; update make-ha-addon.mjs'); process.exit(1) }
fs.writeFileSync(path.join(dest, 'Dockerfile'), dockerfile.replace(/\r\n/g, '\n').replace(from, 'ADD src-gingerbread.tar.gz ./\nRUN npm ci --no-audit --no-fund\n'))
for (const icon of ['icon.png', 'logo.png']) {
  fs.copyFileSync(path.join(root, 'src-gingerbread', 'icons', 'icon128.png'), path.join(dest, icon))
}
console.log(`Add-on assembled in ${dest}`)
