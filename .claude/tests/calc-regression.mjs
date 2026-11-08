#!/usr/bin/env node
// 결산 계산 회귀 테스트
//  A. 가상 장부 확정 기대값 (손으로 계산한 값, virtual-ledger.mjs)
//  B. 기존 코드(HEAD 또는 --baseline 파일)와 같은 입력에서 출력 비교
//  C. 관계식(합계·이월·잔액이 서로 맞는지) — 가상 장부 + 작업본의 SEED
//  D. 입력 자료 점검 (읽을 수 없는 금액 등)
// 사용: node calc-regression.mjs [--file index.html] [--baseline HEAD|경로|none]
// 종료 코드: 0 통과, 1 실패. 실제 금액은 출력하지 않는다(어긋난 항목 이름만 출력).
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine, gitShowHead, ROOT, INDEX } from '../hooks/yj-lib.mjs';
import { buildLedger, EXPECT } from './virtual-ledger.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const file = path.resolve(arg('--file', INDEX()));
const baseArg = arg('--baseline', 'HEAD');
const clone = (o) => JSON.parse(JSON.stringify(o));

const results = [];
const ok = (name) => results.push({ name, pass: true });
const bad = (name, why) => results.push({ name, pass: false, why });
const eq = (name, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(name) : bad(name, `기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`));

let work;
try { work = loadEngine(fs.readFileSync(file, 'utf8')); }
catch (e) { console.log('✗ 작업본에서 계산 엔진을 꺼내지 못함: ' + e.message); process.exit(1); }
const C = work.Calc;
const names = ['parseWon', 'formatWon', 'sumRows', 'revenueMonth', 'revenueHalf', 'revenueTotal', 'expenseMonth', 'expenseQuarter', 'expenseHalf', 'accountsTotal', 'resolveCarryover', 'summarize', 'createYear', 'ensureThroughYear', 'balanceThrough', 'emptyYear'];
const missing = names.filter((n) => typeof C[n] !== 'function');
if (missing.length) { console.log('✗ 계산 엔진에 함수가 없음: ' + missing.join(', ')); process.exit(1); }

// ── A. 가상 장부 확정 기대값 ──
(function A() {
  const db = buildLedger(), E = EXPECT;
  const y90 = db.years[2090], e90 = E.y2090;
  for (let m = 1; m <= 12; m++) {
    if (C.revenueMonth(y90, m) !== e90.monthIncome[m]) bad(`A 2090년 ${m}월 수입`, `기대 ${e90.monthIncome[m]} / 실제 ${C.revenueMonth(y90, m)}`);
    if (C.expenseMonth(y90, m) !== e90.monthExpense[m]) bad(`A 2090년 ${m}월 지출`, `기대 ${e90.monthExpense[m]} / 실제 ${C.expenseMonth(y90, m)}`);
  }
  if (!results.some((r) => !r.pass && r.name.startsWith('A 2090년'))) ok('A 2090년 월별 수입·지출 12개월');
  eq('A 2090년 상·하반기 수입', [C.revenueHalf(y90, 1), C.revenueHalf(y90, 2)], e90.revenueHalf);
  eq('A 2090년 연 수입', C.revenueTotal(y90), e90.revenueTotal);
  eq('A 2090년 분기 지출', [1, 2, 3, 4].map((q) => C.expenseQuarter(y90, q)), e90.expenseQuarter);
  eq('A 2090년 상·하반기 지출', [C.expenseHalf(y90, 1), C.expenseHalf(y90, 2)], e90.expenseHalf);
  const s90 = C.summarize(db, 2090);
  eq('A 2090년 이월·합계·잔액', { c: s90.carryover, i: s90.totalIncome, e: s90.totalExpense, d: s90.diff, b: s90.balance },
    { c: e90.carryover, i: e90.totalIncome, e: e90.totalExpense, d: e90.diff, b: e90.balance });
  eq('A 2090년 월말 잔액 0~12월', [...Array(13).keys()].map((k) => C.balanceThrough(db, 2090, k)), e90.balanceThrough);
  const s91 = C.summarize(db, 2091), e91 = EXPECT.y2091;
  eq('A 2091년 이월 자동·합계·잔액', { c: s91.carryover, i: s91.totalIncome, e: s91.totalExpense, d: s91.diff, b: s91.balance },
    { c: e91.carryover, i: e91.totalIncome, e: e91.totalExpense, d: e91.diff, b: e91.balance });
  eq('A 2091년 월말 잔액 0~12월(적자 달 포함)', [...Array(13).keys()].map((k) => C.balanceThrough(db, 2091, k)), e91.balanceThrough);
  eq('A 없는 연도 요약은 0', C.summarize(db, 1999).balance, 0);

  const d2 = clone(db);
  const y92 = C.createYear(d2, 2092);
  eq('A createYear 2092 이월 = 전년 잔액', C.summarize(d2, 2092).carryover, E.created2092.carryover);
  eq('A createYear 2092 연말 잔액', C.summarize(d2, 2092).balance, E.created2092.balance);
  // 이월이 자동일 때는 저장값이 화면 계산에 쓰이지 않지만, 수동으로 바꾸면 저장값이 이월이 된다 → 저장값도 맞아야 함
  eq('A createYear 저장된 이월값 = 전년 잔액 (자동 상태)', [y92.carryover, y92.carryoverAuto], [E.created2092.carryover, true]);
  const manual = clone(d2); manual.years[2092].carryoverAuto = false;
  eq('A 이월을 수동으로 바꾸면 저장값이 이월로 쓰임', C.summarize(manual, 2092).carryover, E.created2092.carryover);
  eq('A createYear 금액은 비우고 이름·차수는 유지', [y92.revenue[1].smp[0].amount, y92.revenue[1].smp[0].label, y92.expense[1][0].item, y92.expense[1][0].amount], [null, '1차', '항목A', null]);
  const rowsOk = [...Array(12).keys()].every((i) => y92.expense[i + 1].length >= E.created2092.expenseRows(i + 1));
  rowsOk ? ok('A createYear 지출 칸 수(10/11/10) 이상') : bad('A createYear 지출 칸 수', '기본 칸 수보다 적음');
  const d3 = clone(db);
  eq('A ensureThroughYear 2094 생성 연도', C.ensureThroughYear(d3, 2094), E.ensureThrough2094.made);
  eq('A ensureThroughYear 2094 연말 잔액', C.summarize(d3, 2094).balance, E.ensureThrough2094.balance);
  eq('A ensureThroughYear 이미 있으면 새로 만들지 않음', C.ensureThroughYear(clone(db), 2091), []);
  eq('A accountsTotal(빈칸 포함)', C.accountsTotal({ accounts: E.accountsTotal.accounts }), E.accountsTotal.total);
  eq('A sumRows(빈 줄·null 줄 포함)', C.sumRows(E.sumRows.rows), E.sumRows.total);
  E.parseWon.forEach(([i, o]) => { const g = C.parseWon(i); (Object.is(g, o) || g === o) ? 0 : bad(`A parseWon(${String(i)})`, `기대 ${o} / 실제 ${g}`); });
  if (!results.some((r) => !r.pass && r.name.startsWith('A parseWon'))) ok(`A parseWon ${E.parseWon.length}건`);
  E.formatWon.forEach(([i, o]) => { const g = C.formatWon(i); g === o ? 0 : bad(`A formatWon(${String(i)})`, `기대 "${o}" / 실제 "${g}"`); });
  if (!results.some((r) => !r.pass && r.name.startsWith('A formatWon'))) ok(`A formatWon ${E.formatWon.length}건`);
})();

// ── 공통: 한 엔진에서 모든 계산 결과를 한 덩어리로 ──
function snapshot(Calc, db) {
  const out = {};
  Object.keys(db.years).forEach((y) => {
    const yd = db.years[y], o = (out[y] = {});
    o.summary = Calc.summarize(db, y);
    o.carry = Calc.resolveCarryover(db, y);
    o.months = Calc.MONTHS.map((m) => [Calc.revenueMonth(yd, m), Calc.expenseMonth(yd, m)]);
    o.half = [Calc.revenueHalf(yd, 1), Calc.revenueHalf(yd, 2), Calc.revenueTotal(yd), Calc.expenseHalf(yd, 1), Calc.expenseHalf(yd, 2)];
    o.quarter = [1, 2, 3, 4].map((q) => Calc.expenseQuarter(yd, q));
    o.acc = Calc.accountsTotal(yd);
    o.bal = [...Array(13).keys()].map((k) => Calc.balanceThrough(db, y, k));
  });
  const d = clone(db), made = Calc.ensureThroughYear(d, Math.max(...Object.keys(db.years).map(Number)) + 2);
  out.created = { made, summaries: made.map((y) => Calc.summarize(d, y)), sample: made.length ? d.years[made[0]].expense[1] : null,
                  stored: made.map((y) => [d.years[y].carryover, d.years[y].carryoverAuto]) };
  out.fmt = [1234567, -1000, 0, null, '12,345원'].map((v) => Calc.formatWon(v));
  return out;
}
function firstDiff(a, b, p = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], p + '/' + k); if (d) return d; }
  }
  return p || '/';
}

// ── B. 기존 코드와 비교 ──
(function B() {
  let baseHtml = null, label = '';
  if (baseArg === 'none') { results.push({ name: 'B 기존 코드와 비교', skipped: true, why: '--baseline none' }); return; }
  if (baseArg === 'HEAD') { baseHtml = gitShowHead('index.html'); label = 'HEAD'; }
  else { try { baseHtml = fs.readFileSync(path.resolve(baseArg), 'utf8'); label = baseArg; } catch { baseHtml = null; } }
  if (!baseHtml) { results.push({ name: 'B 기존 코드와 비교', skipped: true, why: `기준본(${baseArg})을 읽지 못함 → 미검증` }); return; }
  let base;
  try { base = loadEngine(baseHtml); } catch (e) { bad('B 기준본 엔진 추출', e.message); return; }
  const inputs = { '가상 장부': buildLedger(), '작업본 SEED': clone(work.SEED), '기준본 SEED': clone(base.SEED) };
  for (const [nm, db] of Object.entries(inputs)) {
    const a = snapshot(base.Calc, clone(db)), b = snapshot(work.Calc, clone(db));
    const d = firstDiff(a, b);
    d ? bad(`B ${label} 대비 결과 비교 [${nm}]`, `처음 달라진 항목: ${d}`) : ok(`B ${label} 대비 결과 동일 [${nm}]`);
  }
  if (work.Calc.MONTHS && JSON.stringify(work.Calc.MONTHS) !== JSON.stringify(base.Calc.MONTHS)) bad('B MONTHS', '월 목록이 달라짐');
})();

// ── C. 관계식 ──
(function Cc() {
  const sets = { '가상 장부': buildLedger(), '작업본 SEED': clone(work.SEED) };
  for (const [nm, db] of Object.entries(sets)) {
    const probs = [];
    const ys = Object.keys(db.years).map(Number).sort((a, b) => a - b);
    ys.forEach((y) => {
      const yd = db.years[y], s = C.summarize(db, y);
      const mi = C.MONTHS.reduce((t, m) => t + C.revenueMonth(yd, m), 0), me = C.MONTHS.reduce((t, m) => t + C.expenseMonth(yd, m), 0);
      if (s.balance !== s.carryover + s.totalIncome - s.totalExpense) probs.push(`${y} 잔액 = 이월+수입-지출`);
      if (s.diff !== s.totalIncome - s.totalExpense) probs.push(`${y} 차액`);
      if (s.totalIncome !== mi || s.totalIncome !== C.revenueTotal(yd) || s.totalIncome !== C.revenueHalf(yd, 1) + C.revenueHalf(yd, 2)) probs.push(`${y} 수입 합계(월·반기·연)`);
      if (s.totalExpense !== me || s.totalExpense !== C.expenseHalf(yd, 1) + C.expenseHalf(yd, 2) || s.totalExpense !== [1, 2, 3, 4].reduce((t, q) => t + C.expenseQuarter(yd, q), 0)) probs.push(`${y} 지출 합계(월·분기·반기·연)`);
      if (C.balanceThrough(db, y, 12) !== s.balance) probs.push(`${y} 12월말 잔액 ≠ 연말 잔액`);
      if (C.balanceThrough(db, y, 0) !== s.carryover) probs.push(`${y} 0월 잔액 ≠ 이월`);
      let run = s.carryover;
      for (let k = 1; k <= 12; k++) { run += C.revenueMonth(yd, k) - C.expenseMonth(yd, k); if (run !== C.balanceThrough(db, y, k)) { probs.push(`${y} ${k}월말 잔액`); break; } }
      if (yd.carryoverAuto !== false && db.years[y - 1] && s.carryover !== C.summarize(db, y - 1).balance) probs.push(`${y} 이월 ≠ 전년 잔액`);
    });
    probs.length ? bad(`C 관계식 [${nm}]`, probs.join(', ')) : ok(`C 관계식 [${nm}] ${ys.length}개 연도`);
  }
})();

// ── D. 입력 자료 점검 (작업본 SEED) ──
(function D() {
  const probs = [];
  Object.entries(work.SEED.years || {}).forEach(([y, yd]) => {
    const chk = (v, where) => { if (v === null || v === undefined || v === '') return; if (typeof v === 'number' ? !Number.isFinite(v) : C.parseWon(v) === null) probs.push(`${y} ${where}`); };
    C.MONTHS.forEach((m) => {
      const rv = yd.revenue && yd.revenue[m];
      if (rv) [...(rv.smp || []), ...(rv.rec || [])].forEach((r) => chk(r && r.amount, `${m}월 수입`));
      ((yd.expense && yd.expense[m]) || []).forEach((r) => chk(r && r.amount, `${m}월 지출`));
    });
    (yd.accounts || []).forEach((a) => chk(a && a.balance, '통장 잔액'));
  });
  probs.length ? bad('D 읽을 수 없는 금액 (SEED)', probs.slice(0, 8).join(', ') + (probs.length > 8 ? ` 외 ${probs.length - 8}건` : '')) : ok('D SEED 금액이 모두 숫자로 읽힘');
})();

let fail = 0;
for (const r of results) {
  if (r.skipped) console.log(`- ${r.name}: 건너뜀 (${r.why})`);
  else if (r.pass) console.log(`✓ ${r.name}`);
  else { fail++; console.log(`✗ ${r.name}: ${r.why}`); }
}
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
