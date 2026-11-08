#!/usr/bin/env node
// PostToolUse: index.html 을 고친 직후 HTML·JS 문법 + 계산 회귀(기존 코드·가상 장부·관계식) 검사
// 실패하면 exit 2 로 오류를 모델에 돌려준다 (파일을 자동으로 되돌리지는 않는다).
// 훅 자체의 인프라 오류(시간 초과 등)는 작업을 막지 않고 경고만 한다.
import { readStdin, parseJson, isIndex, staticChecks, runRegression, failBlock, warn, log } from './yj-lib.mjs';

if (process.env.YJ_HOOKS === 'off') process.exit(0);
const input = parseJson(await readStdin());
const fp = (input.tool_input || {}).file_path;
if (!isIndex(fp)) process.exit(0);

try {
  const problems = staticChecks();
  const reg = runRegression();
  if (reg.infra) { warn('[결산서 훅] 계산 회귀 검사를 실행하지 못했습니다(미검증): ' + reg.out); }
  else if (!reg.ok) problems.push(...reg.fails.map((l) => '계산 회귀 ' + l));
  if (problems.length) {
    log('post.log', { result: 'fail', problems });
    failBlock(['[결산서 훅] index.html 수정 후 검사에서 문제가 발견되었습니다. 원인을 고친 뒤 다시 확인해 주세요.', ...problems.map((p) => ' - ' + p)]);
  }
  log('post.log', { result: 'pass', regressionRan: !reg.infra });
  if (!reg.infra) warn('[결산서 훅] 실행한 검사 통과: JS 문법, HTML 구조(HEAD 대비), 계산 회귀(가상 장부·HEAD 비교·관계식)');
  process.exit(0);
} catch (e) {
  warn('[결산서 훅] 사후 검사 중 오류로 검사를 끝내지 못했습니다(미검증): ' + (e && e.message));
  process.exit(0);
}
