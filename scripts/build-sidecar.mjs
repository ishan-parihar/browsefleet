#!/usr/bin/env node
/**
 * Build the BrowseFleet sidecar bundle for embedding inside the Overlord
 * Tauri app.
 *
 * The bundle is a self-contained folder that the Tauri app ships as
 * resources. At runtime the Tauri Rust side spawns the user's system
 * `node` against `server.js` inside the bundle. We do not produce a single
 * binary because BrowseFleet's dependency tree (hono with subpath exports +
 * puppeteer-core + puppeteer-extra-plugin-stealth + better-sqlite3 native
 * bindings) does not bundle cleanly through pkg/ncc/nexe — every attempt
 * either explodes the binary size or breaks runtime resolution.
 *
 * Output layout:
 *   app/src-tauri/sidecars/browsefleet/
 *     server.js              # entrypoint (dist/server.js renamed)
 *     dist/...               # rest of compiled TS
 *     node_modules/...       # production deps only (npm install --omit=dev)
 *     package.json           # runtime metadata
 *
 * Build pipeline:
 *   1. tsc — compile TypeScript into ./dist
 *   2. mkdir + copy dist/ into the bundle
 *   3. produce a minimal package.json that points at server.js
 *   4. npm install --omit=dev --prefix <bundle> against the original
 *      package.json so we get exactly the prod tree. Native bindings
 *      (better-sqlite3, etc.) are rebuilt for the host platform here.
 *
 * Usage:
 *   node scripts/build-sidecar.mjs                 # build for host
 *   node scripts/build-sidecar.mjs --skip-tsc      # reuse existing dist/
 *
 * Cross-compilation note:
 *   This bundle is platform-specific (because of native bindings). For
 *   Windows/Mac/Linux release builds, run this script on a matching host
 *   CI runner. Future improvement: support `--platform` to invoke
 *   `npm install --target_platform=<x>` for prebuilt better-sqlite3.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const overlordRoot = path.resolve(repoRoot, '..', '..');
const bundleDir = path.join(
  overlordRoot,
  'app',
  'src-tauri',
  'sidecars',
  'browsefleet'
);

// ── arg parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
const skipTsc = flags.has('skip-tsc');
const cleanFirst = !flags.has('keep-bundle');

// ── helpers ────────────────────────────────────────────────────────────────

function run(cmd, argv, opts = {}) {
  const isWindows = process.platform === 'win32';
  const result = spawnSync(cmd, argv, {
    cwd: opts.cwd || repoRoot,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} exited with ${result.status}`);
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── steps ──────────────────────────────────────────────────────────────────

console.log(`[build-sidecar] target bundle: ${bundleDir}`);

// 1. tsc
if (!skipTsc) {
  console.log('[build-sidecar] step 1/4: tsc');
  run('npx', ['tsc', '--outDir', 'dist']);
} else {
  console.log('[build-sidecar] step 1/4: tsc (skipped)');
}

const distDir = path.join(repoRoot, 'dist');
const serverEntry = path.join(distDir, 'server.js');
if (!existsSync(serverEntry)) {
  throw new Error(`expected entry not found: ${serverEntry}`);
}

// 2. clean + copy dist
console.log('[build-sidecar] step 2/4: stage bundle');
if (cleanFirst && existsSync(bundleDir)) {
  rmSync(bundleDir, { recursive: true, force: true });
}
ensureDir(bundleDir);
cpSync(distDir, path.join(bundleDir, 'dist'), { recursive: true });

// 3. package.json — minimal runtime descriptor pointing at server.js
console.log('[build-sidecar] step 3/4: write runtime package.json');
const upstreamPkg = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
);
const runtimePkg = {
  name: 'browsefleet-sidecar',
  version: upstreamPkg.version,
  private: true,
  type: upstreamPkg.type, // "module"
  main: 'dist/server.js',
  // Keep the prod deps tree exactly as upstream so npm install reproduces
  // the same versions tsc was built against. devDependencies are dropped
  // by --omit=dev below.
  dependencies: upstreamPkg.dependencies,
};
writeFileSync(
  path.join(bundleDir, 'package.json'),
  JSON.stringify(runtimePkg, null, 2)
);

// 4. install production deps inside the bundle
console.log('[build-sidecar] step 4/4: npm install --omit=dev (this rebuilds native modules for the host)');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], {
  cwd: bundleDir,
});

console.log('[build-sidecar] done. bundle ready at:', bundleDir);
console.log('[build-sidecar] reminder: system node + Chrome required at runtime');
