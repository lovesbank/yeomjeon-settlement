// 손으로 계산한 가상 장부와 확정 기대값 (실제 장부와 무관한 만든 숫자)
// 기대값은 계산 엔진을 돌려서 얻은 것이 아니라, 아래 산수를 사람이 먼저 계산해 적은 것이다.
//
// ── 2090년 (이월 직접 입력 1,000,000, carryoverAuto=false) ──
//  1월 수입: SMP 100,000 + 200,000, REC 50,000                    = 350,000
//  1월 지출: 120,000                                              = 120,000
//  2월 수입: 없음                                                 = 0
//  2월 지출: 30,000 + "20,000원"(글자 섞인 금액)                  = 50,000
//  3월 수입: SMP "1,000,000"(쉼표 문자열) + 결산이자 5            = 1,000,005
//  3월 지출: 400,000 + "-"(0) + "abc"(읽을 수 없음→0)             = 400,000
//  7월 수입: SMP 250,000 + REC 10,000                             = 260,000
//  7월 지출: 60,000                                               = 60,000
//  상반기 수입 = 350,000 + 0 + 1,000,005                          = 1,350,005
//  하반기 수입 = 260,000                                          = 260,000
//  연 수입     = 1,350,005 + 260,000                              = 1,610,005
//  분기 지출   = 1분기 (120,000+50,000+400,000)=570,000, 2분기 0, 3분기 60,000, 4분기 0
//  연 지출     = 570,000 + 60,000                                 = 630,000
//  수입-지출   = 1,610,005 - 630,000                              = 980,005
//  연말 잔액   = 1,000,000 + 980,005                              = 1,980,005
//  월말 잔액:  0월 1,000,000 / 1월 1,230,000 / 2월 1,180,000 / 3월 1,780,005
//              4~6월 1,780,005 / 7월 1,780,005+260,000-60,000 = 1,980,005 / 8~12월 1,980,005
//
// ── 2091년 (이월 자동 = 2090년 잔액) ──
//  1월 수입 SMP 500,000, 1월 지출 700,000, 나머지 없음 → 연 수입 500,000, 연 지출 700,000
//  이월 1,980,005 → 1월말 1,980,005 + 500,000 - 700,000 = 1,780,005 → 연말 1,780,005 (이후 변동 없음)
//
// ── 2092~2094년 (createYear / ensureThroughYear 로 자동 생성, 모두 비어 있음) ──
//  2092 이월 = 2091 연말 잔액 = 1,780,005 → 비어 있으므로 연말 잔액도 1,780,005 (2093, 2094 도 같음)

const EXP_ROWS = [10, 11, 10];
const mk = (arr, labels) => arr.map((a, i) => ({ label: labels[i], amount: a, memo: '' }));
const SMP_LABELS = ['1차', '2차', '3차', '4차'];
const REC_LABELS = ['1차', '2차', '결산이자'];
const exp = (items) => items.map(([item, amount]) => ({ date: '', item, amount }));

function year(carryover, auto, rev, expense) {
  const revenue = {}, ex = {};
  for (let m = 1; m <= 12; m++) {
    const r = rev[m] || {};
    revenue[m] = { smp: mk(r.smp || [null, null, null, null], SMP_LABELS), rec: mk(r.rec || [null, null, null], REC_LABELS) };
    ex[m] = exp(expense[m] || []);
  }
  return { carryover, carryoverAuto: auto, notes: {}, revenue, expense: ex, bank: {},
           accounts: [{ name: '가상은행A', balance: null, account: '000-000' }, { name: '가상은행B', balance: null, account: '111-111' }], receipt: '' };
}

export function buildLedger() {
  return {
    version: 2,
    years: {
      2090: year('1,000,000', false,
        { 1: { smp: [100000, 200000, null, null], rec: [50000, null, null] },
          3: { smp: ['1,000,000', null, null, null], rec: [null, null, 5] },
          7: { smp: [250000, null, null, null], rec: [10000, null, null] } },
        { 1: [['항목A', 120000]], 2: [['항목A', 30000], ['항목B', '20,000원']], 3: [['항목A', 400000], ['항목B', '-'], ['항목C', 'abc']], 7: [['항목A', 60000]] }),
      2091: year(0, true, { 1: { smp: [500000, null, null, null] } }, { 1: [['항목A', 700000]] }),
    },
  };
}

export const EXPECT = {
  y2090: {
    monthIncome: { 1: 350000, 2: 0, 3: 1000005, 4: 0, 5: 0, 6: 0, 7: 260000, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 },
    monthExpense: { 1: 120000, 2: 50000, 3: 400000, 4: 0, 5: 0, 6: 0, 7: 60000, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 },
    revenueHalf: [1350005, 260000], revenueTotal: 1610005,
    expenseQuarter: [570000, 0, 60000, 0], expenseHalf: [570000, 60000],
    carryover: 1000000, totalIncome: 1610005, totalExpense: 630000, diff: 980005, balance: 1980005,
    balanceThrough: [1000000, 1230000, 1180000, 1780005, 1780005, 1780005, 1780005, 1980005, 1980005, 1980005, 1980005, 1980005, 1980005],
  },
  y2091: {
    carryover: 1980005, totalIncome: 500000, totalExpense: 700000, diff: -200000, balance: 1780005,
    balanceThrough: [1980005, 1780005, 1780005, 1780005, 1780005, 1780005, 1780005, 1780005, 1780005, 1780005, 1780005, 1780005, 1780005],
  },
  created2092: { carryover: 1780005, balance: 1780005, expenseRows: (m) => EXP_ROWS[(m - 1) % 3] },
  ensureThrough2094: { made: [2092, 2093, 2094], balance: 1780005 },
  accountsTotal: { accounts: [{ balance: '1,000' }, { balance: 2500 }, { balance: null }], total: 3500 },
  parseWon: [['1,234', 1234], ['₩ 1,234', 1234], ['12,345원', 12345], [12.6, 13], [0, 0], ['0', 0], ['', null], ['-', null], ['abc', null], [null, null], [undefined, null], [NaN, null], [Infinity, null]],
  formatWon: [[1234567, '1,234,567'], [-1000, '-1,000'], [0, '0'], [null, ''], ['12,345원', '12,345'], [999, '999'], [1000, '1,000']],
  sumRows: { rows: [{ amount: 100 }, { amount: null }, { amount: '2,000' }, null], total: 2100 },
};
