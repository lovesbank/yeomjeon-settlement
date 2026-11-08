#!/usr/bin/env node
// Stop: 종료 직전 최종 점검 (프로젝트용). git 의 커밋·푸시 상태는 기존 Stop 훅이 맡으므로 보지 않는다.
//  - stop_hook_active 이면 즉시 통과 (무한 반복 방지 1차)
//  - 같은 상태의 같은 실패는 최대 2번만 막고 그 뒤에는 경고와 함께 통과 (2차 안전장치)
//  - 이 훅은 추적되는 파일을 쓰지 않는다 (쓰면 기존 Stop 훅이 다시 막아 반복될 수 있음)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, STATE_DIR, INDEX, readStdin, parseJson, sha256, staticChecks, runRegression, failBlock, warn, log } from './yj-lib.mjs';

if (process.env.YJ_HOOKS === 'off') process.exit(0);
const input = parseJson(await readStdin());
if (input.stop_hook_active === true) process.exit(0);

const git = (...a) => spawnSync('git', a, { cwd: ROOT(), encoding: 'utf8', timeout: 15000 });
if (git('rev-parse', '--git-dir').status !== 0) process.exit(0);

try {
  const problems = [], notes = [];
  const PROT = /(\.hwpx$|(^|\/)(stamp\.png|audit_stamp\.png)$)/i;

  // 1) 보호 파일이 바뀌지 않았는가
  const st = git('status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(Boolean);
  st.map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((f) => PROT.test(f)).forEach((f) => problems.push(`보호 파일이 변경됨: ${f}`));

  // 2) 백업·상태 폴더가 git 에 올라가지 않았는가 (공개 저장소 보호)
  git('ls-files', '.claude/backups', '.claude/state').stdout.split('\n').filter(Boolean).forEach((f) => problems.push(`추적되면 안 되는 파일이 git 에 있음: ${f}`));

  // 3) index.html 이 HEAD 와 다르면: 백업 장부 + 문법 + 회귀
  const modified = git('diff', '--quiet', 'HEAD', '--', 'index.html').status !== 0;
  if (modified) {
    let okBackups = 0;
    try {
      fs.readFileSync(path.join(STATE_DIR(), 'backups.jsonl'), 'utf8').trim().split('\n').filter(Boolean).forEach((l) => {
        const m = JSON.parse(l);
        if (fs.existsSync(m.file) && sha256(fs.readFileSync(m.file)) === m.sha256) okBackups++;
      });
    } catch { /* 장부 없음 */ }
    if (okBackups === 0) problems.push('index.html 이 바뀌었는데 무결성이 확인되는 백업이 없음 (훅을 거치지 않은 수정일 수 있음)');
    problems.push(...staticChecks());
    const reg = runRegression();
    if (reg.infra) notes.push('계산 회귀 검사를 실행하지 못함(미검증)');
    else if (!reg.ok) problems.push(...reg.fails.map((l) => '계산 회귀 ' + l));
  }

  // 4) 작업기록은 낮에 강제하지 않는다 (밤 기록 방식 유지). 이 훅은 작업기록을 읽거나 만들지 않는다.

  // 무한 반복 방지: 같은 상태의 같은 실패는 2번까지만 막는다
  const f = path.join(STATE_DIR(), 'stop-blocks.json');
  let counts = {};
  try { counts = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 처음 */ }
  if (!problems.length) {
    if (Object.keys(counts).length) { try { fs.writeFileSync(f, '{}'); } catch { /* 무시 */ } }
    if (modified) warn('[결산서 훅] 종료 점검 통과: 보호 파일, 백업 무결성, JS/HTML 검사, 계산 회귀' + (notes.length ? ` (${notes.join(', ')})` : ''));
    process.exit(0);
  }
  let key = 'x';
  try { key = sha256(fs.readFileSync(INDEX()) + '\n' + problems.join('\n')); } catch { key = sha256(problems.join('\n')); }
  const n = counts[key] || 0;
  if (n >= 2) {
    log('stop.log', { released: true, problems });
    warn('[결산서 훅] 같은 문제로 두 번 알렸으므로 이번에는 막지 않고 통과시킵니다. 해결되지 않은 문제: ' + problems.join(' / '));
    process.exit(0);
  }
  counts[key] = n + 1;
  try { fs.mkdirSync(STATE_DIR(), { recursive: true }); fs.writeFileSync(f, JSON.stringify(counts)); } catch { /* 무시 */ }
  log('stop.log', { blocked: true, count: n + 1, problems });
  failBlock(['[결산서 훅] 종료 전에 해결할 문제가 있습니다:', ...problems.map((p) => ' - ' + p)]);
} catch (e) {
  warn('[결산서 훅] 종료 점검 중 오류로 검사를 끝내지 못했습니다(미검증): ' + (e && e.message));
  process.exit(0);
}
