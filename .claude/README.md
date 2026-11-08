# 결산서 전용 Hooks

이 폴더는 결산서 앱(`index.html`)을 안전하게 고치기 위한 가드레일입니다. 이 저장소는 **공개**이므로
이 폴더의 파일에는 실제 금액·이름·계좌를 넣지 않습니다(필요한 값은 실행할 때 `index.html`에서 읽습니다).

## 훅 목록

| 훅 | 시점 | 하는 일 | 실패 시 |
|---|---|---|---|
| `yj-session-start.mjs` | 세션 시작 | 고정 안내 문구 출력 | 항상 통과 |
| `yj-pre-guard.mjs` | Write/Edit/MultiEdit/Bash 직전 | 계산 엔진·SEED 수정 차단, `.hwpx`·도장 이미지 수정 차단, `index.html` 수정 전 백업+해시 확인 | deny (백업 실패도 deny) |
| `yj-post-check.mjs` | `index.html` 수정 직후 | JS 문법, HTML 구조, 계산 회귀 | exit 2 (오류를 모델에 전달) |
| `yj-stop-check.mjs` | 종료 직전 | 보호 파일, 백업 장부, 추적되면 안 되는 파일, 문법·회귀 | exit 2 (같은 문제 최대 2번, 그 뒤엔 경고하고 통과) |

작업기록은 읽거나 쓰지 않습니다(밤 기록 방식 유지). 쪽수 검사는 자동이 아닙니다.

## 수동 실행

```
node .claude/tests/calc-regression.mjs     # 계산 회귀 (가상 장부 기대값 + 기존 코드 비교 + 관계식)
node .claude/tests/syntax-check.mjs        # HTML·JS 문법
TMPDIR=<임시폴더> node .claude/tests/hook-selftest.mjs   # 훅 자체 시험 (복사본 저장소에서만 실행)
```

## 계산식·SEED 변경 허용 (사용자 승인 후에만)

계산 엔진(`window.Calc`)과 기본 자료(`window.SEED`)를 바꾸는 수정은 기본적으로 **deny** 입니다.
승인한 작업이면 **사용자가 직접** 허용 장치를 한 번 발급합니다(기본 20분, 1회, 소진 후 자동 소멸):

```
node .claude/hooks/yj-allow.mjs calc 20 1
node .claude/hooks/yj-allow.mjs revoke
```

### 한계 (기술적으로 강제할 수 없는 것)
- 이 장치는 **실수 방지용 가드레일**이며, 모델의 의도적 우회를 막는 보안 장치가 아닙니다. 모델이 도구로 허용 파일을
  만들거나 발급 도구를 실행하는 것은 막지만(패턴 검사), 난독화된 명령(`node -e`, `python -c` 등)까지 막지는 못합니다.
- Bash 로 `index.html` 을 쓰는 난독화된 명령은 사전 차단이 안 됩니다. 그 경우 종료 시 백업 장부·문법·회귀 검사로 사후에 잡습니다.
- 훅 파일 자체(`.claude/hooks`, `settings.json`)는 이 훅이 보호하지 않습니다.
- 계산 엔진(`Calc`) 밖의 금액 계산(월 보고서 합계, 재무제표, 차트, HWPX 출력)은 아직 자동 검증하지 않습니다.
- `ask`(승인 요청)는 자동 모드에서 사용자 확인 여부를 검증하지 못해 사용하지 않습니다.

## 끄는 방법
`.claude/settings.json` 에서 해당 항목을 지우거나, 환경 변수 `YJ_HOOKS=off` 를 설정합니다.

## 기존 훅과의 관계
기존 Stop 훅(git 커밋·푸시 점검)과 플러그인 훅은 그대로이며 병렬로 함께 실행됩니다.
백업·상태 파일은 `.gitignore` 로 제외되어 기존 Stop 훅의 "추적되지 않는 파일" 검사에 걸리지 않습니다
(`.gitignore` 없이 쓰면 기존 Stop 훅이 종료를 막습니다).
