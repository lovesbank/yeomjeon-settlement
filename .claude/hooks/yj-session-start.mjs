#!/usr/bin/env node
// SessionStart: 고정 문구만 출력한다 (저장소 내용·파일 텍스트는 출력하지 않음). 항상 exit 0.
if (process.env.YJ_HOOKS === 'off') process.exit(0);
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write([
    '[결산서 훅] 이 프로젝트에는 결산서 보호 훅이 설치되어 있습니다.',
    '- 계산 엔진(window.Calc)·기본 자료(window.SEED) 수정은 사용자 승인 없이 차단됩니다.',
    '- index.html 수정 전에 자동 백업(.claude/backups)을 만들고, 백업이 안 되면 수정이 차단됩니다.',
    '- 수정 후에는 JS 문법·HTML 구조·계산 회귀 검사가 자동 실행됩니다.',
    '- 한글 원본(.hwpx)과 도장 이미지는 수정할 수 없습니다.',
    '- 작업기록은 이 훅이 읽거나 쓰지 않습니다. 쪽수 검사는 자동이 아니라 수동입니다.',
    '',
  ].join('\n'));
  process.exit(0);
});
