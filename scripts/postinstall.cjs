// Post-install fixups that keep `pnpm install` working without approving
// dependency build scripts.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')

// 1. node-pty ships N-API prebuilds (ABI-stable across Electron versions), but
//    pnpm can drop the executable bit on spawn-helper, which makes every spawn
//    fail with "posix_spawnp failed".
const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds')
if (fs.existsSync(prebuilds)) {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper')
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
}

// 2. Download the Electron binary if its own install script was skipped.
const electronDir = path.join(root, 'node_modules', 'electron')
if (fs.existsSync(electronDir) && !fs.existsSync(path.join(electronDir, 'path.txt'))) {
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' })
}
