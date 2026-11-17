#!/usr/bin/env node
/**
 * Reproducible Firefox Manifest V2 build.
 *
 * Firefox has not announced MV2 deprecation, and MV2 install-time host access
 * is required for direct background requests to LAN qBittorrent instances on
 * Firefox 160+. The build bundles four entry points and copies static assets
 * into dist/firefox.
 */

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const outDir = path.join(root, 'dist', 'firefox');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const entries = [
  ['src/background/index.js', 'background.js'],
  ['src/content/index.js', 'content.js'],
  ['src/popup/popup.js', 'popup.js'],
  ['src/options/options.js', 'options.js'],
];

const staticFiles = [
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/options/options.html', 'options.html'],
  ['src/options/options.css', 'options.css'],
  ['icons', 'icons'],
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

console.log('Bundling extension scripts…');
await Promise.all(
  entries.map(([entry, outfile]) =>
    build({
      entryPoints: [path.join(root, entry)],
      outfile: path.join(outDir, outfile),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['firefox140'],
      legalComments: 'none',
      sourcemap: false,
      minify: false,
      logLevel: 'warning',
    }),
  ),
);

for (const [source, destination] of staticFiles) {
  await cp(path.join(root, source), path.join(outDir, destination), { recursive: true });
}

const manifest = JSON.parse(await readFile(path.join(root, 'src', 'manifest.json'), 'utf8'));
manifest.version = packageJson.version;
await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Built Firefox extension ${manifest.version} → dist/firefox`);
