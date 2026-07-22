#!/usr/bin/env node
// Content-security scan for the Clean-Backend repo.
//
// A skill is instructions injected into someone's agent, so a malicious
// contribution is a supply-chain attack. This scan hard-fails on the patterns
// that a prompt-injection payload would need, and warns on softer signals.
// Zero dependencies (Node stdlib only).
//
// Scope matters. Skill content (skills/**) is what actually reaches an agent,
// so the dangerous-instruction rules only apply there. README.md and
// SECURITY.md legitimately describe these threats (they contain words like
// "exfiltrate"), and scanning them would flag the very docs that explain the
// scan. The invisible-Unicode and raw-IP checks run repo-wide.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';

const root = process.cwd();
const findings = [];
const add = (level, file, line, msg) => findings.push({ level, file, line, msg });

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.json', '.jsonc', '.yml', '.yaml',
  '.svg', '.txt',
]);
const NO_EXT_TEXT = new Set(['LICENSE', 'CODEOWNERS', '.gitattributes', '.editorconfig']);

// Invisible / bidirectional / zero-width characters: U+200B-200F, U+202A-202E,
// U+2060-2064, U+2066-2069, U+FEFF, U+00AD, U+2028, U+2029. No legitimate use
// in this repo, and the classic way to smuggle hidden instructions. Built from
// an escaped string so this file itself stays pure ASCII (the check is
// repo-wide and would otherwise flag its own source).
const INVISIBLE = new RegExp(
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u00AD\\u2028\\u2029]'
);

// Raw-IP URLs anywhere.
const RAW_IP_URL = /\bhttps?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i;

// Dangerous instruction patterns — skills/** only.
const INJECTION = [
  [/ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions/i, 'prompt-injection ("ignore previous instructions")'],
  [/disregard\b[^\n]{0,30}\binstructions\b/i, 'prompt-injection ("disregard ... instructions")'],
  [/\bexfiltrat/i, 'exfiltration language'],
  [/\bcurl\b[^\n]{0,80}\|\s*(ba)?sh\b/i, 'pipe-to-shell (curl | sh)'],
  [/\bwget\b[^\n]{0,80}\|\s*(ba)?sh\b/i, 'pipe-to-shell (wget | sh)'],
  [/powershell[^\n]{0,40}-enc\b/i, 'encoded PowerShell command'],
  [/\biex\s*\(/i, 'PowerShell Invoke-Expression'],
  [/base64\s+(-d|--decode)\b[^\n]{0,40}\|\s*(ba)?sh\b/i, 'base64-decode piped to shell'],
  [/\b(read|send|post|upload|print|cat|echo)\b[^\n]{0,40}\b(\.env|api[_ -]?keys?|secrets?|credentials?|tokens?)\b/i, 'reads/sends secrets or environment'],
];

// Opaque blob: a long contiguous base64-ish run — skills/** only.
const BLOB = /[A-Za-z0-9+/]{60,}={0,2}/;

// Any URL, for the allowlist check — skills/** only.
const URL_RE = /\bhttps?:\/\/[^\s)"'`\]]+/gi;

// HTML comment containing an imperative verb — skills/** only, WARN.
const HTML_COMMENT_IMPERATIVE = /<!--[\s\S]*?\b(ignore|execute|fetch|run)\b[\s\S]*?-->/i;

let allowed = [];
try {
  allowed = JSON.parse(readFileSync(join(root, 'scripts/url-allowlist.json'), 'utf8')).allowed || [];
} catch {
  add('FAIL', 'scripts/url-allowlist.json', 1, 'missing or invalid — cannot enforce the URL allowlist');
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), files);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (TEXT_EXT.has(ext) || NO_EXT_TEXT.has(entry.name)) files.push(join(dir, entry.name));
    }
  }
  return files;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

for (const abs of walk(root)) {
  const rel = relative(root, abs).split(sep).join('/');
  let text;
  try {
    // Normalize CRLF so line numbers match on Windows and Linux checkouts.
    text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    continue;
  }
  const inSkill = rel.startsWith('skills/');

  // Repo-wide checks, reported per line.
  text.split('\n').forEach((line, i) => {
    if (INVISIBLE.test(line)) {
      const cp = [...line].find((c) => INVISIBLE.test(c));
      add('FAIL', rel, i + 1, `invisible/bidi character U+${cp.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    }
    if (RAW_IP_URL.test(line)) add('FAIL', rel, i + 1, 'raw-IP URL');
  });

  if (!inSkill) continue;

  // Skill-only checks.
  for (const [re, label] of INJECTION) {
    const m = re.exec(text);
    if (m) add('FAIL', rel, lineOf(text, m.index), label);
  }
  const blob = BLOB.exec(text);
  if (blob) add('FAIL', rel, lineOf(text, blob.index), `opaque ${blob[0].length}-char blob`);

  const comment = HTML_COMMENT_IMPERATIVE.exec(text);
  if (comment) add('WARN', rel, lineOf(text, comment.index), 'HTML comment contains an imperative verb');

  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    if (!allowed.some((prefix) => url.startsWith(prefix))) {
      add('FAIL', rel, lineOf(text, m.index), `external URL not in url-allowlist.json: ${url}`);
    }
  }
}

const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');

for (const f of findings) {
  const stream = f.level === 'FAIL' ? console.error : console.warn;
  stream(`  ${f.level === 'FAIL' ? 'x' : '!'} ${f.level} ${f.file}:${f.line} - ${f.msg}`);
}

if (fails.length > 0) {
  console.error(`\nscan-content: ${fails.length} failure(s), ${warns.length} warning(s).`);
  process.exit(1);
}
console.log(`scan-content: OK - no injection patterns found${warns.length ? ` (${warns.length} warning(s) above)` : ''}.`);
