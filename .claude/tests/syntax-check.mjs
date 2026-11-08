#!/usr/bin/env node
// HTML·JavaScript 문법 검사 (수동 실행용). 사용: node syntax-check.mjs [--file index.html] [--baseline HEAD|경로]
import fs from 'node:fs';
import path from 'node:path';
import { checkJs, compareHtml, gitShowHead, INDEX } from '../hooks/yj-lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const html = fs.readFileSync(path.resolve(arg('--file', INDEX())), 'utf8');
const baseArg = arg('--baseline', 'HEAD');
const base = baseArg === 'HEAD' ? gitShowHead('index.html') : (() => { try { return fs.readFileSync(path.resolve(baseArg), 'utf8'); } catch { return null; } })();

const problems = checkJs(html);
console.log(problems.length ? problems.map((p) => '✗ ' + p).join('\n') : '✓ JavaScript 문법 (모든 인라인 <script>)');
if (base) {
  const h = compareHtml(html, base);
  console.log(h.length ? h.map((p) => '✗ HTML: ' + p).join('\n') : '✓ HTML 구조 (기준본 대비 새 문제·사라진 id 없음)');
  problems.push(...h);
} else console.log('- HTML 구조 비교: 기준본을 읽지 못해 건너뜀 (미검증)');
process.exit(problems.length ? 1 : 0);
