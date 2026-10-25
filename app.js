(() => {
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dstr(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return dstr(d); };
const weekStart = () => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return dstr(d); };
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmtClock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const fmtMin = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim();

/* ---------- storage ---------- */
const KEY = 'lockin.web.v1';
const DEF = () => ({
  config: { focus: 25, brk: 5, cycles: 4, mode: 'relaxed' },
  session: null, target: null,
  prog: { xp: 0, days: {}, exits: {}, streak: { last: null, count: 0 }, log: [], mins: {}, docMins: {} },
  sets: {}, srs: {}, quizlog: {}, weak: {},
  haptics: true, studyDoc: null,
});
let S;
try { S = Object.assign(DEF(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { S = DEF(); }
S.prog = Object.assign(DEF().prog, S.prog || {});
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast('Your browser storage is full.'); } };

// documents live in IndexedDB (they can be big)
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('lockin-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('docs', mode); const rq = fn(t.objectStore('docs')); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); }); };
  return { all: () => tx('readonly', s => s.getAll()), put: d => tx('readwrite', s => s.put(d)), del: id => tx('readwrite', s => s.delete(id)) };
})();
let DOCS = [];

/* ---------- feedback (toast, sound, haptics, confetti) ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }
const vib = p => { if (S.haptics && navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) try { navigator.vibrate(p); } catch { } };
let actx;
function beep(times = 2) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 660 + i * 220; o.connect(g); g.connect(actx.destination);
      const t = actx.currentTime + i * 0.28; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      o.start(t); o.stop(t + 0.26);
    }
  } catch { }
}
function notify(title, body) { try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body }); } catch { } }
function confetti() {
  const c = $('#confetti'), x = c.getContext('2d'); c.width = innerWidth; c.height = innerHeight;
  const cols = ['#6c4cf1', '#f5a623', '#1f9d63', '#ff5d8f', '#2db7f5'];
  const ps = Array.from({ length: 160 }, () => ({ x: Math.random() * c.width, y: -20 - Math.random() * c.height * .5, vx: (Math.random() - .5) * 4, vy: 2 + Math.random() * 5, s: 5 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - .5) * .3, c: cols[Math.floor(Math.random() * cols.length)] }));
  const end = performance.now() + 3500;
  (function f(now) {
    x.clearRect(0, 0, c.width, c.height);
    ps.forEach(p => { p.x += p.vx; p.y += p.vy; p.r += p.vr; x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; x.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .6); x.restore(); });
    if (now < end) requestAnimationFrame(f); else x.clearRect(0, 0, c.width, c.height);
  })(performance.now());
}
function celebrate() {
  confetti(); beep(3);
  const p = []; for (let i = 0; i < 12; i++) p.push(30, 70); p.push(260); vib(p);
}

/* ---------- supabase ---------- */
const CFG = window.LOCKIN_CONFIG || {};
const keyOk = CFG.SUPABASE_KEY && !/PASTE/.test(CFG.SUPABASE_KEY);
let sb = null;
try { if (window.supabase && keyOk) sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY); } catch { }
let user = null;
async function refreshUser() { if (!sb) return; try { const { data } = await sb.auth.getSession(); user = data.session ? data.session.user : null; } catch { user = null; } }
async function getToken() {
  if (!sb) throw new Error('nokey');
  let { data } = await sb.auth.getSession();
  if (!data.session) { const r = await sb.auth.signInAnonymously(); if (r.error) throw r.error; data = r.data; }
  return data.session.access_token;
}

/* ---------- progress rules ---------- */
const DAILY_CAP = 300, WEEKLY_EXITS = 2, STREAK_TARGET = 30, MIN_EXIT_MIN = 10;
const xpToday = () => S.prog.days[today()] || 0;
const exitsLeft = () => Math.max(0, WEEKLY_EXITS - (S.prog.exits[weekStart()] || 0));
function addXp(n) { const room = Math.max(0, DAILY_CAP - xpToday()); const got = Math.min(room, n); S.prog.days[today()] = xpToday() + got; S.prog.xp += got; return got; }

/* ---------- focus session ---------- */
function phases(c) { const a = []; for (let i = 0; i < c.cycles; i++) { a.push({ kind: 'focus', ms: c.focus * 60000 }); if (i < c.cycles - 1) a.push({ kind: 'break', ms: c.brk * 60000 }); } return a; }
const elapsed = s => (s.pausedAt || Date.now()) - s.startedAt - s.pausedMs;
function info(s) {
  const ph = phases(s.cfg), e = elapsed(s); let acc = 0, focusDone = 0;
  for (let i = 0; i < ph.length; i++) {
    if (e < acc + ph[i].ms) { if (ph[i].kind === 'focus') focusDone += e - acc; return { i, kind: ph[i].kind, left: acc + ph[i].ms - e, total: ph[i].ms, focusMs: focusDone, done: false, cycle: ph.slice(0, i + 1).filter(p => p.kind === 'focus').length, cycles: s.cfg.cycles }; }
    if (ph[i].kind === 'focus') focusDone += ph[i].ms; acc += ph[i].ms;
  }
  return { i: ph.length, kind: 'focus', left: 0, total: 1, focusMs: focusDone, done: true, cycle: s.cfg.cycles, cycles: s.cfg.cycles };
}
let lastPhase = -1, result = null;
function startSession() {
  const c = Object.assign({}, S.config);
  S.session = { cfg: c, mode: c.mode, startedAt: Date.now(), pausedMs: 0, pausedAt: null, leaves: 0, doc: S.target };
  lastPhase = 0; result = null; save();
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { }
  vib(40); render();
}
function endSession(complete) {
  const s = S.session; if (!s) return;
  const inf = info(s), mins = Math.floor((complete ? inf.focusMs : inf.focusMs) / 60000);
  let xp = 0, note = '';
  if (s.mode === 'deep') {
    if (complete) { xp = mins * 2 + 40; }
    else {
      S.prog.exits[weekStart()] = (S.prog.exits[weekStart()] || 0) + 1;
      S.prog.streak.count = 0;
      if (mins >= MIN_EXIT_MIN) xp = mins * 2; else note = `Under ${MIN_EXIT_MIN} focused minutes earns no XP.`;
    }
  } else if (complete) xp = Math.floor(mins / 2) + 10;
  else note = 'Ending a Relaxed session early earns no XP, but your focus time still counts.';
  let streakBonus = false;
  if (s.mode === 'deep' && complete) {
    const st = S.prog.streak, t = today();
    if (st.last !== t) { st.count = st.last === addDays(t, -1) ? st.count + 1 : 1; st.last = t; }
    if (st.count >= STREAK_TARGET) { S.prog.xp += 500; streakBonus = true; st.count = 0; }
  }
  const got = addXp(xp);
  S.prog.mins[today()] = (S.prog.mins[today()] || 0) + mins;
  if (s.doc) { S.prog.docMins[s.doc] = (S.prog.docMins[s.doc] || 0) + mins; }
  S.prog.log.unshift({ date: today(), mode: s.mode, mins, xp: got, complete }); S.prog.log = S.prog.log.slice(0, 30);
  result = { complete, mins, xp: got, capped: got < xp, note, streakBonus, leaves: s.leaves };
  S.session = null; save();
  if (complete) celebrate(); else vib(60);
  render();
}
function tick() {
  const s = S.session; if (!s) return;
  const inf = info(s);
  if (inf.done) { notify('Session complete 🎉', `You focused for ${fmtMin(Math.floor(inf.focusMs / 60000))}. Open LockIn to review your flashcards and quizzes.`); endSession(true); return; }
  if (lastPhase !== -1 && inf.i !== lastPhase) {
    beep(2); vib([60, 60, 60]);
    notify(inf.kind === 'break' ? 'Break time ☕' : 'Back to focus 🎯', inf.kind === 'break' ? 'Stretch, drink water.' : `Cycle ${inf.cycle} of ${inf.cycles}.`);
    lastPhase = inf.i; if (tab === 'focus') render(); return;
  }
  lastPhase = inf.i;
  const el = $('#clock'); if (el) {
    el.textContent = fmtClock(inf.left);
    const fg = $('#ringfg'); if (fg) fg.style.strokeDashoffset = String(565.5 * (inf.left / inf.total));
    document.title = `${fmtClock(inf.left)} · LockIn`;
  }
}
setInterval(tick, 500);
document.addEventListener('visibilitychange', () => { const s = S.session; if (document.hidden && s && s.mode === 'deep') { s.leaves++; save(); } if (!document.hidden) tick(); });
window.addEventListener('beforeunload', e => { if (S.session && S.session.mode === 'deep') { e.preventDefault(); e.returnValue = ''; } });

/* ---------- document import ---------- */
const MAXB = 50 * 1024 * 1024;
const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function sectionize(text, size = 2500) {
  const paras = text.replace(/\r/g, '').split(/\n{1,}/).map(p => p.trim()).filter(Boolean), out = []; let cur = '';
  for (const p of paras) { if (cur && (cur + '\n' + p).length > size) { out.push(cur); cur = ''; } cur = cur ? cur + '\n' + p : p; while (cur.length > size * 2) { out.push(cur.slice(0, size)); cur = cur.slice(size); } }
  if (cur) out.push(cur); return out;
}
async function readPdf(buf) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise, pages = [];
  for (let n = 1; n <= pdf.numPages; n++) { const p = await pdf.getPage(n), tc = await p.getTextContent(); pages.push(tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim()); }
  return pages;
}
async function readDocx(buf) {
  const z = await JSZip.loadAsync(buf), f = z.file('word/document.xml'); if (!f) throw new Error('bad');
  const xml = await f.async('string'), paras = [];
  for (const p of xml.split('</w:p>')) { const t = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => decodeXml(m[1])).join(''); if (t.trim()) paras.push(t.trim()); }
  return sectionize(paras.join('\n'));
}
async function readPptx(buf) {
  const z = await JSZip.loadAsync(buf);
  const names = Object.keys(z.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]));
  const pages = [];
  for (const n of names) { const xml = await z.file(n).async('string'); pages.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => decodeXml(m[1])).join(' ').trim()); }
  return pages;
}
async function importFile(file) {
  if (file.size > MAXB) return toast('That file is over 50 MB.');
  const name = file.name, ext = (name.split('.').pop() || '').toLowerCase();
  toast('Reading ' + name + '…');
  try {
    let pages, kind = ext;
    if (ext === 'pdf') pages = await readPdf(await file.arrayBuffer());
    else if (ext === 'docx') pages = await readDocx(await file.arrayBuffer());
    else if (ext === 'pptx') pages = await readPptx(await file.arrayBuffer());
    else if (ext === 'txt' || ext === 'md') pages = sectionize(await file.text());
    else return toast('Use a PDF, Word (.docx), PowerPoint (.pptx) or text file.');
    if (!pages.some(p => p.trim().length > 20)) return toast('No readable text found (scanned pages need text to work).');
    const doc = { id: uid(), title: name.replace(/\.[^.]+$/, ''), pages, kind, added: Date.now() };
    await idb.put(doc); DOCS.unshift(doc); toast('Added ' + doc.title); render();
  } catch (e) { console.error(e); toast('Could not read that file.'); }
}

/* ---------- study sets ---------- */
const getSet = id => S.sets[id];
function ensureSet(id) { return S.sets[id] || (S.sets[id] = { summary: '', cards: [], quiz: [] }); }
function cleanAi(j) {
  if (!j || typeof j !== 'object') throw new Error('bad');
  const cards = (Array.isArray(j.flashcards) ? j.flashcards : []).filter(c => c && typeof c.front === 'string' && typeof c.back === 'string' && c.front.trim() && c.back.trim()).map(c => ({ front: c.front.trim(), back: c.back.trim() }));
  const quiz = (Array.isArray(j.quiz) ? j.quiz : []).filter(q => q && typeof q.prompt === 'string' && Array.isArray(q.options) && q.options.length >= 2 && q.options.every(o => typeof o === 'string') && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < q.options.length).map(q => ({ prompt: q.prompt.trim(), options: q.options.map(o => o.trim()), correctIndex: q.correctIndex, explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '' }));
  if (!cards.length && !quiz.length) throw new Error('empty');
  return { summary: typeof j.summary === 'string' ? j.summary.trim() : '', cards, quiz };
}
function buildChunks(doc, from, to) {
  const texts = doc.pages.slice(from - 1, to).map(t => t.trim()).filter(Boolean), chunks = []; let cur = '', total = 0;
  for (const t of texts) {
    for (let i = 0; i < t.length; i += 7500) {
      const piece = t.slice(i, i + 7500);
      if (cur && cur.length + piece.length + 2 > 7800) { chunks.push(cur); cur = ''; }
      cur = cur ? cur + '\n\n' + piece : piece;
    }
  }
  if (cur) chunks.push(cur);
  const out = []; for (const c of chunks) { if (total + c.length > 99000 || out.length >= 60) break; out.push(c); total += c.length; }
  return out;
}
const AI_ERR = { 401: 'Please sign in again (Account tab).', 413: 'That is too much text at once. Choose fewer pages.', 429: 'You have used today\'s AI runs. Try again tomorrow.', 400: 'There is not enough readable text in those pages.' };
let generating = false, genErr = '';
async function generate(doc, from, to) {
  if (generating) return; genErr = ''; generating = true; render();
  try {
    if (!sb) throw Object.assign(new Error('nokey'), { friendly: 'The website is not connected to the server yet (see config.js).' });
    const chunks = buildChunks(doc, from, to);
    if (!chunks.length) throw Object.assign(new Error('short'), { friendly: AI_ERR[400] });
    const ctl = new AbortController(), to_ = setTimeout(() => ctl.abort(), 120000);
    let res; const call = async tok => fetch(CFG.SUPABASE_URL + '/functions/v1/generate-study', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, apikey: CFG.SUPABASE_KEY }, body: JSON.stringify({ title: doc.title, chunks, quizCount: 30, avoidQuiz: (S.sets[doc.id] ? S.sets[doc.id].quiz.map(q => q.prompt) : []).slice(-150), avoidCards: (S.sets[doc.id] ? S.sets[doc.id].cards.map(c => c.front) : []).slice(-150) }) });
    res = await call(await getToken());
    if (res.status === 401) { try { await sb.auth.refreshSession(); } catch { } res = await call(await getToken()); }
    clearTimeout(to_);
    let body = null; try { body = await res.json(); } catch { }
    if (!res.ok) { const code = body && body.error; throw Object.assign(new Error('http'), { friendly: code === 'busy' ? 'The AI is busy right now. Try again soon.' : AI_ERR[res.status] || 'The AI had trouble with that. Please try again.' }); }
    const r = cleanAi(body), set = ensureSet(doc.id), have = new Set(set.cards.map(c => hash(c.front.toLowerCase()))), haveQ = new Set(set.quiz.map(q => hash(q.prompt.toLowerCase())));
    r.cards.forEach(c => { if (!have.has(hash(c.front.toLowerCase()))) set.cards.push(c); });
    r.quiz.forEach(q => { if (!haveQ.has(hash(q.prompt.toLowerCase()))) set.quiz.push(q); });
    if (r.summary) set.summary = r.summary;
    save(); sub = 'cards'; toast('Study set ready ✨');
  } catch (e) {
    genErr = e.friendly || (e.name === 'AbortError' ? 'This is taking too long. Please try again.' : 'Could not reach the server. Check your connection and try again.');
  } finally { generating = false; render(); }
}

/* flashcards */
let deck = [], deckI = 0, flipped = false, deckAll = false;
function srsOf(docId) { return S.srs[docId] || (S.srs[docId] = {}); }
function buildDeck() {
  const set = getSet(studyDocId()); if (!set) { deck = []; return; }
  const srs = srsOf(studyDocId()), t = today();
  deck = set.cards.filter(c => deckAll || !srs[hash(c.front)] || srs[hash(c.front)].due <= t);
  deckI = 0; flipped = false;
}
function grade(known) {
  const c = deck[deckI]; if (!c) return; const srs = srsOf(studyDocId()), k = hash(c.front), cur = srs[k] || { interval: 0, ease: 2.2 };
  if (known) { const iv = cur.interval < 1 ? 1 : cur.interval < 3 ? 3 : Math.min(180, Math.round(cur.interval * cur.ease)); srs[k] = { interval: iv, ease: cur.ease, due: addDays(today(), iv) }; vib(15); }
  else { srs[k] = { interval: 0, ease: Math.max(1.3, cur.ease - .2), due: today() }; }
  save(); flipped = false;
  if (known || deckAll) { if (deckI < deck.length - 1) deckI++; else { deckI = deck.length; } } else { deck.push(deck.splice(deckI, 1)[0]); }
  render();
}
const nextInterval = c => { const cur = srsOf(studyDocId())[hash(c.front)] || { interval: 0, ease: 2.2 }; return cur.interval < 1 ? 1 : cur.interval < 3 ? 3 : Math.min(180, Math.round(cur.interval * cur.ease)); };

/* quiz */
let quiz = null;
function startQuiz(onlyWeak) {
  const id = studyDocId(), set = getSet(id); if (!set) return;
  const w = (S.weak[id] || {});
  let qs = set.quiz; if (onlyWeak) qs = qs.filter(q => w[hash(q.prompt)] > 0);
  if (!qs.length) return toast(onlyWeak ? 'No weak spots yet. Nice!' : 'No quiz questions yet.');
  quiz = { i: 0, done: false, qs: shuffle(qs).map(q => ({ q, order: shuffle(q.options.map((_, i) => i)), pick: null })) };
  render();
}
function pickAnswer(n) {
  const it = quiz.qs[quiz.i]; if (it.pick !== null) return; it.pick = n;
  const ok = it.order[n] === it.q.correctIndex; vib(ok ? 20 : [40, 40, 40]);
  render();
}
function finishQuiz() {
  const id = studyDocId(); quiz.done = true;
  const score = quiz.qs.filter(x => x.pick !== null && x.order[x.pick] === x.q.correctIndex).length;
  const w = S.weak[id] || (S.weak[id] = {});
  quiz.qs.forEach(x => { if (x.pick === null) return; const k = hash(x.q.prompt), ok = x.order[x.pick] === x.q.correctIndex; w[k] = ok ? Math.max(0, (w[k] || 0) - 1) : (w[k] || 0) + 1; });
  (S.quizlog[id] = S.quizlog[id] || []).push({ date: today(), score, total: quiz.qs.length }); S.quizlog[id] = S.quizlog[id].slice(-20);
  addXp(Math.round(score * 2)); save(); if (score === quiz.qs.length) celebrate(); render();
}

/* ---------- views ---------- */
let tab = 'focus', sub = 'cards', reviewing = false;
const studyDocId = () => (DOCS.find(d => d.id === S.studyDoc) || DOCS[0] || {}).id;
const stat = (icon, t) => `<div>${icon} ${t}</div>`;
function summaryCard() {
  return `<div class="card stats">${stat('⚡', `<b>${S.prog.xp} XP</b> · ${xpToday()} of ${DAILY_CAP} today`)}${stat('🛡️', `Emergency exits left this week: ${exitsLeft()} of ${WEEKLY_EXITS}`)}${stat('🔥', `Deep Focus streak: ${S.prog.streak.count} of ${STREAK_TARGET} days`)}</div>`;
}
function stepper(label, key, min, max, step, unit) {
  const v = S.config[key];
  return `<div class="step"><span>${label}</span><span class="row"><button data-act="step" data-k="${key}" data-d="-${step}" aria-label="Decrease ${label}">−</button><span class="val">${v} ${unit}</span><button data-act="step" data-k="${key}" data-d="${step}" aria-label="Increase ${label}">+</button></span></div>`;
}
function viewFocus() {
  const s = S.session;
  if (result) {
    const r = result;
    return `<div class="card center"><div style="font-size:64px">${r.complete ? '🎉' : '🏁'}</div><h2>${r.complete ? 'Session complete' : 'Session ended'}</h2>
    <p>${r.complete ? `Nice work. You focused for ${fmtMin(r.mins)}.` : `${fmtMin(r.mins)} of focus time was counted.`}</p>
    ${r.xp ? `<p><span class="pill">⚡ +${r.xp} XP</span></p>` : ''}${r.capped ? '<p class="mute">Daily XP cap reached.</p>' : ''}${r.streakBonus ? '<p><b>30 clean days! +500 XP bonus unlocked 🔥</b></p>' : ''}${r.note ? `<p class="mute">${esc(r.note)}</p>` : ''}${r.leaves ? `<p class="mute">You left this tab ${r.leaves} time${r.leaves > 1 ? 's' : ''} during the session.</p>` : ''}
    <p class="mute">Tap below to review your flashcards and quizzes.</p>
    <div class="row" style="justify-content:center"><button class="b" data-act="goStudy">Review now</button><button class="b alt" data-act="doneResult">Done</button></div></div>`;
  }
  if (s) {
    const inf = info(s), deep = s.mode === 'deep', paused = !!s.pausedAt, doc = DOCS.find(d => d.id === s.doc);
    return `<div class="card center"><span class="pill">${inf.kind === 'focus' ? '🎓 Focus time' : '☕ Break time'}</span><p class="mute">Cycle ${inf.cycle} of ${inf.cycles} · ${deep ? '🔥 Deep Focus' : '🌿 Relaxed'}${doc ? ' · ' + esc(doc.title) : ''}</p>
    <div class="ring"><svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="90" fill="none" stroke="var(--line)" stroke-width="12"/><circle id="ringfg" cx="100" cy="100" r="90" fill="none" stroke="var(--pri)" stroke-width="12" stroke-linecap="round" stroke-dasharray="565.5" stroke-dashoffset="${565.5 * (inf.left / inf.total)}"/></svg><div class="t" id="clock">${fmtClock(inf.left)}</div></div>
    ${paused ? '<p><b>Paused</b></p>' : ''}
    <div class="row" style="justify-content:center">${!deep ? `<button class="b alt" data-act="${paused ? 'resume' : 'pause'}">${paused ? '▶ Resume' : '⏸ Pause'}</button>` : ''}<button class="b alt" data-act="endEarly" ${deep && exitsLeft() === 0 ? 'disabled' : ''}>End session</button></div>
    ${deep && exitsLeft() === 0 ? '<p class="mute">No emergency exits left this week. Finish this session to stay on track. Exits come back on Sunday.</p>' : ''}
    ${deep ? '<p class="mute">Deep Focus has no pause. On the web there is no app lock, so keep this tab open and stay on task.</p>' : ''}</div>`;
  }
  const c = S.config, tot = c.cycles * c.focus + (c.cycles - 1) * c.brk, doc = DOCS.find(d => d.id === S.target);
  return `${doc ? `<div class="card row" style="background:color-mix(in srgb,var(--pri) 14%,var(--card))">📖 <b class="grow">Studying: ${esc(doc.title)}</b><button class="b alt" data-act="clearTarget" aria-label="Do not tie this session to a document">✕</button></div>` : ''}
  <h2>Plan your session</h2><p class="mute">${c.cycles} × ${c.focus} min focus with ${c.brk} min breaks. About ${fmtMin(tot)} in total.</p>
  <div class="card">${stepper('Focus', 'focus', 1, 180, 5, 'min')}${stepper('Break', 'brk', 1, 60, 1, 'min')}${stepper('Cycles', 'cycles', 1, 12, 1, 'cycles')}</div>
  <div class="modes"><button class="mode ${c.mode === 'relaxed' ? 'on' : ''}" data-act="mode" data-m="relaxed"><b>🌿 Relaxed</b><span class="mute">1 XP per 2 min, +10 for finishing. Pause allowed. Ending early earns no XP.</span></button>
  <button class="mode ${c.mode === 'deep' ? 'on' : ''}" data-act="mode" data-m="deep"><b>🔥 Deep Focus</b><span class="mute">2 XP per min, +40 for finishing. No pause: leaving early uses one of your 2 weekly exits.</span></button></div>
  ${summaryCard()}<button class="b" style="width:100%" data-act="start">▶ Start session</button>`;
}
function viewLibrary() {
  return `<h2>Library</h2><div class="card"><p class="mute">Import a PDF, Word (.docx), PowerPoint (.pptx) or text file. It stays in this browser.</p>
  <input type="file" id="file" accept=".pdf,.docx,.pptx,.txt,.md" multiple>
  <label for="paste">…or paste text</label><input id="ptitle" placeholder="Title (optional)"><textarea id="paste" placeholder="Paste your notes here" style="margin-top:8px"></textarea><button class="b" data-act="pasteAdd" style="margin-top:8px">Add notes</button></div>
  <div class="card">${DOCS.length ? DOCS.map(d => { const m = S.prog.docMins[d.id] || 0; return `<div class="doc"><div class="grow"><b>${esc(d.title)}</b><div class="mute">${d.pages.length} ${d.kind === 'pdf' ? 'pages' : d.kind === 'pptx' ? 'slides' : 'sections'} · ${d.kind.toUpperCase()}${m ? ' · ' + fmtMin(m) + ' studied' : ''}</div></div><button class="b alt" data-act="studyThis" data-id="${d.id}">Study this</button><button class="b" data-act="makeSet" data-id="${d.id}">${S.sets[d.id] ? 'Open' : 'Make set'}</button><button class="b alt" data-act="delDoc" data-id="${d.id}" aria-label="Delete ${esc(d.title)}">🗑</button></div>`; }).join('') : '<p class="mute">Nothing here yet. Add your first document above.</p>'}</div>`;
}
function viewStudy() {
  if (!DOCS.length) return `<div class="card center"><h2>Study</h2><p class="mute">Import a document in the Library first, then make flashcards and quizzes from it.</p><button class="b" data-act="tab" data-t="library">Go to Library</button></div>`;
  const id = studyDocId(), d = DOCS.find(x => x.id === id), set = getSet(id);
  const head = `<h2>Study</h2><select id="docsel" aria-label="Document">${DOCS.map(x => `<option value="${x.id}" ${x.id === id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>`;
  const range = `<div class="card"><h3>${set ? 'Make more with AI' : 'Make a study set with AI'}</h3><p class="mute">${d.pages.length} ${d.kind === 'pdf' ? 'pages' : d.kind === 'pptx' ? 'slides' : 'sections'}. Pick which part to use. You get 10 AI runs a day.</p>
  <div class="row"><div class="grow"><label for="from">From</label><input id="from" type="number" min="1" max="${d.pages.length}" value="1"></div><div class="grow"><label for="to">To</label><input id="to" type="number" min="1" max="${d.pages.length}" value="${Math.min(d.pages.length, 30)}"></div></div>
  ${genErr ? `<p class="err">${esc(genErr)}</p>` : ''}<button class="b" data-act="gen" ${generating ? 'disabled' : ''} style="margin-top:8px">${generating ? 'Thinking… (up to a minute)' : '✨ Generate'}</button></div>`;
  if (!set || (!set.manual && !set.cards.length && !set.quiz.length && !set.summary)) return head + range + manualBox(id);
  const tabs = [['cards', `Flashcards (${set.cards.length})`], ['quiz', `Quiz (${set.quiz.length})`], ['summary', 'Summary'], ['edit', 'Edit'], ['more', 'More']];
  let body = '';
  if (sub === 'summary') body = `<div class="card summary">${esc(set.summary) || '<span class="mute">No summary yet.</span>'}</div>`;
  else if (sub === 'cards') body = viewCards(set);
  else if (sub === 'quiz') body = viewQuiz(set, id);
  else if (sub === 'edit') body = viewEdit(set);
  else body = range + `<div class="card"><button class="b alt" data-act="printSet">🖨 Print / save as PDF</button> <button class="b bad" data-act="delSet">Delete this study set</button></div>`;
  return head + `<div class="seg" role="tablist">${tabs.map(t => `<button data-act="sub" data-s="${t[0]}" class="${sub === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}</div>` + body;
}
function viewCards(set) {
  if (!set.cards.length) return '<div class="card mute">No flashcards yet.</div>';
  const due = set.cards.filter(c => { const e = srsOf(studyDocId())[hash(c.front)]; return !e || e.due <= today(); }).length;
  const toggle = `<div class="row"><span class="mute grow">${due} due today · ${set.cards.length} total</span><button class="b alt" data-act="deckAll">${deckAll ? 'Show due only' : 'Show all cards'}</button></div>`;
  if (!deck.length || deckI >= deck.length) { const empty = deck.length === 0; return toggle + `<div class="card center"><div style="font-size:48px">${empty ? '✅' : '🎉'}</div><h3>${empty ? 'Nothing due today' : 'Deck finished'}</h3><p class="mute">${empty ? 'Come back later, or review every card.' : 'Cards you marked "I know this" will come back later.'}</p><button class="b" data-act="deckAll2">${empty ? 'Review all cards' : 'Go again'}</button></div>`; }
  const c = deck[deckI];
  return toggle + `<div class="bar"><i style="width:${Math.round(deckI / deck.length * 100)}%"></i></div><div class="mute center">Card ${deckI + 1} of ${deck.length}</div>
  <div class="fc"><div class="face ${flipped ? 'back' : ''}" data-act="flip" role="button" tabindex="0">${esc(flipped ? c.back : c.front)}</div></div>
  <div class="row" style="justify-content:center"><button class="b alt" data-act="cprev" ${deckI === 0 ? 'disabled' : ''}>‹</button>${flipped ? `<button class="b alt" data-act="again">Still learning<br><small>Ask me again today</small></button><button class="b ok" data-act="know">I know this<br><small>Back in ${nextInterval(c)} day${nextInterval(c) > 1 ? 's' : ''}</small></button>` : '<button class="b" data-act="flip">Show answer</button>'}<button class="b alt" data-act="cnext" ${deckI >= deck.length - 1 ? 'disabled' : ''}>›</button></div>`;
}
function viewQuiz(set, id) {
  const hist = (S.quizlog[id] || []).slice(-3).reverse(), weak = Object.values(S.weak[id] || {}).filter(v => v > 0).length;
  if (!quiz) return `<div class="card"><h3>Ready?</h3><p class="mute">${set.quiz.length} questions, shuffled each time.</p><div class="row"><button class="b" data-act="qstart">Start quiz</button>${weak ? `<button class="b alt" data-act="qweak">Practice ${weak} weak spot${weak > 1 ? 's' : ''}</button>` : ''}</div>${hist.length ? `<h3 style="margin-top:16px">Recent scores</h3>${hist.map(h => `<div class="mute">${h.date}: ${h.score}/${h.total}</div>`).join('')}` : ''}</div>`;
  if (quiz.done) {
    const sc = quiz.qs.filter(x => x.pick !== null && x.order[x.pick] === x.q.correctIndex).length;
    return `<div class="card center"><div style="font-size:48px">${sc === quiz.qs.length ? '🏆' : '📝'}</div><h2>${sc} / ${quiz.qs.length}</h2><div class="row" style="justify-content:center"><button class="b" data-act="qstart">Retake</button><button class="b alt" data-act="qreview">${reviewing ? 'Hide review' : 'Review answers'}</button><button class="b alt" data-act="qexit">Close</button></div></div>${reviewing ? quiz.qs.map((x, n) => { const ok = x.pick !== null && x.order[x.pick] === x.q.correctIndex; return `<div class="card"><b>${n + 1}. ${esc(x.q.prompt)}</b><div class="${ok ? '' : 'err'}">${x.pick === null ? 'Skipped' : 'You: ' + esc(x.q.options[x.order[x.pick]])}</div><div>✔ ${esc(x.q.options[x.q.correctIndex])}</div><div class="mute">${esc(x.q.explanation)}</div></div>`; }).join('') : ''}`;
  }
  const it = quiz.qs[quiz.i], answered = it.pick !== null;
  return `<div class="bar"><i style="width:${Math.round((quiz.i + 1) / quiz.qs.length * 100)}%"></i></div><div class="mute center">Question ${quiz.i + 1} of ${quiz.qs.length}</div>
  <div class="card"><b>${esc(it.q.prompt)}</b>${it.order.map((oi, n) => { let cl = ''; if (answered) { if (oi === it.q.correctIndex) cl = 'good'; else if (n === it.pick) cl = 'wrong'; } return `<button class="opt ${cl}" data-act="ans" data-n="${n}" ${answered ? 'aria-disabled="true"' : ''}>${esc(it.q.options[oi])}</button>`; }).join('')}${answered && it.q.explanation ? `<p class="mute">${esc(it.q.explanation)}</p>` : ''}</div>
  <div class="row" style="justify-content:center"><button class="b alt" data-act="qprev" ${quiz.i === 0 ? 'disabled' : ''}>‹ Previous</button>${quiz.i < quiz.qs.length - 1 ? '<button class="b" data-act="qnext">Next ›</button>' : '<button class="b ok" data-act="qfinish">Finish</button>'}</div>`;
}
function viewEdit(set) {
  return `<div class="card"><h3>Add a flashcard</h3><label for="nf">Front</label><input id="nf"><label for="nb">Back</label><input id="nb"><button class="b" data-act="addCard" style="margin-top:8px">Add card</button></div>
  <div class="card"><h3>Add a quiz question</h3><label for="nq">Question</label><input id="nq">${[0, 1, 2, 3].map(i => `<label for="no${i}">Option ${'ABCD'[i]}</label><input id="no${i}">`).join('')}<label for="nc">Correct answer</label><select id="nc"><option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option></select><label for="ne">Why (optional)</label><input id="ne"><button class="b" data-act="addQ" style="margin-top:8px">Add question</button></div>
  <div class="card"><h3>Your cards</h3>${set.cards.map((c, i) => `<div class="doc"><div class="grow">${esc(c.front)}<div class="mute">${esc(c.back)}</div></div><button class="b alt" data-act="delCard" data-i="${i}" aria-label="Delete card">🗑</button></div>`).join('') || '<p class="mute">None.</p>'}</div>
  <div class="card"><h3>Your questions</h3>${set.quiz.map((q, i) => `<div class="doc"><div class="grow">${esc(q.prompt)}</div><button class="b alt" data-act="delQ" data-i="${i}" aria-label="Delete question">🗑</button></div>`).join('') || '<p class="mute">None.</p>'}</div>`;
}
function manualBox(id) { return `<div class="card"><p class="mute">Prefer to write your own? <button class="b alt" data-act="startEmpty">Start an empty set</button></p></div>`; }
async function viewAccount() {
  await refreshUser();
  const signed = user && !user.is_anonymous;
  return `<h2>Account</h2><div class="card">${!sb ? '<p class="err">Not connected: add your publishable key in config.js.</p>' : signed ? `<p>Signed in as <b>${esc(user.email || 'your Google account')}</b>.</p><button class="b alt" data-act="signout">Sign out</button>` : `<p>${user ? 'Using a guest session.' : 'Not signed in.'} Sign in with the same Google account you use in the phone app.</p><button class="b" data-act="google">Sign in with Google</button>`}<p class="mute">AI study sets need no sign-in (guest sessions are created automatically) but your 10 daily runs are per account.</p></div>
  <div class="card"><h3>Notifications</h3><p class="mute">${!('Notification' in window) ? 'This browser does not support notifications.' : Notification.permission === 'granted' ? 'On. You will be told when a phase or session ends.' : Notification.permission === 'denied' ? 'Blocked. Click the lock icon next to the address, set Notifications to Allow, then reload.' : 'Off. Turn them on to hear about phase ends while you are in another tab.'}</p><div class="row"><button class="b" data-act="notifOn">Turn on / test</button></div></div>
  <div class="card"><label><input type="checkbox" id="hap" style="width:auto" ${S.haptics ? 'checked' : ''}> Vibrate on supported phones</label></div>
  <div class="card"><h3>Your data</h3><p class="mute">Documents and progress live in this browser only. Export a copy to keep or move them.</p><div class="row"><button class="b alt" data-act="export">Export backup</button><label class="b alt" style="margin:0;cursor:pointer">Import backup<input type="file" id="imp" accept=".json" hidden></label></div></div>
  <div class="card"><h3>Privacy</h3><p class="mute">Your documents are never uploaded except the text you choose when you press Generate, which is sent to the AI to make cards and is not stored.</p></div>`;
}

/* ---------- render + events ---------- */
const main = $('#main');
async function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const keep = { st: window.scrollY };
  let html = '';
  if (tab === 'focus') html = viewFocus(); else if (tab === 'library') html = viewLibrary(); else if (tab === 'study') { if (!deck.length && sub === 'cards' && !deckBuilt) { buildDeck(); deckBuilt = true; } html = viewStudy(); } else html = await viewAccount();
  main.innerHTML = html; if (tab !== 'focus') document.title = 'LockIn';
  if (tab === 'focus' && !S.session) document.title = 'LockIn';
  window.scrollTo(0, keep.st);
  bind();
}
let deckBuilt = false;
function bind() {
  const f = $('#file'); if (f) f.onchange = async () => { for (const x of f.files) await importFile(x); f.value = ''; };
  const ds = $('#docsel'); if (ds) ds.onchange = () => { S.studyDoc = ds.value; save(); quiz = null; deckBuilt = false; deck = []; render(); };
  const hp = $('#hap'); if (hp) hp.onchange = () => { S.haptics = hp.checked; save(); };
  const im = $('#imp'); if (im) im.onchange = async () => { try { const j = JSON.parse(await im.files[0].text()); if (!j || !j.store) throw 0; S = Object.assign(DEF(), j.store); for (const d of j.docs || []) { await idb.put(d); } DOCS = await idb.all(); save(); toast('Backup restored'); render(); } catch { toast('That is not a LockIn backup.'); } };
}
const A = {
  step: el => { const k = el.dataset.k, d = +el.dataset.d, lim = { focus: [1, 180], brk: [1, 60], cycles: [1, 12] }[k]; S.config[k] = Math.min(lim[1], Math.max(lim[0], S.config[k] + d)); save(); render(); },
  mode: el => { S.config.mode = el.dataset.m; save(); render(); },
  start: () => startSession(),
  pause: () => { const s = S.session; s.pausedAt = Date.now(); save(); render(); },
  resume: () => { const s = S.session; s.pausedMs += Date.now() - s.pausedAt; s.pausedAt = null; save(); render(); },
  endEarly: () => { const s = S.session, deep = s.mode === 'deep'; const msg = deep ? `This uses 1 of your emergency exits (${exitsLeft()} left this week) and loses the finishing bonus. XP for the minutes you focused is kept once you reach ${MIN_EXIT_MIN}.` : 'Ending early earns no XP, but your focus time still counts.'; if (confirm('End this session?\n\n' + msg)) endSession(false); },
  doneResult: () => { result = null; document.title = 'LockIn'; render(); },
  goStudy: () => { result = null; tab = 'study'; render(); },
  clearTarget: () => { S.target = null; save(); render(); },
  tab: el => { tab = el.dataset.t; render(); },
  studyThis: el => { S.target = el.dataset.id; save(); tab = 'focus'; toast('Next session is tied to this document'); render(); },
  makeSet: el => { S.studyDoc = el.dataset.id; save(); quiz = null; deckBuilt = false; deck = []; sub = S.sets[el.dataset.id] ? 'cards' : 'cards'; tab = 'study'; render(); },
  delDoc: async el => { const d = DOCS.find(x => x.id === el.dataset.id); if (!d || !confirm(`Delete "${d.title}" and its study set?`)) return; await idb.del(d.id); DOCS = DOCS.filter(x => x.id !== d.id); delete S.sets[d.id]; delete S.srs[d.id]; if (S.target === d.id) S.target = null; if (S.studyDoc === d.id) S.studyDoc = null; save(); deckBuilt = false; deck = []; render(); },
  pasteAdd: async () => { const t = $('#paste').value.trim(); if (t.length < 50) return toast('Paste a bit more text first.'); const doc = { id: uid(), title: $('#ptitle').value.trim() || 'My notes', pages: sectionize(t), kind: 'txt', added: Date.now() }; await idb.put(doc); DOCS.unshift(doc); toast('Added'); render(); },
  sub: el => { sub = el.dataset.s; if (sub === 'cards') { deckBuilt = false; deck = []; } reviewing = false; render(); },
  gen: () => { const d = DOCS.find(x => x.id === studyDocId()); let from = parseInt($('#from').value) || 1, to = parseInt($('#to').value) || d.pages.length; from = Math.max(1, Math.min(from, d.pages.length)); to = Math.max(from, Math.min(to, d.pages.length)); generate(d, from, to); },
  startEmpty: () => { ensureSet(studyDocId()).manual = true; save(); sub = 'edit'; render(); },
  flip: () => { flipped = !flipped; vib(8); render(); },
  know: () => grade(true), again: () => grade(false),
  cprev: () => { if (deckI > 0) { deckI--; flipped = false; render(); } }, cnext: () => { if (deckI < deck.length - 1) { deckI++; flipped = false; render(); } },
  deckAll: () => { deckAll = !deckAll; buildDeck(); render(); }, deckAll2: () => { deckAll = true; buildDeck(); render(); },
  qstart: () => { reviewing = false; startQuiz(false); }, qweak: () => { reviewing = false; startQuiz(true); },
  ans: el => pickAnswer(+el.dataset.n), qprev: () => { if (quiz.i > 0) { quiz.i--; render(); } }, qnext: () => { if (quiz.i < quiz.qs.length - 1) { quiz.i++; render(); } },
  qfinish: () => { const un = quiz.qs.filter(x => x.pick === null).length; if (un && !confirm(`${un} question${un > 1 ? 's are' : ' is'} unanswered. Finish anyway?`)) return; finishQuiz(); },
  qreview: () => { reviewing = !reviewing; render(); }, qexit: () => { quiz = null; reviewing = false; render(); },
  addCard: () => { const f = $('#nf').value.trim(), b = $('#nb').value.trim(); if (!f || !b) return toast('Fill in both sides.'); ensureSet(studyDocId()).cards.push({ front: f, back: b }); save(); toast('Card added'); render(); },
  addQ: () => { const p = $('#nq').value.trim(), o = [0, 1, 2, 3].map(i => $('#no' + i).value.trim()); if (!p || o.some(x => !x)) return toast('Fill in the question and all four options.'); ensureSet(studyDocId()).quiz.push({ prompt: p, options: o, correctIndex: +$('#nc').value, explanation: $('#ne').value.trim() }); save(); toast('Question added'); render(); },
  delCard: el => { getSet(studyDocId()).cards.splice(+el.dataset.i, 1); save(); render(); }, delQ: el => { getSet(studyDocId()).quiz.splice(+el.dataset.i, 1); save(); render(); },
  delSet: () => { if (confirm('Delete this study set?')) { const id = studyDocId(); delete S.sets[id]; delete S.srs[id]; save(); deck = []; deckBuilt = false; quiz = null; render(); } },
  printSet: () => printSet(),
  google: async () => { try { const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }); if (error) throw error; } catch { toast('Google sign-in is not set up for this site yet.'); } },
  signout: async () => { try { await sb.auth.signOut(); } catch { } user = null; render(); },
  notifOn: async () => { try { if (!('Notification' in window)) return toast('Not supported here.'); if (Notification.permission === 'default') await Notification.requestPermission(); if (Notification.permission === 'granted') { new Notification('LockIn', { body: 'Notifications work 🎉' }); beep(1); } } catch { } render(); },
  export: async () => { const blob = new Blob([JSON.stringify({ store: S, docs: DOCS })], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lockin-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); },
};
function printSet() {
  const id = studyDocId(), set = getSet(id), d = DOCS.find(x => x.id === id), w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to print.');
  w.document.write(`<!doctype html><title>${esc(d.title)} – study sheet</title><style>body{font:14px/1.5 system-ui;max-width:720px;margin:20px auto;padding:0 16px}h1,h2{margin:.6em 0 .3em}.q{margin:10px 0;page-break-inside:avoid}</style><h1>${esc(d.title)}</h1>${set.summary ? `<h2>Summary</h2><p>${esc(set.summary).replace(/\n/g, '<br>')}</p>` : ''}<h2>Flashcards</h2>${set.cards.map(c => `<div class="q"><b>${esc(c.front)}</b><br>${esc(c.back)}</div>`).join('')}<h2>Quiz</h2>${set.quiz.map((q, n) => `<div class="q"><b>${n + 1}. ${esc(q.prompt)}</b><br>${q.options.map((o, i) => `${'ABCDEF'[i]}. ${esc(o)}${i === q.correctIndex ? ' ✔' : ''}`).join('<br>')}<br><i>${esc(q.explanation)}</i></div>`).join('')}`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
}
document.addEventListener('click', e => {
  const t = e.target.closest('#tabs button'); if (t) { tab = t.dataset.tab; vib(8); if (tab === 'study') { deckBuilt = false; } render(); return; }
  const el = e.target.closest('[data-act]'); if (!el || !main.contains(el)) return;
  if (el.disabled) return;
  if (!['flip', 'ans'].includes(el.dataset.act)) vib(8);
  const fn = A[el.dataset.act]; if (fn) fn(el);
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.face[data-act]')) { e.preventDefault(); A.flip(); } });

/* ---------- boot ---------- */
(async () => {
  try { DOCS = (await idb.all()).sort((a, b) => b.added - a.added); } catch { DOCS = []; toast('Your browser blocks saved documents (private mode?).'); }
  if (sb) { try { sb.auth.onAuthStateChange((_e, sess) => { user = sess ? sess.user : null; if (tab === 'account') render(); }); } catch { } }
  if (S.session) { lastPhase = info(S.session).i; }
  render();
})();
})();
