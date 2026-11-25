// @ts-nocheck
// SaKu: Edge Function "api" untuk Supabase. DIBUAT OTOMATIS dari netlify/lib/core.mjs + sb/handler.mjs; jangan diubah manual.
// Deploy tanpa verifikasi JWT:  supabase functions deploy api --no-verify-jwt
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
if (!globalThis.Buffer) globalThis.Buffer = Buffer;

// SaKu: inti backend untuk Netlify Functions + Netlify Blobs.
// Semua logika ada di sini supaya bisa diuji tanpa Netlify (lihat netlify/test).

const DEFAULT_PW = 'catatuang123';
const DAY = 86400000;
const DEFAULT_SESSION_MIN = 20;
const SESSION_GRACE = 60000;
const TOKEN_TTL = 30 * DAY;
const MAX_TX = 3000;
const MAX_ACCOUNTS = 200;
const MAX_PENDING = 30;
const MAX_BODY = 2_000_000;
const MAX_OPS = 600;
const MAX_PHOTO = 450_000;
const MIN_PW = 5;
const BACKUP_DEFAULT_SEC = 30;
const ID_RE = /^[a-z0-9]{8,32}$/;

class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || ''; }
}
const bad = (m, code) => new ApiError(400, m, code || 'invalid');

/* ---------- util ---------- */
function slug(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
/* ===== Indeks saham: hanya IHSG (hanya dibaca; dipakai menu Kurs & Indeks) =====
   Sumber utama Yahoo Finance (grafik harian), cadangan Stooq. Hasil disimpan sebentar di memori fungsi agar tidak membebani sumber data. */
const MKT_INDICES = [
  { id: 'ihsg', y: '^JKSE', st: '^jci', name: 'IHSG', full: 'Indeks Harga Saham Gabungan', cc: 'ID', ccy: 'IDR', min: 100, max: 1e6 }
];
const MKT_TTL = 5 * 60000, MKT_KEEP = 70;
const num = x => (typeof x === 'number' && isFinite(x) ? x : null);
function mktShape(ix, closes, dates, src) {
  const pts = closes.map((c, i) => ({ c, d: dates[i] })).filter(p => num(p.c) !== null && p.c > (ix.min || 0) && p.c < (ix.max || Infinity));     // nilai di luar rentang wajar pasti keliru
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1], prev = pts[pts.length - 2], series = pts.slice(-MKT_KEEP).map(p => Math.round(p.c * 100) / 100);
  return { id: ix.id, name: ix.name, full: ix.full, cc: ix.cc, ccy: ix.ccy, price: Math.round(last.c * 100) / 100, prev: Math.round(prev.c * 100) / 100,
    chg: Math.round((last.c - prev.c) * 100) / 100, pct: Math.round((last.c / prev.c - 1) * 10000) / 100, asof: last.d || null, series, src };
}
/* Yahoo v8 chart -> { closes, dates }; harga terkini (regularMarketPrice) menggantikan penutupan terakhir bila sesi masih berjalan */
function mktParseYahoo(ix, j) {
  const r = j && j.chart && Array.isArray(j.chart.result) ? j.chart.result[0] : null; if (!r) return null;
  const ts = Array.isArray(r.timestamp) ? r.timestamp : [], q = r.indicators && r.indicators.quote && r.indicators.quote[0], cl = q && Array.isArray(q.close) ? q.close : [];
  const closes = [], dates = [];
  for (let i = 0; i < cl.length; i++) if (num(cl[i]) !== null) { closes.push(cl[i]); dates.push(ts[i] ? new Date(ts[i] * 1000).toISOString().slice(0, 10) : null); }
  const live = r.meta && num(r.meta.regularMarketPrice), lt = r.meta && r.meta.regularMarketTime;
  if (live !== null && live > 0 && closes.length) {
    const ld = lt ? new Date(lt * 1000).toISOString().slice(0, 10) : null;
    if (ld && dates[dates.length - 1] === ld) closes[closes.length - 1] = live; else { closes.push(live); dates.push(ld); }
  }
  return mktShape(ix, closes, dates, 'yahoo');
}
/* Stooq CSV harian: Date,Open,High,Low,Close,Volume */
function mktParseStooq(ix, text) {
  const rows = String(text || '').trim().split(/\r?\n/).slice(1).map(l => l.split(',')).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a[0]) && a.length >= 5);
  const closes = rows.map(a => Number(a[4])), dates = rows.map(a => a[0]);
  return mktShape(ix, closes, dates, 'stooq');
}
async function mktGet(fetchFn, url, ms) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null, to = ctl ? setTimeout(() => ctl.abort(), ms || 7000) : null;
  try {
    const res = await fetchFn(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; SaKu/1.0)', accept: 'application/json,text/csv,*/*' }, signal: ctl ? ctl.signal : undefined });
    if (!res || !res.ok) return null;
    return res;
  } catch (e) { return null; } finally { if (to) clearTimeout(to); }
}
async function mktOne(ix, fetchFn) {
  const y = await mktGet(fetchFn, 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ix.y) + '?range=3mo&interval=1d');
  if (y) { try { const o = mktParseYahoo(ix, await y.json()); if (o) return o; } catch (e) { /* coba cadangan */ } }
  const st = await mktGet(fetchFn, 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(ix.st) + '&i=d');
  if (st) { try { const o = mktParseStooq(ix, await st.text()); if (o) return o; } catch (e) { /* gagal */ } }
  return null;
}
async function mktFetchIndices(fetchFn, st, now) {
  now = now || Date.now();
  if (st.v && now - st.t < MKT_TTL) return st.v;
  if (typeof fetchFn !== 'function') return null;
  const got = await Promise.all(MKT_INDICES.map(ix => mktOne(ix, fetchFn).catch(() => null)));
  const items = got.filter(Boolean);
  if (!items.length) return st.v ? Object.assign({}, st.v, { stale: true }) : null;
  const v = { ok: true, at: new Date(now).toISOString(), items, missing: MKT_INDICES.filter(ix => !got.some(g => g && g.id === ix.id)).map(ix => ix.id) };
  st.t = now; st.v = v; return v;
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const isYmd = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const pubList = (x, me) => { const o = pub(x); if (x.id !== me && o.photo) { delete o.photo; o.hasPhoto = true; } return o; };
/* Field rahasia tidak boleh sampai ke klien: hash kata sandi, token reset (reset), dan identitas Google yang tertaut (gsub) */
const pub = a => { const o = Object.assign({}, a); delete o.hash; delete o.reset; delete o.gsub; o.isDefault = !a.hash; return o; };
/* Galat status akun (menunggu, ditolak, nonaktif); dipakai bersama oleh login dan masuk lewat Google supaya pesannya persis sama */
const statusBlock = a => {
  if (a.status === 'pending') return new ApiError(403, 'Pendaftaran Anda masih menunggu persetujuan admin. Coba lagi nanti.', 'pending');
  if (a.status === 'rejected') return new ApiError(403, 'Pendaftaran Anda ditolak admin. Hubungi administrator.', 'rejected');
  if (a.active === false) return new ApiError(403, 'Akun ini dinonaktifkan. Hubungi administrator.', 'disabled');
  return null;
};
const cleanMin = v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : DEFAULT_SESSION_MIN; };
const cleanBackup = c => { const n = Number(c && c.backupSeconds); return { on: !(c && c.backupOn === false), seconds: Number.isInteger(n) && n >= 5 && n <= 600 ? n : BACKUP_DEFAULT_SEC }; };
const marker = a => (a.hash ? sha(a.hash).slice(0, 16) : 'd');

const scryptP = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt1$' + salt.toString('base64url') + '$' + (await scryptP(pw, salt)).toString('base64url');
}
async function verifyHash(pw, stored) {
  try {
    const [tag, s, h] = String(stored).split('$');
    if (tag !== 'scrypt1') return false;
    const k = await scryptP(pw, Buffer.from(s, 'base64url')), want = Buffer.from(h, 'base64url');
    return want.length === k.length && crypto.timingSafeEqual(k, want);
  } catch (e) { return false; }
}
let DUMMY = null;

/* ---------- inti ---------- */
function createApi(deps) {
  const { meta, ledger, env = () => undefined, now = () => Date.now(), fetchFn = (...a) => globalThis.fetch(...a), forgotFloorMs = 700 } = deps;
  const iso = () => new Date(now()).toISOString();
  let secretCache = null, cfgCache = null;
  async function readCfg() {
    if (cfgCache && now() - cfgCache.t < 20000) return cfgCache;
    const c = await meta.get('config', { type: 'json' });
    cfgCache = { v: cleanMin(c && c.sessionMinutes), backup: cleanBackup(c), t: now() };
    return cfgCache;
  }
  const sessMin = async () => (await readCfg()).v;
  const backupCfg = async () => (await readCfg()).backup;

  /* Pembaruan atomik dengan etag (compare-and-swap). fn(data) -> { value, result }; value undefined = tanpa tulis */
  async function readDoc(store, key) {
    const r = await store.getWithMetadata(key, { type: 'json' });
    return r ? { data: r.data, etag: r.etag || null } : { data: null, etag: null };
  }
  async function casUpdate(store, key, fn) {
    for (let i = 0; i < 10; i++) {
      const { data, etag } = await readDoc(store, key);
      const out = await fn(data);
      if (out.value === undefined) return out.result;
      const res = await store.setJSON(key, out.value, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
      if (!res || res.modified !== false) return out.result;
      await sleep(10 + Math.random() * 30 * (i + 1));
    }
    throw new ApiError(503, 'Server sedang sibuk. Coba lagi sebentar lagi.', 'busy');
  }
  const readAccounts = async () => (await readDoc(meta, 'accounts')).data || {};
  const updateAccounts = fn => casUpdate(meta, 'accounts', d => fn(d || {}));

  async function secret() {
    if (secretCache) return secretCache;
    const e = env('SESSION_SECRET');
    if (e && String(e).length >= 16) return (secretCache = String(e));
    let s = await meta.get('secret', { type: 'json' });
    if (!s || !s.k) {
      const k = crypto.randomBytes(32).toString('hex');
      await meta.setJSON('secret', { k }, { onlyIfNew: true });
      s = await meta.get('secret', { type: 'json' });
    }
    return (secretCache = s.k);
  }
  async function makeToken(acc) {
    const p = Buffer.from(JSON.stringify({ u: acc.id, e: now() + TOKEN_TTL, m: marker(acc), a: now() })).toString('base64url');
    return p + '.' + crypto.createHmac('sha256', await secret()).update(p).digest('base64url');
  }
  async function readToken(tok) {
    if (typeof tok !== 'string' || tok.length > 600) return null;
    const i = tok.indexOf('.'); if (i < 1) return null;
    const p = tok.slice(0, i), mac = Buffer.from(tok.slice(i + 1)), want = Buffer.from(crypto.createHmac('sha256', await secret()).update(p).digest('base64url'));
    if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
    try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o && o.e > now() ? o : null; } catch (e) { return null; }
  }
  async function session(acc) { return { token: await makeToken(acc), account: pub(acc), sessionMinutes: await sessMin(), backup: await backupCfg() }; }
  /* Ubah sebagian isi akun (statistik aktivitas, cadangan terakhir). Gagal menulis tidak boleh menggagalkan permintaan utama. */
  const touchAcct = (id, patch) => updateAccounts(map => (map[id] ? { value: Object.assign({}, map, { [id]: Object.assign({}, map[id], patch) }), result: true } : { value: undefined, result: false }));

  async function authed(req) {
    const h = req.headers.get('authorization') || '', m = /^Bearer (.+)$/.exec(h);
    const t = m ? await readToken(m[1]) : null;
    if (!t) throw new ApiError(401, 'Sesi berakhir. Silakan masuk lagi.', 'session');
    const map = await readAccounts(), acc = map[t.u];
    if (!acc) throw new ApiError(401, 'Akun Anda dinonaktifkan atau dihapus oleh administrator.', 'disabled');
    if (acc.active === false || acc.status === 'pending' || acc.status === 'rejected') throw new ApiError(401, 'Akun Anda dinonaktifkan atau dihapus oleh administrator.', 'disabled');
    if (t.m !== marker(acc)) throw new ApiError(401, 'Kata sandi akun ini berubah. Silakan masuk lagi.', 'session');
    const mins = await sessMin();
    if (now() - (t.a || 0) > mins * 60000 + SESSION_GRACE) throw new ApiError(401, 'Sesi berakhir karena tidak ada aktivitas selama ' + mins + ' menit. Silakan masuk lagi.', 'expired');
    return { acc, map, mins };
  }
  const needAdmin = a => { if (a.acc.role !== 'admin') throw new ApiError(403, 'Hanya administrator yang boleh melakukan ini.', 'forbidden'); };
  /* Admin pembantu ('helper'): tetap pengguna biasa dengan catatan sendiri, ditambah menu Admin untuk pekerjaan rutin
     (menyetujui/menolak pendaftar, membuat akun pengguna, mengaktifkan/menonaktifkan pengguna). Tidak boleh mereset sandi,
     menghapus akun, mengubah peran, memegang brankas cadangan, atau mengubah pengaturan; dan hanya menyentuh akun pengguna biasa. */
  const isStaff = a => a.acc.role === 'admin' || a.acc.role === 'helper';
  const needStaff = a => { if (!isStaff(a)) throw new ApiError(403, 'Hanya administrator atau admin pembantu yang boleh melakukan ini.', 'forbidden'); };

  /* ---------- pembatas percobaan ---------- */
  async function rlCheck(key) {
    const r = await meta.get('rl/' + key, { type: 'json' });
    if (r && r.until > now()) throw new ApiError(429, 'Terlalu banyak percobaan. Coba lagi dalam ' + Math.max(1, Math.ceil((r.until - now()) / 60000)) + ' menit.', 'locked');
    return r;
  }
  async function rlFail(key, prev, max, windowMs, lockMs) {
    const t = now(), fresh = prev && t - prev.t < windowMs, n = (fresh ? prev.n : 0) + 1;
    await meta.setJSON('rl/' + key, { n, t: fresh ? prev.t : t, until: n >= max ? t + lockMs : 0 });
  }
  const rlClear = key => meta.delete('rl/' + key).catch(() => {});

  /* ---------- validasi ---------- */
  function cleanReg(b) {
    const v = { first: clean(b.first), last: clean(b.last), username: String(b.username || '').trim().toLowerCase(), birth: String(b.birth || '').trim(), phone: String(b.phone || '').replace(/[\s().-]/g, ''), email: String(b.email || '').trim() };
    if (!/\p{L}/u.test(v.first) || v.first.length > 30) throw bad('Isi nama depan Anda.');
    if (!/\p{L}/u.test(v.last) || v.last.length > 30) throw bad('Isi nama belakang Anda.');
    if (!/^[a-z][a-z0-9]{3,19}$/.test(v.username)) throw bad('Username 4–20 karakter: huruf kecil dan angka saja, diawali huruf. Contoh: sifulan12.');
    if (v.birth && (!isYmd(v.birth) || v.birth < '1900-01-01' || v.birth > new Date(now() + DAY).toISOString().slice(0, 10))) throw bad('Pilih tanggal lahir yang valid.');
    if (!/^\+?\d{8,15}$/.test(v.phone)) throw bad('Nomor HP tidak valid. Isi 8–15 angka, contoh 081234567890.');
    if (v.email.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) throw bad('Email tidak valid. Contoh: sifulan12@email.com.');
    return v;
  }
  function cleanNewPw(raw) {
    const pw = String(raw == null ? '' : raw);
    if (pw.length < MIN_PW || pw.length > 100) throw bad('Kata sandi minimal ' + MIN_PW + ' karakter.');
    if (pw === DEFAULT_PW) throw bad('Pilih kata sandi yang berbeda dari kata sandi awal.');
    return pw;
  }
  function cleanTx(d) {
    if (!d || typeof d !== 'object') throw bad('Data transaksi tidak valid.');
    const amount = Math.round(Number(d.amount));
    if (d.type !== 'in' && d.type !== 'out') throw bad('Jenis transaksi tidak valid.');
    if (!(amount >= 1 && amount <= 1e12)) throw bad('Jumlah uang tidak valid.');
    if (!/^[a-z0-9_-]{1,30}$/.test(String(d.cat))) throw bad('Kategori tidak valid.');
    if (!isYmd(String(d.date))) throw bad('Tanggal tidak valid.');
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, 40).map(i => ({
      n: String((i && i.n) || '').slice(0, 60), q: Math.min(999, Math.max(1, Math.round(Number(i && i.q)) || 1)), p: Math.min(1e9, Math.max(0, Math.round(Number(i && i.p)) || 0))
    }));
    if (d.photo != null && !ID_RE.test(String(d.photo))) throw bad('Foto tidak valid.');
    const t = { type: d.type, amount, cat: String(d.cat), date: String(d.date), note: String(d.note || '').slice(0, 80), items, photo: d.photo || null, createdAt: String(d.createdAt || iso()).slice(0, 40), updatedAt: String(d.updatedAt || iso()).slice(0, 40) };
    if (d.demo === true) t.demo = true;
    /* rekening pembayaran (acc) dan rekening tujuan pada pindah saldo / topup e-wallet (to) */
    ['acc', 'to'].forEach(k => { if (d[k] != null && d[k] !== '') { if (!ID_RE.test(String(d[k]))) throw bad('Rekening tidak valid.'); t[k] = String(d[k]); } });
    const rf = d.ref;
    if (rf && typeof rf === 'object' && PLAN_COLS.indexOf(rf.k) >= 0 && ID_RE.test(String(rf.id))) { t.ref = { k: rf.k, id: String(rf.id) }; if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(rf.p || ''))) t.ref.p = String(rf.p); }
    return t;
  }
  function cleanSettings(d) {
    const o = {}; if (!d || typeof d !== 'object') return o;
    if (d.budget != null) o.budget = Math.min(1e12, Math.max(0, Math.round(Number(d.budget)) || 0));
    if (typeof d.reminder === 'boolean') o.reminder = d.reminder;
    if (typeof d.currency === 'string' && /^(IDR|USD|CNY|MYR|JPY|KRW)$/.test(d.currency)) o.currency = d.currency;
    if (d.budgetDay != null) { const n = Math.round(Number(d.budgetDay)); if (n >= 2 && n <= 31) o.budgetDay = n; }
    if (d.budgetAdds && typeof d.budgetAdds === 'object') {
      const a = {};
      Object.keys(d.budgetAdds).filter(k => /^\d{4}-(0[1-9]|1[0-2])$/.test(k)).sort().slice(-36).forEach(k => { const v = Math.min(1e12, Math.max(0, Math.round(Number(d.budgetAdds[k])) || 0)); if (v) a[k] = v; });
      if (Object.keys(a).length) o.budgetAdds = a;
    }
    if (d.catBudgets && typeof d.catBudgets === 'object' && !Array.isArray(d.catBudgets)) {
      const c = {};
      Object.keys(d.catBudgets).filter(k => /^[a-z0-9_-]{1,30}$/.test(k)).slice(0, 60).forEach(k => { const v = Math.min(1e12, Math.max(0, Math.round(Number(d.catBudgets[k])) || 0)); if (v) c[k] = v; });
      if (Object.keys(c).length) o.catBudgets = c;
    }
    /* rekening bank / e-wallet pengguna, rekening bawaan pembayaran, dan kategori buatan sendiri */
    if (Array.isArray(d.accts)) {
      const seen = {}, list = [];
      d.accts.slice(0, 40).forEach(x => {
        if (!x || typeof x !== 'object' || !ID_RE.test(String(x.id)) || seen[x.id]) return; seen[x.id] = 1;
        const brand = String(x.brand || '').replace(/[^a-z0-9]/g, '').slice(0, 20);
        list.push({ id: String(x.id), kind: x.kind === 'ewallet' ? 'ewallet' : x.kind === 'cash' ? 'cash' : 'bank', brand, name: String(x.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || brand, open: Math.max(-1e12, Math.min(1e12, Math.round(Number(x.open)) || 0)) });
      });
      if (list.length) o.accts = list;
    }
    if (typeof d.payDefault === 'string' && ID_RE.test(d.payDefault)) o.payDefault = d.payDefault;
    if (Array.isArray(d.customCats)) {
      const seen = {}, list = [];
      d.customCats.slice(0, 80).forEach(x => {
        if (!x || typeof x !== 'object' || !/^u[a-z0-9]{6,20}$/.test(String(x.id)) || seen[x.id]) return; seen[x.id] = 1;
        const label = String(x.label || '').replace(/\s+/g, ' ').trim().slice(0, 40); if (!label) return;
        list.push({ id: String(x.id), type: x.type === 'in' ? 'in' : 'out', label, group: String(x.group || '').replace(/[^a-z0-9_]/g, '').slice(0, 30), icon: String(x.icon || 'more').replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'more' });
      });
      if (list.length) o.customCats = list;
    }
    return o;
  }
  /*PLANCLEAN:BEGIN*/
  const PLAN_COLS = ['cicilan', 'hutang', 'target', 'ramean', 'trip', 'wish'];
  const PLAN_MAX = { cicilan: 60, hutang: 300, target: 60, ramean: 120, trip: 40, wish: 120 };
  const PLAN_BYTES = 250000;
  const CICILAN_KIND_IDS = ['kpr', 'mobil', 'hp', 'multi'];
  const TARGET_KIND_IDS = ['darurat', 'tabungan', 'investasi', 'haji', 'nikah', 'rumah', 'kendaraan', 'liburan', 'pendidikan', 'lain'];
  /* Merapikan satu data rencana (cicilan, hutang, target, ramean, perjalanan, wishlist). Hasil { ok: data } atau { err: pesan }. */
  function planClean(c, d, stamp) {
    const fail = m => ({ err: m });
    if (!d || typeof d !== 'object' || Array.isArray(d)) return fail('Data tidak valid.');
    const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
    const int = (v, lo, hi) => { const n = Math.round(Number(v)); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
    const isDay = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const t = new Date(s + 'T00:00:00Z'); return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s; };
    const isMon = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
    const monN = s => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
    const base = { createdAt: str(d.createdAt || stamp, 40), updatedAt: str(d.updatedAt || stamp, 40) };
    if (c === 'cicilan') {
      const name = str(d.name, 60), kind = CICILAN_KIND_IDS.indexOf(d.kind) >= 0 ? d.kind : '', mode = d.mode === 'float' || d.mode === 'flat' ? d.mode : '';
      if (!name) return fail('Isi nama cicilan.');
      if (!kind) return fail('Pilih jenis cicilan.');
      if (!mode) return fail('Pilih konsep cicilan.');
      const amount = int(d.amount, 0, 1e12); if (amount < 1) return fail('Isi nominal cicilan.');
      const start = str(d.start, 7), end = str(d.end, 7);
      if (!isMon(start) || !isMon(end)) return fail('Isi bulan mulai dan bulan selesai.');
      const n = monN(end) - monN(start) + 1; if (n < 1 || n > 600) return fail('Periode cicilan tidak valid (1 sampai 600 bulan).');
      return { ok: Object.assign({ name, kind, mode, lender: str(d.lender, 60), amount, start, end, day: int(d.day, 1, 31), done0: int(d.done0, 0, n), note: str(d.note, 120), remind: d.remind !== false }, base) };
    }
    if (c === 'hutang') {
      const dir = d.dir === 'piutang' || d.dir === 'hutang' ? d.dir : '', who = str(d.who, 60);
      if (!dir) return fail('Pilih jenis hutang.');
      if (!who) return fail('Isi nama orangnya.');
      const amount = int(d.amount, 0, 1e12); if (amount < 1) return fail('Isi nominal hutang.');
      const date = str(d.date, 10), first = str(d.first, 10);
      if (!isDay(date)) return fail('Tanggal pinjam tidak valid.');
      if (!isDay(first)) return fail('Tanggal jatuh tempo tidak valid.');
      const freq = d.freq === 'monthend' || d.freq === 'day' ? d.freq : 'once';
      const o = { dir, who, amount, date, first, freq, day: freq === 'day' ? int(d.day, 1, 31) : 31, inst: freq === 'once' ? 0 : int(d.inst, 0, amount), note: str(d.note, 120), remind: d.remind !== false };
      if (d.closed === true) o.closed = true;
      if (d.group != null && String(d.group)) o.group = str(d.group, 40);
      return { ok: Object.assign(o, base) };
    }
    if (c === 'target') {
      const name = str(d.name, 60), kind = TARGET_KIND_IDS.indexOf(d.kind) >= 0 ? d.kind : 'lain';
      if (!name) return fail('Isi nama target.');
      const months = int(d.months, 0, 60), goal = int(d.goal, 0, 1e13);
      if (goal < 1 && !months) return fail('Isi nominal target.');
      const deadline = str(d.deadline, 10), start = str(d.start, 10);
      if (deadline && !isDay(deadline)) return fail('Tanggal target tidak valid.');
      if (start && !isDay(start)) return fail('Tanggal mulai tidak valid.');
      const o = { name, kind, goal, months, deadline, start, monthly: int(d.monthly, 0, 1e12), pocket: d.pocket === 'investasi' ? 'investasi' : 'tabungan', base: int(d.base, 0, 1e13), note: str(d.note, 120) };
      if (d.closed === true) o.closed = true;
      return { ok: Object.assign(o, base) };
    }
    if (c === 'ramean') {
      const name = str(d.name, 60); if (!name) return fail('Isi nama acara.');
      const x = d.data == null ? {} : d.data;
      if (!x || typeof x !== 'object' || Array.isArray(x)) return fail('Data acara tidak valid.');
      const people = (Array.isArray(x.people) ? x.people : []).slice(0, 30).map((p, i) => str(p, 30) || (i === 0 ? 'Saya' : 'Teman ' + i));
      if (!people.length) people.push('Saya');
      const np = people.length, pi = v => { const n = Math.round(Number(v)); return isFinite(n) ? Math.min(np - 1, Math.max(0, n)) : 0; };
      const items = (Array.isArray(x.items) ? x.items : []).slice(0, 60).map(it => {
        const o = it && typeof it === 'object' ? it : {}, w = [];
        (Array.isArray(o.w) ? o.w : []).slice(0, 30).forEach(v => { const n = Math.round(Number(v)); if (isFinite(n) && n >= 0 && n < np && w.indexOf(n) < 0) w.push(n); });
        return { n: str(o.n, 40), a: int(o.a, 0, 1e10), w: w.sort((p, q) => p - q) };
      });
      const data = { people, mode: x.mode === 'item' ? 'item' : 'equal', payer: pi(x.payer), total: int(x.total, 0, 1e11), items, tax: int(x.tax, 0, 100), ship: int(x.ship, 0, 1e10), disc: int(x.disc, 0, 1e10), cat: String(x.cat == null ? '' : x.cat).replace(/[^a-z_]/g, '').slice(0, 20) };
      if (x.rec && typeof x.rec === 'object' && x.rec.done === true) {
        const h = {}, src = x.rec.h && typeof x.rec.h === 'object' && !Array.isArray(x.rec.h) ? x.rec.h : {};
        Object.keys(src).slice(0, 30).forEach(k => { const n = Number(k); if (Number.isInteger(n) && n >= 0 && n < np && /^[a-z0-9]{8,32}$/.test(String(src[k]))) h[n] = String(src[k]); });
        data.rec = { done: true, at: str(x.rec.at, 40), mine: int(x.rec.mine, 0, 1e11), h };
      }
      const dt = str(d.date, 10);
      return { ok: Object.assign({ name, date: isDay(dt) ? dt : '', budget: int(d.budget, 0, 1e12), note: str(d.note, 120), data }, base) };
    }
    if (c === 'trip') {
      const name = str(d.name, 60); if (!name) return fail('Isi nama perjalanan.');
      const mode = ['darat', 'laut', 'udara', 'kombinasi'].indexOf(d.mode) >= 0 ? d.mode : 'darat';
      const date = str(d.date, 10); if (date && !isDay(date)) return fail('Tanggal berangkat tidak valid.');
      const x = d.data == null ? {} : d.data;
      if (!x || typeof x !== 'object' || Array.isArray(x)) return fail('Data perjalanan tidak valid.');
      const num = (v, lo, hi, dp) => { const n = Number(v), k = Math.pow(10, dp || 0); return isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * k) / k)) : lo; };
      const segs = [];
      for (const o0 of (Array.isArray(x.segs) ? x.segs : []).slice(0, 8)) {
        const o = o0 && typeof o0 === 'object' ? o0 : {}, m = ['darat', 'laut', 'udara'].indexOf(o.m) >= 0 ? o.m : 'darat';
        const sg = { m, name: str(o.name, 60), km: int(o.km, 0, 20000), h: num(o.h, 0, 300, 1), toll: int(o.toll, 0, 1e8), fare: int(o.fare, 0, 1e9), veh: int(o.veh, 0, 1e9) };
        if (m === 'darat' && sg.km < 1) return fail('Isi jarak untuk ruas darat.');
        if (m !== 'darat' && !(sg.h > 0)) return fail('Isi lama perjalanan untuk ruas laut atau udara.');
        segs.push(sg);
      }
      if (!segs.length) return fail('Tambahkan minimal satu ruas perjalanan.');
      const dep = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x.dep)) ? String(x.dep) : '06:00';
      const off = (Array.isArray(x.off) ? x.off : []).slice(0, 80).map(k => String(k)).filter(k => /^[0-9a-z-]{1,24}$/.test(k));
      const data = { from: str(x.from, 40), to: str(x.to, 40), veh: ['motor', 'mobil', 'suv', 'diesel'].indexOf(x.veh) >= 0 ? x.veh : 'mobil', kmpl: num(x.kmpl, 3, 80, 1), price: int(x.price, 1000, 100000), persons: int(x.persons, 1, 30), rest: int(x.rest, 50, 500), dep, transfer: int(x.transfer, 0, 1e8), off, segs };
      return { ok: Object.assign({ name, mode, date, budget: int(d.budget, 0, 1e12), note: str(d.note, 120), data }, base) };
    }
    if (c === 'wish') {
      const name = str(d.name, 60); if (!name) return fail('Isi nama wishlist.');
      const kind = d.kind === 'kegiatan' ? 'kegiatan' : 'barang', cost = int(d.cost, 0, 1e13);
      if (cost < 1) return fail('Isi estimasi biaya.');
      const date = str(d.date, 10); if (date && !isDay(date)) return fail('Tanggal rencana tidak valid.');
      const o = { name, kind, cost, saved: int(d.saved, 0, 1e13), date, freq: ['harian', 'mingguan', 'bulanan'].indexOf(d.freq) >= 0 ? d.freq : 'bulanan', note: str(d.note, 120) };
      if (d.done === true) o.done = true;
      return { ok: Object.assign(o, base) };
    }
    return fail('Jenis data tidak dikenal.');
  }
  /*PLANCLEAN:END*/
  function cleanPlan(c, d) { const r = planClean(c, d, iso()); if (r.err) throw bad(r.err); return r.ok; }
  const emptyPlan = () => ({ cicilan: [], hutang: [], target: [], ramean: [], trip: [], wish: [] });
  function normPlan(p) { const o = emptyPlan(); if (p && typeof p === 'object') PLAN_COLS.forEach(c => { if (Array.isArray(p[c])) o[c] = p[c].slice(); }); return o; }


  /* ---------- Teman: kode teman, permintaan, dan berbagi rencana ----------
     fr/{uid}  = { code, friends:{id:at}, in:{id:at}, out:{id:at}, shares:{ kunci:{kind,itemId,name,to:[id],at,data} } }
     fcode/{KODE} = { u: uid }. Teman hanya bisa MELIHAT salinan yang dibagikan pemiliknya; pemilik memperbarui salinannya sendiri. */
  const FR_AL = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', FR_KINDS = ['wish', 'ramean', 'target', 'trip', 'budget'], FR_MAX_F = 50, FR_MAX_S = 40, FR_BYTES = 30000;
  const frNorm = x => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SAKU/, '').slice(0, 8);
  const frFmt = c => 'SAKU-' + c.slice(0, 4) + '-' + c.slice(4);
  const frNew = d => Object.assign({ code: '', friends: {}, in: {}, out: {}, shares: {} }, d || {});
  const frKey = uid => 'fr/' + uid;
  async function frEnsure(uid) {
    const cur = await meta.get(frKey(uid), { type: 'json' });
    if (cur && cur.code) return frNew(cur);
    for (let i = 0; i < 10; i++) {
      const hex = crypto.randomBytes(8).toString('hex'); let code = ''; for (let j = 0; j < 8; j++) code += FR_AL[parseInt(hex.substr(j * 2, 2), 16) % FR_AL.length];
      const r = await meta.setJSON('fcode/' + code, { u: uid }, { onlyIfNew: true });
      if (r && r.modified === false) continue;
      return frNew(await casUpdate(meta, frKey(uid), d => (d && d.code ? { value: undefined, result: d } : { value: Object.assign(frNew(d), { code }), result: Object.assign(frNew(d), { code }) })));
    }
    throw new ApiError(503, 'Kode teman belum bisa dibuat. Coba lagi.', 'busy');
  }
  const frName = (map, id) => { const x = map[id]; return x && x.active !== false && x.status !== 'pending' && x.status !== 'rejected' ? String(x.name || id) : null; };
  async function frState(uid, map) {
    const d = await frEnsure(uid), list = o => Object.keys(o).map(id => ({ id, name: frName(map, id), at: o[id] })).filter(x => x.name);
    const friends = list(d.friends), withMe = [];
    for (const f of friends) {
      const fd = frNew(await meta.get(frKey(f.id), { type: 'json' }));
      Object.keys(fd.shares).forEach(k => { const sh = fd.shares[k]; if (sh && Array.isArray(sh.to) && sh.to.indexOf(uid) >= 0) withMe.push({ key: k, from: { id: f.id, name: f.name }, kind: sh.kind, name: sh.name, at: sh.at, data: sh.data }); });
    }
    const mine = Object.keys(d.shares).map(k => { const sh = d.shares[k]; return { key: k, kind: sh.kind, itemId: sh.itemId, name: sh.name, at: sh.at, to: sh.to.map(id => ({ id, name: frName(map, id) })).filter(x => x.name) }; });
    return { code: frFmt(d.code), friends, incoming: list(d.in), outgoing: list(d.out), mine, withMe };
  }
  /* Hapus semua jejak hubungan antara dua akun (tolak, batalkan, atau putus pertemanan) */
  async function frUnlink(a, b) {
    for (const [x, y] of [[a, b], [b, a]]) {
      await casUpdate(meta, frKey(x), d => {
        if (!d) return { value: undefined, result: null };
        const n = frNew(d); let ch = false;
        ['friends', 'in', 'out'].forEach(k => { if (n[k][y]) { delete n[k][y]; ch = true; } });
        Object.keys(n.shares).forEach(k => { const t = n.shares[k].to.filter(i => i !== y); if (t.length !== n.shares[k].to.length) { ch = true; if (t.length) n.shares[k].to = t; else delete n.shares[k]; } });
        return ch ? { value: n, result: n } : { value: undefined, result: n };
      });
    }
  }

  /* ---------- pembukuan per pengguna ---------- */
  const bookKey = uid => uid + '/book';
  async function loadBook(uid) { return (await ledger.get(bookKey(uid), { type: 'json' })) || { rev: 0, tx: [], settings: {}, plan: emptyPlan() }; }
  async function syncBook(uid, rev) {
    const b = await loadBook(uid);
    if (Number.isInteger(rev) && rev === b.rev) return { same: true, rev: b.rev };
    return { rev: b.rev, tx: b.tx, settings: b.settings || {}, plan: normPlan(b.plan) };
  }
  async function wipeLedger(uid) {
    const { blobs } = await ledger.list({ prefix: uid + '/' });
    for (const b of blobs || []) await ledger.delete(b.key);
  }


  /* ---------- brankas cadangan: salinan tertutup seluruh akun ----------
     Administrator boleh MENGUNDUH dan MEMULIHKAN cadangan semua akun, tetapi tidak pernah menerima isinya dalam bentuk terbaca:
     server menyegel tiap potong data dengan AES-256-GCM memakai kunci yang hanya ada di server (VAULT_SECRET, atau kunci acak
     yang disimpan di server), lalu hanya mengirim bagian tersegel. Pemulihan dibuka kembali oleh server, bukan oleh admin. */
  const wcrypto = () => (globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto : crypto.webcrypto);
  const u8b64 = u => { let t = ''; for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const b64u8 = t => { const r = atob(String(t).replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; };
  const vAad = (kind, id, pid) => new TextEncoder().encode('saku-vault|' + kind + '|' + id + (pid ? '|' + pid : ''));
  let vaultCache = null;
  async function vaultKey(create) {
    if (vaultCache) return vaultCache;
    const w = wcrypto(), e = env('VAULT_SECRET');
    let raw, src;
    if (e && String(e).length >= 16) { raw = new Uint8Array(await w.subtle.digest('SHA-256', new TextEncoder().encode('saku-vault|' + e))); src = 'env'; }
    else {
      let v = await meta.get('vault', { type: 'json' });
      if (!v || !v.k) {
        if (!create) return null;
        await meta.setJSON('vault', { k: u8b64(w.getRandomValues(new Uint8Array(32))), at: iso() }, { onlyIfNew: true });
        v = await meta.get('vault', { type: 'json' });
      }
      raw = b64u8(v.k); src = 'store';
    }
    const key = await w.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return (vaultCache = { key, src, kid: u8b64(new Uint8Array(await w.subtle.digest('SHA-256', raw))).slice(0, 8) });
  }
  async function vSeal(k, aad, obj) {
    const w = wcrypto(), iv = w.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await w.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k.key, new TextEncoder().encode(JSON.stringify(obj))));
    return { v: 1, a: 'A256GCM', k: k.kid, i: u8b64(iv), c: u8b64(ct) };
  }
  async function vOpen(k, aad, sealed) {
    if (!sealed || typeof sealed !== 'object' || sealed.v !== 1 || sealed.a !== 'A256GCM' || typeof sealed.i !== 'string' || typeof sealed.c !== 'string' || sealed.c.length > 2_000_000) throw bad('Berkas cadangan tidak dikenali.', 'vaultbad');
    if (sealed.k !== k.kid) throw new ApiError(400, 'Cadangan ini disegel dengan kunci brankas lain, jadi server ini tidak bisa membukanya. Pasang VAULT_SECRET yang sama dengan server asalnya.', 'vaultkey');
    try { return JSON.parse(new TextDecoder().decode(await wcrypto().subtle.decrypt({ name: 'AES-GCM', iv: b64u8(sealed.i), additionalData: aad }, k.key, b64u8(sealed.c)))); }
    catch (e) { throw bad('Berkas cadangan rusak, sudah diubah, atau bukan milik akun ini.', 'vaultbad'); }
  }
  /* Hanya isi yang lolos pembersih yang sama dengan penulisan biasa yang dipulihkan */
  function vaultClean(o) {
    let skipped = 0;
    const tx = [], seen = new Set();
    for (const t of (Array.isArray(o.tx) ? o.tx : []).slice(0, MAX_TX)) {
      try { if (!t || !ID_RE.test(String(t.id)) || seen.has(t.id)) throw 0; seen.add(t.id); tx.push(Object.assign({ id: String(t.id) }, cleanTx(t))); } catch (e) { skipped++; }
    }
    const plan = emptyPlan();
    for (const col of PLAN_COLS) {
      for (const p of (Array.isArray(o.plan && o.plan[col]) ? o.plan[col] : []).slice(0, PLAN_MAX[col])) {
        const r = p && ID_RE.test(String(p.id)) ? planClean(col, p, iso()) : { err: 1 };
        if (r.ok) plan[col].push(Object.assign({ id: String(p.id) }, r.ok)); else skipped++;
      }
    }
    return { tx, plan, settings: cleanSettings(o.settings), skipped };
  }

  /* ---------- Masuk dengan Google dan lupa kata sandi ----------
     Google: ID token (JWT RS256) diperiksa di server terhadap kunci publik Google (JWKS); email Google harus terverifikasi dan dicocokkan
     dengan email akun. Lupa kata sandi: token acak sekali pakai dikirim lewat email (Brevo/Resend); hanya hash-nya yang disimpan di akun.
     Tidak ada token, kata sandi, atau credential yang boleh masuk log. */
  const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
  const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
  const RESET_TTL = 30 * 60000;
  const B64U = /^[A-Za-z0-9_-]+$/;
  const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const gbadErr = () => new ApiError(401, 'Masuk dengan Google gagal: tanda pengenal tidak valid atau sudah kedaluwarsa. Coba lagi.', 'gbad');
  const badLink = () => new ApiError(400, 'Tautan tidak valid, sudah dipakai, atau sudah kedaluwarsa. Minta tautan baru lewat "Lupa kata sandi?".', 'badlink');
  const mailReady = () => !!(String(env('MAIL_API_KEY') || '').trim() && String(env('MAIL_FROM') || '').trim());
  const mailOf = a => (a && typeof a.email === 'string' ? a.email.trim().toLowerCase() : '');

  /* Penghitung sederhana: true bila masih boleh (dan dihitung), false bila sudah melewati batas dalam jendela waktu */
  async function rlHit(key, max, windowMs) {
    const r = await meta.get('rl/' + key, { type: 'json' }), t = now(), fresh = r && t - r.t < windowMs;
    if (fresh && r.n >= max) return false;
    await meta.setJSON('rl/' + key, { n: (fresh ? r.n : 0) + 1, t: fresh ? r.t : t, until: 0 });
    return true;
  }
  async function fetchTimed(url, init, ms) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null, to = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    try { return await fetchFn(url, Object.assign({}, init, ctl ? { signal: ctl.signal } : {})); } finally { if (to) clearTimeout(to); }
  }

  /* Kunci publik Google: disimpan di memori fungsi sesuai max-age (bawaan dan maksimum 1 jam). Kunci tak dikenal memicu muat ulang (paling cepat tiap 60 detik). */
  let jwks = null, jwksBusy = null;
  function loadJwks() {
    if (jwksBusy) return jwksBusy;
    jwksBusy = (async () => {
      try {
        const res = await fetchTimed(String(env('GOOGLE_CERTS_URL') || '').trim() || GOOGLE_CERTS, { headers: { accept: 'application/json' } }, 6000);
        if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
        const text = await res.text(); if (text.length > 200000) throw new Error('terlalu besar');
        const j = JSON.parse(text);
        const keys = (Array.isArray(j && j.keys) ? j.keys : []).filter(k => k && k.kty === 'RSA' && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
        if (!keys.length) throw new Error('tanpa kunci');
        const m = /max-age=(\d+)/i.exec((res.headers && res.headers.get && res.headers.get('cache-control')) || ''), age = m ? Math.min(3600, Math.max(60, Number(m[1]))) : 3600;
        return (jwks = { keys, t: now(), exp: now() + age * 1000 });
      } catch (e) { console.error('catat-uang: kunci publik Google tidak terbaca (' + (e && e.message || e) + ')'); return null; }
      finally { jwksBusy = null; }
    })();
    return jwksBusy;
  }
  async function googleKey(kid) {
    let loaded = false, cur = jwks && now() < jwks.exp ? jwks : null;
    if (!cur) { loaded = true; cur = (await loadJwks()) || jwks; }          // gagal memuat: pakai salinan lama bila ada
    if (!cur) throw new ApiError(502, 'Google belum bisa dihubungi untuk memeriksa tanda pengenal. Coba lagi sebentar lagi.', 'gupstream');
    let k = cur.keys.find(x => x.kid === kid);
    if (!k && !loaded && now() - cur.t >= 60000) { const fr = await loadJwks(); if (fr) k = fr.keys.find(x => x.kid === kid); }
    return k || null;
  }
  /* Memeriksa ID token Google; hasil { sub, email, first, last }. Semua kegagalan menjadi galat generik gbad. */
  async function verifyGoogle(cred, cid) {
    const parts = typeof cred === 'string' && cred.length <= 4096 ? cred.split('.') : [];
    if (parts.length !== 3 || !parts.every(p => B64U.test(p))) throw gbadErr();
    let head, cl;
    try { head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); cl = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { throw gbadErr(); }
    if (!head || typeof head !== 'object' || head.alg !== 'RS256' || typeof head.kid !== 'string' || !cl || typeof cl !== 'object' || Array.isArray(cl)) throw gbadErr();
    const jwk = await googleKey(head.kid);
    if (!jwk) throw gbadErr();
    let sigOk = false;
    try { sigOk = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url')); } catch (e) { sigOk = false; }
    if (!sigOk) throw gbadErr();
    const t = now() / 1000;
    if (GOOGLE_ISS.indexOf(cl.iss) < 0 || typeof cl.aud !== 'string' || cl.aud !== cid) throw gbadErr();
    if (typeof cl.exp !== 'number' || !(t <= cl.exp + 60)) throw gbadErr();
    if (cl.nbf !== undefined && (typeof cl.nbf !== 'number' || t < cl.nbf - 60)) throw gbadErr();
    if (cl.email_verified !== true && cl.email_verified !== 'true') throw gbadErr();
    const email = typeof cl.email === 'string' ? cl.email.trim().toLowerCase() : '';
    if (typeof cl.sub !== 'string' || !cl.sub || cl.sub.length > 255 || email.length > 254 || !MAIL_RE.test(email)) throw gbadErr();
    const str = v => (typeof v === 'string' ? clean(v) : '');
    const full = str(cl.name), local = email.split('@')[0];
    const first = (str(cl.given_name) || full.split(' ')[0] || local).slice(0, 30);
    const last = (str(cl.family_name) || (str(cl.given_name) ? '' : full.split(' ').slice(1).join(' '))).slice(0, 30);
    return { sub: cl.sub, email, first, last };
  }
  /* Username akun baru dari bagian lokal email: huruf kecil dan angka, diawali huruf, 4-20 karakter; bentrok -> tambah angka */
  function googleUsername(email, map) {
    let base = email.split('@')[0].replace(/[^a-z0-9]/g, '');
    if (!/^[a-z]/.test(base)) base = 'u' + base;
    base = base.slice(0, 20);
    if (base.length < 4) base += '1234'.slice(0, 4 - base.length);
    if (!map[base]) return base;
    for (let n = 2; n < 100000; n++) { const cand = base.slice(0, 20 - String(n).length) + n; if (!map[cand]) return cand; }
    return base + crypto.randomBytes(2).toString('hex');
  }

  /* Email lewat penyedia (brevo bawaan | resend) memakai fetchFn; true bila diterima penyedia. Galat hanya dicatat tanpa isi pesan. */
  async function sendMail(to, subject, html, text) {
    const key = String(env('MAIL_API_KEY') || '').trim(), from = String(env('MAIL_FROM') || '').trim(), prov = String(env('MAIL_PROVIDER') || 'brevo').trim().toLowerCase();
    const fname = String(env('MAIL_FROM_NAME') || '').replace(/[<>"\r\n]/g, '').trim() || 'SaKu', over = String(env('MAIL_API_URL') || '').trim();
    let url, headers, body;
    if (prov === 'brevo') {
      url = over || 'https://api.brevo.com/v3/smtp/email'; headers = { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' };
      body = { sender: { email: from, name: fname }, to: [{ email: to }], subject, htmlContent: html, textContent: text };
    } else if (prov === 'resend') {
      url = over || 'https://api.resend.com/emails'; headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
      body = { from: fname + ' <' + from + '>', to: [to], subject, html, text };
    } else { console.error('catat-uang: MAIL_PROVIDER tidak dikenal (pakai brevo atau resend)'); return false; }
    try {
      const res = await fetchTimed(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' }, 10000);
      if (!res || !res.ok) { console.error('catat-uang: penyedia email menolak pengiriman (HTTP ' + (res && res.status) + ')'); return false; }
      return true;
    } catch (e) { console.error('catat-uang: email tidak terkirim (' + ((e && e.name) || 'galat') + ')'); return false; }
  }
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  /* Isi email reset: items = [{ u, name, link }] (satu tautan per akun) */
  function resetMailBody(items, siteName) {
    const one = items.length === 1;
    const text = 'Halo,\n\nKami menerima permintaan mengatur ulang kata sandi ' + siteName + ' Anda.\n\n'
      + items.map(i => (one ? '' : 'Akun ' + i.u + ':\n') + 'Buka tautan ini untuk membuat kata sandi baru (berlaku 30 menit, hanya bisa dipakai sekali):\n' + i.link + '\n').join('\n')
      + '\nBila bukan Anda yang meminta, abaikan saja email ini. Kata sandi Anda tidak berubah.\n';
    const html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b2540;max-width:480px">'
      + '<p>Halo,</p><p>Kami menerima permintaan mengatur ulang kata sandi <b>' + esc(siteName) + '</b> Anda.</p>'
      + items.map(i => '<p style="margin:18px 0 6px">' + (one ? '' : 'Akun <b>' + esc(i.u) + '</b>: ') + 'Tautan ini berlaku <b>30 menit</b> dan hanya bisa dipakai sekali.</p>'
        + '<p style="margin:0 0 6px"><a href="' + esc(i.link) + '" style="display:inline-block;background:#2f5bea;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Buat kata sandi baru</a></p>'
        + '<p style="margin:0;font-size:12px;color:#5b6684;word-break:break-all">Atau salin tautan ini: ' + esc(i.link) + '</p>').join('')
      + '<p style="margin-top:22px;color:#5b6684">Bila bukan Anda yang meminta, abaikan saja email ini. Kata sandi Anda tidak berubah.</p></div>';
    return { subject: 'Atur ulang kata sandi ' + siteName, text, html };
  }
  /* Alamat dasar tautan: APP_URL bila diisi dan valid, kalau tidak origin permintaan */
  function appBase(req) {
    const cfg = String(env('APP_URL') || '').trim();
    if (cfg) { try { const u = new URL(cfg); if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')); } catch (e) { /* abaikan, pakai origin permintaan */ } }
    try { return new URL(req.url).origin; } catch (e) { return ''; }
  }
  const sameHash = (a, b) => { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === 32 && x.length === y.length && crypto.timingSafeEqual(x, y); };
  /* Token reset di akun cocok? ({h, exp} dibandingkan dengan hash token yang dikirim) */
  const resetOk = (acc, code) => !!(acc && acc.reset && typeof acc.reset.h === 'string' && acc.reset.exp > now() && !statusBlock(acc) && sameHash(sha(code), acc.reset.h));

  /* ---------- operasi ---------- */
  const mktState = { t: 0, v: null };
  const ops = {
    /* Data IHSG untuk menu Kurs & Indeks (hanya baca; semua akun yang sudah masuk) */
    async 'market.indices'(b, c) {
      await authed(c.req);
      const v = await mktFetchIndices(deps.fetchFn || (typeof fetch === 'function' ? fetch : null), mktState);
      if (!v) throw new ApiError(502, 'Data IHSG belum bisa diambil dari sumbernya. Coba lagi beberapa saat lagi.', 'market');
      return v;
    },
    async status() {
      const map = await readAccounts();
      return { hasAccounts: Object.keys(map).length > 0, setupReady: !!env('SETUP_CODE'), aiScan: !!env('ANTHROPIC_API_KEY'), sessionMinutes: await sessMin(), backup: await backupCfg(),
        /* Masuk dengan Google / lupa kata sandi: bendera untuk UI (Netlify: satu kolom "username atau email", tanpa tautan akun Google di Pengaturan) */
        google: String(env('GOOGLE_CLIENT_ID') || '').trim(), resetMail: mailReady(), resetNeedsEmail: false, glink: false };
    },

    async setup(b, c) {
      const want = env('SETUP_CODE');
      if (!want) throw new ApiError(503, 'Server belum diatur: isi variabel SETUP_CODE di Netlify, lalu deploy ulang.', 'nosetup');
      const key = 'setup-' + c.ipKey, prev = await rlCheck(key);
      if (!safeEq(String(b.code || ''), want)) { await rlFail(key, prev, 5, 15 * 60000, 15 * 60000); throw new ApiError(403, 'Kode setup salah.', 'badcode'); }
      const username = String(b.username || 'admin').trim().toLowerCase(), pw = String(b.password || '');
      if (!/^[a-z][a-z0-9]{3,19}$/.test(username)) throw bad('Username admin 4–20 karakter: huruf kecil dan angka, diawali huruf.');
      if (pw.length < 6 || pw.length > 100) throw bad('Kata sandi minimal 6 karakter.');
      if (pw === DEFAULT_PW) throw bad('Pilih kata sandi yang berbeda dari kata sandi awal.');
      const acc = { id: username, name: 'Administrator', role: 'admin', active: true, status: 'active', hash: await hashPassword(pw), createdAt: iso(), createdBy: 'setup', lastLoginAt: iso() };
      const ok = await updateAccounts(map => (Object.keys(map).length ? { value: undefined, result: false } : { value: { [username]: acc }, result: true }));
      if (!ok) throw new ApiError(409, 'Akun sudah ada. Masuk memakai akun yang ada.', 'exists');
      await rlClear(key);
      return session(acc);
    },

    async login(b, c) {
      const id = slug(b.username), pw = String(b.password || '');
      if (!id || !pw || pw.length > 200) throw bad('Isi username dan kata sandi.');
      const ku = 'login-u-' + id, ki = 'login-ip-' + c.ipKey;
      const [pu, pi] = [await rlCheck(ku), await rlCheck(ki)];
      const acc = (await readAccounts())[id];
      let ok = false;
      if (acc) ok = acc.hash ? await verifyHash(pw, acc.hash) : safeEq(pw, DEFAULT_PW);
      else { DUMMY = DUMMY || await hashPassword('x'); await verifyHash(pw, DUMMY); }
      if (!ok) {
        await rlFail(ku, pu, 8, 15 * 60000, 10 * 60000); await rlFail(ki, pi, 40, 15 * 60000, 10 * 60000);
        throw new ApiError(401, 'Username atau kata sandi salah.', 'badlogin');
      }
      const blocked = statusBlock(acc); if (blocked) throw blocked;
      await rlClear(ku);
      const at = iso(); await touchAcct(id, { lastLoginAt: at }).catch(() => {});
      return session(Object.assign({}, acc, { lastLoginAt: at }));
    },

    async register(b, c) {
      const key = 'reg-' + c.ipKey, prev = await rlCheck(key);
      await rlFail(key, prev, 12, 60 * 60000, 60 * 60000);
      const v = cleanReg(b), pw = cleanNewPw(b.password), t = iso(), hash = await hashPassword(pw);
      const res = await updateAccounts(map => {
        const all = Object.values(map);
        if (!all.length) return { value: undefined, result: 'noadmin' };
        if (map[v.username]) return { value: undefined, result: 'dupe' };
        if (all.length >= MAX_ACCOUNTS) return { value: undefined, result: 'full' };
        if (all.filter(a => a.status === 'pending').length >= MAX_PENDING) return { value: undefined, result: 'queue' };
        return { value: Object.assign({}, map, { [v.username]: { id: v.username, name: v.first + ' ' + v.last, first: v.first, last: v.last, role: 'user', status: 'pending', active: false, hash, birth: v.birth, phone: v.phone, email: v.email, requestedAt: t, createdAt: t, createdBy: 'daftar' } }), result: 'ok' };
      });
      if (res === 'dupe') throw new ApiError(409, 'Username ini sudah dipakai. Coba tambahkan angka lain.', 'dupe');
      if (res === 'queue') throw new ApiError(429, 'Antrean pendaftaran sedang penuh. Coba lagi nanti atau hubungi admin.', 'queue');
      if (res === 'full') throw new ApiError(409, 'Jumlah akun sudah mencapai batas. Hubungi admin.', 'full');
      if (res === 'noadmin') throw new ApiError(409, 'Aplikasi belum disiapkan oleh administrator.', 'noadmin');
      return { ok: true };
    },

    /* Masuk dengan Google: { credential } = ID token dari Google Identity Services. Hasil sama dengan login.
       Akun dicocokkan lewat email Google (huruf kecil). Belum ada akun -> dibuat akun pending (menunggu admin), kata sandinya acak dan tidak diketahui siapa pun. */
    async google(b, c) {
      const cid = String(env('GOOGLE_CLIENT_ID') || '').trim();
      if (!cid) throw new ApiError(503, 'Masuk dengan Google belum diaktifkan di server ini.', 'gdisabled');
      const ki = 'g-ip-' + c.ipKey, pi = await rlCheck(ki);
      await rlFail(ki, pi, 30, 15 * 60000, 15 * 60000);                   // semua percobaan dihitung per IP
      const g = await verifyGoogle(b.credential, cid);
      const ke = 'g-em-' + sha(g.email).slice(0, 24), pe = await rlCheck(ke);
      await rlFail(ke, pe, 10, 15 * 60000, 15 * 60000);                   // dan per email Google
      const map = await readAccounts(), at = iso();
      const rank = a => (a.status === 'pending' ? 1 : a.status === 'rejected' ? 2 : a.active === false ? 3 : 0);
      const hits = Object.values(map).filter(a => a && mailOf(a) === g.email);
      const actives = hits.filter(a => rank(a) === 0);
      if (actives.length > 1) throw new ApiError(409, 'Email Google ini cocok dengan lebih dari satu akun di sini. Masuklah memakai username dan kata sandi akun Anda.', 'gmulti');
      const acc = actives[0] || hits.sort((x, y) => rank(x) - rank(y) || String(x.createdAt || '').localeCompare(String(y.createdAt || '')))[0];
      if (acc) {
        let fresh = null;
        const res = await updateAccounts(m => {
          const cur = m[acc.id]; if (!cur) return { value: undefined, result: gbadErr() };
          if (cur.gsub && !safeEq(cur.gsub, g.sub)) return { value: undefined, result: gbadErr() };   // email ini sudah terikat ke identitas Google lain
          const blocked = statusBlock(cur); if (blocked) return { value: undefined, result: blocked };
          fresh = Object.assign({}, cur, { gsub: g.sub, lastLoginAt: at });
          return { value: Object.assign({}, m, { [cur.id]: fresh }), result: null };
        });
        if (res) throw res;
        return session(fresh);
      }
      /* Belum ada akun: daftarkan sebagai pending. hash BUKAN null (null = kata sandi awal yang bisa ditebak). */
      const kn = 'gnew-' + c.ipKey, pn = await rlCheck(kn);
      await rlFail(kn, pn, 12, 60 * 60000, 60 * 60000);
      const hash = await hashPassword(crypto.randomBytes(32).toString('hex'));
      const made = await updateAccounts(m => {
        const all = Object.values(m);
        if (!all.length) return { value: undefined, result: 'noadmin' };
        if (all.some(a => a && mailOf(a) === g.email)) return { value: undefined, result: 'ok' };     // keburu dibuat permintaan lain
        if (all.length >= MAX_ACCOUNTS) return { value: undefined, result: 'full' };
        if (all.filter(a => a.status === 'pending').length >= MAX_PENDING) return { value: undefined, result: 'queue' };
        const id = googleUsername(g.email, m), name = (g.first + ' ' + g.last).trim();
        return { value: Object.assign({}, m, { [id]: { id, name, first: g.first, last: g.last, role: 'user', status: 'pending', active: false, hash, birth: '', phone: '', email: g.email, gsub: g.sub, requestedAt: at, createdAt: at, createdBy: 'google' } }), result: 'ok' };
      });
      if (made === 'queue') throw new ApiError(429, 'Antrean pendaftaran sedang penuh. Coba lagi nanti atau hubungi admin.', 'queue');
      if (made === 'full') throw new ApiError(409, 'Jumlah akun sudah mencapai batas. Hubungi admin.', 'full');
      if (made === 'noadmin') throw new ApiError(409, 'Aplikasi belum disiapkan oleh administrator.', 'noadmin');
      throw new ApiError(403, 'Pendaftaran Anda masih menunggu persetujuan admin. Coba lagi nanti.', 'pending');
    },

    /* Lupa kata sandi: { id } = username atau email. Selalu { ok: true } (tidak membocorkan ada/tidaknya akun), kecuali kolom kosong,
       terlalu sering dari satu IP (429 rate), atau pengiriman email belum diatur. Hanya akun aktif yang punya email yang dikirimi. */
    async forgot(b, c) {
      const raw = String(b.id == null ? '' : b.id).trim().toLowerCase();
      if (!raw) throw bad('Isi username atau email Anda.');
      if (!mailReady()) throw new ApiError(503, 'Pemulihan kata sandi lewat email belum diaktifkan di server ini. Hubungi administrator.', 'nomail');
      if (!(await rlHit('fg-ip-' + c.ipKey, 3, 60 * 60000))) throw new ApiError(429, 'Terlalu sering meminta tautan. Coba lagi dalam satu jam.', 'rate');
      const t0 = Date.now();
      try { if (raw.length <= 100) await sendResets(raw, c.req); } catch (e) { console.error('catat-uang: permintaan reset gagal diproses'); }
      /* Waktu respons dibuat hampir sama (ada/tidaknya akun tidak terbaca dari lamanya) */
      const rest = forgotFloorMs - (Date.now() - t0); if (rest > 0) await sleep(rest);
      return { ok: true };
    },

    /* Reset kata sandi dari tautan email: { u, code, password }. Token sekali pakai; sesudah sukses langsung masuk dan semua sesi lama mati. */
    async reset(b, c) {
      const ki = 'rs-ip-' + c.ipKey, pi = await rlCheck(ki);
      const pw = cleanNewPw(b.password), u = slug(b.u), code = typeof b.code === 'string' && b.code.length <= 200 ? b.code : '';
      const cur0 = u && code ? (await readAccounts())[u] : null;
      if (!resetOk(cur0, code)) { await rlFail(ki, pi, 10, 15 * 60000, 15 * 60000); throw badLink(); }
      const hash = await hashPassword(pw), at = iso();
      let fresh = null;
      const ok = await updateAccounts(m => {
        const cur = m[u]; if (!resetOk(cur, code)) return { value: undefined, result: false };     // dipakai permintaan lain lebih dulu
        fresh = Object.assign({}, cur, { hash, lastLoginAt: at }); delete fresh.reset;
        return { value: Object.assign({}, m, { [u]: fresh }), result: true };
      });
      if (!ok) { await rlFail(ki, pi, 10, 15 * 60000, 15 * 60000); throw badLink(); }
      await rlClear('login-u-' + u);
      return session(fresh);
    },

    async me(b, c) { const a = await authed(c.req); return { account: pub(a.acc), sessionMinutes: a.mins, backup: await backupCfg() }; },

    /* Dipanggil aplikasi saat pengguna aktif: memperpanjang batas waktu login */
    async ping(b, c) { const a = await authed(c.req); return { token: await makeToken(a.acc), sessionMinutes: a.mins }; },

    /* Pengaturan admin: batas waktu login (menit) dan pengingat cadangan akhir pekan (aktif/tidak, lama tampil dalam detik) */
    async 'config.set'(b, c) {
      const a = await authed(c.req); needAdmin(a);
      const cur = (await meta.get('config', { type: 'json' })) || {}, next = Object.assign({}, cur); let any = false;
      if (b.sessionMinutes !== undefined) {
        const n = Number(b.sessionMinutes);
        if (!Number.isInteger(n) || n < 1 || n > 1440) throw bad('Isi angka bulat 1 sampai 1440 menit.');
        next.sessionMinutes = n; any = true;
      }
      if (b.backupOn !== undefined) { if (typeof b.backupOn !== 'boolean') throw bad('Pilihan pengingat cadangan tidak valid.'); next.backupOn = b.backupOn; any = true; }
      if (b.backupSeconds !== undefined) {
        const n = Number(b.backupSeconds);
        if (!Number.isInteger(n) || n < 5 || n > 600) throw bad('Isi angka bulat 5 sampai 600 detik.');
        next.backupSeconds = n; any = true;
      }
      if (!any) throw bad('Isi angka bulat 1 sampai 1440 menit.');
      next.updatedAt = iso(); next.updatedBy = a.acc.id;
      await meta.setJSON('config', next);
      cfgCache = null;
      const k = await readCfg();
      return { ok: true, sessionMinutes: k.v, backup: k.backup };
    },

    /* satu panggilan berkala: akun (+ semua akun untuk admin) + pembukuan */
    async poll(b, c) {
      const a = await authed(c.req);
      return { account: pub(a.acc), accounts: isStaff(a) ? Object.values(a.map).map(x => pubList(x, a.acc.id)) : [pub(a.acc)], sessionMinutes: a.mins, backup: await backupCfg(), ledger: await syncBook(a.acc.id, b.rev) };
    },

    async 'pw.change'(b, c) {
      const a = await authed(c.req), cur = String(b.cur || ''), next = String(b.next || '');
      if (next.length < MIN_PW || next.length > 100) throw bad('Kata sandi baru minimal ' + MIN_PW + ' karakter.');
      if (next === DEFAULT_PW) throw bad('Pilih kata sandi yang berbeda dari kata sandi awal.');
      const ku = 'login-u-' + a.acc.id, pu = await rlCheck(ku);
      const ok = a.acc.hash ? await verifyHash(cur, a.acc.hash) : safeEq(cur, DEFAULT_PW);
      if (!ok) { await rlFail(ku, pu, 8, 15 * 60000, 10 * 60000); throw new ApiError(400, 'Kata sandi saat ini salah.', 'badpw'); }
      await rlClear(ku);
      const h = await hashPassword(next); let fresh = null;
      await updateAccounts(map => {
        const cur2 = map[a.acc.id]; if (!cur2) return { value: undefined, result: null };
        fresh = Object.assign({}, cur2, { hash: h }); delete fresh.reset; return { value: Object.assign({}, map, { [a.acc.id]: fresh }), result: null };
      });
      return session(fresh || a.acc);
    },

    /* Profil sendiri: foto, tanggal lahir, email (edisi ini tanpa verifikasi email) */
    async 'profile.set'(b, c) {
      const a = await authed(c.req), p = {};
      if ('birth' in b) { const v = String(b.birth || '').trim(); if (v && (!isYmd(v) || v < '1900-01-01' || v > new Date(now() + DAY).toISOString().slice(0, 10))) throw bad('Pilih tanggal lahir yang valid.'); p.birth = v; }
      if ('photo' in b) { const v = String(b.photo || ''); if (v && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 40000)) throw bad('Foto tidak valid atau terlalu besar.'); p.photo = v; }
      if ('email' in b) { const v = String(b.email || '').trim().toLowerCase(); if (v.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw bad('Email tidak valid. Contoh: janedoe@email.com.'); p.email = v; }
      if (!Object.keys(p).length) throw bad('Tidak ada yang diubah.');
      let fresh = null;
      await updateAccounts(map => {
        const cur = map[a.acc.id]; if (!cur) return { value: undefined, result: null };
        fresh = Object.assign({}, cur, p);
        /* Email berganti: tautan reset yang sudah terkirim ke email lama dan identitas Google lama tidak berlaku lagi */
        if ('email' in p && String(cur.email || '').trim().toLowerCase() !== p.email) { delete fresh.reset; delete fresh.gsub; }
        return { value: Object.assign({}, map, { [a.acc.id]: fresh }), result: null };
      });
      return { account: pub(fresh || a.acc) };
    },

    async 'acct.create'(b, c) {
      const a = await authed(c.req); needStaff(a);
      const name = clean(b.name), id = slug(name), role = a.acc.role === 'admin' && (b.role === 'admin' || b.role === 'helper') ? b.role : 'user';
      if (name.length < 2 || name.length > 40) throw bad('Isi nama 2–40 karakter.');
      if (!id) throw bad('Nama harus memuat huruf atau angka.');
      const res = await updateAccounts(map => {
        if (map[id]) return { value: undefined, result: 'dupe' };
        if (Object.keys(map).length >= MAX_ACCOUNTS) return { value: undefined, result: 'full' };
        return { value: Object.assign({}, map, { [id]: { id, name, role, active: true, status: 'active', hash: null, createdAt: iso(), createdBy: a.acc.id } }), result: 'ok' };
      });
      if (res === 'dupe') throw new ApiError(409, 'Nama ini sudah dipakai. Tambahkan inisial atau nama belakang.', 'dupe');
      if (res === 'full') throw new ApiError(409, 'Jumlah akun sudah mencapai batas.', 'full');
      return { ok: true, id };
    },

    async 'acct.approve'(b, c) { return acctEdit(c, b.id, { self: false, staff: true }, a => (a.status === 'pending' || a.status === 'rejected' ? { status: 'active', active: true, approvedAt: iso(), approvedBy: 'ADMIN' } : null), 'Akun ini tidak menunggu persetujuan.'); },
    async 'acct.reject'(b, c) { return acctEdit(c, b.id, { self: false, staff: true }, a => (a.status === 'pending' ? { status: 'rejected', active: false, rejectedAt: iso(), rejectedBy: 'ADMIN' } : null), 'Hanya pendaftaran yang menunggu yang bisa ditolak.'); },
    async 'acct.reset'(b, c) { return acctEdit(c, b.id, { self: false }, () => ({ hash: null, reset: undefined }), ''); },
    async 'acct.toggle'(b, c) { return acctEdit(c, b.id, { self: false, staff: true }, a => (a.status === 'active' ? { active: a.active === false } : null), 'Akun ini belum aktif.'); },

    /* Admin memilih siapa yang menjadi administrator (atau mencabutnya). Akun sendiri tidak bisa diubah, jadi selalu ada minimal satu admin. */
    async 'acct.role'(b, c) {
      const role = b.role === 'admin' ? 'admin' : b.role === 'helper' ? 'helper' : b.role === 'user' ? 'user' : '';
      if (!role) throw bad('Pilih peran: administrator, admin pembantu, atau pengguna.');
      return acctEdit(c, b.id, { self: false }, a => (a.status === 'active' && a.role !== role ? { role, roleAt: iso(), roleBy: 'ADMIN' } : null), 'Peran akun ini tidak bisa diubah. Pastikan akunnya aktif dan perannya berbeda.');
    },

    async 'acct.delete'(b, c) {
      const a = await authed(c.req); needAdmin(a);
      const id = slug(b.id); if (!id) throw bad('Akun tidak ditemukan.');
      if (id === a.acc.id) throw bad('Anda tidak bisa menghapus akun sendiri.');
      const found = await updateAccounts(map => { if (!map[id]) return { value: undefined, result: false }; const m2 = Object.assign({}, map); delete m2[id]; return { value: m2, result: true }; });
      if (!found) throw new ApiError(404, 'Akun tidak ditemukan.', 'notfound');
      await wipeLedger(id);
      return { ok: true };
    },

    /* ---- brankas cadangan (hanya administrator; isi tidak pernah dikirim dalam bentuk terbaca) ---- */
    async 'vault.status'(b, c) {
      const a = await authed(c.req); needAdmin(a);
      const k = await vaultKey(false), last = await meta.get('vaultlog', { type: 'json' });
      return { mode: 'server', ready: true, needKey: false, kid: k ? k.kid : '', keyFrom: k ? k.src : (env('VAULT_SECRET') && String(env('VAULT_SECRET')).length >= 16 ? 'env' : 'store'), last: last || null };
    },

    async 'vault.seal'(b, c) {
      const a = await authed(c.req); needAdmin(a);
      const id = slug(b.id), acc = id ? a.map[id] : null; if (!acc) throw new ApiError(404, 'Akun tidak ditemukan.', 'notfound');
      const k = await vaultKey(true), bk = await ledger.get(bookKey(id), { type: 'json' });
      if (!bk) return { id, name: acc.name, role: acc.role, empty: true };
      const txs = Array.isArray(bk.tx) ? bk.tx : [], photos = Array.from(new Set(txs.map(t => t && t.photo).filter(p => p && ID_RE.test(String(p)))));
      const at = iso();
      return { id, name: acc.name, role: acc.role, n: txs.length, at, photos, sealed: await vSeal(k, vAad('book', id), { v: 1, id, name: acc.name, at, rev: bk.rev || 0, tx: txs, settings: bk.settings || {}, plan: normPlan(bk.plan) }) };
    },

    async 'vault.photo'(b, c) {
      const a = await authed(c.req); needAdmin(a);
      const id = slug(b.id), pid = String(b.pid || '');
      if (!id || !a.map[id]) throw new ApiError(404, 'Akun tidak ditemukan.', 'notfound');
      if (!ID_RE.test(pid)) throw bad('ID foto tidak valid.');
      const k = await vaultKey(true), d = await ledger.get(id + '/photo/' + pid, { type: 'json' });
      if (!d || typeof d.data !== 'string') return { id, pid, missing: true };
      return { id, pid, sealed: await vSeal(k, vAad('photo', id, pid), { v: 1, data: d.data, createdAt: String(d.createdAt || '') }) };
    },

    /* Dicatat setelah administrator selesai mengunduh: hanya waktu dan hitungan */
    async 'vault.log'(b, c) {
      const a = await authed(c.req); needAdmin(a);
      const n = v => Math.min(1e7, Math.max(0, Math.round(Number(v)) || 0));
      const rec = { at: iso(), by: a.acc.id, accounts: n(b.accounts), tx: n(b.tx), photos: n(b.photos) };
      await meta.setJSON('vaultlog', rec);
      return { ok: true, last: rec };
    },

    async 'vault.restore'(b, c) {
      const a = await authed(c.req); needAdmin(a);
      const id = slug(b.id), acc = id ? a.map[id] : null;
      if (!acc) throw new ApiError(404, 'Akun ini belum ada di server. Buat akunnya dulu dengan nama yang sama, lalu pulihkan.', 'notfound');
      if (acc.status === 'pending' || acc.status === 'rejected') throw bad('Akun ini belum aktif.');
      const k = await vaultKey(false);
      if (!k) throw new ApiError(400, 'Server ini belum punya kunci brankas, jadi tidak bisa membuka cadangan. Pasang VAULT_SECRET yang sama dengan server asalnya.', 'vaultkey');
      if (b.phase === 'photo') {
        const pid = String(b.pid || ''); if (!ID_RE.test(pid)) throw bad('ID foto tidak valid.');
        const o = await vOpen(k, vAad('photo', id, pid), b.sealed), d = o && o.data;
        if (typeof d !== 'string' || d.length > MAX_PHOTO || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) throw bad('Foto di dalam cadangan rusak.', 'vaultbad');
        await ledger.setJSON(id + '/photo/' + pid, { data: d, createdAt: String(o.createdAt || iso()).slice(0, 40) });
        return { ok: true };
      }
      if (b.phase !== 'book') throw bad('Permintaan tidak valid.');
      const mode = b.mode === 'merge' ? 'merge' : 'replace';
      const o = await vOpen(k, vAad('book', id), b.sealed);
      if (!o || o.id !== id) throw bad('Cadangan ini bukan milik akun tersebut.', 'vaultbad');
      const cl = vaultClean(o);
      let added = 0, oldPhotos = [];
      const book = await casUpdate(ledger, bookKey(id), cur => {
        const bk = cur ? { rev: cur.rev || 0, tx: (cur.tx || []).slice(), settings: cur.settings || {}, plan: normPlan(cur.plan) } : { rev: 0, tx: [], settings: {}, plan: emptyPlan() };
        added = 0; oldPhotos = bk.tx.map(t => t && t.photo).filter(Boolean);
        if (mode === 'replace') { bk.tx = cl.tx.slice(); bk.settings = cl.settings; bk.plan = cl.plan; added = cl.tx.length; }
        else {
          const have = new Set(bk.tx.map(t => t.id));
          for (const t of cl.tx) if (!have.has(t.id)) { if (bk.tx.length >= MAX_TX) throw new ApiError(409, 'Batas ' + MAX_TX + ' transaksi tercapai. Pakai "Ganti" atau hapus transaksi lama dulu.', 'limit'); bk.tx.push(t); added++; }
          if (!Object.keys(bk.settings || {}).length && Object.keys(cl.settings).length) { bk.settings = cl.settings; added++; }
          for (const col of PLAN_COLS) {
            const ids = new Set(bk.plan[col].map(x => x && x.id));
            for (const p of cl.plan[col]) if (!ids.has(p.id) && bk.plan[col].length < PLAN_MAX[col]) { bk.plan[col].push(p); added++; }
          }
        }
        if (mode === 'merge' && !added) return { value: undefined, result: bk };
        if (JSON.stringify(bk.plan).length > PLAN_BYTES) throw new ApiError(409, 'Data rencana hasil pemulihan terlalu besar.', 'limit');
        bk.rev += 1;
        return { value: bk, result: bk };
      });
      if (mode === 'replace') { const keep = new Set(book.tx.map(t => t.photo).filter(Boolean)); for (const pid of new Set(oldPhotos)) if (!keep.has(pid)) await ledger.delete(id + '/photo/' + pid).catch(() => {}); }
      await touchAcct(id, { txCount: book.tx.length, lastTxAt: iso() }).catch(() => {});
      return { ok: true, n: book.tx.length, added, skipped: cl.skipped, rev: book.rev };
    },

    async 'friend.state'(b, c) { const a = await authed(c.req); return frState(a.acc.id, a.map); },

    async 'friend.add'(b, c) {
      const a = await authed(c.req), me = a.acc.id, code = frNorm(b.code), rk = 'fr-' + me, prev = await rlCheck(rk);
      if (code.length !== 8) throw bad('Kode teman tidak lengkap. Contoh: SAKU-7K2M-9QXA.');
      const hit = await meta.get('fcode/' + code, { type: 'json' }), other = hit && hit.u;
      if (!other || !frName(a.map, other)) { await rlFail(rk, prev, 10, 600000, 600000); throw bad('Kode teman tidak ditemukan. Periksa lagi kodenya.', 'nocode'); }
      if (other === me) throw bad('Itu kode Anda sendiri. Kirim kode ini ke teman, bukan dimasukkan di sini.');
      const mine = frNew(await frEnsure(me)), theirs = await frEnsure(other);
      if (mine.friends[other]) throw bad('Kalian sudah berteman.');
      if (Object.keys(mine.friends).length >= FR_MAX_F) throw bad('Jumlah teman sudah mencapai batas (' + FR_MAX_F + ').');
      const at = iso();
      if (mine.in[other] || theirs.out[me]) {
        await casUpdate(meta, frKey(me), d => { const n = frNew(d); delete n.in[other]; delete n.out[other]; n.friends[other] = at; return { value: n, result: n }; });
        await casUpdate(meta, frKey(other), d => { const n = frNew(d); delete n.in[me]; delete n.out[me]; n.friends[me] = at; return { value: n, result: n }; });
        return { result: 'friends', state: await frState(me, a.map) };
      }
      if (mine.out[other]) return { result: 'sent', state: await frState(me, a.map) };
      if (Object.keys(mine.out).length >= 30) throw bad('Terlalu banyak permintaan yang menunggu. Batalkan sebagian dulu.');
      await casUpdate(meta, frKey(me), d => { const n = frNew(d); n.out[other] = at; return { value: n, result: n }; });
      await casUpdate(meta, frKey(other), d => { const n = frNew(d); n.in[me] = at; return { value: n, result: n }; });
      return { result: 'sent', state: await frState(me, a.map) };
    },

    async 'friend.respond'(b, c) {
      const a = await authed(c.req), me = a.acc.id, id = String(b.id || ''), mine = await frEnsure(me);
      if (!mine.in[id]) throw bad('Permintaan ini sudah tidak ada.');
      if (b.accept !== true) { await frUnlink(me, id); return { state: await frState(me, a.map) }; }
      if (Object.keys(mine.friends).length >= FR_MAX_F) throw bad('Jumlah teman sudah mencapai batas (' + FR_MAX_F + ').');
      const at = iso();
      await casUpdate(meta, frKey(me), d => { const n = frNew(d); delete n.in[id]; delete n.out[id]; n.friends[id] = at; return { value: n, result: n }; });
      await casUpdate(meta, frKey(id), d => { const n = frNew(d); delete n.in[me]; delete n.out[me]; n.friends[me] = at; return { value: n, result: n }; });
      return { state: await frState(me, a.map) };
    },

    async 'friend.remove'(b, c) {
      const a = await authed(c.req), me = a.acc.id, id = String(b.id || ''); if (!id || id === me) throw bad('Teman tidak valid.');
      await frUnlink(me, id); return { state: await frState(me, a.map) };
    },

    async 'friend.share'(b, c) {
      const a = await authed(c.req), me = a.acc.id, kind = String(b.kind || ''), itemId = String(b.itemId || 'anggaran');
      if (FR_KINDS.indexOf(kind) < 0) throw bad('Jenis data tidak bisa dibagikan.');
      if (!ID_RE.test(itemId)) throw bad('ID tidak valid.');
      const mine = await frEnsure(me), key = kind + '_' + itemId, to = (Array.isArray(b.to) ? b.to : []).map(String).filter((x, i, ar) => ar.indexOf(x) === i && mine.friends[x]).slice(0, FR_MAX_F);
      if (!to.length) {
        await casUpdate(meta, frKey(me), d => { const n = frNew(d); if (!n.shares[key]) return { value: undefined, result: n }; delete n.shares[key]; return { value: n, result: n }; });
        return { state: await frState(me, a.map) };
      }
      let data, name;
      if (kind === 'budget') {
        const st = cleanSettings(b.data); data = { budget: st.budget || 0, catBudgets: st.catBudgets || {} }; name = 'Anggaran bulanan';
        if (!data.budget) throw bad('Isi batas pengeluaran dulu sebelum membagikan anggaran.');
      } else { data = cleanPlan(kind, b.data); name = String(data.name || 'Tanpa nama').slice(0, 60); }
      if (JSON.stringify(data).length > FR_BYTES) throw bad('Data terlalu besar untuk dibagikan.');
      const at = iso();
      await casUpdate(meta, frKey(me), d => {
        const n = frNew(d); if (!n.shares[key] && Object.keys(n.shares).length >= FR_MAX_S) throw new ApiError(409, 'Jumlah item yang dibagikan sudah mencapai batas (' + FR_MAX_S + ').', 'limit');
        n.shares[key] = { kind, itemId, name, to, at, data }; return { value: n, result: n };
      });
      return { state: await frState(me, a.map) };
    },

    async 'ledger.write'(b, c) {
      const a = await authed(c.req), uid = a.acc.id, list = Array.isArray(b.ops) ? b.ops : null;
      if (!list || !list.length) throw bad('Tidak ada yang disimpan.');
      if (list.length > MAX_OPS) throw bad('Terlalu banyak perubahan sekaligus.');
      const steps = list.map(o => {
        if (!o || typeof o !== 'object') throw bad('Permintaan tidak valid.');
        const k = o.k;
        if (k === 'tx.set') { if (!ID_RE.test(String(o.id))) throw bad('ID transaksi tidak valid.'); return { k, id: String(o.id), t: cleanTx(o.data) }; }
        if (k === 'tx.del' || k === 'photo.del') { if (!ID_RE.test(String(o.id))) throw bad('ID tidak valid.'); return { k, id: String(o.id) }; }
        if (k === 'photo.set') {
          if (!ID_RE.test(String(o.id))) throw bad('ID foto tidak valid.');
          const d = o.data && o.data.data;
          if (typeof d !== 'string' || d.length > MAX_PHOTO || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) throw bad('Foto tidak valid atau terlalu besar.');
          return { k, id: String(o.id), d };
        }
        if (k === 'settings.set') return { k, s: cleanSettings(o.data) };
        if (k === 'settings.del') return { k };
        if (k === 'plan.set') {
          if (PLAN_COLS.indexOf(o.c) < 0) throw bad('Jenis data tidak dikenal.');
          if (!ID_RE.test(String(o.id))) throw bad('ID tidak valid.');
          return { k, c: o.c, id: String(o.id), p: cleanPlan(o.c, o.data) };
        }
        if (k === 'plan.del') {
          if (PLAN_COLS.indexOf(o.c) < 0) throw bad('Jenis data tidak dikenal.');
          if (!ID_RE.test(String(o.id))) throw bad('ID tidak valid.');
          return { k, c: o.c, id: String(o.id) };
        }
        throw bad('Perintah tidak dikenal.');
      });
      for (const s of steps) {
        if (s.k === 'photo.set') await ledger.setJSON(uid + '/photo/' + s.id, { data: s.d, createdAt: iso() });
        else if (s.k === 'photo.del') await ledger.delete(uid + '/photo/' + s.id);
      }
      const book = await casUpdate(ledger, bookKey(uid), cur => {
        const bk = cur ? { rev: cur.rev || 0, tx: cur.tx.slice(), settings: cur.settings || {}, plan: normPlan(cur.plan) } : { rev: 0, tx: [], settings: {}, plan: emptyPlan() };
        const idx = new Map(bk.tx.map((t, i) => [t.id, i]));
        let changed = false;
        for (const s of steps) {
          if (s.k === 'tx.set') {
            const rec = Object.assign({ id: s.id }, s.t);
            if (idx.has(s.id)) bk.tx[idx.get(s.id)] = rec;
            else { if (bk.tx.length >= MAX_TX) throw new ApiError(409, 'Batas ' + MAX_TX + ' transaksi tercapai. Hapus transaksi lama dulu.', 'limit'); idx.set(s.id, bk.tx.push(rec) - 1); }
            changed = true;
          } else if (s.k === 'tx.del') {
            if (idx.has(s.id)) { bk.tx[idx.get(s.id)] = null; idx.delete(s.id); changed = true; }
          } else if (s.k === 'settings.set') { bk.settings = s.s; changed = true; }
          else if (s.k === 'settings.del') { bk.settings = {}; changed = true; }
          else if (s.k === 'plan.set') {
            const arr = bk.plan[s.c], at = arr.findIndex(x => x && x.id === s.id), rec = Object.assign({ id: s.id }, s.p);
            if (at >= 0) arr[at] = rec;
            else { if (arr.length >= PLAN_MAX[s.c]) throw new ApiError(409, 'Batas ' + PLAN_MAX[s.c] + ' data tercapai. Hapus data lama dulu.', 'limit'); arr.push(rec); }
            changed = true;
          } else if (s.k === 'plan.del') {
            const arr = bk.plan[s.c], at = arr.findIndex(x => x && x.id === s.id);
            if (at >= 0) { arr.splice(at, 1); changed = true; }
          }
        }
        bk.tx = bk.tx.filter(Boolean);
        if (!changed) return { value: undefined, result: bk };
        if (JSON.stringify(bk.plan).length > PLAN_BYTES) throw new ApiError(409, 'Data rencana sudah terlalu besar. Hapus data lama dulu.', 'limit');
        bk.rev += 1;
        return { value: bk, result: bk };
      });
      if (steps.some(s => s.k === 'tx.set' || s.k === 'tx.del')) await touchAcct(uid, { txCount: book.tx.length, lastTxAt: iso() }).catch(() => {});
      return { rev: book.rev, tx: book.tx, settings: book.settings, plan: book.plan };
    },

    /* Dicatat setelah pengguna mengunduh cadangan; dipakai untuk pengingat dan pemantauan admin (hanya waktunya, bukan isinya) */
    async 'backup.log'(b, c) {
      const a = await authed(c.req), t = iso();
      await touchAcct(a.acc.id, { lastBackupAt: t });
      return { ok: true, lastBackupAt: t };
    },

    async 'photo.get'(b, c) {
      const a = await authed(c.req), id = String(b.id || '');
      if (!ID_RE.test(id)) throw bad('ID foto tidak valid.');
      const d = await ledger.get(a.acc.id + '/photo/' + id, { type: 'json' });
      return d ? { exists: true, doc: d } : { exists: false };
    },

    async scan(b, c) {
      const a = await authed(c.req), key = env('ANTHROPIC_API_KEY');
      if (!key) throw new ApiError(501, 'Baca foto otomatis belum diaktifkan di server ini.', 'noscan');
      const prompt = String(b.prompt || ''), image = String(b.image || '');
      if (!prompt || prompt.length > 4000) throw bad('Permintaan tidak valid.');
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!m || image.length > 900_000) throw bad('Foto tidak valid atau terlalu besar.');
      const rk = 'scan-' + a.acc.id, prev = await meta.get('rl/' + rk, { type: 'json' });
      const fresh = prev && now() - prev.t < 3600000;
      if (fresh && prev.n >= 30) throw new ApiError(429, 'Terlalu sering membaca foto. Coba lagi nanti.', 'rate_limited');
      await meta.setJSON('rl/' + rk, { n: (fresh ? prev.n : 0) + 1, t: fresh ? prev.t : now(), until: 0 });
      let res;
      try {
        res = await fetchFn('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: env('ANTHROPIC_MODEL') || 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: prompt }] }] })
        });
      } catch (e) { throw new ApiError(502, 'Layanan baca foto tidak bisa dihubungi.', 'upstream'); }
      if (res.status === 429) throw new ApiError(429, 'Layanan baca foto sedang sibuk. Coba lagi nanti.', 'rate_limited');
      if (!res.ok) throw new ApiError(502, res.status === 401 ? 'Kunci ANTHROPIC_API_KEY di server tidak valid.' : 'Layanan baca foto gagal merespons.', 'upstream');
      const j = await res.json().catch(() => null);
      const text = j && Array.isArray(j.content) ? j.content.filter(x => x && x.type === 'text').map(x => x.text).join('') : '';
      if (!text) throw new ApiError(502, 'Foto belum bisa dibaca. Coba foto yang lebih jelas.', 'empty');
      return { text };
    }
  };

  /* Membuat token reset dan mengirim email. Akun yang dicari lewat email bisa lebih dari satu: satu email berisi satu tautan per akun (maks 3). */
  async function sendResets(raw, req) {
    const map = await readAccounts(), okAcc = a => a && !statusBlock(a) && MAIL_RE.test(mailOf(a));
    let list;
    if (raw.indexOf('@') >= 0) list = Object.values(map).filter(a => okAcc(a) && mailOf(a) === raw).sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || ''))).slice(0, 3);
    else { const a = map[slug(raw)]; list = okAcc(a) ? [a] : []; }
    const allowed = [];
    for (const a of list) if (await rlHit('fg-acc-' + a.id, 3, 60 * 60000)) allowed.push(a);     // lewat batas per akun: dilewati diam-diam
    if (!allowed.length) return;
    const toks = {}; allowed.forEach(a => { toks[a.id] = crypto.randomBytes(32).toString('base64url'); });
    const exp = now() + RESET_TTL; let used = [];
    await updateAccounts(m => {
      used = []; const n = Object.assign({}, m);
      for (const a of allowed) { const cur = m[a.id]; if (cur && !statusBlock(cur)) { n[a.id] = Object.assign({}, cur, { reset: { h: sha(toks[a.id]), exp } }); used.push(a); } }
      return used.length ? { value: n, result: true } : { value: undefined, result: false };
    });
    const base = appBase(req), site = String(env('MAIL_FROM_NAME') || '').replace(/[<>"\r\n]/g, '').trim() || 'SaKu';
    const byMail = {};
    used.forEach(a => { (byMail[mailOf(a)] = byMail[mailOf(a)] || []).push({ u: a.id, link: base + '/?u=' + encodeURIComponent(a.id) + '&rs=' + toks[a.id] }); });
    for (const to of Object.keys(byMail)) { const m = resetMailBody(byMail[to], site); await sendMail(to, m.subject, m.html, m.text); }
  }

  async function acctEdit(c, rawId, opt, patchFn, failMsg) {
    const a = await authed(c.req); if (opt.staff) needStaff(a); else needAdmin(a);
    const id = slug(rawId); if (!id) throw bad('Akun tidak ditemukan.');
    if (id === a.acc.id && !opt.self) throw bad('Untuk akun Anda sendiri, pakai menu Pengaturan.');
    const res = await updateAccounts(map => {
      const cur = map[id]; if (!cur) return { value: undefined, result: 'nf' };
      if (a.acc.role !== 'admin' && cur.role !== 'user') return { value: undefined, result: 'deny' };
      const p = patchFn(cur); if (!p) return { value: undefined, result: 'no' };
      for (const k of Object.keys(p)) if (p[k] === 'ADMIN') p[k] = a.acc.id;
      return { value: Object.assign({}, map, { [id]: Object.assign({}, cur, p) }), result: 'ok' };
    });
    if (res === 'nf') throw new ApiError(404, 'Akun tidak ditemukan.', 'notfound');
    if (res === 'deny') throw new ApiError(403, 'Admin pembantu hanya boleh mengelola akun pengguna biasa.', 'forbidden');
    if (res === 'no') throw bad(failMsg || 'Tidak bisa diproses.');
    return { ok: true };
  }

  /* ---------- pintu masuk HTTP ---------- */
  const PUBLIC = new Set(['status', 'setup', 'login', 'register', 'google', 'forgot', 'reset']);
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  return async function handle(req, context) {
    try {
      let body = {};
      if (req.method === 'GET') body = { op: 'status' };
      else if (req.method === 'POST') {
        const text = await req.text();
        if (text.length > MAX_BODY) throw new ApiError(413, 'Data terlalu besar.', 'toolarge');
        try { body = JSON.parse(text || '{}'); } catch (e) { throw bad('Permintaan tidak valid.'); }
      } else throw new ApiError(405, 'Metode tidak didukung.', 'method');
      const op = body && typeof body.op === 'string' && Object.prototype.hasOwnProperty.call(ops, body.op) ? body.op : null;
      if (!op) throw bad('Perintah tidak dikenal.');
      const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
      const out = await ops[op](body, { req, ipKey: sha(ip).slice(0, 24), public: PUBLIC.has(op) });
      return json(out);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message, code: e.code }, e.status);
      console.error('catat-uang error', e && e.stack || e);
      return json({ error: 'Terjadi kesalahan di server. Coba lagi.', code: 'server' }, 500);
    }
  };
}

// SaKu untuk Supabase: penyimpanan Postgres (lewat PostgREST RPC) + pembungkus HTTP (CORS, pesan penyiapan).
// Berkas ini TIDAK memakai API khusus Deno/Node supaya bisa diuji di Node; Deno.serve dipasang oleh build-supabase.js.

const sbSleep = ms => new Promise(r => setTimeout(r, ms));

/* Kunci rahasia: kunci baru (SUPABASE_SECRET_KEYS, "sb_secret_...") diutamakan; kunci lama (SUPABASE_SERVICE_ROLE_KEY) sebagai cadangan. */
function sbPickKey(env) {
  const raw = env('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const o = JSON.parse(raw);
      const k = (o && typeof o === 'object' && (o.default || Object.values(o).find(v => typeof v === 'string' && v))) || '';
      if (k) return String(k);
    } catch (e) { /* lanjut ke kunci lama */ }
  }
  return env('SUPABASE_SERVICE_ROLE_KEY') || '';
}

/* Penyimpanan kunci-nilai dengan antarmuka yang sama seperti Netlify Blobs yang dipakai core.mjs. */
function sbMakeStore(name, rpc) {
  return {
    async get(key) {
      const r = await rpc('saku_kv_get', { p_store: name, p_key: String(key) });
      return r ? r.v : null;
    },
    async getWithMetadata(key) {
      const r = await rpc('saku_kv_get', { p_store: name, p_key: String(key) });
      return r ? { data: r.v, etag: String(r.ver) } : null;
    },
    async setJSON(key, value, opts) {
      const mode = opts && opts.onlyIfMatch ? 'match' : opts && opts.onlyIfNew ? 'new' : 'any';
      const args = { p_store: name, p_key: String(key), p_val: value, p_mode: mode };
      if (mode === 'match') args.p_ver = Number(opts.onlyIfMatch);
      const r = await rpc('saku_kv_put', args);
      return { modified: !!(r && r.modified), etag: r && r.ver != null ? String(r.ver) : undefined };
    },
    async delete(key) { await rpc('saku_kv_del', { p_store: name, p_key: String(key) }); },
    async list(opts) {
      const keys = await rpc('saku_kv_list', { p_store: name, p_prefix: (opts && opts.prefix) || '' });
      return { blobs: (Array.isArray(keys) ? keys : []).map(key => ({ key })) };
    }
  };
}

function sbMakeHandler({ createApi, env, fetchFn }) {
  const doFetch = fetchFn || fetch;
  const state = { setupErr: '' };
  const baseUrl = () => String(env('SUPABASE_URL') || '').replace(/\/+$/, '');

  async function rpc(fn, args) {
    const url = baseUrl(), key = sbPickKey(env);
    if (!url || !key) {
      state.setupErr = 'Kunci rahasia Supabase tidak terbaca oleh fungsi. Pastikan fungsi di-deploy di proyek Supabase (SUPABASE_URL dan kunci rahasia terisi otomatis).';
      throw new Error('kunci/URL Supabase kosong');
    }
    const headers = { 'content-type': 'application/json', apikey: key };
    if (!/^sb_/.test(key)) headers.authorization = 'Bearer ' + key;   // kunci lama berupa JWT; kunci baru hanya lewat header apikey
    let res = null, text = '';
    for (let i = 0; i < 3; i++) {
      try {
        res = await doFetch(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify(args) });
        text = await res.text();
      } catch (e) {
        res = null;
        if (i === 2) throw e;
        await sbSleep(80 * (i + 1)); continue;
      }
      if ([502, 503, 504].indexOf(res.status) >= 0 && i < 2) { await sbSleep(120 * (i + 1)); continue; }
      break;
    }
    if (!res.ok) {
      let j = null; try { j = JSON.parse(text); } catch (e) { j = null; }
      const code = (j && (j.code || j.error_code)) || '', msg = (j && (j.message || j.msg || j.error)) || text.slice(0, 200);
      if (code === 'PGRST202' || code === '42883' || code === '42P01' || res.status === 404) state.setupErr = 'Database Supabase belum disiapkan. Jalankan berkas migrasi SQL (supabase/migrations/…sql) di SQL Editor, lalu muat ulang halaman ini.';
      else if (res.status === 401 || res.status === 403 || /invalid api key|invalid jwt|permission denied/i.test(String(msg))) state.setupErr = 'Fungsi tidak diizinkan mengakses database. Pastikan fungsi di-deploy di proyek yang sama dengan database dan memakai kunci rahasia bawaan Supabase.';
      throw new Error('supabase ' + fn + ' ' + res.status + ' ' + code + ' ' + msg);
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { throw new Error('jawaban Supabase bukan JSON: ' + text.slice(0, 100)); }
  }

  const api = createApi({ meta: sbMakeStore('meta', rpc), ledger: sbMakeStore('ledger', rpc), env });

  /* Asal yang diizinkan: ALLOWED_ORIGINS (dipisah koma) atau semua asal bila tidak diisi. API memakai token Bearer (bukan cookie), jadi aman. */
  function corsHeaders(req) {
    const list = String(env('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    const origin = req.headers.get('origin') || '';
    const h = {
      'access-control-allow-headers': 'authorization, content-type, x-client-info, apikey',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-max-age': '86400'
    };
    if (!list.length) h['access-control-allow-origin'] = '*';
    else { h.vary = 'origin'; if (origin && list.indexOf(origin.replace(/\/+$/, '')) >= 0) h['access-control-allow-origin'] = origin; }
    return h;
  }
  /* IP pelanggan untuk pembatasan percobaan masuk. Hanya header yang dipasang infrastruktur (Cloudflare) yang dipercaya;
     header buatan klien (mis. x-nf-client-connection-ip) tidak dipakai. */
  function clientIp(req) {
    const h = n => (req.headers.get(n) || '').trim();
    return h('cf-connecting-ip') || h('x-real-ip') || h('x-forwarded-for').split(',')[0].trim() || 'unknown';
  }

  return async function handle(req) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    state.setupErr = '';
    let res;
    try { res = await api(req, { ip: clientIp(req) }); }
    catch (e) { res = new Response(JSON.stringify({ error: 'Terjadi kesalahan di server. Coba lagi.', code: 'server' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } }); }
    if (res.status === 500 && state.setupErr) {
      const msg = state.setupErr; state.setupErr = '';
      res = new Response(JSON.stringify({ error: msg, code: 'dbsetup' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const headers = new Headers(res.headers);
    Object.keys(cors).forEach(k => headers.set(k, cors[k]));
    return new Response(res.body, { status: res.status, headers });
  };
}

/* ---------- Pintu masuk Supabase Edge Function ---------- */
const sbHandle = sbMakeHandler({ createApi, env: k => Deno.env.get(k), fetchFn: fetch });
Deno.serve(sbHandle);
