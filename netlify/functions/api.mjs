// API de Monasfit Equipos (Netlify Functions + Netlify Blobs)
// Variables de entorno en Netlify:
//   ADMIN_PASSWORD  (obligatoria) contraseña del coordinador
//   ACCESS_CODE     (opcional)    código que debe escribir quien abre la app
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, timingSafeEqual, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, createCipheriv, sign as cSign } from "node:crypto";

export const config = { path: "/api/*" };

const TEAMS = 12;
const KEYS = ["config", "teams", "teachers", "bookings", "settings"];
// Franjas en las que el alumnado está en el aula Ateca (se repiten cada semana).
// Se pueden cambiar en Gestión → Disponibilidad para reservar.
const DEFAULT_SETTINGS = {
  cap: 4,
  open: {1:[1,2],2:[1,5,6],3:[1,2,3,4],4:[3,4,5],5:[4,5]},
  resp: {"1-1":"Fernando","1-2":"Fernando","2-1":"Fernando","2-5":"Fran","2-6":"Fran","3-1":"Fernando","3-2":"Fernando","3-3":"Fran","3-4":"Fran","4-3":"Fran","4-4":"Fran","4-5":"Fran","5-4":"Fernando","5-5":"Fernando"},
  closed: [],
  horizon: 21,
};
const FALLBACK = {
  config: { nextTeam: 1 },
  teams: {},
  teachers: {},
  bookings: [],
  settings: DEFAULT_SETTINGS,
  emails: {},
};
// Minuto del día en que empieza cada franja (7:55, 8:50, 9:45, 11:10, 12:05, 13:00)
const SLOT_START_MIN = [null, 475, 530, 585, 670, 725, 780];
const MAX_UPCOMING_PER_TEACHER = 8;

const store = () => getStore({ name: "monasfit-equipos", consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
// Error de regla de negocio (se enseña tal cual a quien reserva)
class Rule extends Error { constructor(m, data) { super(m); this.data = data; } }
const fail = (msg, data) => { throw new Rule(msg, data); };

const digest = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => !!a && !!b && timingSafeEqual(digest(a), digest(b));
const isAdmin = (req) => {
  const p = process.env.ADMIN_PASSWORD;
  return !!p && same(req.headers.get("x-admin"), p);
};
const codeOk = (req) => {
  const c = process.env.ACCESS_CODE;
  return !c || same(req.headers.get("x-code"), c);
};

const int = (v, a, b) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= a && n <= b ? n : null;
};
const str = (v, max) => String(v == null ? "" : v).slice(0, max);
// Distancia de edición (para detectar erratas al escribir un correo)
const editDist = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
};
const normEmail = (s) => String(s == null ? "" : s).trim().toLowerCase();
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const tkeyOf = (n) =>
  String(n).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "sin-nombre";

/* ---------- Fechas (hora de Madrid) ---------- */
const madridFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function madridNow() {
  const p = {};
  for (const x of madridFmt.formatToParts(new Date())) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
const parts = (s) => s.split("-").map(Number);
const validDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parts(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const dow = (s) => { const [y, m, d] = parts(s); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const addDays = (s, n) => {
  const [y, m, d] = parts(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

// Curso escolar actual (septiembre a agosto), por ejemplo "2026-27"
const courseNow = () => {
  const d = madridNow().date;
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  const s0 = m >= 9 ? y : y - 1;
  return s0 + "-" + String((s0 + 1) % 100).padStart(2, "0");
};

/* ---------- Almacenamiento y bloqueo ---------- */
async function read(key) {
  const v = await store().get(key, { type: "json" });
  return v && typeof v === "object" && "rev" in v ? v : { rev: 0, data: FALLBACK[key] };
}
async function write(key, cur, data) {
  const rev = cur.rev + 1;
  await store().setJSON(key, { rev, data });
  if (key === "bookings") { try { queueBookingPushes(cur.data, data); } catch {} }
  return rev;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Un solo cambio a la vez: evita que dos reservas simultáneas pisen los mismos datos.
async function withLock(fn) {
  const s = store();
  for (let i = 0; i < 40; i++) {
    const cur = await s.getWithMetadata("lock", { type: "json" });
    const now = Date.now();
    let res;
    if (!cur) res = await s.setJSON("lock", { t: now }, { onlyIfNew: true });
    else if (now - ((cur.data && cur.data.t) || 0) > 10000) res = await s.setJSON("lock", { t: now }, { onlyIfMatch: cur.etag });
    else { await sleep(150); continue; }
    if (res === undefined || res.modified !== false) {
      try { return await fn(); } finally { try { await s.delete("lock"); } catch {} }
    }
    await sleep(100);
  }
  const e = new Error("busy");
  e.busy = true;
  throw e;
}

/* ---------- Validación de lo que escribe el coordinador ---------- */
function cleanBookings(v) {
  if (!Array.isArray(v) || v.length > 4000) return null;
  const out = [];
  for (const b of v) {
    const slot = int(b && b.slot, 1, 6);
    if (!b || !/^\d{4}-\d{2}-\d{2}$/.test(b.date || "") || !slot || !["E", "V"].includes(b.type) || !b.tkey) return null;
    out.push({
      id: str(b.id, 40),
      date: b.date,
      slot,
      type: b.type,
      teacher: str(b.teacher, 80),
      tkey: str(b.tkey, 80),
      team: b.team == null ? null : int(b.team, 1, TEAMS),
      createdAt: Number(b.createdAt) || 0,
      conf: ["pending", "ok"].includes(b.conf) ? b.conf : undefined,
      dueAt: Number(b.dueAt) || undefined,
      assignedAt: Number(b.assignedAt) || undefined,
      reminded: b.reminded === true ? true : undefined,
      confirmedAt: Number(b.confirmedAt) || undefined,
      subst: b.subst === true ? true : undefined,
      auto: b.auto === true ? true : undefined,
      declined: Array.isArray(b.declined) && b.declined.length
        ? b.declined.slice(0, 20).map((d) => ({ t: int(d && d.t, 1, TEAMS), why: ["no", "timeout", "admin"].includes(d && d.why) ? d.why : "no", at: Number(d && d.at) || 0 })).filter((d) => d.t)
        : undefined,
    });
  }
  return out;
}
function cleanTeachers(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length > 400) return null;
  const out = {};
  for (const k of keys) {
    if (!/^[a-z0-9-]{1,80}$/.test(k)) continue;
    const t = v[k] || {};
    out[k] = { tkey: k, name: str(t.name, 80), valTeam: t.valTeam == null ? null : int(t.valTeam, 1, TEAMS), course: str(t.course, 12).trim(), archived: !!t.archived, ...(t.needsVal ? { needsVal: true } : {}), ...(t.self ? { self: true, joined: str(t.joined, 10) } : {}) };
  }
  return out;
}
function cleanTeams(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (let n = 1; n <= TEAMS; n++) {
    if (v[n]) out[n] = { n, members: str(v[n].members, 120) };
  }
  return out;
}
function cleanConfig(v) {
  if (!v || typeof v !== "object") return null;
  return { nextTeam: int(v.nextTeam, 1, TEAMS) || 1, updatedAt: Number(v.updatedAt) || 0 };
}
function cleanSettings(v) {
  if (!v || typeof v !== "object") return null;
  const cap = int(v.cap, 1, TEAMS);
  if (!cap) return null;
  const open = {};
  for (let d = 1; d <= 5; d++) {
    const a = v.open && Array.isArray(v.open[d]) ? v.open[d] : [];
    open[d] = [...new Set(a.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 6))].sort((x, y) => x - y);
  }
  const resp = {};
  if (v.resp && typeof v.resp === "object") {
    for (const k of Object.keys(v.resp)) {
      if (!/^[1-5]-[1-6]$/.test(k)) continue;
      const t = str(v.resp[k], 40).trim();
      if (t) resp[k] = t;
    }
  }
  // "2026-11-20" cierra el día entero; "2026-11-20#3" cierra solo la franja 3
  const closed = Array.isArray(v.closed) ? [...new Set(v.closed.filter((x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}(#[1-6])?$/.test(x) && validDate(x.slice(0, 10))))].sort().slice(0, 600) : [];
  const horizon = int(v.horizon, 7, 120) || 21;
  return { cap, open, resp, closed, horizon };
}
const CLEAN = { bookings: cleanBookings, teachers: cleanTeachers, teams: cleanTeams, config: cleanConfig, settings: cleanSettings };

/* ---------- Rotación (misma lógica que el coordinador) ---------- */
const TYPE_RANK = { V: 0, E: 1 };
const cmp = (a, b) =>
  a.date.localeCompare(b.date) || a.slot - b.slot || (TYPE_RANK[a.type] || 0) - (TYPE_RANK[b.type] || 0) ||
  (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id));

// Reparto equitativo: cada sesión sin equipo va al equipo libre en esa franja que lleva MENOS sesiones
// (si empatan, el siguiente en el orden de rotación desde "ptr"). Los equipos que ya renunciaron a esa sesión se saltan.
// La valoración de un profesor la hace siempre su equipo; si ese equipo renunció a esa sesión, la hace otro (subst).
// onlyIds (opcional): solo se asignan esas reservas.
function planAssign(bookings, teachers, ptr, onlyIds) {
  const all = bookings.map((b) => ({ ...b }));
  const val = {};
  Object.keys(teachers).forEach((k) => { val[k] = teachers[k].valTeam || null; });
  all.filter((b) => b.type === "V" && b.team && !b.subst).sort(cmp).forEach((b) => { if (!val[b.tkey]) val[b.tkey] = b.team; });
  const load = {};
  for (let t = 1; t <= TEAMS; t++) load[t] = 0;
  all.forEach((b) => { if (b.team) load[b.team]++; });
  const pend = all.filter((b) => !b.team && (!onlyIds || onlyIds.has(b.id))).sort(cmp);
  const assign = [], vals = [];
  for (const b of pend) {
    const dec = (b.declined || []).map((d) => d.t);
    let team = null, subst = false;
    const busy = {};
    all.forEach((x) => { if (x.team && x.date === b.date && x.slot === b.slot) busy[x.team] = 1; });
    if (b.type === "V" && val[b.tkey] && !dec.includes(val[b.tkey]) && !busy[val[b.tkey]]) team = val[b.tkey];
    else {
      if (b.type === "V" && val[b.tkey]) subst = true;
      let best = null;
      for (let i = 0; i < TEAMS; i++) {
        const c = ((ptr - 1 + i) % TEAMS) + 1;
        if (busy[c] || dec.includes(c)) continue;
        if (best === null || load[c] < load[best]) best = c;
      }
      if (best) { team = best; ptr = (best % TEAMS) + 1; }
      if (b.type === "V" && team && !val[b.tkey]) { val[b.tkey] = team; vals.push({ tkey: b.tkey, team }); }
    }
    if (team) { b.team = team; load[team]++; assign.push({ id: b.id, team, subst }); }
  }
  return { assign, vals, ptr };
}

/* ---------- Confirmación del equipo asignado ---------- */
const RESPOND_H = 12;  // el equipo puede responder hasta 12 h antes de la sesión
const GRACE_MIN = 180; // si se le asigna tarde, tiene al menos 3 h para responder
const LAST_MIN = 60;   // y nunca se espera más allá de 1 h antes del inicio
const dayNum = (s) => { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d) / 86400000; };
function minsToStart(date, slot) {
  const n = madridNow();
  return (dayNum(date) - dayNum(n.date)) * 1440 + SLOT_START_MIN[slot] - n.min;
}
function dueFor(b, nowMs) {
  const start = nowMs + minsToStart(b.date, b.slot) * 60000;
  return Math.min(start - LAST_MIN * 60000, Math.max(start - RESPOND_H * 3600000, nowMs + GRACE_MIN * 60000));
}
// Marca una asignación hecha por el sistema como "pendiente de confirmar" (o confirmada si ya no hay tiempo de esperar)
function stampPending(b, nowMs) {
  b.assignedAt = nowMs;
  delete b.confirmedAt; delete b.reminded;
  const due = dueFor(b, nowMs);
  if (due <= nowMs) { b.conf = "ok"; b.auto = true; delete b.dueAt; }
  else { b.conf = "pending"; b.dueAt = Math.round(due); delete b.auto; }
}
// La valoración confirmada fija el equipo que valora al profesor (salvo una sustitución puntual)
function settleVal(b, tdata) {
  if (b.type === "V" && b.team && b.conf !== "pending" && !b.subst && tdata[b.tkey] && !tdata[b.tkey].valTeam) {
    tdata[b.tkey] = { ...tdata[b.tkey], valTeam: b.team };
    return true;
  }
  return false;
}
const needSweep = (list, nowMs) => list.some((b) => b.conf === "pending" && ((b.team && b.dueAt && nowMs >= b.dueAt) || (!b.team && b.declined && b.declined.length)));
// Pasa al siguiente equipo las sesiones cuyo plazo ha vencido, y reintenta las que se quedaron sin equipo
function sweepBookings(list, teachers, ptr, nowMs) {
  const all = list.map((b) => ({ ...b }));
  const tdata = { ...teachers };
  const reset = new Set();
  let changed = false, tchanged = false;
  for (const b of all) {
    if (b.conf === "pending" && b.team && b.dueAt && nowMs >= b.dueAt) {
      b.declined = [...(b.declined || []), { t: b.team, why: "timeout", at: nowMs }];
      b.team = null; b.subst = undefined; delete b.dueAt;
      reset.add(b.id); changed = true;
    } else if (b.conf === "pending" && !b.team && b.declined && b.declined.length) reset.add(b.id);
  }
  if (reset.size) {
    const plan = planAssign(all, tdata, ptr, reset);
    ptr = plan.ptr;
    for (const a of plan.assign) {
      const b = all.find((x) => x.id === a.id);
      b.team = a.team; b.subst = a.subst || undefined; stampPending(b, nowMs); changed = true;
      if (settleVal(b, tdata)) tchanged = true;
    }
  }
  return { all, tdata, ptr, changed, tchanged };
}
async function runSweep() {
  return withLock(async () => {
    const [cfg, teachers, bookings] = await Promise.all(["config", "teachers", "bookings"].map(read));
    const nowMs = Date.now();
    if (!needSweep(bookings.data, nowMs)) return;
    const r = sweepBookings(bookings.data, teachers.data, Math.min(TEAMS, Math.max(1, Number(cfg.data.nextTeam) || 1)), nowMs);
    if (!r.changed) return;
    if (r.tchanged) await write("teachers", teachers, r.tdata);
    await write("config", cfg, { nextTeam: r.ptr, updatedAt: nowMs });
    await write("bookings", bookings, r.all);
  });
}
const REMIND_BEFORE_MS = 3 * 3600000; // recordatorio cuando faltan 3 h para el límite
// Tarea programada: pasa de equipo lo vencido y recuerda confirmar a quien sigue sin hacerlo
export async function cronJob() {
  await runSweep();
  const nowMs = Date.now();
  const pre = await read("bookings");
  const due = pre.data.filter((b) => b.conf === "pending" && b.team && b.dueAt && !b.reminded && nowMs >= b.dueAt - REMIND_BEFORE_MS && nowMs < b.dueAt && b.date >= madridNow().date && (!b.assignedAt || b.dueAt - b.assignedAt > REMIND_BEFORE_MS + 3600000));
  if (due.length) {
    await withLock(async () => {
      const cur = await read("bookings");
      const ids = new Set(due.map((b) => b.id));
      const mine = cur.data.filter((b) => ids.has(b.id) && b.conf === "pending" && b.team && !b.reminded);
      if (!mine.length) return;
      const done = new Set(mine.map((b) => b.id));
      await write("bookings", cur, cur.data.map((b) => (done.has(b.id) ? { ...b, reminded: true } : b)));
      for (const b of mine) outbox.push({ team: b.team, msg: { title: "Equipo " + b.team + ": recordatorio, confirmad " + pushWhatKind(b), body: pushWhat(b) + ". Si no confirmáis antes del " + pushDue(b.dueAt) + ", pasará a otro equipo.", tag: "bk-" + b.id, url: "/#mi-equipo" } });
    });
  }
  await flushPush();
  return { reminded: due.length };
}
async function respond(req, b, admin) {
  const id = str(b && b.id, 40);
  const ans = b && b.answer;
  if (!["ok", "no"].includes(ans)) fail("Respuesta no válida.");
  let team = int(b && b.team, 1, TEAMS);
  if (!admin) {
    if (!team) fail("Elige tu equipo.");
    if (!(await teamAuth(req, team, true))) fail("La clave de tu equipo no es válida. Vuelve a elegir tu equipo e introdúcela.");
  }
  return withLock(async () => {
    const [cfg, teams, teachers, bookings] = await Promise.all(["config", "teams", "teachers", "bookings"].map(read));
    const all = bookings.data.map((x) => ({ ...x }));
    const bk = all.find((x) => x.id === id);
    if (!bk) fail("Esa sesión ya no existe.");
    if (!bk.team) fail("Ahora mismo esta sesión no tiene equipo asignado.");
    if (admin) team = bk.team;
    if (team !== bk.team) fail("Esta sesión ya no es de tu equipo.");
    if (minsToStart(bk.date, bk.slot) <= 0) fail("Esa sesión ya ha empezado.");
    const nowMs = Date.now();
    const tdata = { ...teachers.data };
    if (ans === "ok") {
      if (bk.conf === "pending") {
        bk.conf = "ok"; bk.confirmedAt = nowMs; delete bk.dueAt; delete bk.auto;
        if (settleVal(bk, tdata)) await write("teachers", teachers, tdata);
        await write("bookings", bookings, all);
      }
      return { ok: true, booking: bk };
    }
    // Renuncia: la sesión pasa al equipo libre con menos sesiones
    bk.declined = [...(bk.declined || []), { t: team, why: admin ? "admin" : "no", at: nowMs }];
    bk.team = null; bk.subst = undefined; bk.conf = "pending"; delete bk.dueAt; delete bk.confirmedAt; delete bk.auto;
    const plan = planAssign(all, tdata, Math.min(TEAMS, Math.max(1, Number(cfg.data.nextTeam) || 1)), new Set([id]));
    let tch = false;
    for (const a of plan.assign) {
      bk.team = a.team; bk.subst = a.subst || undefined; stampPending(bk, nowMs);
      if (settleVal(bk, tdata)) tch = true;
    }
    if (tch) await write("teachers", teachers, tdata);
    await write("config", cfg, { nextTeam: plan.ptr, updatedAt: nowMs });
    await write("bookings", bookings, all);
    const tm = bk.team && teams.data[bk.team];
    return { ok: true, booking: bk, now: bk.team || null, members: (tm && tm.members) || "" };
  });
}

/* ---------- Quién ve y quién escribe cada prescripción ---------- */
const sees = (tkey, team, teachers, bookings) =>
  (teachers[tkey] && teachers[tkey].valTeam === team) ||
  bookings.some((b) => b.tkey === tkey && b.team === team && b.conf !== "pending");
const edits = (tkey, team, teachers, bookings) =>
  (teachers[tkey] && teachers[tkey].valTeam === team) ||
  bookings.some((b) => b.tkey === tkey && b.type === "V" && b.team === team && b.conf !== "pending" && !b.subst);

// Criterios con los que el profesorado puntúa a los equipos (1 a 5), distintos para valoración y entrenamiento
const RATE_ITEMS = {
  V: ["puntualidad", "trato", "tecnica", "prescripcion", "global"],
  E: ["puntualidad", "trato", "tecnica", "adaptacion", "global"],
};
const scoreOf = (v) => {
  if (v && v.scores) {
    const xs = Object.values(v.scores).map(Number).filter((n) => n >= 1 && n <= 5);
    if (xs.length) return xs.reduce((a, n) => a + n, 0) / xs.length;
  }
  return Number(v && v.stars) || 0;
};
// Equipos que ya han atendido a un profesor: el que lo valora (V) y los que lo han entrenado (E, hasta hoy).
function rateTeams(t, tkey, bookings) {
  const out = [];
  if (t && t.valTeam) out.push({ kind: "V", team: t.valTeam, dates: [] });
  const today = madridNow().date;
  const byTeam = new Map();
  for (const b of bookings) {
    if (b.tkey === tkey && b.type === "E" && b.team && b.date <= today) {
      if (!byTeam.has(b.team)) byTeam.set(b.team, []);
      byTeam.get(b.team).push(b.date);
    }
  }
  for (const [team, dates] of [...byTeam].sort((a, c) => Math.min(...a[1].map((d) => +d.replace(/-/g, ""))) - Math.min(...c[1].map((d) => +d.replace(/-/g, ""))))) out.push({ kind: "E", team, dates: dates.sort() });
  return out;
}

/* ---------- Reservar y cancelar (profesorado) ---------- */
async function book(b) {
  const type = b && b.type;
  const date = str(b && b.date, 10);
  const slot = int(b && b.slot, 1, 6);
  if (!["E", "V"].includes(type)) fail("Elige entrenamiento o valoración.");
  if (!validDate(date) || !slot) fail("Fecha o franja no válida.");

  await runSweep();
  return withLock(async () => {
    const [cfg, teams, teachers, bookings, settings] = await Promise.all(KEYS.map(read));
    // Con correos registrados, quien reserva se identifica con su correo corporativo.
    const emails = await read("emails");
    let name, tk, newEmail = null;
    if (Object.keys(emails.data).length) {
      const em = normEmail(b && b.email);
      if (!em || !EMAIL_RE.test(em) || em.length > 120) fail("Escribe tu correo corporativo completo.");
      tk = emails.data[em];
      if (tk && teachers.data[tk]) name = teachers.data[tk].name;
      else {
        // Correo nuevo: puede unirse al proyecto si es del mismo dominio que los ya registrados
        // y no parece una errata de un correo existente.
        const [loc, dom] = em.split("@");
        const known = Object.keys(emails.data).map((e) => e.split("@"));
        if (!known.some((k) => k[1] === dom))
          fail("Ese correo no es del dominio del proyecto. Usa tu correo corporativo.");
        if (known.some((k) => k[1] === dom && editDist(k[0], loc) <= 1))
          fail("Ese correo se parece mucho a otro ya registrado. Revisa que esté bien escrito; si de verdad es el tuyo, pide al coordinador que te añada.");
        const nm = str(b && b.name, 60).trim().replace(/\s+/g, " ");
        if (nm.length < 2) fail("Es tu primera vez en el proyecto: escribe tu nombre y apellidos para unirte.", { needName: true });
        tk = tkeyOf(nm);
        if (teachers.data[tk]) fail("Ya hay alguien con ese nombre en el proyecto. Pide al coordinador que asocie tu correo.");
        name = nm;
        newEmail = em;
      }
    } else {
      name = str(b && b.name, 60).trim().replace(/\s+/g, " ");
      if (name.length < 2) fail("Escribe tu nombre.");
      tk = tkeyOf(name);
    }
    const st = settings.data;
    const now = madridNow();
    if (date < now.date) fail("Esa fecha ya ha pasado.");
    if (date > addDays(now.date, st.horizon)) fail("Todavía no se puede reservar tan adelante.");
    const wd = dow(date);
    if (wd < 1 || wd > 5) fail("Solo se reserva de lunes a viernes.");
    if (!((st.open[wd] || []).includes(slot)) || st.closed.includes(date) || st.closed.includes(date + "#" + slot)) fail("Esa franja no está disponible.");
    if (date === now.date && now.min >= SLOT_START_MIN[slot]) fail("Esa franja ya ha empezado.");

    const list = bookings.data;
    if (list.some((x) => x.tkey === tk && x.date === date && x.slot === slot)) fail("Ya tienes una reserva en esa franja.");
    if (list.filter((x) => x.tkey === tk && x.date >= now.date).length >= MAX_UPCOMING_PER_TEACHER)
      fail("Ya tienes muchas reservas próximas. Cancela alguna o pide ayuda al coordinador.");
    if (list.length >= 3900) fail("No se pueden guardar más reservas. Avisa al coordinador.");
    const here = list.filter((x) => x.date === date && x.slot === slot);
    if (here.length >= st.cap) fail("Esa franja está completa.");

    const tdata = { ...teachers.data };
    const t = tdata[tk] ? { ...tdata[tk] } : { tkey: tk, name, valTeam: null, course: courseNow(), archived: false, needsVal: true, ...(newEmail ? { self: true, joined: now.date } : {}) };
    let teachersDirty = !tdata[tk];
    if (t.archived) { t.archived = false; t.course = courseNow(); teachersDirty = true; }
    // Profesor nuevo: primero valoración y prescripción; hasta entonces no puede reservar entrenamiento guiado.
    if (type === "E" && t.needsVal) {
      const pr = await store().get("prescriptions/" + tk, { type: "json" });
      const fi = pr ? null : await readFicha(tk);
      const hasPresDoc = !!(fi && (fi.docs || []).some((d) => d.cat === "prescripcion"));
      if (!pr && !hasPresDoc) fail("Como es tu primera vez en el proyecto, primero te hacemos la valoración y el equipo te prepara la prescripción. Reserva una valoración; cuando tu prescripción esté lista podrás reservar entrenamientos.");
      delete t.needsVal; teachersDirty = true;
    }
    const priorV = list.find((x) => x.tkey === tk && x.type === "V" && x.team && x.conf !== "pending" && !x.subst);
    if (!t.valTeam && priorV) { t.valTeam = priorV.team; teachersDirty = true; }
    const pendV = list.find((x) => x.tkey === tk && x.type === "V" && x.team && !x.subst);
    const vt = t.valTeam || (pendV && pendV.team) || null;
    if (type === "V" && vt && here.some((x) => x.team === vt))
      fail(`A ti te valora siempre el equipo ${vt}, que a esa hora ya tiene otra sesión. Elige otra franja.`);
    tdata[tk] = t;

    const id = randomBytes(5).toString("hex") + Date.now().toString(36);
    const nb = { id, date, slot, type, teacher: t.name || name, tkey: tk, team: null, createdAt: Date.now() };
    const all = [...list, nb];
    const ptr = Math.min(TEAMS, Math.max(1, Number(cfg.data.nextTeam) || 1));
    const plan = planAssign(all, tdata, ptr, new Set([id]));
    plan.assign.forEach((a) => { const x = all.find((y) => y.id === a.id); if (x) { x.team = a.team; x.subst = a.subst || undefined; stampPending(x, Date.now()); if (settleVal(x, tdata)) teachersDirty = true; } });
    if (!nb.team) fail("En esa franja no queda ningún equipo libre. Elige otra.");

    if (teachersDirty) await write("teachers", teachers, tdata);
    if (newEmail) await write("emails", emails, { ...emails.data, [newEmail]: tk });
    await write("config", cfg, { nextTeam: plan.ptr, updatedAt: Date.now() });
    await write("bookings", bookings, all);
    const token = randomBytes(18).toString("hex");
    await store().setJSON("tokens/" + id, { h: digest(token).toString("hex"), at: Date.now() });
    const tm = teams.data[nb.team];
    return { ok: true, token, booking: nb, members: (tm && tm.members) || "" };
  });
}

async function cancel(b) {
  const id = str(b && b.id, 40);
  const token = str(b && b.token, 100);
  if (!id || !token) fail("Falta la reserva.");
  return withLock(async () => {
    const rec = await store().get("tokens/" + id, { type: "json" });
    if (!rec || !rec.h || !timingSafeEqual(Buffer.from(rec.h), Buffer.from(digest(token).toString("hex"))))
      fail("No puedes cancelar esta reserva desde este dispositivo. Pide ayuda al coordinador.");
    const [teachers, bookings] = await Promise.all([read("teachers"), read("bookings")]);
    const bk = bookings.data.find((x) => x.id === id);
    if (!bk) fail("Esa reserva ya no existe.");
    if (bk.date < madridNow().date) fail("No se pueden cancelar reservas pasadas.");
    const rest = bookings.data.filter((x) => x.id !== id);
    await write("bookings", bookings, rest);
    if (bk.type === "V" && !rest.some((x) => x.tkey === bk.tkey && x.type === "V")) {
      const t = teachers.data[bk.tkey];
      if (t && t.valTeam === bk.team && !bk.subst) await write("teachers", teachers, { ...teachers.data, [bk.tkey]: { ...t, valTeam: null } });
    }
    if (bk.type === "E" && bk.team && !rest.some((x) => x.type === "E" && x.createdAt > bk.createdAt)) {
      // Era el último entrenamiento asignado: el turno vuelve a ese equipo (no se "gasta" la rotación).
      const cfg = await read("config");
      await write("config", cfg, { nextTeam: bk.team, updatedAt: Date.now() });
    }
    await store().delete("tokens/" + id);
    return { ok: true };
  });
}

/* ---------- Fichas personales del profesorado (clave propia) ---------- */
const KEY_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin I, L, O, 0, 1 para no confundir
const newKey = () => { let k = ""; for (const x of randomBytes(6)) k += KEY_ALPHA[x % KEY_ALPHA.length]; return k; };
const normKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const keyHash = (salt, k) => createHash("sha256").update(salt + ":" + normKey(k)).digest("hex");
const TKEY_RE = /^[a-z0-9-]{1,80}$/;
const MAX_DOC = 4 * 1024 * 1024;
const DOC_CATS = ["valoracion", "parq", "prescripcion", "otro"];
const DOC_TYPES = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  txt: "text/plain; charset=utf-8", docx: "application/octet-stream", xlsx: "application/octet-stream",
};

// Equipo que entrena (o ha entrenado) a un profesor: solo consulta su ficha.
const trains = (tkey, team, bookings) => bookings.some((b) => b.tkey === tkey && b.team === team && b.conf !== "pending" && (b.type === "E" || b.subst));

// Clave de equipo (alumnado). Si el equipo aún no tiene clave, el acceso sigue abierto como antes.
async function teamAuth(req, team, count) {
  if (!team) return false;
  const s = store();
  const rec = await s.get("teamkeys/" + team, { type: "json" });
  if (!rec) return true;
  const kp = req.headers.get("x-team-key");
  if (!kp) return false;
  const now = Date.now();
  const at = await s.get("att/team-" + team, { type: "json" });
  if (at && at.until > now) fail("Demasiados intentos. Espera 15 minutos.");
  const a = Buffer.from(rec.h), b = Buffer.from(keyHash(rec.s, kp));
  if (a.length === b.length && timingSafeEqual(a, b)) {
    if (at) { try { await s.delete("att/team-" + team); } catch {} }
    return true;
  }
  if (count) {
    const n = ((at && at.n) || 0) + 1;
    await s.setJSON("att/team-" + team, n >= 8 ? { n: 0, until: now + 15 * 60000 } : { n, until: 0 });
  }
  return false;
}

// Devuelve "admin", "key" (clave del profesor), "team" (equipo que lo valora) o "trainer" (equipo que lo entrena, solo lectura).
async function fichaAccess(req, tkey, admin) {
  if (!TKEY_RE.test(tkey || "")) fail("Profesor no válido.");
  if (admin) return "admin";
  const kp = req.headers.get("x-tpass");
  if (kp) {
    const s = store();
    const now = Date.now();
    const at = await s.get("att/" + tkey, { type: "json" });
    if (at && at.until > now) fail("Demasiados intentos. Espera unos minutos y vuelve a probar.");
    const rec = await s.get("keys/" + tkey, { type: "json" });
    if (!rec) fail("Este profesor aún no tiene clave. Pídesela al coordinador.");
    const a = Buffer.from(rec.h), b = Buffer.from(keyHash(rec.s, kp));
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (at) { try { await s.delete("att/" + tkey); } catch {} }
      return "key";
    }
    const n = ((at && at.n) || 0) + 1;
    await s.setJSON("att/" + tkey, n >= 5 ? { n: 0, until: now + 15 * 60000 } : { n, until: 0 });
    fail(n >= 5 ? "Demasiados intentos. Espera 15 minutos." : "Clave incorrecta.");
  }
  const team = int(req.headers.get("x-team"), 1, TEAMS);
  if (team) {
    /* Cualquier equipo con su clave puede abrir, descargar, subir y borrar en la ficha de cualquier profesor
       (así otro equipo puede cubrir una valoración o prescripción que no se hizo). */
    if (await teamAuth(req, team, true)) return "team";
    fail("La clave de tu equipo no es válida. Vuelve a elegir tu equipo e introdúcela.");
  }
  fail("No tienes acceso a esta ficha.");
}

const EMPTY_FICHA = () => ({ valoraciones: [], entrevista: {}, docs: [], updatedAt: 0 });
const readFicha = async (tkey) => {
  const f = await store().get("ficha/" + tkey, { type: "json" });
  return { ...EMPTY_FICHA(), ...(f || {}), tkey };
};
const num = (v, a, b) => {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= a && n <= b ? Math.round(n * 10) / 10 : null;
};
const ENTREVISTA = ["objetivo", "salud", "lesiones", "actividad", "habitos", "disponibilidad", "notas"];
function cleanValoraciones(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 60).map((x) => ({
    id: str(x && x.id, 20) || randomBytes(4).toString("hex"),
    date: x && validDate(str(x.date, 10)) ? x.date : "",
    peso: num(x && x.peso, 20, 300),
    talla: num(x && x.talla, 100, 230),
    grasa: num(x && x.grasa, 1, 70),
    musculo: num(x && x.musculo, 10, 80),
    cintura: num(x && x.cintura, 40, 200),
    notas: str(x && x.notas, 600).trim(),
  }));
}
function cleanEntrevista(v) {
  const out = {};
  const src = v && typeof v === "object" ? v : {};
  for (const k of ENTREVISTA) out[k] = str(src[k], 1500).trim();
  return out;
}

async function readJson(req) { try { return await req.json(); } catch { fail("Petición no válida."); } }

async function fichaRoutes(route, req, url, admin) {
  const q = (n) => str(url.searchParams.get(n), 120);
  if (route === "import-teachers" && req.method === "POST") {
    if (!admin) fail("Solo el coordinador puede importar profesorado.");
    const b = await readJson(req);
    const items = Array.isArray(b && b.items) ? b.items.slice(0, 300) : [];
    if (!items.length) fail("No hay profesores que importar.");
    return withLock(async () => {
      const [teachers, emails] = await Promise.all([read("teachers"), read("emails")]);
      const tdata = { ...teachers.data }, edata = { ...emails.data };
      let added = 0, updated = 0;
      const errors = [];
      for (const it of items) {
        const name = str(it && it.name, 80).trim().replace(/\s+/g, " ");
        if (name.length < 2) { errors.push("Falta el nombre en una línea."); continue; }
        const tk = tkeyOf(name);
        const em = normEmail(it.email);
        if (em && (!EMAIL_RE.test(em) || em.length > 120)) { errors.push(name + ": el correo no es válido."); continue; }
        if (em && edata[em] && edata[em] !== tk) { errors.push(name + ": ese correo ya es de " + ((tdata[edata[em]] || {}).name || edata[em]) + "."); continue; }
        const team = it.team ? int(it.team, 1, TEAMS) : null;
        const old = tdata[tk];
        const t = old ? { ...old } : { tkey: tk, name, valTeam: null, course: "", archived: false };
        if (!t.course) t.course = courseNow();
        t.archived = false;
        if (team) t.valTeam = team;
        tdata[tk] = t;
        if (em) {
          for (const k of Object.keys(edata)) if (edata[k] === tk && k !== em) delete edata[k];
          edata[em] = tk;
        }
        old ? updated++ : added++;
      }
      if (added || updated) {
        await write("teachers", teachers, tdata);
        await write("emails", emails, edata);
      }
      return json({ ok: true, added, updated, errors });
    });
  }
  if (route === "teacher-email" && req.method === "POST") {
    if (!admin) fail("Solo el coordinador puede cambiar correos.");
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80), em = normEmail(b && b.email);
    if (!TKEY_RE.test(tkey)) fail("Profesor no válido.");
    if (em && (!EMAIL_RE.test(em) || em.length > 120)) fail("El correo no es válido.");
    return withLock(async () => {
      const [teachers, emails] = await Promise.all([read("teachers"), read("emails")]);
      if (!teachers.data[tkey]) fail("Ese profesor no existe.");
      const edata = { ...emails.data };
      if (em && edata[em] && edata[em] !== tkey) fail("Ese correo ya es de " + ((teachers.data[edata[em]] || {}).name || edata[em]) + ".");
      for (const k of Object.keys(edata)) if (edata[k] === tkey) delete edata[k];
      if (em) edata[em] = tkey;
      await write("emails", emails, edata);
      return json({ ok: true });
    });
  }
  if (route === "ficha-key" && req.method === "POST") {
    if (!admin) fail("Solo el coordinador puede generar claves.");
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80);
    if (!TKEY_RE.test(tkey)) fail("Profesor no válido.");
    let key = newKey();
    if (b && b.key != null && b.key !== "") {          // clave elegida por el coordinador
      const nk = normKey(b.key);
      if (nk.length < 6 || nk.length > 24) fail("La clave debe tener entre 6 y 24 letras o números.");
      key = nk;
    }
    const salt = randomBytes(8).toString("hex");
    await store().setJSON("keys/" + tkey, { s: salt, h: keyHash(salt, key), at: Date.now() });
    try { await store().delete("att/" + tkey); } catch {}
    return json({ ok: true, key });
  }
  if (route === "team-key" && req.method === "POST") {
    if (!admin) fail("Solo el coordinador puede generar claves de equipo.");
    const b = await readJson(req);
    const team = int(b && b.team, 1, TEAMS);
    if (!team) fail("Equipo no válido.");
    let key = "EQUIPO" + team + "-" + String(1000 + (randomBytes(2).readUInt16BE() % 9000));
    if (b && b.key != null && b.key !== "") {
      const nk = normKey(b.key);
      if (nk.length < 6 || nk.length > 24) fail("La clave debe tener entre 6 y 24 letras o números.");
      key = nk;
    }
    const salt = randomBytes(8).toString("hex");
    await store().setJSON("teamkeys/" + team, { s: salt, h: keyHash(salt, key), at: Date.now() });
    try { await store().delete("att/team-" + team); } catch {}
    return json({ ok: true, team, key });
  }
  if (route === "team-check" && req.method === "POST") {
    const b = await readJson(req);
    const team = int(b && b.team, 1, TEAMS);
    if (!team) fail("Equipo no válido.");
    const fake = new Request("http://x", { headers: { "x-team-key": String((b && b.key) || "") } });
    if (!(await teamAuth(fake, team, true))) fail("Clave incorrecta.");
    return json({ ok: true });
  }
  if (route === "ficha" && req.method === "GET") {
    const tkey = q("tkey");
    const role = await fichaAccess(req, tkey, admin);
    const [ficha, presc, teachers, bookings, ratings] = await Promise.all([readFicha(tkey), store().get("prescriptions/" + tkey, { type: "json" }), read("teachers"), read("bookings"), store().get("ratings/" + tkey, { type: "json" })]);
    const t = teachers.data[tkey];
    const mine = role === "key" || role === "admin";
    return json({ role, name: (t && t.name) || tkey, ficha, prescription: presc || null, ...(mine ? { rateTeams: rateTeams(t, tkey, bookings.data), ratings: ratings || {} } : {}) });
  }
  if (route === "rate" && req.method === "POST") {
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80);
    const role = await fichaAccess(req, tkey, admin);
    if (role === "team" || role === "trainer") fail("Solo el profesor puede valorar a los equipos.");
    const kind = b && b.kind, team = int(b && b.team, 1, TEAMS);
    if (!["V", "E"].includes(kind) || !team) fail("Equipo no válido.");
    const scores = {};
    for (const id of RATE_ITEMS[kind]) {
      const n = int(b && b.scores && b.scores[id], 1, 5);
      if (!n) fail("Puntúa todos los apartados de 1 a 5 estrellas.");
      scores[id] = n;
    }
    const stars = Math.round((Object.values(scores).reduce((a, n) => a + n, 0) / RATE_ITEMS[kind].length) * 100) / 100;
    const [teachers, bookings] = await Promise.all([read("teachers"), read("bookings")]);
    if (!rateTeams(teachers.data[tkey], tkey, bookings.data).some((x) => x.kind === kind && x.team === team)) fail("Ese equipo todavía no te ha atendido.");
    return withLock(async () => {
      const old = (await store().get("ratings/" + tkey, { type: "json" })) || {};
      old[kind + ":" + team] = { scores, stars, comment: str(b && b.comment, 500).trim(), at: Date.now() };
      await store().setJSON("ratings/" + tkey, old);
      return json({ ok: true, ratings: old });
    });
  }
  if (route === "ficha" && req.method === "POST") {
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80);
    const role = await fichaAccess(req, tkey, admin);
    if (role === "trainer") fail("Tu equipo solo puede consultar y descargar esta ficha.");
    const val = cleanValoraciones(b.valoraciones), ent = cleanEntrevista(b.entrevista);
    if (!val) fail("Datos no válidos.");
    return withLock(async () => {
      const old = await readFicha(tkey);
      const rec = { ...old, valoraciones: val, entrevista: ent, updatedAt: Date.now(), updatedBy: role };
      await store().setJSON("ficha/" + tkey, rec);
      return json({ role, ficha: rec });
    });
  }
  if (route === "doc" && req.method === "POST") {
    const tkey = q("tkey");
    const role = await fichaAccess(req, tkey, admin);
    if (role === "trainer") fail("Tu equipo solo puede consultar y descargar esta ficha.");
    const name = q("name").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim() || "documento";
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (!DOC_TYPES[ext]) fail("Formato no permitido. Sube PDF, imagen (png, jpg, webp), txt, docx o xlsx.");
    const cat = DOC_CATS.includes(q("cat")) ? q("cat") : "";
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) fail("El archivo está vacío.");
    if (buf.byteLength > MAX_DOC) fail("El archivo pesa más de 4 MB.");
    return withLock(async () => {
      const old = await readFicha(tkey);
      if (old.docs.length >= 40) fail("Ya hay 40 documentos. Borra alguno antes de subir otro.");
      const id = randomBytes(6).toString("hex");
      await store().set("docs/" + tkey + "/" + id, buf);
      const rec = { ...old, docs: [...old.docs, { id, name, ext, size: buf.byteLength, at: Date.now(), by: role, ...(cat ? { cat } : {}) }], updatedAt: Date.now() };
      await store().setJSON("ficha/" + tkey, rec);
      return json({ role, ficha: rec });
    });
  }
  if (route === "doc" && req.method === "GET") {
    const tkey = q("tkey"), id = q("id");
    await fichaAccess(req, tkey, admin);
    const f = await readFicha(tkey);
    const d = f.docs.find((x) => x.id === id);
    if (!d) fail("Ese documento ya no existe.");
    const buf = await store().get("docs/" + tkey + "/" + id, { type: "arrayBuffer" });
    if (!buf) fail("Ese documento ya no existe.");
    return new Response(buf, {
      headers: {
        "content-type": DOC_TYPES[d.ext] || "application/octet-stream",
        "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(d.name),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  }
  if (route === "doc-cat" && req.method === "POST") {
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80), id = str(b && b.id, 20);
    const role = await fichaAccess(req, tkey, admin);
    if (role === "trainer") fail("Tu equipo solo puede consultar y descargar esta ficha.");
    if (!DOC_CATS.includes(b && b.cat)) fail("Tipo de documento no válido.");
    return withLock(async () => {
      const old = await readFicha(tkey);
      if (!old.docs.some((x) => x.id === id)) fail("Ese documento ya no existe.");
      const rec = { ...old, docs: old.docs.map((x) => (x.id === id ? { ...x, cat: b.cat } : x)), updatedAt: Date.now() };
      await store().setJSON("ficha/" + tkey, rec);
      return json({ role, ficha: rec });
    });
  }
  if (route === "doc-delete" && req.method === "POST") {
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80), id = str(b && b.id, 20);
    const role = await fichaAccess(req, tkey, admin);
    if (role === "trainer") fail("Tu equipo solo puede consultar y descargar esta ficha.");
    return withLock(async () => {
      const old = await readFicha(tkey);
      const rec = { ...old, docs: old.docs.filter((x) => x.id !== id), updatedAt: Date.now() };
      await store().setJSON("ficha/" + tkey, rec);
      try { await store().delete("docs/" + tkey + "/" + id); } catch {}
      return json({ ficha: rec });
    });
  }
  return null;
}

/* ---------- Rutas ---------- */

/* ---------- Avisos al móvil (Web Push, sin librerías) ---------- */
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const SLOT_LABEL = [null, "7:55–8:50", "8:50–9:45", "9:45–10:40", "11:10–12:05", "12:05–13:00", "13:00–13:55"];
const SITE = "https://monasfit-salud.netlify.app";
async function vapid() {
  const s = store();
  let v = await s.get("vapid", { type: "json" });
  if (!v) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    const pj = publicKey.export({ format: "jwk" });
    const rec = { priv: jwk, pub: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(pj.x, "base64url"), Buffer.from(pj.y, "base64url")])) };
    const r = await s.setJSON("vapid", rec, { onlyIfNew: true });
    v = r && r.modified === false ? await s.get("vapid", { type: "json" }) : rec;
  }
  return v;
}
function vapidAuth(v, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE }));
  const sig = cSign("sha256", Buffer.from(head + "." + claims), { key: createPrivateKey({ key: v.priv, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return "vapid t=" + head + "." + claims + "." + b64u(sig) + ", k=" + v.pub;
}
// Cifrado del mensaje según RFC 8291 (aes128gcm)
function encryptPush(sub, payload) {
  const ua = Buffer.from(sub.keys.p256dh, "base64url"), auth = Buffer.from(sub.keys.auth, "base64url");
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(ua);
  const prk = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]), 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
async function sendOne(v, sub, msg) {
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "43200", urgency: "high", authorization: vapidAuth(v, sub.endpoint) },
    body: encryptPush(sub, JSON.stringify(msg)),
    signal: AbortSignal.timeout(6000),
  });
  return r.status;
}
async function pushToTeam(team, msg) {
  const s = store();
  const subs = (await s.get("push/" + team, { type: "json" })) || [];
  if (!subs.length) return { sent: 0, total: 0 };
  const v = await vapid();
  const dead = new Set();
  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      const st = await sendOne(v, sub, msg);
      if (st >= 200 && st < 300) sent++;
      else if (st === 404 || st === 410) dead.add(sub.endpoint);
    } catch {}
  }));
  if (dead.size) {
    const cur = (await s.get("push/" + team, { type: "json" })) || [];
    await s.setJSON("push/" + team, cur.filter((x) => !dead.has(x.endpoint)));
  }
  return { sent, total: subs.length };
}
const pushDate = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }); };
const pushWhat = (b) => (b.teacher || "Profesor") + " · " + (b.type === "V" ? "valoración" : "entrenamiento") + " · " + pushDate(b.date) + ", " + (SLOT_LABEL[b.slot] || "");
const pushDue = (ms) => new Date(ms).toLocaleString("es-ES", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }).replace(",", "").replace(/ (\d{2}:\d{2})$/, " a las $1");
const pushWhatKind = (b) => (b.type === "V" ? "la valoración" : "el entrenamiento");
let outbox = [];
function queueBookingPushes(oldList, newList) {
  const today = madridNow().date;
  const olds = {}; (oldList || []).forEach((b) => { olds[b.id] = b; });
  const news = {}; (newList || []).forEach((b) => { news[b.id] = b; });
  for (const b of newList || []) {
    if (b.date < today) continue;
    const o = olds[b.id];
    if (b.team && (!o || o.team !== b.team)) {
      outbox.push({ team: b.team, msg: b.conf === "pending"
        ? { title: "Equipo " + b.team + ": confirmad " + pushWhatKind(b), body: pushWhat(b) + ". Entrad en la app y confirmad si podéis" + (b.dueAt ? " antes del " + pushDue(b.dueAt) : "") + "; si no, pasará a otro equipo.", tag: "bk-" + b.id, url: "/#mi-equipo" }
        : { title: "Equipo " + b.team + ": nueva sesión", body: pushWhat(b), tag: "bk-" + b.id, url: "/#mi-equipo" } });
    }
    if (o && o.team && o.team !== b.team) {
      const last = (b.declined || []).slice(-1)[0];
      if (!(last && last.t === o.team && last.why === "no")) outbox.push({ team: o.team, msg: { title: "Equipo " + o.team + ": sesión que pasa a otro equipo", body: pushWhat(b), tag: "bk-" + b.id, url: "/#mi-equipo" } });
    }
  }
  for (const o of oldList || []) {
    if (o.team && o.date >= today && !news[o.id]) outbox.push({ team: o.team, msg: { title: "Equipo " + o.team + ": sesión cancelada", body: pushWhat(o), tag: "bk-" + o.id, url: "/#mi-equipo" } });
  }
}
async function flushPush() {
  const items = outbox; outbox = [];
  if (!items.length) return;
  await Promise.allSettled(items.map((i) => pushToTeam(i.team, i.msg)));
}

const handle = async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const admin = isAdmin(req);
  try {
    if (route === "admin-check") {
      if (!process.env.ADMIN_PASSWORD) return json({ error: "Falta la variable ADMIN_PASSWORD en Netlify." }, 503);
      return admin ? json({ ok: true }) : json({ error: "Contraseña incorrecta." }, 401);
    }
    // Logo del proyecto: público (lo carga <img>, que no puede mandar el código de acceso)
    if (route === "logo" && req.method === "GET") {
      const s = store();
      const [buf, meta] = await Promise.all([s.get("logo", { type: "arrayBuffer" }), s.get("logo.meta", { type: "json" })]);
      if (!buf) return new Response("", { status: 404 });
      return new Response(buf, { headers: { "content-type": (meta && meta.type) || "image/png", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
    }
    if (!admin && !codeOk(req)) return json({ needCode: true, error: "Código de acceso necesario." }, 401);

    if (route === "logo" && req.method === "POST") {
      if (!admin) fail("Solo el coordinador puede cambiar el logo.");
      const LT = { png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };
      const type = LT[(url.searchParams.get("type") || "").toLowerCase()];
      if (!type) fail("Formato de logo no permitido (png, webp o jpg).");
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) fail("El archivo está vacío.");
      if (buf.byteLength > 1024 * 1024) fail("El logo pesa más de 1 MB.");
      await store().set("logo", buf);
      await store().setJSON("logo.meta", { type, at: Date.now() });
      return json({ ok: true });
    }

    if (route === "push-key" && req.method === "GET") return json({ key: (await vapid()).pub });
    if (route.startsWith("push-") && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const team = int(b.team, 1, TEAMS);
      if (!team) fail("Elige tu equipo.");
      if (!(await teamAuth(req, team, true))) fail("La clave de tu equipo no es válida. Vuelve a elegir tu equipo e introdúcela.");
      const s = store();
      const cur = (await s.get("push/" + team, { type: "json" })) || [];
      if (route === "push-sub") {
        const sub = b.sub || {};
        const ep = String(sub.endpoint || ""), k = sub.keys || {};
        if (!(/^https:\/\//.test(ep) || (process.env.PUSH_TEST_HTTP === "1" && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(ep))) || ep.length > 600 || !k.p256dh || !k.auth || String(k.p256dh).length > 200 || String(k.auth).length > 100) fail("Este móvil no ha enviado una suscripción válida.");
        const next = cur.filter((x) => x.endpoint !== ep);
        next.push({ endpoint: ep, keys: { p256dh: String(k.p256dh), auth: String(k.auth) }, at: Date.now() });
        await s.setJSON("push/" + team, next.slice(-12));
        return json({ ok: true });
      }
      if (route === "push-unsub") {
        await s.setJSON("push/" + team, cur.filter((x) => x.endpoint !== String(b.endpoint || "")));
        return json({ ok: true });
      }
      if (route === "push-test") {
        const r = await pushToTeam(team, { title: "Equipo " + team + ": aviso de prueba", body: "Si ves esto, los avisos funcionan en este móvil.", tag: "test", url: "/#mi-equipo" });
        return json({ ok: true, ...r });
      }
    }

    if (route === "state" && req.method === "GET") {
      if (needSweep((await read("bookings")).data, Date.now())) await runSweep();
      const [cfg, teams, teachers, bookings, settings] = await Promise.all(KEYS.map(read));
      const team = int(url.searchParams.get("team"), 1, TEAMS);
      const s = store();
      const { blobs } = await s.list({ prefix: "prescriptions/" });
      const recs = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
      const prescriptions = {};
      const teamOk = admin || (team ? await teamAuth(req, team, false) : false);
      for (const p of recs) {
        if (!p || !p.tkey) continue;
        if (admin || (team && teamOk)) prescriptions[p.tkey] = p;
      }
      const teamKeysSet = {};
      for (const b of (await s.list({ prefix: "teamkeys/" })).blobs) teamKeysSet[b.key.slice(9)] = true;
      const em = await read("emails");
      const emailMode = Object.keys(em.data).length > 0;
      let keys, emailList;
      if (admin) {
        emailList = em.data;
        keys = {};
        const kl = await s.list({ prefix: "keys/" });
        for (const b of kl.blobs) keys[b.key.slice(5)] = true;
      }
      // Valoraciones de los profesores a los equipos: detalle solo para coordinación; ranking (media y nº) para todos
      const ratings = admin ? [] : undefined;
      const agg = {};
      {
        const rl = await s.list({ prefix: "ratings/" });
        const rr = await Promise.all(rl.blobs.map((b) => s.get(b.key, { type: "json" })));
        rr.forEach((r, i) => {
          const tk = rl.blobs[i].key.slice(8);
          for (const [k, v] of Object.entries(r || {})) {
            const [kind, team] = k.split(":");
            const a = (agg[team] = agg[team] || { V: [], E: [] });
            const sc = scoreOf(v);
            (kind === "V" ? a.V : a.E).push(sc);
            if (admin) ratings.push({ tkey: tk, teacher: (teachers.data[tk] && teachers.data[tk].name) || tk, kind, team: Number(team), stars: sc, scores: v.scores || null, comment: v.comment || "", at: v.at });
          }
        });
      }
      const mean = (xs) => (xs.length ? xs.reduce((a, n) => a + n, 0) / xs.length : null);
      const ranking = Object.entries(agg).map(([t, a]) => {
        const vAvg = mean(a.V), eAvg = mean(a.E);
        const parts = [vAvg, eAvg].filter((x) => x !== null);
        return { team: Number(t), avg: parts.reduce((x, y) => x + y, 0) / parts.length, vAvg, eAvg, nV: a.V.length, nE: a.E.length, n: a.V.length + a.E.length };
      }).sort((x, y) => y.avg - x.avg || y.n - x.n || x.team - y.team);
      const bookingsOut = admin ? bookings : { ...bookings, data: bookings.data.map((x) => (x.declined ? { ...x, declined: undefined, dn: x.declined.length } : x)) };
      return json({ config: cfg, teams, teachers, bookings: bookingsOut, settings, prescriptions, admin, keys, emailMode, emails: emailList, ratings, ranking, teamKeysSet });
    }

    {
      const fr = await fichaRoutes(route, req, url, admin);
      if (fr) return fr;
    }

    if (route === "book" && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return json({ error: "Petición no válida." }, 400); }
      return json(await book(b));
    }
    if (route === "confirm" && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return json({ error: "Petición no válida." }, 400); }
      return json(await respond(req, b, admin));
    }
    if (route === "cancel" && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return json({ error: "Petición no válida." }, 400); }
      return json(await cancel(b));
    }

    if (route === "admin" && req.method === "POST") {
      if (!process.env.ADMIN_PASSWORD) return json({ error: "Falta la variable ADMIN_PASSWORD en Netlify." }, 503);
      if (!admin) return json({ error: "Contraseña de coordinación incorrecta." }, 403);
      let body;
      try { body = await req.json(); } catch { return json({ error: "Petición no válida." }, 400); }
      const key = body && body.key;
      if (!KEYS.includes(key)) return json({ error: "Colección desconocida." }, 400);
      const data = CLEAN[key](body.value);
      if (data === null) return json({ error: "Datos no válidos." }, 400);
      return await withLock(async () => {
        const cur = await read(key);
        if (Number(body.baseRev) !== cur.rev) return json({ error: "conflict", rev: cur.rev }, 409);
        const rev = await write(key, cur, data);
        return json({ ok: true, rev });
      });
    }

    if (route === "prescription" && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return json({ error: "Petición no válida." }, 400); }
      const tkey = str(b && b.tkey, 80);
      if (!/^[a-z0-9-]{1,80}$/.test(tkey)) return json({ error: "Profesor no válido." }, 400);
      const team = b.team == null ? null : int(b.team, 1, TEAMS);
      if (!admin && !team) return json({ error: "Elige tu equipo antes de guardar." }, 400);
      const plan = str(b.plan, 6000).trim();
      if (!plan) return json({ error: "Falta el plan de entrenamiento." }, 400);
      if (!admin) {
        if (!(await teamAuth(req, team, true))) return json({ error: "La clave de tu equipo no es válida. Vuelve a elegir tu equipo e introdúcela." }, 403);
      }
      const rec = {
        tkey,
        teacher: str(b.teacher, 80),
        team,
        goal: str(b.goal, 120).trim(),
        days: int(b.days, 1, 7) || 3,
        plan,
        notes: str(b.notes, 2000).trim(),
        updatedAt: Date.now(),
      };
      await store().setJSON("prescriptions/" + tkey, rec);
      return json(rec);
    }

    return json({ error: "No encontrado." }, 404);
  } catch (e) {
    if (e instanceof Rule) return json({ error: e.message, ...(e.data || {}) }, 422);
    if (e && e.busy) return json({ error: "Hay mucha gente reservando a la vez. Inténtalo de nuevo en unos segundos." }, 503);
    console.error(e);
    return json({ error: "Error del servidor." }, 500);
  }
};
export default async (req) => {
  const res = await handle(req);
  try { await flushPush(); } catch {}
  return res;
};
