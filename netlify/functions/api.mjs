// API de Monasfit Equipos (Netlify Functions + Netlify Blobs)
// Variables de entorno en Netlify:
//   ADMIN_PASSWORD  (obligatoria) contraseña del coordinador
//   ACCESS_CODE     (opcional)    código que debe escribir el alumnado al abrir la app
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const TEAMS = 12;
const KEYS = ["config", "teams", "teachers", "bookings"];
const FALLBACK = {
  config: { nextTeam: 1 },
  teams: {},
  teachers: {},
  bookings: [],
};

const store = () => getStore({ name: "monasfit-equipos", consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

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

async function read(key) {
  const v = await store().get(key, { type: "json" });
  return v && typeof v === "object" && "rev" in v ? v : { rev: 0, data: FALLBACK[key] };
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
    out[k] = { tkey: k, name: str(t.name, 80), valTeam: t.valTeam == null ? null : int(t.valTeam, 1, TEAMS) };
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
const CLEAN = { bookings: cleanBookings, teachers: cleanTeachers, teams: cleanTeams, config: cleanConfig };

/* ---------- Quién ve y quién escribe cada prescripción ---------- */
const sees = (tkey, team, teachers, bookings) =>
  (teachers[tkey] && teachers[tkey].valTeam === team) ||
  bookings.some((b) => b.tkey === tkey && b.team === team);
const edits = (tkey, team, teachers, bookings) =>
  (teachers[tkey] && teachers[tkey].valTeam === team) ||
  bookings.some((b) => b.tkey === tkey && b.type === "V" && b.team === team);

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
      const [cfg, teams, teachers, bookings] = await Promise.all(KEYS.map(read));
      const team = int(url.searchParams.get("team"), 1, TEAMS);
      const s = store();
      const { blobs } = await s.list({ prefix: "prescriptions/" });
      const recs = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
      const prescriptions = {};
      for (const p of recs) {
        if (!p || !p.tkey) continue;
        if (admin || (team && sees(p.tkey, team, teachers.data, bookings.data))) prescriptions[p.tkey] = p;
      }
      return json({ config: cfg, teams, teachers, bookings, prescriptions, admin });
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
      const cur = await read(key);
      if (Number(body.baseRev) !== cur.rev) return json({ error: "conflict", rev: cur.rev }, 409);
      const rev = cur.rev + 1;
      await store().setJSON(key, { rev, data });
      return json({ ok: true, rev });
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
    console.error(e);
    return json({ error: "Error del servidor." }, 500);
  }
};
