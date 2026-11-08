#!/usr/bin/env node
// 훅 자체 시험 — 모든 시험은 임시 폴더의 복사본 저장소에서만 실행한다 (실제 index.html 은 읽기만 함).
// 사용: TMPDIR=<임시 폴더> node .claude/tests/hook-selftest.mjs
// 임시 폴더는 os.tmpdir() (TMPDIR 환경 변수)를 따른다. 끝나면 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.join(HERE, '../hooks');
const REAL_INDEX = path.join(HERE, '../../index.html');
const EXISTING_STOP = path.join(os.homedir(), '.claude/stop-hook-git-check.sh');
const ORIG = fs.readFileSync(REAL_INDEX, 'utf8');
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

const results = [];
const T = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: cond ? '' : detail });
const tmpRoots = [];

function git(dir, ...a) { return spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GENV } }); }
function makeProject({ html = ORIG, remote = false, extra = {}, gitignore = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-selftest-'));
  tmpRoots.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  if (gitignore) fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/backups/\n.claude/state/\n');
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(dir, k), v);
  git(dir, 'init', '-q', '-b', 'work');
  git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  if (remote) {
    const bare = dir + '-origin.git'; tmpRoots.push(bare);
    spawnSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    git(dir, 'remote', 'add', 'origin', bare); git(dir, 'push', '-q', '-u', 'origin', 'work');
  }
  return dir;
}
function runHook(script, dir, input, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, script)], { cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...GENV, CLAUDE_PROJECT_DIR: dir, ...env }, timeout: 60000 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const decision = (r) => { try { return JSON.parse(r.out).hookSpecificOutput.permissionDecision; } catch { return null; } };
const reason = (r) => { try { return JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason; } catch { return ''; } };
const edit = (dir, o, n) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'index.html'), old_string: o, new_string: n } });
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const write = (file_path, content = 'x') => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content } });
const manifest = (dir) => { try { return fs.readFileSync(path.join(dir, '.claude/state/backups.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sha = (s) => spawnSync('sha256sum', { input: s, encoding: 'utf8' }).stdout.split(' ')[0];
function mutate(html, from, to) { const c = html.split(from).length - 1; return c === 1 ? html.replace(from, () => to) : null; }

const TITLE = '<title>결산 보고서 · 연도별 수입·지출 장부</title>';
const TITLE2 = '<title>결산 보고서 (시험)</title>';
const CALC_OLD = 'var EXP_ROWS = [10, 11, 10];';
const CALC_NEW = 'var EXP_ROWS = [10, 11, 12];';
const SEED_OLD = '"version":2,"years"';
const SEED_NEW = '"version":3,"years"';

// ───────────────────────── 보호 훅 (PreToolUse) ─────────────────────────
(function pre() {
  const d = makeProject();
  let r = runHook('yj-pre-guard.mjs', d, edit(d, TITLE, TITLE2));
  T('P1 일반 수정은 통과(deny 아님)', r.status === 0 && decision(r) === null, r.out + r.err);
  let m = manifest(d);
  T('P1 백업 1개 생성 + 해시가 원본과 일치', m.length === 1 && fs.existsSync(m[0].file) && sha(fs.readFileSync(m[0].file)) === sha(ORIG) && m[0].sha256 === sha(ORIG), JSON.stringify(m));
  r = runHook('yj-pre-guard.mjs', d, edit(d, TITLE, TITLE2));
  T('P2 같은 내용이면 백업 재사용(새로 만들지 않음)', decision(r) === null && manifest(d).length === 1);

  r = runHook('yj-pre-guard.mjs', d, edit(d, CALC_OLD, CALC_NEW));
  T('P3 계산 엔진 수정은 deny', decision(r) === 'deny' && /계산 엔진/.test(reason(r)), r.out);
  r = runHook('yj-pre-guard.mjs', d, edit(d, SEED_OLD, SEED_NEW));
  T('P4 SEED 수정은 deny', decision(r) === 'deny' && /기본 자료/.test(reason(r)), r.out);
  r = runHook('yj-pre-guard.mjs', d, write(path.join(d, 'index.html'), ORIG.replace('window.Calc = (function', 'window.Calcx = (function')));
  T('P5 전체 덮어쓰기로 표식을 없애도 deny', decision(r) === 'deny', r.out);
  r = runHook('yj-pre-guard.mjs', d, { hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', tool_input: { file_path: path.join(d, 'index.html'), edits: [{ old_string: TITLE, new_string: TITLE2 }, { old_string: CALC_OLD, new_string: CALC_NEW }] } });
  T('P6 MultiEdit 에 계산식이 섞이면 deny', decision(r) === 'deny', r.out);
  r = runHook('yj-pre-guard.mjs', d, edit(d, '이런문자열은없다_zzz', 'x'));
  T('P7 적용 불가한 수정은 훅이 막지 않음(도구가 스스로 실패)', r.status === 0 && decision(r) === null);
  T('P3~P6 deny 가 백업 장부를 건드리지 않음', manifest(d).length === 1);
  r = runHook('yj-pre-guard.mjs', d, edit(d, TITLE, TITLE2).tool_input && { ...edit(d, '<html lang="ko">', '<html lang="ko" data-x="1">') });
  T('P7b 계산식 밖의 다른 수정(html 속성)도 통과', decision(r) === null, r.out);

  // 백업 실패 → 수정 차단
  const d2 = makeProject();
  fs.writeFileSync(path.join(d2, 'blocker'), 'file');
  r = runHook('yj-pre-guard.mjs', d2, edit(d2, TITLE, TITLE2), { YJ_BACKUP_DIR: path.join(d2, 'blocker', 'sub') });
  T('P8 백업 실패 시 일반 수정도 deny', decision(r) === 'deny' && /백업/.test(reason(r)), r.out);

  // 표식 없는 파일
  const d3 = makeProject({ html: '<html><body>표식 없음</body></html>' });
  r = runHook('yj-pre-guard.mjs', d3, edit(d3, '표식 없음', '변경'));
  T('P9 표식을 못 찾으면 안전하게 deny', decision(r) === 'deny' && /표식/.test(reason(r)), r.out);

  // 보호 파일
  for (const f of ['template.hwpx', 'stamp.PNG', 'audit_stamp.png', '염전마을결산.hwpx', 'sub/other.HWPX']) {
    r = runHook('yj-pre-guard.mjs', d, write(path.join(d, f)));
    T(`P10 보호 파일 ${f} 는 deny`, decision(r) === 'deny', r.out);
  }
  r = runHook('yj-pre-guard.mjs', d, write(path.join(d, 'notes.txt')));
  T('P10 관련 없는 파일은 통과', r.status === 0 && decision(r) === null);

  // 허용 장치 보호 + Bash
  r = runHook('yj-pre-guard.mjs', d, write(path.join(d, '.claude/state/allow-calc.json'), '{}'));
  T('P11 허용 토큰 파일을 도구로 만들면 deny', decision(r) === 'deny', r.out);
  const B = [
    ['echo x > .claude/state/allow-calc.json', 'deny'], ['node .claude/hooks/yj-allow.mjs calc', 'deny'],
    ["sed -i 's/a/b/' index.html", 'deny'], ['echo hi > index.html', 'deny'], ['cp /tmp/x index.html', 'deny'], ['rm index.html', 'deny'],
    ['cat index.html | head -3', null], ['cp index.html /tmp/x', null], ['grep -c foo index.html', null], ['git status', null], ['node .claude/tests/calc-regression.mjs', null],
    ['echo x > template.hwpx', 'deny'], ['cp a.png stamp.PNG', 'deny'],
    ['git push --force origin foo', 'deny'], ['git push -f origin foo', 'deny'], ['git push origin main', 'deny'], ['git push origin HEAD:main', 'deny'],
    ['git push -u origin claude/foo', null], ['git push --force-with-lease origin claude/foo', null],
  ];
  B.forEach(([c, want]) => { const x = runHook('yj-pre-guard.mjs', d, bash(c)); T(`P12 Bash \`${c}\` → ${want || '통과'}`, decision(x) === want, x.out); });

  // 허용 토큰 흐름
  const d4 = makeProject();
  r = runHook('yj-pre-guard.mjs', d4, edit(d4, CALC_OLD, CALC_NEW));
  T('P13 토큰 없으면 계산식 수정 deny', decision(r) === 'deny');
  const a = spawnSync(process.execPath, [path.join(HOOKS, 'yj-allow.mjs'), 'calc', '5', '1'], { env: { ...process.env, ...GENV, CLAUDE_PROJECT_DIR: d4 }, encoding: 'utf8' });
  T('P13 사용자 쪽 발급 도구가 토큰을 만든다', a.status === 0 && fs.existsSync(path.join(d4, '.claude/state/allow-calc.json')), a.stdout + a.stderr);
  r = runHook('yj-pre-guard.mjs', d4, edit(d4, CALC_OLD, CALC_NEW));
  T('P13 토큰이 있으면 1회 통과 + 백업 생성', decision(r) === null && manifest(d4).length === 1, r.out);
  r = runHook('yj-pre-guard.mjs', d4, edit(d4, CALC_OLD, CALC_NEW));
  T('P13 토큰은 횟수 소진 후 다시 deny', decision(r) === 'deny', r.out);
  fs.writeFileSync(path.join(d4, '.claude/state/allow-calc.json'), JSON.stringify({ expires: new Date(Date.now() - 1000).toISOString(), uses_left: 5 }));
  r = runHook('yj-pre-guard.mjs', d4, edit(d4, CALC_OLD, CALC_NEW));
  T('P13 만료된 토큰은 deny', decision(r) === 'deny', r.out);
  fs.writeFileSync(path.join(d4, '.claude/state/allow-calc.json'), 'not json');
  r = runHook('yj-pre-guard.mjs', d4, edit(d4, CALC_OLD, CALC_NEW));
  T('P13 깨진 토큰도 deny', decision(r) === 'deny');
  r = runHook('yj-pre-guard.mjs', d4, 'not json');
  T('P14 깨진 입력은 열어 둠(exit 0, 출력 없음)', r.status === 0 && r.out === '');
  r = runHook('yj-pre-guard.mjs', d, edit(d, TITLE, TITLE2), { YJ_HOOKS: 'off' });
  T('P14 YJ_HOOKS=off 면 아무것도 하지 않음', r.status === 0 && r.out === '');
})();

// ───────────────────────── 후처리 훅 + 회귀 변조 시험 ─────────────────────────
(function post() {
  const payload = (d) => ({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(d, 'index.html') } });
  const withHtml = (html) => { const d = makeProject(); fs.writeFileSync(path.join(d, 'index.html'), html); return d; };
  const runPost = (html) => { const d = withHtml(html); return runHook('yj-post-check.mjs', d, payload(d)); };

  let r = runPost(mutate(ORIG, TITLE, TITLE2));
  T('K1 정상 수정은 통과 + 검사 목록 안내', r.status === 0 && /통과/.test(r.out), r.out + r.err);
  r = runPost(ORIG);
  T('K1b 변경 없는 원본도 통과', r.status === 0, r.err);
  r = runPost(mutate(ORIG, 'function px(v){', 'function px(v{'));
  T('K2 JS 문법 오류는 exit 2', r.status === 2 && /JavaScript 문법 오류/.test(r.err), r.err);
  r = runPost(mutate(ORIG, 'id="btnPrint"', 'id="btnPrintX"'));
  T('K3 기존 id 가 사라지면 exit 2', r.status === 2 && /btnPrint/.test(r.err), r.err);
  r = runPost(mutate(ORIG, 'id="btnExport"', 'id="btnPrint"'));
  T('K4 중복 id 는 exit 2', r.status === 2 && /중복/.test(r.err), r.err);
  r = runPost(ORIG.replace('</section>', ''));
  T('K5 닫는 태그가 빠지면 exit 2', r.status === 2 && /section/.test(r.err), r.err);
  const d = makeProject();
  r = runHook('yj-post-check.mjs', d, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(d, 'notes.txt') } });
  T('K7 index.html 이 아닌 파일은 검사하지 않음', r.status === 0 && r.out === '');

  // 변조(mutation) 시험: 일부러 계산식을 망가뜨려 회귀 테스트가 잡는지
  const MUT = [
    ['M1 월말 잔액에서 지출을 더함', 'b += s.months[i].income - s.months[i].expense;', 'b += s.months[i].income + s.months[i].expense;'],
    ['M2 월 수입에서 REC 누락', 'return b ? sumRows(b.smp) + sumRows(b.rec) : 0;', 'return b ? sumRows(b.smp) : 0;'],
    ['M3 상·하반기 지출이 뒤바뀜', 'function expenseHalf(yd, h) { return h === 1 ?', 'function expenseHalf(yd, h) { return h === 2 ?'],
    ['M4 새 연도 이월에 잔액 대신 수입을 넣음', 'yd.carryover = summarize(db, year - 1).balance;', 'yd.carryover = summarize(db, year - 1).totalIncome;'],
    ['M5 금액의 쉼표를 지우지 않음', ".replace(/[,\\s원₩]/g, '')", ".replace(/[\\s원₩]/g, '')"],
    ['M6 해가 바뀔 때 올해 장부 생성 누락', 'y <= cur; y++) { createYear(db, y); made.push(y); }', 'y < cur; y++) { createYear(db, y); made.push(y); }'],
  ];
  for (const [name, from, to] of MUT) {
    const html = mutate(ORIG, from, to);
    if (!html) { T(`${name}: 변조 대상 문자열을 찾음`, false, '원본에서 정확히 1곳을 찾지 못함'); continue; }
    const dm = withHtml(html);
    const reg = spawnSync(process.execPath, [path.join(HERE, 'calc-regression.mjs')], { cwd: dm, encoding: 'utf8', env: { ...process.env, ...GENV, CLAUDE_PROJECT_DIR: dm } });
    const caughtA = /✗ A /.test(reg.stdout), caughtB = /✗ B /.test(reg.stdout);
    T(`${name} → 회귀 테스트가 잡음 (가상 장부 ${caughtA ? 'O' : 'X'} / 기존 코드 비교 ${caughtB ? 'O' : 'X'})`, reg.status === 1 && (caughtA || caughtB), reg.stdout.slice(0, 300));
    T(`${name} → 가상 장부 기대값 단독으로도 잡음`, caughtA, '가상 장부(A)가 못 잡음');
    T(`${name} → 기존 코드 비교 단독으로도 잡음`, caughtB, '기존 코드 비교(B)가 못 잡음');
    const p = runHook('yj-post-check.mjs', dm, payload(dm));
    T(`${name} → 후처리 훅이 exit 2`, p.status === 2 && /계산 회귀/.test(p.err), p.err);
  }
  // 기준본 없이(예: 첫 커밋) 실행하면 B 는 건너뛰고 A·C·D 만으로도 잡는가
  const dm2 = withHtml(mutate(ORIG, MUT[0][1], MUT[0][2]));
  const reg2 = spawnSync(process.execPath, [path.join(HERE, 'calc-regression.mjs'), '--baseline', 'none'], { cwd: dm2, encoding: 'utf8', env: { ...process.env, ...GENV, CLAUDE_PROJECT_DIR: dm2 } });
  T('M1 기준본 없이도 가상 장부·관계식이 잡음(B 건너뜀)', reg2.status === 1 && /건너뜀/.test(reg2.stdout) && /✗ A /.test(reg2.stdout), reg2.stdout.slice(0, 300));
})();

// ───────────────────────── Stop 훅 + 기존 Stop 훅과의 충돌·무한 반복 ─────────────────────────
await (async function stop() {
  const S = (d, active = false) => runHook('yj-stop-check.mjs', d, { hook_event_name: 'Stop', stop_hook_active: active });
  const guardEdit = (d, o, n) => runHook('yj-pre-guard.mjs', d, edit(d, o, n));
  const applyTitle = (d) => fs.writeFileSync(path.join(d, 'index.html'), ORIG.replace(TITLE, TITLE2));

  let d = makeProject({ remote: true });
  let r = S(d);
  T('S1 변경이 없으면 조용히 통과', r.status === 0 && r.out === '', r.out + r.err);
  T('S1 Stop 훅이 추적되는 파일을 만들지 않음(git 상태 깨끗)', git(d, 'status', '--porcelain').stdout === '');

  // 정상 흐름: 훅(백업) → 수정 → Stop
  d = makeProject({ remote: true });
  guardEdit(d, TITLE, TITLE2); applyTitle(d);
  r = S(d);
  T('S4 정상 흐름(백업 후 수정)은 통과 + 점검 안내', r.status === 0 && /통과/.test(r.out), r.out + r.err);

  // 훅을 거치지 않은 수정 → 막고, 같은 문제는 2번까지만
  d = makeProject({ remote: true }); applyTitle(d);
  r = S(d); T('S2 백업 없는 수정은 exit 2', r.status === 2 && /백업/.test(r.err), r.err);
  r = S(d); T('S3 같은 문제 두 번째도 exit 2', r.status === 2);
  r = S(d); T('S3 세 번째는 경고와 함께 통과(무한 반복 방지)', r.status === 0 && /두 번 알렸으므로/.test(r.out), r.out + r.err);
  r = S(d, true); T('S5 stop_hook_active=true 면 즉시 통과', r.status === 0 && r.out === '');

  // 보호 파일 변경
  d = makeProject({ remote: true, extra: { 'template.hwpx': 'dummy' } });
  fs.writeFileSync(path.join(d, 'template.hwpx'), 'changed');
  r = S(d); T('S6 보호 파일이 바뀌면 exit 2', r.status === 2 && /보호 파일/.test(r.err), r.err);
  // 백업이 git 에 추적됨
  d = makeProject({ remote: true });
  fs.mkdirSync(path.join(d, '.claude/backups'), { recursive: true }); fs.writeFileSync(path.join(d, '.claude/backups/x'), 'x'); git(d, 'add', '-f', '.claude/backups/x');
  r = S(d); T('S7 백업이 git 에 올라가 있으면 exit 2(공개 저장소 보호)', r.status === 2 && /추적/.test(r.err), r.err);
  // 문법 오류
  d = makeProject({ remote: true }); guardEdit(d, TITLE, TITLE2);
  fs.writeFileSync(path.join(d, 'index.html'), mutate(ORIG, 'function px(v){', 'function px(v{'));
  r = S(d); T('S8 백업이 있어도 문법 오류면 exit 2', r.status === 2 && /문법/.test(r.err), r.err);
  // 계산 변조
  d = makeProject({ remote: true }); guardEdit(d, TITLE, TITLE2);
  fs.writeFileSync(path.join(d, 'index.html'), mutate(ORIG, 'b += s.months[i].income - s.months[i].expense;', 'b += s.months[i].income + s.months[i].expense;'));
  r = S(d); T('S8b 계산 회귀 실패면 exit 2', r.status === 2 && /계산 회귀/.test(r.err), r.err);

  // 기존 Stop 훅과 동시 실행
  if (!fs.existsSync(EXISTING_STOP)) { results.push({ name: 'S9 기존 Stop 훅과 병렬 실행', pass: false, detail: '기존 Stop 훅 파일이 없어 미검증' }); return; }
  const runBoth = (dir, active) => {
    const input = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: active });
    const one = (cmd, args) => new Promise((res) => {
      const p = spawn(cmd, args, { cwd: dir, env: { ...process.env, ...GENV, CLAUDE_PROJECT_DIR: dir } });
      let o = '', e = ''; p.stdout.on('data', (c) => (o += c)); p.stderr.on('data', (c) => (e += c));
      const timer = setTimeout(() => { p.kill('SIGKILL'); res({ status: 'timeout', o, e }); }, 60000);
      p.on('close', (s) => { clearTimeout(timer); res({ status: s, o, e }); });
      p.stdin.end(input);
    });
    return Promise.all([one('bash', [EXISTING_STOP]), one(process.execPath, [path.join(HOOKS, 'yj-stop-check.mjs')])]);
  };
  // (a) 깨끗한 상태: 둘 다 통과
  d = makeProject({ remote: true });
  let [g, o] = await runBoth(d, false);
  T('S9a 깨끗한 상태에서 두 훅 모두 통과', g.status === 0 && o.status === 0, `git훅=${g.status} ${g.e} / 우리=${o.status} ${o.e}`);
  T('S9a 우리 훅이 남긴 상태 파일을 기존 훅이 문제 삼지 않음(.gitignore 효과)', git(d, 'status', '--porcelain').stdout === '' && g.status === 0);
  // (b) 둘 다 막는 상태 → 메시지가 각각 나오고 둘 다 끝남
  d = makeProject({ remote: true }); applyTitle(d);
  [g, o] = await runBoth(d, false);
  T('S9b 동시에 막혀도 둘 다 정상 종료하고 각자 메시지를 냄', g.status === 2 && o.status === 2 && /uncommitted/.test(g.e) && /백업/.test(o.e), `git훅=${g.status} ${g.e} / 우리=${o.status} ${o.e}`);
  // (c) 하네스가 두 번째 시도에서 stop_hook_active=true 를 주는 경우 → 둘 다 통과 (반복 종료)
  [g, o] = await runBoth(d, true);
  T('S9c 두 번째 시도(active=true)에서 둘 다 통과 → 반복 종료', g.status === 0 && o.status === 0, `git훅=${g.status} / 우리=${o.status}`);
  // (d) 반복 시뮬레이션: active 플래그를 주지 않아도 우리 훅은 3번째에 풀어 준다
  d = makeProject({ remote: true }); applyTitle(d);
  const seq = []; for (let i = 0; i < 5; i++) seq.push(S(d, false).status);
  T('S9d active 플래그 없이 반복해도 우리 훅은 [2,2,0,…] 으로 스스로 풀림', JSON.stringify(seq.slice(0, 3)) === '[2,2,0]' && seq.slice(3).every((x) => x === 0), JSON.stringify(seq));
  // (e) 우리 훅이 Stop 중 추적 파일을 쓰지 않는지 (기존 훅 재차단 방지)
  const before = git(d, 'status', '--porcelain').stdout; S(d, false); const after = git(d, 'status', '--porcelain').stdout;
  T('S9e Stop 훅 실행 전후 git 상태가 같음(스스로 반복 유발 안 함)', before === after, `${before} → ${after}`);
  // (f) .gitignore 가 없을 때의 위험을 문서화: 기존 훅이 untracked 로 막는지
  d = makeProject({ remote: true, gitignore: false }); guardEdit(d, TITLE, TITLE2);
  [g] = await runBoth(d, false);
  T('S9f (참고) .gitignore 없이 .claude/state 가 생기면 기존 훅이 막음 → .gitignore 필수', g.status === 2 && /untracked/.test(g.e), `git훅=${g.status} ${g.e}`);
})();

// ───────────────────────── 세션 시작 훅 / 설정 파일 ─────────────────────────
(function misc() {
  const d = makeProject();
  let r = runHook('yj-session-start.mjs', d, '{}');
  T('SS1 세션 시작 훅은 고정 문구를 출력하고 exit 0', r.status === 0 && /결산서 훅/.test(r.out) && !/\d{6}-\d{7}/.test(r.out));
  r = runHook('yj-session-start.mjs', d, '{}', { YJ_HOOKS: 'off' });
  T('SS1 YJ_HOOKS=off 면 출력 없음', r.status === 0 && r.out === '');
  const sp = path.join(HERE, '../settings.json');
  if (!fs.existsSync(sp)) { T('ST1 settings.json 존재', false, '아직 없음'); return; }
  try {
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const cmds = [];
    Object.values(s.hooks || {}).forEach((arr) => arr.forEach((g) => g.hooks.forEach((h) => cmds.push(h.command))));
    const missing = cmds.filter((c) => { const m = /\.claude\/hooks\/([\w.-]+)/.exec(c); return !m || !fs.existsSync(path.join(HOOKS, m[1])); });
    T('ST1 settings.json 의 모든 명령이 실제 파일을 가리킴', cmds.length >= 4 && missing.length === 0, JSON.stringify(missing));
    T('ST2 명령이 $CLAUDE_PROJECT_DIR 경로를 씀(작업 폴더와 무관)', cmds.every((c) => c.includes('$CLAUDE_PROJECT_DIR')));
    T('ST3 settings.json 에 기존 훅 이름이 섞여 있지 않음', !/stop-hook-git-check|session-start-setup|vercel/.test(JSON.stringify(s)));
  } catch (e) { T('ST1 settings.json 이 올바른 JSON', false, e.message); }
})();

// ── 정리 및 요약 ──
for (const t of tmpRoots) { try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* 무시 */ } }
const failed = results.filter((x) => !x.pass);
for (const x of results) console.log(`${x.pass ? '✓' : '✗'} ${x.name}${x.pass ? '' : ' — ' + String(x.detail).split('\n')[0].slice(0, 200)}`);
console.log(`\n총 ${results.length}건: 통과 ${results.length - failed.length}, 실패 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
