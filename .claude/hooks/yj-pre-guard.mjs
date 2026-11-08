#!/usr/bin/env node
// PreToolUse 보호 훅
//  - 원본 파일(.hwpx, 도장 이미지)과 허용 토큰 파일은 수정 금지(deny)
//  - index.html 수정 전: 계산 엔진(Calc)·SEED 구간이 바뀌면 deny, 그 외에는 백업을 만들고 무결성을 확인
//    (백업이 안 되면 수정 자체를 deny)
//  - Bash 로 index.html·보호 파일을 직접 쓰려는 명령은 deny (Edit 도구를 쓰게 한다)
// 한계: 명령 문자열 패턴 검사라서 난독화된 쓰기(node -e, python -c 등)는 막지 못한다.
//       그런 경우는 PostToolUse·Stop 훅이 해시/백업 장부로 사후에 잡는다.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readStdin, parseJson, regions, applyEdit, backupIndex, consumeToken, denyPre, isIndex, log, INDEX } from './yj-lib.mjs';

if (process.env.YJ_HOOKS === 'off') process.exit(0);

const input = parseJson(await readStdin());
const tool = input.tool_name || '';
const ti = input.tool_input || {};

const PROTECTED_BIN = /(\.hwpx$|(^|\/)(stamp\.png|audit_stamp\.png)$)/i;
const TOKEN_PATH = /\.claude\/state\/allow-/;

function deny(reason, extra = {}) {
  log('guard.log', { decision: 'deny', tool, reason, ...extra });
  denyPre('[결산서 훅] ' + reason);
}

try {
  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    if (/yj-allow|\.claude\/state\/allow-/.test(cmd)) deny('계산식 변경 허용 장치는 사용자가 직접 실행해야 하며 이 도구로는 다룰 수 없습니다.');
    // 쓰기 동작이 index.html 또는 보호 파일을 향하는 경우만 (읽기·복사 원본으로 쓰는 경우는 통과)
    const writeToIndex = [
      /\bsed\s+[^|;&\n]*-i[^|;&\n]*index\.html/, /\bperl\s+[^|;&\n]*-p?i[^|;&\n]*index\.html/,
      />>?\s*["']?[^\s|;&"']*index\.html/, /\btee\b[^|;&\n]*index\.html/,
      /\b(mv|cp|install|ln)\b[^|;&\n]*\s["']?[^\s|;&"']*index\.html["']?\s*($|[;&|])/, /\brm\b[^|;&\n]*index\.html/,
    ].some((r) => r.test(cmd));
    if (writeToIndex) deny('Bash 로 index.html 을 직접 고칠 수 없습니다. Edit/Write 도구를 쓰면 백업과 계산식 보호가 적용됩니다.');
    const writeToProtected = /(>>?|\btee\b|\bsed\s+-i|\b(mv|cp|rm)\b)[^|;&\n]*(\.hwpx|stamp\.png|audit_stamp\.png)/i.test(cmd);
    if (writeToProtected) deny('원본 한글 파일(.hwpx)·도장 이미지는 수정하거나 덮어쓸 수 없습니다.');
    if (/\bgit\s+push\b[^|;&\n]*(--force\b|\s-f\b)/.test(cmd) && !/--force-with-lease/.test(cmd)) deny('git push --force 는 허용하지 않습니다.');
    if (/\bgit\s+push\b[^|;&\n]*(\s|:|\/)(main|master)(\s|$)/.test(cmd)) deny('main/master 로의 push 는 별도 승인 없이 할 수 없습니다.');
    process.exit(0);
  }

  // 파일 쓰기 도구
  const fp = ti.file_path || ti.notebook_path || '';
  const rel = fp ? path.relative(ROOT(), path.resolve(ROOT(), fp)).split(path.sep).join('/') : '';
  if (rel && TOKEN_PATH.test(rel)) deny('계산식 변경 허용 장치(.claude/state/allow-*)는 도구로 만들거나 고칠 수 없습니다.');
  if (rel && PROTECTED_BIN.test(rel)) deny(`보호 파일입니다: ${rel} (한글 원본·도장 이미지는 수정 금지)`);
  if (!isIndex(fp)) process.exit(0);

  // ── index.html ──
  const before = fs.existsSync(INDEX()) ? fs.readFileSync(INDEX(), 'utf8') : null;
  if (before === null) process.exit(0);
  const rb = regions(before);
  if (!rb.ok) deny(rb.reason + ' → 안전하게 판단할 수 없어 수정을 막았습니다.');
  const ap = applyEdit(before, tool, ti);
  if (!ap.ok) process.exit(0); // 적용 불가한 수정은 도구가 스스로 실패시킨다 (파일 변경 없음)
  const ra = regions(ap.content);
  const calcChanged = !ra.ok || ra.calc !== rb.calc;
  const seedChanged = !ra.ok || ra.seed !== rb.seed;
  if (calcChanged || seedChanged) {
    if (!consumeToken()) {
      deny(`${calcChanged ? '계산 엔진(window.Calc)' : ''}${calcChanged && seedChanged ? '·' : ''}${seedChanged ? '기본 자료(window.SEED)' : ''} 를 바꾸는 수정은 사용자 승인 없이 할 수 없습니다. ` +
        '진욱 님이 승인하시면 사용자 쪽에서 허용 장치를 한 번 발급해야 합니다 (README 참고).', { calcChanged, seedChanged });
    }
  }
  const b = backupIndex();
  if (!b.ok) deny('index.html 백업에 실패해 수정을 막았습니다: ' + b.reason);
  log('guard.log', { decision: 'allow', tool, backup: path.basename(b.file || ''), reused: !!b.reused, calcChanged, seedChanged });
  process.exit(0);
} catch (e) {
  // 보호 대상(index.html)이면 닫고, 그 밖에는 열어 둔다
  try {
    const fp = (input.tool_input || {}).file_path;
    if (isIndex(fp)) deny('훅 내부 오류로 백업·보호 상태를 확인하지 못해 수정을 막았습니다: ' + (e && e.message));
  } catch { /* 아래로 */ }
  process.exit(0);
}
