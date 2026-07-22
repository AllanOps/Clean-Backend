#!/usr/bin/env node
// Structural + schema validation for the Clean-Backend repo.
//
// Zero dependencies (Node stdlib only) so contributors can run it without an
// `npm install`. Checks the skill frontmatter, both plugin manifests, and the
// cross-file consistency that keeps a release coherent. Exits 1 and prints a
// list of problems when anything is off; exits 0 when the repo is clean.
//
// The frontmatter parser below is deliberately stricter than YAML: it accepts
// only flat `key: value` scalar lines. Structure can't hide in a skill's
// frontmatter, which doubles as a small security control.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const problems = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ALLOWED_FM_KEYS = new Set([
  'name', 'description', 'license', 'when_to_use',
  'compatibility', 'argument-hint', 'allowed-tools',
]);

function readText(file) {
  try {
    // Normalize CRLF so checks behave the same on Windows and Linux checkouts.
    return readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    fail(file, 'file is missing or unreadable');
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(file, `invalid JSON: ${err.message}`);
    return null;
  }
}

// Strict flat-scalar frontmatter parser. Returns { fm, bodyLines } or null.
function parseFrontmatter(file, text) {
  if (!text.startsWith('---\n')) {
    fail(file, 'must open with a `---` frontmatter fence on line 1');
    return null;
  }
  const fenceEnd = text.indexOf('\n---', 3);
  if (fenceEnd === -1) {
    fail(file, 'frontmatter is never closed with `---`');
    return null;
  }
  const block = text.slice(4, fenceEnd);
  const body = text.slice(fenceEnd + 4);
  const fm = {};
  block.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const m = /^([A-Za-z][A-Za-z0-9_-]*): ?(.*)$/.exec(line);
    if (!m) {
      fail(file, `frontmatter line ${i + 1} is not a flat "key: value" pair: ${JSON.stringify(line)}`);
      return;
    }
    fm[m[1]] = m[2];
  });
  return { fm, bodyLines: body.split('\n').length };
}

// --- skills ---------------------------------------------------------------
const skillsDir = 'skills';
if (!existsSync(join(root, skillsDir))) {
  fail(skillsDir, 'directory is missing');
} else {
  const entries = readdirSync(join(root, skillsDir), { withFileTypes: true })
    .filter((e) => e.isDirectory());
  if (entries.length === 0) fail(skillsDir, 'contains no skill directories');

  for (const entry of entries) {
    const dir = entry.name;
    const rel = `${skillsDir}/${dir}/SKILL.md`;
    if (!existsSync(join(root, skillsDir, dir, 'SKILL.md'))) {
      fail(rel, 'missing SKILL.md');
      continue;
    }
    const text = readText(rel);
    if (text === null) continue;
    const parsed = parseFrontmatter(rel, text);
    if (!parsed) continue;
    const { fm, bodyLines } = parsed;

    for (const key of Object.keys(fm)) {
      if (!ALLOWED_FM_KEYS.has(key)) {
        fail(rel, `unexpected frontmatter key "${key}" (allowed: ${[...ALLOWED_FM_KEYS].join(', ')})`);
      }
    }
    if (!fm.name) {
      fail(rel, 'frontmatter is missing `name`');
    } else {
      if (!NAME_RE.test(fm.name)) fail(rel, `name "${fm.name}" must be kebab-case (a-z, 0-9, hyphens)`);
      if (fm.name.length > 64) fail(rel, `name "${fm.name}" exceeds 64 characters`);
      if (fm.name !== dir) fail(rel, `name "${fm.name}" must match its directory "${dir}"`);
    }
    if (!fm.description) {
      fail(rel, 'frontmatter is missing `description`');
    } else if (fm.description.length > 1024) {
      fail(rel, `description is ${fm.description.length} chars (max 1024)`);
    }
    if (bodyLines > 500) fail(rel, `body is ${bodyLines} lines (keep under 500)`);
  }
}

// --- plugin.json ----------------------------------------------------------
const pluginPath = '.claude-plugin/plugin.json';
const plugin = readJson(pluginPath);
if (plugin) {
  if (!plugin.name || !NAME_RE.test(plugin.name)) fail(pluginPath, '`name` must be kebab-case');
  if (!plugin.version || !SEMVER_RE.test(plugin.version)) fail(pluginPath, '`version` must be x.y.z semver');
  if (!plugin.description) fail(pluginPath, 'missing `description`');
  if (plugin.license !== 'MIT') fail(pluginPath, '`license` must be "MIT"');
  if (!plugin.repository) fail(pluginPath, 'missing `repository`');
}

// --- marketplace.json -----------------------------------------------------
const marketPath = '.claude-plugin/marketplace.json';
const market = readJson(marketPath);
if (market) {
  if (!market.name || !NAME_RE.test(market.name)) fail(marketPath, '`name` must be kebab-case');
  if (!market.owner || !market.owner.name) fail(marketPath, 'missing `owner.name`');
  if (!Array.isArray(market.plugins) || market.plugins.length === 0) {
    fail(marketPath, '`plugins` must be a non-empty array');
  } else {
    for (const p of market.plugins) {
      const id = p && p.name ? `plugin "${p.name}"` : 'a plugin entry';
      if (!p.name) fail(marketPath, `${id} is missing \`name\``);
      if (!p.source) fail(marketPath, `${id} is missing \`source\``);
      if ('version' in p) fail(marketPath, `${id} must not pin \`version\` (plugin.json is the single source of truth)`);
      if (p.name === 'clean-backend' && p.source !== './') {
        fail(marketPath, `plugin "clean-backend" source must be "./" (got ${JSON.stringify(p.source)})`);
      }
    }
  }
}

// --- consistency ----------------------------------------------------------
const manifestPath = '.release-please-manifest.json';
const manifest = readJson(manifestPath);
if (manifest && plugin) {
  const tracked = manifest['.'];
  if (tracked !== plugin.version) {
    fail(manifestPath, `version "${tracked}" does not match plugin.json version "${plugin.version}"`);
  }
}

const license = readText('LICENSE');
if (license !== null && !license.startsWith('MIT License')) {
  fail('LICENSE', 'must begin with "MIT License"');
}

// --- report ---------------------------------------------------------------
if (problems.length > 0) {
  console.error(`validate-repo: ${problems.length} problem(s) found\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('validate-repo: OK — manifests, frontmatter, and consistency all check out.');
