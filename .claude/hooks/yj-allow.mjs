#!/usr/bin/env node
// 계산식·SEED 변경 허용 장치 — 사용자가 승인한 뒤 "사용자 쪽에서" 직접 실행하는 도구.
//   node .claude/hooks/yj-allow.mjs calc [유효 분(기본 20, 최대 120)] [허용 횟수(기본 1, 최대 10)]
//   node .claude/hooks/yj-allow.mjs revoke
// 모델이 이 명령을 도구로 실행하거나 토큰 파일을 만들려 하면 yj-pre-guard 가 막는다.
// 한계: 패턴 검사이므로 난독화된 쓰기까지 막지는 못한다. 이 장치는 실수 방지용 가드레일이며
//       모델의 의도적 우회를 기술적으로 막는 보안 장치가 아니다.
import fs from 'node:fs';
import { TOKEN, STATE_DIR, log } from './yj-lib.mjs';

const [cmd, min = '20', uses = '1'] = process.argv.slice(2);
if (cmd === 'revoke') { try { fs.unlinkSync(TOKEN()); } catch { /* 없음 */ } console.log('허용 장치를 삭제했습니다.'); process.exit(0); }
if (cmd !== 'calc') { console.log('사용법: node .claude/hooks/yj-allow.mjs calc [분] [횟수]  |  revoke'); process.exit(1); }
const m = Math.min(120, Math.max(1, parseInt(min, 10) || 20)), u = Math.min(10, Math.max(1, parseInt(uses, 10) || 1));
fs.mkdirSync(STATE_DIR(), { recursive: true });
fs.writeFileSync(TOKEN(), JSON.stringify({ created: new Date().toISOString(), expires: new Date(Date.now() + m * 60000).toISOString(), uses_left: u }));
log('allow-log.jsonl', { issued: true, minutes: m, uses: u });
console.log(`계산식/SEED 변경 허용: ${m}분 동안, ${u}번의 수정까지. (사용 후 자동 소멸)`);
