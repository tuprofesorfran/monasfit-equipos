// API de Monasfit Equipos (Netlify Functions + Netlify Blobs)
// Variables de entorno en Netlify:
//   ADMIN_PASSWORD  (obligatoria) contraseña del coordinador
//   ACCESS_CODE     (opcional)    código que debe escribir quien abre la app
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
class Rule extends Error {}
const fail = (msg) => { throw new Rule(msg); };

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
    out[k] = { tkey: k, name: str(t.name, 80), valTeam: t.valTeam == null ? null : int(t.valTeam, 1, TEAMS), course: str(t.course, 12).trim(), archived: !!t.archived };
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

function planAssign(bookings, teachers, ptr) {
  const all = bookings.map((b) => ({ ...b }));
  const val = {};
  Object.keys(teachers).forEach((k) => { val[k] = teachers[k].valTeam || null; });
  const pend = all.filter((b) => !b.team).sort(cmp);
  const assign = [], vals = [];
  for (const b of pend) {
    let team = null;
    if (b.type === "V" && val[b.tkey]) team = val[b.tkey];
    else {
      const busy = {};
      all.forEach((x) => { if (x.team && x.date === b.date && x.slot === b.slot) busy[x.team] = 1; });
      for (let i = 0; i < TEAMS; i++) {
        const c = ((ptr - 1 + i) % TEAMS) + 1;
        if (!busy[c]) { team = c; ptr = (c % TEAMS) + 1; break; }
      }
      if (b.type === "V" && team) { val[b.tkey] = team; vals.push({ tkey: b.tkey, team }); }
    }
    if (team) { b.team = team; assign.push({ id: b.id, team }); }
  }
  return { assign, vals, ptr };
}

/* ---------- Quién ve y quién escribe cada prescripción ---------- */
const sees = (tkey, team, teachers, bookings) =>
  (teachers[tkey] && teachers[tkey].valTeam === team) ||
  bookings.some((b) => b.tkey === tkey && b.team === team);
const edits = (tkey, team, teachers, bookings) =>
  (teachers[tkey] && teachers[tkey].valTeam === team) ||
  bookings.some((b) => b.tkey === tkey && b.type === "V" && b.team === team);

/* ---------- Reservar y cancelar (profesorado) ---------- */
async function book(b) {
  const name = str(b && b.name, 60).trim().replace(/\s+/g, " ");
  const type = b && b.type;
  const date = str(b && b.date, 10);
  const slot = int(b && b.slot, 1, 6);
  if (name.length < 2) fail("Escribe tu nombre.");
  if (!["E", "V"].includes(type)) fail("Elige entrenamiento o valoración.");
  if (!validDate(date) || !slot) fail("Fecha o franja no válida.");
  const tk = tkeyOf(name);

  return withLock(async () => {
    const [cfg, teams, teachers, bookings, settings] = await Promise.all(KEYS.map(read));
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
    const t = tdata[tk] ? { ...tdata[tk] } : { tkey: tk, name, valTeam: null, course: courseNow(), archived: false };
    let teachersDirty = !tdata[tk];
    if (t.archived) { t.archived = false; t.course = courseNow(); teachersDirty = true; }
    const priorV = list.find((x) => x.tkey === tk && x.type === "V" && x.team);
    if (!t.valTeam && priorV) { t.valTeam = priorV.team; teachersDirty = true; }
    if (type === "V" && t.valTeam && here.some((x) => x.team === t.valTeam))
      fail(`A ti te valora siempre el equipo ${t.valTeam}, que a esa hora ya tiene otra sesión. Elige otra franja.`);
    tdata[tk] = t;

    const id = randomBytes(5).toString("hex") + Date.now().toString(36);
    const nb = { id, date, slot, type, teacher: t.name || name, tkey: tk, team: null, createdAt: Date.now() };
    const all = [...list, nb];
    const ptr = Math.min(TEAMS, Math.max(1, Number(cfg.data.nextTeam) || 1));
    const plan = planAssign(all, tdata, ptr);
    plan.vals.forEach((v) => { if (tdata[v.tkey]) { tdata[v.tkey] = { ...tdata[v.tkey], valTeam: v.team }; teachersDirty = true; } });
    plan.assign.forEach((a) => { const x = all.find((y) => y.id === a.id); if (x) x.team = a.team; });
    if (!nb.team) fail("En esa franja no queda ningún equipo libre. Elige otra.");

    if (teachersDirty) await write("teachers", teachers, tdata);
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
      if (t && t.valTeam === bk.team) await write("teachers", teachers, { ...teachers.data, [bk.tkey]: { ...t, valTeam: null } });
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
const DOC_TYPES = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  txt: "text/plain; charset=utf-8", docx: "application/octet-stream", xlsx: "application/octet-stream",
};

// Devuelve "admin", "key" (clave del profesor) o "team" (equipo que lo valora). Si no, lanza error.
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
    const [t, b] = await Promise.all([read("teachers"), read("bookings")]);
    if (edits(tkey, team, t.data, b.data)) return "team";
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
  if (route === "ficha-key" && req.method === "POST") {
    if (!admin) fail("Solo el coordinador puede generar claves.");
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80);
    if (!TKEY_RE.test(tkey)) fail("Profesor no válido.");
    const key = newKey();
    const salt = randomBytes(8).toString("hex");
    await store().setJSON("keys/" + tkey, { s: salt, h: keyHash(salt, key), at: Date.now() });
    try { await store().delete("att/" + tkey); } catch {}
    return json({ ok: true, key });
  }
  if (route === "ficha" && req.method === "GET") {
    const tkey = q("tkey");
    const role = await fichaAccess(req, tkey, admin);
    const [ficha, presc, teachers] = await Promise.all([readFicha(tkey), store().get("prescriptions/" + tkey, { type: "json" }), read("teachers")]);
    const t = teachers.data[tkey];
    return json({ role, name: (t && t.name) || tkey, ficha, prescription: presc || null });
  }
  if (route === "ficha" && req.method === "POST") {
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80);
    const role = await fichaAccess(req, tkey, admin);
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
    const name = q("name").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim() || "documento";
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (!DOC_TYPES[ext]) fail("Formato no permitido. Sube PDF, imagen (png, jpg, webp), txt, docx o xlsx.");
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) fail("El archivo está vacío.");
    if (buf.byteLength > MAX_DOC) fail("El archivo pesa más de 4 MB.");
    return withLock(async () => {
      const old = await readFicha(tkey);
      if (old.docs.length >= 30) fail("Ya hay 30 documentos. Borra alguno antes de subir otro.");
      const id = randomBytes(6).toString("hex");
      await store().set("docs/" + tkey + "/" + id, buf);
      const rec = { ...old, docs: [...old.docs, { id, name, ext, size: buf.byteLength, at: Date.now(), by: role }], updatedAt: Date.now() };
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
  if (route === "doc-delete" && req.method === "POST") {
    const b = await readJson(req);
    const tkey = str(b && b.tkey, 80), id = str(b && b.id, 20);
    await fichaAccess(req, tkey, admin);
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
export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const admin = isAdmin(req);
  try {
    if (route === "admin-check") {
      if (!process.env.ADMIN_PASSWORD) return json({ error: "Falta la variable ADMIN_PASSWORD en Netlify." }, 503);
      return admin ? json({ ok: true }) : json({ error: "Contraseña incorrecta." }, 401);
    }
    if (!admin && !codeOk(req)) return json({ needCode: true, error: "Código de acceso necesario." }, 401);

    if (route === "state" && req.method === "GET") {
      const [cfg, teams, teachers, bookings, settings] = await Promise.all(KEYS.map(read));
      const team = int(url.searchParams.get("team"), 1, TEAMS);
      const s = store();
      const { blobs } = await s.list({ prefix: "prescriptions/" });
      const recs = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
      const prescriptions = {};
      for (const p of recs) {
        if (!p || !p.tkey) continue;
        if (admin || (team && sees(p.tkey, team, teachers.data, bookings.data))) prescriptions[p.tkey] = p;
      }
      let keys;
      if (admin) {
        keys = {};
        const kl = await s.list({ prefix: "keys/" });
        for (const b of kl.blobs) keys[b.key.slice(5)] = true;
      }
      return json({ config: cfg, teams, teachers, bookings, settings, prescriptions, admin, keys });
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
        const [teachers, bookings] = await Promise.all([read("teachers"), read("bookings")]);
        if (!edits(tkey, team, teachers.data, bookings.data)) {
          return json({ error: "Solo el equipo que valora a este profesor puede escribir su prescripción." }, 403);
        }
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
    if (e instanceof Rule) return json({ error: e.message }, 422);
    if (e && e.busy) return json({ error: "Hay mucha gente reservando a la vez. Inténtalo de nuevo en unos segundos." }, 503);
    console.error(e);
    return json({ error: "Error del servidor." }, 500);
  }
};
