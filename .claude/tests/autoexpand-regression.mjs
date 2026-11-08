#!/usr/bin/env node
// 자동 칸 확장 회귀 테스트 (읽기 전용: index.html 을 수정하지 않는다)
//
// 결산서는 수입·지출·은행 거래내역 칸이 자료에 맞게 자동으로 늘고 줄도록 설계되어 있다.
// 이 테스트는 "칸 수가 늘어난 것"을 오류로 보지 않고, 칸이 늘어도 합계·잔액·이월·기존 자료가 맞는지를 본다.
//
//  A. 계산 엔진(Calc): 수입 9칸 · 지출 25/40칸 · 계좌 3개 이상의 가상 자료로 합계·월말 잔액·연도 이월·기존 자료 보존
//  B. 한글(HWPX) 양식 칸 수: 출력 코드(fit/W)를 소스에서 꺼내 실행 → 합계 보존은 필수, 내역 합침·"0" 오출력은 '알려진 제한'으로 보고
//  C. 브라우저(Playwright, 있을 때만): 은행 표 자동 행 증가·감소, 결산 보고서 수입·지출표 12줄 한도, 장부 화면 칸 증가·저장·불러오기
//
// 결과 표시: ✓ 통과 / ✗ 실패(종료 코드 1) / ⚠ 알려진 제한(현재 설계의 한계, 종료 코드 0) / - 건너뜀(미검증)
// 사용: node autoexpand-regression.mjs [--file index.html] [--no-browser] [--strict-limits]
//   --strict-limits : ⚠ 알려진 제한도 실패로 취급 (제한을 해소한 뒤 확인할 때)
// 실제 금액·이름은 쓰지 않는다. 가상 자료만 사용한다. 브라우저 시험의 저장소는 임시(메모리) 프로필이다.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadEngine, INDEX } from '../hooks/yj-lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const file = path.resolve(arg('--file', INDEX()));
const NO_BROWSER = process.argv.includes('--no-browser');
const STRICT = process.argv.includes('--strict-limits');
const html = fs.readFileSync(file, 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));

const results = [];
const ok = (name) => results.push({ k: 'pass', name });
const bad = (name, why) => results.push({ k: 'fail', name, why });
const limit = (name, why) => results.push({ k: 'limit', name, why });
const skip = (name, why) => results.push({ k: 'skip', name, why });
const check = (name, cond, why = '') => (cond ? ok(name) : bad(name, why));
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`);

let engine;
try { engine = loadEngine(html); } catch (e) { console.log('✗ 계산 엔진을 꺼내지 못함: ' + e.message); process.exit(1); }
const C = engine.Calc, SEED = engine.SEED;

// ───────────────────────── 가상 자료 + 독립 기대값 (Calc 를 쓰지 않고 따로 계산) ─────────────────────────
const wonOf = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).replace(/[,\s원₩]/g, '');
  const n = Number(s);
  return s === '' || s === '-' || !Number.isFinite(n) ? 0 : Math.round(n);
};
const sumW = (arr, key = 'amount') => arr.reduce((t, r) => t + wonOf(r && r[key]), 0);
const expAmt = (m, i, k) => (i % 7 === 6 ? null : i % 11 === 10 ? `${(1000 + 30 * i + m).toLocaleString('en-US')}원` : 3000 * m * k + 13 * i + 5);

// smp: 수입(SMP) 칸 수, rec: REC 칸 수, exp: 월별 지출 칸 수(숫자 또는 월→칸 수 함수), acc: 계좌 수
function buildDb({ smp, rec, exp, acc, years = [2090, 2091, 2092] }) {
  const db = { version: 2, years: {} };
  years.forEach((y, yi) => {
    const k = yi + 1, revenue = {}, expense = {};
    for (let m = 1; m <= 12; m++) {
      revenue[m] = {
        smp: Array.from({ length: smp }, (_, i) => ({ label: `${i + 1}차`, amount: 10000 * m * k + 100 * i + 1, memo: '' })),
        rec: Array.from({ length: rec }, (_, i) => ({ label: `rec${i + 1}`, amount: i === 1 ? null : 700 * m + 10 * i + k, memo: '' })),
      };
      const n = typeof exp === 'function' ? exp(m) : exp;
      expense[m] = Array.from({ length: n }, (_, i) => ({ date: '', item: i % 7 === 6 ? '' : `항목${m}-${i + 1}`, amount: expAmt(m, i, k) }));
    }
    db.years[y] = {
      carryover: yi === 0 ? 50000 : 0, carryoverAuto: yi !== 0, notes: {}, revenue, expense, bank: {},
      accounts: Array.from({ length: acc }, (_, i) => ({ name: `은행${i + 1}`, balance: 100000 * (i + 1) * k + 7, account: `acct-${i + 1}` })),
      receipt: '',
    };
  });
  return db;
}

function expectedOf(db) {
  const out = {}; let prevBal = null;
  Object.keys(db.years).map(Number).sort((a, b) => a - b).forEach((y) => {
    const yd = db.years[y], inc = [0], exp = [0];
    for (let m = 1; m <= 12; m++) {
      inc[m] = sumW(yd.revenue[m].smp) + sumW(yd.revenue[m].rec);
      exp[m] = sumW(yd.expense[m]);
    }
    const carry = yd.carryoverAuto === false || prevBal === null ? wonOf(yd.carryover) : prevBal;
    const bal = [carry];
    for (let m = 1; m <= 12; m++) bal[m] = bal[m - 1] + inc[m] - exp[m];
    const q = [1, 2, 3, 4].map((n) => exp[n * 3 - 2] + exp[n * 3 - 1] + exp[n * 3]);
    const hInc = [1, 2].map((h) => inc.slice(h === 1 ? 1 : 7, h === 1 ? 7 : 13).reduce((t, v) => t + v, 0));
    out[y] = { inc, exp, q, hExp: [q[0] + q[1], q[2] + q[3]], hInc, carry, bal,
               totalInc: hInc[0] + hInc[1], totalExp: q.reduce((t, v) => t + v, 0), acc: sumW(yd.accounts, 'balance') };
    prevBal = bal[12];
  });
  return out;
}

// 계산 엔진 검사: 문제 목록을 돌려준다 (빈 목록 = 통과)
function checkEngine(Calc, db) {
  const probs = [], E = expectedOf(db), push = (s) => { if (probs.length < 12) probs.push(s); };
  Object.keys(E).forEach((ys) => {
    const y = Number(ys), yd = db.years[y], e = E[y], s = Calc.summarize(db, y);
    for (let m = 1; m <= 12; m++) {
      if (Calc.revenueMonth(yd, m) !== e.inc[m]) push(`${y}년 ${m}월 수입`);
      if (Calc.expenseMonth(yd, m) !== e.exp[m]) push(`${y}년 ${m}월 지출`);
    }
    [1, 2, 3, 4].forEach((q) => { if (Calc.expenseQuarter(yd, q) !== e.q[q - 1]) push(`${y}년 ${q}분기 지출`); });
    [1, 2].forEach((h) => {
      if (Calc.expenseHalf(yd, h) !== e.hExp[h - 1]) push(`${y}년 ${h}반기 지출`);
      if (Calc.revenueHalf(yd, h) !== e.hInc[h - 1]) push(`${y}년 ${h}반기 수입`);
    });
    if (Calc.revenueTotal(yd) !== e.totalInc) push(`${y}년 연 수입`);
    if (s.totalIncome !== e.totalInc || s.totalExpense !== e.totalExp) push(`${y}년 summarize 합계`);
    if (s.carryover !== e.carry) push(`${y}년 이월 ${s.carryover} ≠ ${e.carry}`);
    if (s.balance !== e.bal[12]) push(`${y}년 연말 잔액`);
    for (let k = 0; k <= 12; k++) if (Calc.balanceThrough(db, y, k) !== e.bal[k]) { push(`${y}년 ${k}월말 잔액`); break; }
    if (Calc.accountsTotal(yd) !== e.acc) push(`${y}년 계좌 합계(${yd.accounts.length}개)`);
  });
  return probs;
}

// 새 연도 생성 시 기존 자료 보존 검사
function checkPreserve(Calc, db) {
  const probs = [], push = (s) => { if (probs.length < 12) probs.push(s); };
  const years = Object.keys(db.years).map(Number).sort((a, b) => a - b), last = years[years.length - 1];
  const E = expectedOf(db), prev = db.years[last], prevJson = JSON.stringify(prev);
  const d = clone(db), ny = Calc.createYear(d, last + 1);
  for (let m = 1; m <= 12; m++) {
    const pe = prev.expense[m], want = Math.max(pe.length, Calc.EXP_ROWS[(m - 1) % 3]);
    if (ny.expense[m].length !== want) push(`${m}월 지출 칸 수 ${ny.expense[m].length} ≠ ${want}`);
    pe.forEach((r, i) => {
      const n = ny.expense[m][i];
      if (!n) { push(`${m}월 지출 ${i + 1}번째 칸 사라짐`); return; }
      if (n.item !== r.item) push(`${m}월 지출 ${i + 1}번째 내역 바뀜`);
      if (n.amount !== null) push(`${m}월 지출 ${i + 1}번째 금액이 비워지지 않음`);
    });
    const pr = prev.revenue[m], nr = ny.revenue[m];
    if (nr.smp.length !== pr.smp.length) push(`${m}월 SMP 칸 수 ${nr.smp.length} ≠ ${pr.smp.length}`);
    if (nr.rec.length !== pr.rec.length) push(`${m}월 REC 칸 수 ${nr.rec.length} ≠ ${pr.rec.length}`);
    pr.rec.forEach((r, i) => { if (nr.rec[i] && (nr.rec[i].label !== r.label || nr.rec[i].amount !== null)) push(`${m}월 REC ${i + 1}번째 이름·금액`); });
    pr.smp.forEach((r, i) => { if (nr.smp[i] && (nr.smp[i].label !== r.label || nr.smp[i].amount !== null)) push(`${m}월 SMP ${i + 1}번째 이름·금액`); });
  }
  if (ny.accounts.length !== prev.accounts.length) push(`계좌 칸 수 ${ny.accounts.length} ≠ ${prev.accounts.length}`);
  prev.accounts.forEach((a, i) => { const n = ny.accounts[i]; if (n && (n.name !== a.name || n.account !== a.account || n.balance !== null)) push(`계좌 ${i + 1}번째 이름·번호·금액`); });
  if (JSON.stringify(d.years[last]) !== prevJson) push('전년도 원본 자료가 바뀜');
  if (Calc.summarize(d, last + 1).carryover !== E[last].bal[12]) push('새 연도 이월 ≠ 전년 연말 잔액');
  const d2 = clone(db), made = Calc.ensureThroughYear(d2, last + 2);
  if (JSON.stringify(made) !== JSON.stringify([last + 1, last + 2])) push(`ensureThroughYear 생성 연도 ${JSON.stringify(made)}`);
  else {
    if (Calc.summarize(d2, last + 2).carryover !== E[last].bal[12]) push('두 해 건너 생성 시 이월이 이어지지 않음');
    if (d2.years[last + 2].expense[2].length !== Math.max(prev.expense[2].length, Calc.EXP_ROWS[1])) push('두 해 건너 생성 시 지출 칸 수');
  }
  return probs;
}

// ───────────────────────── A. 계산 엔진 ─────────────────────────
(function A() {
  const cases = [
    { name: '수입 9칸(SMP 9+REC 3) · 지출 25칸 · 계좌 3개', spec: { smp: 9, rec: 3, exp: 25, acc: 3 } },
    { name: '수입 9칸(SMP 9+REC 3) · 지출 40칸 · 계좌 5개', spec: { smp: 9, rec: 3, exp: 40, acc: 5 } },
    { name: '월마다 칸 수가 다름(수입 9/지출 3~40/계좌 4)', spec: { smp: 9, rec: 5, exp: (m) => [3, 10, 11, 25, 40, 7, 12, 18, 33, 1, 26, 11][m - 1], acc: 4 } },
    { name: '기본 칸 수(SMP 4·REC 3·지출 10/11/10·계좌 2) 기준선', spec: { smp: 4, rec: 3, exp: (m) => C.EXP_ROWS[(m - 1) % 3], acc: 2 } },
  ];
  cases.forEach((c) => {
    const db = buildDb(c.spec), probs = checkEngine(C, db);
    probs.length ? bad(`A 합계·월말 잔액·이월 [${c.name}]`, probs.join(', ')) : ok(`A 합계·월말 잔액·이월 [${c.name}] 3개 연도`);
    const pp = checkPreserve(C, db);
    pp.length ? bad(`A 새 연도 생성 시 기존 자료 보존 [${c.name}]`, pp.join(', ')) : ok(`A 새 연도 생성 시 기존 자료 보존 [${c.name}]`);
  });
  // 계좌 잔액이 비었거나 '1,000원' 같은 표기여도 합계가 맞아야 함 (칸 수가 늘어도 동일)
  const a = { accounts: [{ balance: '1,000원' }, { balance: null }, { balance: 250 }, { balance: '' }, { balance: '-50' }] };
  eq('A 계좌 5개(빈 칸·쉼표·원·음수 포함) 통합 잔액', C.accountsTotal(a), 1200);

  // 음성 대조: 일부러 망가뜨린 엔진을 이 테스트가 실제로 잡아내는가 (잡지 못하면 테스트가 무의미)
  const db = buildDb({ smp: 9, rec: 3, exp: 25, acc: 3 });
  const first10 = { ...C, expenseMonth: (yd, m) => C.sumRows((yd.expense[m] || []).slice(0, 10)) };
  const trunc = { ...C, createYear: (d, y) => { const r = C.createYear(d, y); for (let m = 1; m <= 12; m++) r.expense[m] = r.expense[m].slice(0, 10); return r; } };
  const acc2 = { ...C, accountsTotal: (yd) => C.sumRows((yd.accounts || []).slice(0, 2).map((x) => ({ amount: x.balance }))) };
  const smp4 = { ...C, revenueMonth: (yd, m) => { const b = yd.revenue[m]; return C.sumRows(b.smp.slice(0, 4)) + C.sumRows(b.rec); } };
  check('A 음성 대조: 지출 앞 10칸만 합산하는 엔진을 잡아냄', checkEngine(first10, db).length > 0, '못 잡음');
  check('A 음성 대조: 새 연도에서 지출 칸을 10칸으로 자르는 엔진을 잡아냄', checkPreserve(trunc, db).length > 0, '못 잡음');
  check('A 음성 대조: 계좌를 2개까지만 합산하는 엔진을 잡아냄', checkEngine(acc2, db).length > 0, '못 잡음');
  check('A 음성 대조: SMP 를 4칸까지만 합산하는 엔진을 잡아냄', checkEngine(smp4, db).length > 0, '못 잡음');
})();

// ───────────────────────── B. 한글(HWPX) 양식 칸 수 ─────────────────────────
(function B() {
  const at = html.indexOf('양식 칸 수보다 많으면');
  const fitSrc = at >= 0 ? /function fit\(rows, n, mk\) \{[\s\S]*?\n    \}/.exec(html.slice(at)) : null;
  const wSrc = /var W = function \(n\) \{[^\n]*\};/.exec(html);
  const capE = /\[\[1, (\d+)\], \[12, (\d+)\], \[24, (\d+)\]\]/.exec(html);
  const capS = /fit\(d\.revenue\[m\]\.smp, (\d+)/.exec(html), capR = /fit\(d\.revenue\[m\]\.rec, (\d+)/.exec(html), capA = /fit\(accRowsY, (\d+)/.exec(html);
  if (!fitSrc || !wSrc || !capE || !capS || !capR || !capA) { skip('B 한글 양식 칸 수 검사', '출력 코드(fit/W/칸 수)를 소스에서 찾지 못함 → 미검증 (코드가 바뀌었는지 확인 필요)'); return; }
  const ctx = { C }; vm.createContext(ctx);
  new vm.Script(`${wSrc[0]}\n${fitSrc[0]}\nthis.fit = fit; this.W = W;`).runInContext(ctx);
  const { fit, W } = ctx;
  const CAP = { exp: [Number(capE[1]), Number(capE[2]), Number(capE[3])], smp: Number(capS[1]), rec: Number(capR[1]), acc: Number(capA[1]) };
  const capOfExp = (m) => CAP.exp[(m - 1) % 3];
  ok(`B 한글 양식 칸 수 확인: 지출 ${CAP.exp.join('/')} · SMP ${CAP.smp} · REC ${CAP.rec} · 계좌 ${CAP.acc} (소스에서 읽음)`);

  // 출력 코드의 합침 방식이 '금액을 더하는 방식'인지 (합계 보존의 전제)
  const sumMk = (html.match(/amount: C\.sumRows\(rest\)/g) || []).length, balMk = /balance: C\.sumRows\(rest\.map/.test(html);
  check('B 초과분 합침 함수가 금액을 더함(지출·수입 2곳, 계좌 1곳)', sumMk >= 2 && balMk, `sumRows(rest) ${sumMk}곳, 계좌 ${balMk}`);
  const mkExp = (rest) => ({ date: rest[0].date, item: rest.map((x) => x.item).filter(Boolean).join('·'), amount: C.sumRows(rest) });
  const mkRev = (rest) => ({ label: rest.map((x) => x.label).filter(Boolean).join('·'), amount: C.sumRows(rest), memo: rest.map((x) => x.memo).filter(Boolean).join('·') });
  const mkAcc = (rest) => ({ name: rest.map((x) => x.name).join('·'), balance: C.sumRows(rest.map((a) => ({ amount: a.balance }))), account: rest.map((x) => x.account).join('·') });

  // B1. 칸 수가 양식보다 많아도 출력되는 금액 합계가 원본 합계와 같아야 한다 (필수)
  const probs = [];
  for (let m = 1; m <= 12; m++) for (const n of [capOfExp(m), capOfExp(m) + 1, 25, 40]) {
    const rows = buildDb({ smp: 4, rec: 3, exp: n, acc: 2, years: [2090] }).years[2090].expense[m];
    const cells = fit(rows, capOfExp(m), mkExp), got = cells.reduce((t, r) => t + (r ? wonOf(r.amount) : 0), 0);
    if (got !== sumW(rows)) probs.push(`지출 ${m}월 ${n}칸→${capOfExp(m)}칸`);
  }
  for (const n of [CAP.smp, CAP.smp + 1, 9]) {
    const rows = buildDb({ smp: n, rec: 3, exp: 10, acc: 2, years: [2090] }).years[2090].revenue[3].smp;
    if (fit(rows, CAP.smp, mkRev).reduce((t, r) => t + (r ? wonOf(r.amount) : 0), 0) !== sumW(rows)) probs.push(`SMP ${n}칸→${CAP.smp}칸`);
  }
  for (const n of [CAP.acc, CAP.acc + 1, 5]) {
    const rows = buildDb({ smp: 4, rec: 3, exp: 10, acc: n, years: [2090] }).years[2090].accounts;
    if (fit(rows, CAP.acc, mkAcc).reduce((t, r) => t + (r ? wonOf(r.balance) : 0), 0) !== sumW(rows, 'balance')) probs.push(`계좌 ${n}개→${CAP.acc}칸`);
  }
  probs.length ? bad('B 칸 수가 양식을 넘어도 출력 금액 합계 보존', probs.join(', ')) : ok('B 칸 수가 양식을 넘어도 출력 금액 합계 보존 (지출 25/40칸, SMP 9칸, 계좌 5개)');

  // B2. 양식보다 적거나 같으면 그대로, 빈 칸은 빈 문자열로 (0 이 찍히면 안 됨)
  {
    const rows = buildDb({ smp: 4, rec: 3, exp: 7, acc: 2, years: [2090] }).years[2090].expense[1];
    const cells = fit(rows, 10, mkExp);
    check('B 양식보다 적은 자료는 그대로 + 남는 칸은 빈 칸', cells.length === 10 && cells.slice(7).every((r) => r === null) && cells.slice(0, 7).every((r, i) => r.item === rows[i].item), '');
    const tenRows = buildDb({ smp: 4, rec: 3, exp: 10, acc: 2, years: [2090] }).years[2090].expense[1];
    tenRows[9] = { date: '', item: '', amount: null };   // 마지막 칸을 비운 10칸 (양식과 같은 칸 수)
    const exact = fit(tenRows, 10, mkExp);
    check('B 양식과 같은 칸 수의 빈 마지막 칸은 빈 칸으로 출력(0 아님)', W(exact[9].amount) === '', `마지막 칸 출력 "${W(exact[9].amount)}"`);
  }

  // B3. 탐지기: 내역이 합쳐지는 경우 / 빈 초과 칸이 "0" 으로 찍히는 경우
  const filled = (r) => !!(r && (r.item || r.label || r.name || wonOf(r.amount) || wonOf(r.balance)));
  const detect = (rows, cap) => {
    if (rows.length <= cap) return null;
    const f = rows.slice(cap - 1).filter(filled).length;
    return f >= 2 ? { kind: 'merge', n: f } : f === 0 ? { kind: 'zero' } : null;
  };
  check('B 탐지기 자체 점검: 양식 이하 → 정상, 초과+내역 2줄 이상 → 합침, 초과+전부 빈 칸 → 0', (() => {
    const mk = (n, blanks) => Array.from({ length: n }, (_, i) => ({ item: i >= n - blanks ? '' : `x${i}`, amount: i >= n - blanks ? null : 100 + i }));
    return detect(mk(10, 0), 10) === null && detect(mk(11, 0), 10)?.kind === 'merge' && detect(mk(12, 3), 10)?.kind === 'zero' && detect(mk(12, 2), 10) === null;
  })(), '');

  // B4. 출력 코드의 현재 동작 확인 (알려진 제한): 초과분이 전부 빈 칸이면 마지막 칸에 0 이 찍히는가
  {
    const rows = Array.from({ length: 12 }, (_, i) => ({ date: '', item: i < 9 ? `x${i}` : '', amount: i < 9 ? 100 + i : null }));
    const cell = fit(rows, 10, mkExp)[9];
    W(cell.amount) === '0'
      ? limit('B 초과 칸이 전부 비어도 한글 출력의 마지막 칸에 "0" 이 찍힘', `지출 12칸(9칸만 내용) → 양식 10칸: 10번째 칸 금액이 빈 칸이 아니라 "0" 으로 출력됨 (출력 코드 W(sumRows(rest)) 의 동작; 이번 단계에서는 수정하지 않음)`)
      : ok('B 초과 칸이 전부 비어도 한글 출력에 "0" 이 찍히지 않음');
  }

  // B5. EXP_ROWS(새 연도 기본 칸)가 한글 양식 칸 수를 넘으면 모든 새 연도에서 위 "0" 현상 발생 → 알려줌 (EXP_ROWS 증가 자체는 오류 아님)
  const exceed = [0, 1, 2].filter((k) => C.EXP_ROWS[k] > CAP.exp[k]);
  exceed.length ? limit('B 새 연도 기본 지출 칸(EXP_ROWS)이 한글 양식 칸보다 많음', `EXP_ROWS=${JSON.stringify(C.EXP_ROWS)} / 한글 양식=${JSON.stringify(CAP.exp)} → 새 연도의 빈 초과 칸이 "0" 으로 출력될 수 있음`)
               : ok(`B 새 연도 기본 지출 칸(EXP_ROWS ${JSON.stringify(C.EXP_ROWS)}) ≤ 한글 양식 칸(${JSON.stringify(CAP.exp)})`);

  // B6. 현재 실제 기본 자료(SEED)에서 양식을 넘는 곳 (읽기 전용 조사)
  let any = false;
  Object.keys(SEED.years || {}).forEach((y) => {
    const yd = SEED.years[y];
    C.MONTHS.forEach((m) => {
      const report = (label, rows, cap) => {
        const d = detect(rows, cap), over = rows.length > cap;
        if (d && d.kind === 'merge') { any = true; limit(`B ${y}년 ${m}월 ${label}가 한글 양식 칸 수를 넘음`, `${rows.length}칸 > 양식 ${cap}칸: 마지막 ${d.n}줄이 한 칸에 합쳐져 출력됨 (합계는 보존)`); }
        else if (d && d.kind === 'zero') { any = true; limit(`B ${y}년 ${m}월 ${label} 초과분이 빈 칸`, `${rows.length}칸 > 양식 ${cap}칸: 마지막 칸에 "0" 출력`); }
        else if (over) { any = true; limit(`B ${y}년 ${m}월 ${label}가 한글 양식 칸 수를 넘음`, `${rows.length}칸 > 양식 ${cap}칸: 내용 1줄만 있어 표시는 정상`); }
      };
      report('지출', (yd.expense && yd.expense[m]) || [], capOfExp(m));
      const rv = yd.revenue && yd.revenue[m];
      if (rv) { report('SMP', rv.smp || [], CAP.smp); report('REC', rv.rec || [], CAP.rec); }
    });
    if ((yd.accounts || []).length > CAP.acc) { any = true; limit(`B ${y}년 계좌가 한글 양식 칸 수를 넘음`, `${yd.accounts.length}개 > 양식 ${CAP.acc}칸`); }
  });
  if (!any) ok('B 현재 기본 자료(SEED)는 모두 한글 양식 칸 수 안에 있음');
})();

// ───────────────────────── C. 브라우저 시험 ─────────────────────────
async function browser() {
  if (NO_BROWSER) { skip('C 브라우저 시험 전체', '--no-browser 지정 → 미검증'); return; }
  let chromium;
  try { chromium = createRequire(import.meta.url)('playwright').chromium; }
  catch (e) { skip('C 브라우저 시험 전체', 'playwright 를 불러오지 못함 → 미검증: ' + String(e.message).split('\n')[0]); return; }
  let br;
  try { br = await chromium.launch(); }
  catch (e) { skip('C 브라우저 시험 전체', '브라우저를 실행하지 못함 → 미검증: ' + String(e.message).split('\n')[0]); return; }
  const url = pathToFileURL(file).href;
  const STORAGE_KEY = 'income-expense-ledger:v2';
  const num = (s) => Number(String(s || '0').replace(/[^\d-]/g, '')) || 0;
  const fmtW = (n) => (n < 0 ? '-' : '') + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  async function open(seedDb) {
    const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message || e)));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.addInitScript((arg) => {
      try { if (arg.db && !localStorage.getItem(arg.key)) localStorage.setItem(arg.key, JSON.stringify(arg.db)); } catch (e) { /* 무시 */ }
      window.__snapBank = (sel, pre) => {
        const num = (v) => Number(String(v || '0').replace(/[^\d-]/g, '')) || 0;
        const t = document.querySelector('#report ' + sel);
        const rows = Array.from(t.querySelectorAll('tbody tr')).map((tr) => {
          const f = tr.querySelectorAll('input');
          return { inn: num(f[2].value), out: num(f[3].value), bal: num(f[4].value), hidden: tr.classList.contains('rowHide'), x: f[0].classList.contains('xrow') };
        });
        const nz = rows.filter((r) => r.inn || r.out);
        return { total: rows.length, xrow: rows.filter((r) => r.x).length, visible: rows.filter((r) => !r.hidden).length, nonzero: nz.length,
                 hiddenNonzero: nz.filter((r) => r.hidden).length, rowsIn: rows.reduce((t, r) => t + r.inn, 0), rowsOut: rows.reduce((t, r) => t + r.out, 0),
                 lastBal: rows.length ? rows[rows.length - 1].bal : null,
                 inSum: num(document.getElementById(pre + 'InSum').value), outSum: num(document.getElementById(pre + 'OutSum').value),
                 end: num(document.getElementById(pre + 'End').value), prev: num(document.getElementById(pre + 'Prev').value) };
      };
    }, { key: STORAGE_KEY, db: seedDb || null });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    return { ctx, page, errs };
  }

  try {
    // ── C1. 은행 거래내역 표: 자동 행 증가·감소 ──
    {
      const { ctx, page, errs } = await open(null);
      const snap = async () => ({ ib: await page.evaluate(() => window.__snapBank('#ibTable', 'ib')), nh: await page.evaluate(() => window.__snapBank('#nhTable', 'nh')),
                                  integrated: await page.evaluate(() => document.getElementById('integratedBal').textContent) });
      await page.evaluate(() => window.__bankSync());
      await page.waitForTimeout(400);
      const base = await snap();
      check('C 은행 표 기본 상태: 기본 14줄 · 늘어난 줄 없음', base.ib.total === 14 && base.nh.total === 14 && base.ib.xrow === 0 && base.nh.xrow === 0, `${base.ib.total}/${base.nh.total}줄, 늘림 ${base.ib.xrow}/${base.nh.xrow}`);

      const list = [];
      for (let i = 0; i < 12; i++) list.push({ bank: 'ib', d: `11.${String(i + 1).padStart(2, '0')}`, desc: `시험입금${i + 1}`, inn: String(1000 * (i + 1)), out: '' });
      for (let i = 0; i < 11; i++) list.push({ bank: 'nh', d: `11.${String(i + 1).padStart(2, '0')}`, desc: `시험출금${i + 1}`, inn: '', out: String(500 * (i + 1)) });
      list.push({ bank: 'ib2nh', d: '11.20', desc: '시험이체1', inn: '7000', out: '' }, { bank: 'ib2nh', d: '11.21', desc: '시험이체2', inn: '7000', out: '' }, { bank: 'nh2ib', d: '11.22', desc: '시험이체3', inn: '3000', out: '' });
      await page.evaluate((items) => {
        for (const q of items) {
          const sel = document.getElementById('bqBank'); sel.value = q.bank; sel.dispatchEvent(new Event('change'));
          document.getElementById('bqDate').value = q.d; document.getElementById('bqDesc').value = q.desc;
          document.getElementById('bqIn').value = q.inn; document.getElementById('bqOut').value = q.out;
          document.getElementById('bqAdd').click();
        }
      }, list);
      await page.waitForTimeout(700);
      const add = await snap();
      const ibIn = base.ib.inSum + 12 * 13 * 500 + 3000, ibOut = base.ib.outSum + 14000;
      const nhIn = base.nh.inSum + 14000, nhOut = base.nh.outSum + 500 * 66 + 3000;
      eq('C 은행 표 증가: 기업은행 입금·출금 합계', [add.ib.inSum, add.ib.outSum], [ibIn, ibOut]);
      eq('C 은행 표 증가: 농협 입금·출금 합계', [add.nh.inSum, add.nh.outSum], [nhIn, nhOut]);
      check('C 은행 표 증가: 거래 수만큼 줄이 늘어남(기업/농협)', add.ib.nonzero === base.ib.nonzero + 15 && add.nh.nonzero === base.nh.nonzero + 14 && add.ib.total === Math.max(14, add.ib.nonzero) && add.nh.total === Math.max(14, add.nh.nonzero),
        `기업 ${base.ib.nonzero}→${add.ib.nonzero}건/${add.ib.total}줄, 농협 ${base.nh.nonzero}→${add.nh.nonzero}건/${add.nh.total}줄`);
      check('C 은행 표 증가: 늘어난 줄 수 = 전체 줄 - 기본 14', add.ib.xrow === add.ib.total - 14 && add.nh.xrow === add.nh.total - 14 && add.ib.xrow > 0, `${add.ib.xrow}/${add.nh.xrow}`);
      check('C 은행 표 증가: 내용 있는 줄은 숨겨지지 않음', add.ib.hiddenNonzero === 0 && add.nh.hiddenNonzero === 0, `숨김 ${add.ib.hiddenNonzero}/${add.nh.hiddenNonzero}`);
      // 소스 주석은 "두 표의 줄 수를 같게 맞춤(나란히 놓인 표)" 이지만, 늘어난 줄은 거래가 많은 쪽 표에만 생긴다 → 서로 다르면 알려진 제한으로 보고
      add.ib.visible === add.nh.visible
        ? ok(`C 은행 표 증가: 나란히 놓인 두 표의 보이는 줄 수가 같음 (${add.ib.visible}줄)`)
        : limit('C 은행 표: 나란히 놓인 두 표의 보이는 줄 수가 서로 다름', `기업은행 ${add.ib.visible}줄 / 농협 ${add.nh.visible}줄 (거래 ${add.ib.nonzero}건 / ${add.nh.nonzero}건). 소스 주석(fitBankRows)은 같게 맞춘다고 되어 있으나 늘어난 줄이 거래가 많은 쪽 표에만 생김. 합계·잔액에는 영향 없음 확인. 인쇄 모양 영향은 미검증`);
      check('C 은행 표 증가: 줄별 합 = 합계, 잔액 = 전월이월 + 입금 - 출금 = 마지막 줄 잔액', [add.ib, add.nh].every((b) => b.rowsIn === b.inSum && b.rowsOut === b.outSum && b.end === b.prev + b.inSum - b.outSum && b.lastBal === b.end),
        JSON.stringify([add.ib, add.nh].map((b) => [b.rowsIn - b.inSum, b.rowsOut - b.outSum, b.end - (b.prev + b.inSum - b.outSum), b.lastBal - b.end])));
      check('C 통합 잔액 = 기업은행 잔액 + 농협 잔액', num(add.integrated) === add.ib.end + add.nh.end, `${add.integrated} vs ${add.ib.end + add.nh.end}`);

      for (let guard = 0; guard < 60; guard++) {
        const left = await page.evaluate(() => { const b = document.querySelector('#bqList button[data-qdel]'); if (b) b.click(); return document.querySelectorAll('#bqList button[data-qdel]').length; });
        if (!left) break;
      }
      await page.waitForTimeout(700);
      const del = await snap();
      check('C 은행 표 감소: 거래를 지우면 늘어난 줄이 줄어 기본 줄 수로 돌아옴', del.ib.total === Math.max(14, base.ib.nonzero) && del.nh.total === Math.max(14, base.nh.nonzero) && del.ib.xrow === 0 && del.nh.xrow === 0, `기업 ${del.ib.total}줄(늘림 ${del.ib.xrow}), 농협 ${del.nh.total}줄(늘림 ${del.nh.xrow})`);
      eq('C 은행 표 감소: 합계·잔액이 처음 상태로 돌아옴', [del.ib.inSum, del.ib.outSum, del.ib.end, del.nh.inSum, del.nh.outSum, del.nh.end], [base.ib.inSum, base.ib.outSum, base.ib.end, base.nh.inSum, base.nh.outSum, base.nh.end]);
      check('C 은행 시험 중 화면 오류(pageerror) 없음', errs.length === 0, errs.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // ── C2. 결산 보고서 수입·지출표: 12줄 한도 ──
    {
      const { ctx, page, errs } = await open(null);
      const r = await page.evaluate(() => {
        const t = document.querySelector('#report #incomeExpenseTable');
        const trs = Array.from(t.querySelectorAll('tbody tr'));
        trs.forEach((tr, i) => {
          const f = tr.querySelectorAll('input:not(.dtcol)'); if (f.length < 4) return;
          f[0].value = `시험수입${i + 1}`; f[1].value = '1,000'; f[2].value = `시험지출${i + 1}`; f[3].value = '500';
        });
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return { rows: trs.length, buttons: t.querySelectorAll('button').length };
      });
      await page.waitForTimeout(900);
      const s = await page.evaluate(() => {
        const t = document.querySelector('#report #incomeExpenseTable'), num = (v) => Number(String(v || '0').replace(/[^\d-]/g, '')) || 0;
        const last = t.querySelectorAll('tbody tr:last-child input'); if (last[0]) last[0].focus();
        return { rows: t.querySelectorAll('tbody tr').length, hidden: t.querySelectorAll('tbody tr.rowHide').length, inc: num(document.getElementById('incSum').value), exp: num(document.getElementById('expSum').value) };
      });
      eq('C 보고서 수입·지출표 12줄을 모두 채우면 합계가 맞음(수입·지출)', [s.inc, s.exp], [r.rows * 1000, r.rows * 500]);
      check('C 보고서 수입·지출표 12줄을 모두 채우면 숨겨진 줄 없음', s.hidden === 0, `숨김 ${s.hidden}줄`);
      if (s.rows > 12 || r.buttons > 0) ok(`C 보고서 수입·지출표가 12줄을 넘어 늘어남 (현재 ${s.rows}줄, 늘리기 단추 ${r.buttons}개)`);
      else limit('C 결산 보고서 수입·지출표는 12줄이 한도 (13번째 항목을 입력할 칸이 없음)', `표 본문 ${s.rows}줄 고정, 줄 늘리기 단추 없음, 12줄을 다 채워도 새 줄이 생기지 않음. 한 달 수입 또는 지출이 12건을 넘으면 이 표로는 입력할 수 없고, 은행 표의 「빠른 입력」으로만 은행 거래를 보탤 수 있음`);
      check('C 보고서 시험 중 화면 오류(pageerror) 없음', errs.length === 0, errs.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // ── C3. 장부 화면: 칸 수 표시 · 칸 추가/삭제 · 저장 · 불러오기 ──
    {
      const spec = { smp: 9, rec: 3, exp: (m) => (m === 1 ? 25 : m === 2 ? 40 : C.EXP_ROWS[(m - 1) % 3]), acc: 3, years: [2090, 2091] };
      const db = buildDb(spec), E = expectedOf(db);
      let { ctx, page, errs } = await open(db);
      const pickYear = async (y) => { await page.evaluate((yy) => { const s = document.getElementById('yearSelect'); s.value = String(yy); s.dispatchEvent(new Event('change', { bubbles: true })); }, y); await page.waitForTimeout(500); };
      const cnt = (sel) => page.evaluate((q) => document.querySelectorAll(q).length, sel);
      const txt = (key) => page.evaluate((k) => { const el = document.querySelector(`#ledger [data-calc="${k}"]`); return el ? el.textContent : null; }, key);
      await pickYear(2090);
      eq('C 장부 화면: 지출 25칸(1월)·40칸(2월)이 그대로 표시', [await cnt('#ledger input[data-path^="expense.1."][data-path$=".item"]'), await cnt('#ledger input[data-path^="expense.2."][data-path$=".item"]')], [25, 40]);
      eq('C 장부 화면: 수입 SMP 9칸·계좌 3개가 그대로 표시', [await cnt('#ledger input[data-path^="revenue.1.smp."][data-path$=".amount"]'), await cnt('#ledger input[data-path^="accounts."][data-path$=".balance"]')], [9, 3]);
      eq('C 장부 화면: 1월·2월 지출 합계(25·40칸)', [await txt('exp-m:1'), await txt('exp-m:2')], [fmtW(E[2090].exp[1]), fmtW(E[2090].exp[2])]);
      eq('C 장부 화면: 연 수입·연 지출 합계', [await txt('sum-ti'), await txt('sum-te')], [fmtW(E[2090].totalInc), fmtW(E[2090].totalExp)]);
      eq('C 장부 화면: 이월·연말 잔액·계좌 합계', [await txt('carry'), await txt('bal'), await txt('acc-t')], [fmtW(E[2090].carry), fmtW(E[2090].bal[12]), fmtW(E[2090].acc)]);
      await pickYear(2091);
      eq('C 장부 화면: 다음 연도 이월 = 전년 연말 잔액', await txt('carry'), fmtW(E[2090].bal[12]));
      await pickYear(2090);

      const before = JSON.stringify(db.years[2090].expense[1]);
      await page.evaluate(() => document.querySelector('#ledger button[data-act="add-row"][data-target="expense.1"]').click());
      await page.waitForTimeout(500);
      check('C 장부 화면: 칸 추가(＋) → 지출 26칸', (await cnt('#ledger input[data-path^="expense.1."][data-path$=".item"]')) === 26, '');
      await page.evaluate(() => {
        const el = document.querySelector('#ledger input.money[data-path="expense.1.25.amount"]');
        el.value = '1,500'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('focusout', { bubbles: true }));
      });
      await page.waitForTimeout(700);
      const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
      check('C 저장: 칸 추가·입력이 저장소에 반영(26칸, 26번째 금액 1500)', saved.years[2090].expense[1].length === 26 && saved.years[2090].expense[1][25].amount === 1500, `${saved.years[2090].expense[1].length}칸 / ${saved.years[2090].expense[1][25] && saved.years[2090].expense[1][25].amount}`);
      check('C 저장: 기존 25칸 내용은 그대로', JSON.stringify(saved.years[2090].expense[1].slice(0, 25)) === before, '기존 칸 내용이 바뀜');
      eq('C 장부 화면: 1월 지출 합계가 새 금액만큼 증가', await txt('exp-m:1'), fmtW(E[2090].exp[1] + 1500));
      // 장부 자료 항목만 비교한다 (페이지가 items·minutes·biz 같은 다른 기능의 부가 항목을 자동으로 채우는 것은 장부 변경이 아님)
      const LEDGER_KEYS = ['carryover', 'carryoverAuto', 'revenue', 'expense', 'accounts', 'bank', 'notes', 'receipt'];
      const pick = (yd) => JSON.stringify(LEDGER_KEYS.map((k) => yd[k]));
      check('C 저장: 다른 연도(2091)의 장부 자료(수입·지출·계좌·이월)는 그대로', pick(saved.years[2091]) === pick(db.years[2091]), '2091년 장부 자료가 바뀜');
      const o90 = clone(db.years[2090]); o90.expense[1] = saved.years[2090].expense[1];
      check('C 저장: 같은 연도의 다른 달(2월 40칸 포함)·수입·계좌·이월은 그대로', pick(saved.years[2090]) === pick(o90) && saved.years[2090].expense[2].length === 40, '2090년 다른 자료가 바뀜');

      // 새로 열기: 방금 저장된 내용(saved)을 새 브라우저 프로필의 저장소에 넣고 연다.
      // (file:// 주소에서는 Chromium 이 새로고침 사이에 localStorage 를 항상 유지하지는 않아 page.reload 를 쓰면 시험이 간헐적으로 흔들림 → 앱이 저장 내용을 제대로 불러오는지만 안정적으로 확인)
      const errsFirst = errs;   // 처음 연 화면의 오류 배열 (마지막에 새로 연 화면의 오류와 함께 확인)
      await ctx.close();
      ({ ctx, page, errs } = await open(saved));
      await pickYear(2090);
      eq('C 불러오기: 새로 열어도 26칸·합계 유지', [await cnt('#ledger input[data-path^="expense.1."][data-path$=".item"]'), await txt('exp-m:1')], [26, fmtW(E[2090].exp[1] + 1500)]);
      // 마지막 칸 금액을 지운 뒤 삭제(－): 빈 칸이면 확인창 없이 삭제 → 25칸 복귀
      await page.evaluate(() => {
        const el = document.querySelector('#ledger input.money[data-path="expense.1.25.amount"]');
        el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('focusout', { bubbles: true }));
        document.querySelector('#ledger button[data-act="del-row"][data-target="expense.1"]').click();
      });
      await page.waitForTimeout(700);
      const saved2 = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
      check('C 칸 삭제(－): 25칸으로 돌아가고 기존 내용·합계 유지', saved2.years[2090].expense[1].length === 25 && JSON.stringify(saved2.years[2090].expense[1]) === before && (await txt('exp-m:1')) === fmtW(E[2090].exp[1]), `${saved2.years[2090].expense[1].length}칸`);
      const errsAll = errsFirst.concat(errs);
      check('C 장부 시험 중 화면 오류(pageerror) 없음', errsAll.length === 0, errsAll.slice(0, 2).join(' | '));
      await ctx.close();
    }
    skip('C 한글(HWPX) 파일 실제 생성·열기', '원본 양식(template.hwpx)을 화면에서 불러와 내려받는 단계는 이 시험에서 자동화하지 않음 → 미검증. B 의 fit/W 시험은 출력 코드를 소스에서 꺼내 실행한 것');
    skip('C 인쇄·PDF 쪽 나눔', '인쇄 미리보기는 자동 비교하지 않음 → 미검증 (사람이 확인 필요)');
  } catch (e) {
    bad('C 브라우저 시험 실행', String(e.stack || e).split('\n').slice(0, 3).join(' / '));
  } finally { await br.close().catch(() => {}); }
}
await browser();

// ───────────────────────── 결과 ─────────────────────────
const cnt = { pass: 0, fail: 0, limit: 0, skip: 0 };
for (const r of results) {
  cnt[r.k]++;
  if (r.k === 'pass') console.log(`✓ ${r.name}`);
  else if (r.k === 'fail') console.log(`✗ ${r.name}: ${r.why}`);
  else if (r.k === 'limit') console.log(`⚠ [알려진 제한] ${r.name}: ${r.why}`);
  else console.log(`- [미검증] ${r.name}: ${r.why}`);
}
const failTotal = cnt.fail + (STRICT ? cnt.limit : 0);
console.log(`\n자동 확장 회귀 테스트: 통과 ${cnt.pass}, 실패 ${cnt.fail}, 알려진 제한 ${cnt.limit}, 미검증 ${cnt.skip}${STRICT ? ' (--strict-limits: 알려진 제한도 실패로 계산)' : ''}`);
process.exit(failTotal ? 1 : 0);
