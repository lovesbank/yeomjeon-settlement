// 결산서 전용 훅 공통 모듈 (외부 패키지 없음, Node 내장 기능만 사용)
// 주의: 이 파일에는 실제 장부 숫자·이름·계좌를 넣지 않는다. 필요한 값은 실행 때 index.html에서 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();
export const STATE_DIR = () => path.join(ROOT(), '.claude/state');
export const BACKUP_DIR = () => process.env.YJ_BACKUP_DIR || path.join(ROOT(), '.claude/backups');
export const INDEX = () => path.join(ROOT(), 'index.html');
export const KEEP_BACKUPS = 20;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}
export const parseJson = (raw) => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };

export function log(file, obj) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR(), file), JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
  } catch { /* 기록 실패는 무시 */ }
}

// ── 보호 구간 추출: 줄 번호가 아니라 표식 문자열로 찾는다 ──
export function regions(html) {
  const one = (needle) => {
    const a = html.indexOf(needle);
    return a >= 0 && html.indexOf(needle, a + 1) < 0 ? a : -1;
  };
  const iCalc = one('window.Calc = (function');
  const iEnd = one('/* ===== 기본 자료');
  const iSeed = one('window.SEED = ');
  if (iCalc < 0 || iEnd < 0 || iSeed < 0 || !(iCalc < iEnd && iEnd <= iSeed)) {
    return { ok: false, reason: '계산 엔진(window.Calc)·기본 자료(window.SEED) 표식을 찾지 못했거나 순서가 바뀌었습니다' };
  }
  let seedEnd = html.indexOf('\n', iSeed);
  if (seedEnd < 0) seedEnd = html.length;
  return { ok: true, calc: html.slice(iCalc, iEnd), seed: html.slice(iSeed, seedEnd) };
}

// 계산 엔진과 SEED를 격리된 vm 에서 실행해 꺼낸다 (DOM·파일·네트워크 접근 없음)
export function loadEngine(html) {
  const r = regions(html);
  if (!r.ok) throw new Error(r.reason);
  const ctx = { window: {} };
  vm.createContext(ctx);
  new vm.Script(r.calc, { filename: 'Calc' }).runInContext(ctx, { timeout: 5000 });
  new vm.Script(r.seed, { filename: 'SEED' }).runInContext(ctx, { timeout: 5000 });
  return { Calc: ctx.window.Calc, SEED: ctx.window.SEED };
}

// ── Edit / MultiEdit / Write 를 메모리에서 가상 적용 ──
export function applyEdit(content, tool, input) {
  if (tool === 'Write') return { ok: true, content: String(input.content ?? '') };
  const list = tool === 'MultiEdit' ? input.edits || [] : [input];
  let cur = content;
  for (const e of list) {
    const o = String(e.old_string ?? ''), n = String(e.new_string ?? '');
    if (!o || !cur.includes(o)) return { ok: false, reason: 'old_string 을 찾지 못함' };
    if (e.replace_all) cur = cur.split(o).join(n);
    else {
      if (cur.indexOf(o) !== cur.lastIndexOf(o)) return { ok: false, reason: 'old_string 이 여러 곳에 있음' };
      cur = cur.replace(o, () => n);
    }
  }
  return { ok: true, content: cur };
}

// ── 백업 + 무결성 검사. 성공해야만 {ok:true} ──
export function backupIndex() {
  try {
    const src = INDEX();
    if (!fs.existsSync(src)) return { ok: true, skipped: 'index.html 없음' };
    const data = fs.readFileSync(src);
    if (data.length === 0) return { ok: false, reason: 'index.html 이 비어 있어 백업 불가' };
    const hash = sha256(data);
    const dir = BACKUP_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(STATE_DIR(), 'backups.jsonl');
    fs.mkdirSync(STATE_DIR(), { recursive: true });

    // 같은 내용의 백업이 이미 있고 디스크 상 해시도 맞으면 재사용
    let last = null;
    try {
      const lines = fs.readFileSync(manifest, 'utf8').trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && !last; i--) {
        const m = JSON.parse(lines[i]);
        if (m.sha256 === hash && fs.existsSync(m.file) && sha256(fs.readFileSync(m.file)) === hash) last = m;
      }
    } catch { /* 장부 없으면 새로 만든다 */ }
    if (last) return { ok: true, reused: true, file: last.file, sha256: hash };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(dir, `index.html.${stamp}.${hash.slice(0, 12)}`);
    fs.writeFileSync(dst, data, { flag: 'wx' });
    const back = fs.readFileSync(dst);
    if (back.length !== data.length || sha256(back) !== hash) {
      try { fs.unlinkSync(dst); } catch { /* 무시 */ }
      return { ok: false, reason: '백업 파일의 해시·크기가 원본과 다름' };
    }
    fs.appendFileSync(manifest, JSON.stringify({ t: new Date().toISOString(), file: dst, sha256: hash, bytes: data.length }) + '\n');
    // 오래된 백업 정리 (이 폴더 안의 index.html.* 만)
    try {
      const olds = fs.readdirSync(dir).filter((f) => f.startsWith('index.html.')).sort();
      olds.slice(0, Math.max(0, olds.length - KEEP_BACKUPS)).forEach((f) => fs.unlinkSync(path.join(dir, f)));
    } catch { /* 정리 실패는 무시 */ }
    return { ok: true, file: dst, sha256: hash };
  } catch (e) {
    return { ok: false, reason: '백업 중 오류: ' + (e && e.message) };
  }
}

// ── 계산식 변경 허용 토큰 (사용자가 직접 발급, 시간·횟수 제한) ──
export const TOKEN = () => path.join(STATE_DIR(), 'allow-calc.json');
export function consumeToken() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN(), 'utf8'));
    if (!t || Date.now() > Date.parse(t.expires) || !(t.uses_left > 0)) return false;
    t.uses_left -= 1;
    fs.writeFileSync(TOKEN(), JSON.stringify(t));
    log('allow-log.jsonl', { used: true, uses_left: t.uses_left });
    return true;
  } catch { return false; }
}

// ── HTML·JS 정적 검사 ──
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const OPTIONAL_END = new Set(['p', 'li', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'option', 'dt', 'dd', 'colgroup', 'html', 'body', 'head']);

export function checkJs(html) {
  const problems = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    const typeM = /\btype\s*=\s*["']?([\w/+-]+)/i.exec(m[1]);
    if (/\bsrc\s*=/.test(m[1]) || (typeM && !/^(text|application)\/javascript$/i.test(typeM[1]))) continue;
    const startLine = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
    try { new vm.Script(m[2], { filename: `script${n}` }); }
    catch (e) {
      const mm = /script\d+:(\d+)/.exec(String(e.stack));
      problems.push(`JavaScript 문법 오류 (script ${n}, 약 ${mm ? startLine + Number(mm[1]) : '?'}번째 줄): ${e.message}`);
    }
  }
  if (n === 0) problems.push('검사할 <script> 가 하나도 없음');
  return problems;
}

export function scanHtml(html) {
  const issues = [], ids = new Map();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (s) => s.replace(/[^\n]/g, ' '));
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  const stack = [];
  let m;
  while ((m = re.exec(body))) {
    const line = body.slice(0, m.index).split('\n').length;
    const [, close, tagRaw, attrs] = m;
    const tag = tagRaw.toLowerCase();
    if (!close) {
      const im = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
      if (im) { const id = im[1] ?? im[2]; ids.set(id, (ids.get(id) || 0) + 1); }
      if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, line });
    } else if (!VOID.has(tag)) {
      let found = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { found = i; break; }
      if (found < 0) { issues.push({ key: `stray:${tag}`, msg: `짝 없는 닫는 태그 </${tag}> (${line}번째 줄)` }); continue; }
      for (let i = stack.length - 1; i > found; i--) if (!OPTIONAL_END.has(stack[i].tag)) issues.push({ key: `unclosed:${stack[i].tag}`, msg: `닫히지 않은 <${stack[i].tag}> (${stack[i].line}번째 줄)` });
      stack.length = found;
    }
  }
  stack.forEach((s) => { if (!OPTIONAL_END.has(s.tag)) issues.push({ key: `unclosed:${s.tag}`, msg: `닫히지 않은 <${s.tag}> (${s.line}번째 줄)` }); });
  for (const [id, c] of ids) if (c > 1) issues.push({ key: `dup:${id}`, msg: `중복 id="${id}" (${c}개)` });
  return { issues, ids: new Set(ids.keys()) };
}

// 작업본의 HTML 문제 중 기준본(HEAD)에 없던 새 문제 + 사라진 id
export function compareHtml(workHtml, baseHtml) {
  const w = scanHtml(workHtml), b = scanHtml(baseHtml);
  const baseKeys = new Map();
  b.issues.forEach((i) => baseKeys.set(i.key, (baseKeys.get(i.key) || 0) + 1));
  const out = [];
  w.issues.forEach((i) => {
    const left = baseKeys.get(i.key) || 0;
    if (left > 0) baseKeys.set(i.key, left - 1); else out.push(i.msg);
  });
  for (const id of b.ids) if (!w.ids.has(id)) out.push(`기존 id="${id}" 가 사라짐`);
  return out;
}

export function gitShowHead(file) {
  const r = spawnSync('git', ['show', `HEAD:${file}`], { cwd: ROOT(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
  return r.status === 0 ? r.stdout : null;
}

// ── 출력 도우미 ──
export function denyPre(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}
export function failBlock(lines) { process.stderr.write(lines.join('\n') + '\n'); process.exit(2); }

// 이 경로가 프로젝트의 index.html 인지
export function isIndex(p) {
  if (!p) return false;
  try { return path.resolve(ROOT(), p) === path.resolve(INDEX()); } catch { return false; }
}

// ── 후처리·종료 훅 공용: 정적 검사 + 계산 회귀 ──
export function staticChecks() {
  const problems = [];
  let html;
  try { html = fs.readFileSync(INDEX(), 'utf8'); } catch { return ['index.html 을 읽지 못함']; }
  problems.push(...checkJs(html));
  const head = gitShowHead('index.html');
  if (head) problems.push(...compareHtml(html, head).map((m) => 'HTML: ' + m));
  return problems;
}
export function runRegression() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tests/calc-regression.mjs');
  const r = spawnSync(process.execPath, [script], { cwd: ROOT(), env: process.env, encoding: 'utf8', timeout: 25000 });
  if (r.error || r.signal) return { infra: true, ok: false, fails: [], out: String(r.error || r.signal) };
  return { infra: false, ok: r.status === 0, fails: r.stdout.split('\n').filter((l) => l.startsWith('✗')), out: r.stdout };
}
export function warn(msg) { process.stdout.write(JSON.stringify({ systemMessage: msg })); }
