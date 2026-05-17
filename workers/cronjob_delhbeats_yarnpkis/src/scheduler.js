// scheduler.js
// Cron único que ejecuta:
// - Heartbeats cleanup (R2) (si hay binding)
// - Yarn KPIs incremental (D1 cursor) PERO leyendo la operativa desde R2
//
// Bindings esperados:
// - env.DB (D1)
// - env.BALUX_MONITOR (R2 bucket)  [balux-monitor-operativa]
// Opcional:
// - env.MONITOR_PREFIX_MODE  ("ymd" | "dateeq" | "dateslash" | "autodetect")  default: "autodetect"
//
// IMPORTANTE (D1):
// 1) Si quieres seguir usando ON CONFLICT, necesitas UNIQUE/PK.
//    - derived_cursor: UNIQUE(table_name, machine_id)
//    - yarns_kpis:     UNIQUE(yarn_id, time)
//   Si no lo tienes, este código ya NO usa ON CONFLICT para evitar el error.
//
// 2) Los totales "172800" son 86400 * nº de máquinas (si sumas producción de varias máquinas por yarn_id).
//    Este código SUMA por yarn_id a nivel global (como tu tabla actual). Si quieres por máquina,
//    hay que añadir machine_id a yarns_kpis y a la clave única.

const RETENTION_DAYS = 1;

// Eventos que esperas en operativa
const EVENT_DEFECT = "defect";
const EVENT_ROLL_CHANGE = "roll_change";

// Cursor real en tu tabla derived_cursor
const CURSOR_TABLE = "yarns_kpis";
const CURSOR_KEY = "__global__"; // como lo tienes ahora

function isoZ(d) {
  return d.toISOString().replace(".000Z", "Z");
}
function dayStringUTC(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function dayStartUTCFromIso(iso) {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}
function addDaysUTC(d, days) {
  return new Date(d.getTime() + days * 24 * 3600 * 1000);
}
function clampMs(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** ---------------- Cursor (derived_cursor: table_name, machine_id, last_dt) ---------------- */
async function getCursor(DB) {
  const row = await DB.prepare(
    `SELECT last_dt
     FROM derived_cursor
     WHERE table_name = ? AND machine_id = ?
     LIMIT 1`
  ).bind(CURSOR_TABLE, CURSOR_KEY).first();

  return row?.last_dt || "2025-11-01T00:00:00Z";
}

// Evita ON CONFLICT para no depender de UNIQUE
async function setCursor(DB, lastDt) {
  const upd = await DB.prepare(
    `UPDATE derived_cursor
     SET last_dt = ?
     WHERE table_name = ? AND machine_id = ?`
  ).bind(lastDt, CURSOR_TABLE, CURSOR_KEY).run();

  if ((upd?.meta?.changes ?? 0) === 0) {
    await DB.prepare(
      `INSERT INTO derived_cursor (table_name, machine_id, last_dt)
       VALUES (?, ?, ?)`
    ).bind(CURSOR_TABLE, CURSOR_KEY, lastDt).run();
  }
}

/** ---------------- JOB 1: Heartbeats cleanup ---------------- */
async function cleanHeartbeats(env) {
  const bucket = env.BALUX_MONITOR;
  if (!bucket) throw new Error("Missing R2 binding: BALUX_MONITOR");

  const now = Date.now();
  const cutoffMs = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  console.log(`[cleanHeartbeats] deleting older than ${new Date(cutoffMs).toISOString()}`);

  let cursor = undefined;
  let totalDeleted = 0;

  do {
    const options = { prefix: "" };
    if (cursor) options.cursor = cursor;

    const listing = await bucket.list(options);

    for (const obj of listing.objects || []) {
      const key = obj.key;
      if (!key.includes("__heartbeat.json")) continue;

      const uploaded = obj.uploaded;
      if (!uploaded) continue;

      if (uploaded.getTime() < cutoffMs) {
        await bucket.delete(key);
        totalDeleted++;
      }
    }

    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  console.log(`[cleanHeartbeats] done deleted=${totalDeleted}`);
}

/** ---------------- R2 helpers: detectar prefijos por fecha ---------------- */
function prefixesForDay({ clientId, machineId, dayStr, mode }) {
  // El bucket suele tener "directorios" tipo:
  // A) client/machine/YYYY/MM/DD/
  // B) client/machine/date=YYYY-MM-DD/
  // C) client/machine/YYYY-MM-DD/
  // Además, a veces hay un subdir "events/" o "states/".
  const [Y, M, D] = dayStr.split("-");
  const base = `${clientId}/${machineId}`;

  if (mode === "ymd") return [`${base}/${Y}/${M}/${D}/`];
  if (mode === "dateeq") return [`${base}/date=${dayStr}/`];
  if (mode === "dateslash") return [`${base}/${dayStr}/`];

  // autodetect: probamos los 3
  return [
    `${base}/${Y}/${M}/${D}/`,
    `${base}/date=${dayStr}/`,
    `${base}/${dayStr}/`,
  ];
}

async function listObjectsFirstHit(bucket, prefixes) {
  for (const p of prefixes) {
    const listing = await bucket.list({ prefix: p });
    const objs = listing.objects || [];
    if (objs.length > 0) return { usedPrefix: p, objects: objs };
  }
  return { usedPrefix: null, objects: [] };
}

async function readJsonLines(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return [];
  const text = await obj.text();
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);

  const out = [];
  for (const ln of lines) {
    try {
      out.push(JSON.parse(ln));
    } catch {
      // Si hay alguna línea corrupta, la ignoramos para no tumbar el cron
    }
  }
  return out;
}

/**
 * Heurística: en operativa puedes tener ficheros separados o mezclados.
 * Este parser intenta reconocer dos tipos:
 * - events: { event, time, machine_id? }
 * - states: { status, start_time, end_time?, machine_id? }
 * Si tu esquema difiere, ajusta SOLO estas 2 funciones.
 */
function isEventRec(r) {
  return r && typeof r === "object" && typeof r.event === "string" && typeof r.time === "string";
}
function isStateRec(r) {
  return r && typeof r === "object" && typeof r.status === "string" && typeof r.start_time === "string";
}

/**
 * Carga operativa de un día desde R2 para una máquina:
 * - lee todos los objetos del prefijo del día
 * - separa records en events/states
 * - filtra por ventana [windowStart, windowEnd)
 */
async function loadOperativaDay({ bucket, clientId, machineId, dayStr, windowStart, windowEnd, mode }) {
  const prefixes = prefixesForDay({ clientId, machineId, dayStr, mode });
  const { usedPrefix, objects } = await listObjectsFirstHit(bucket, prefixes);

  console.log("[yarn_kpis] R2 day", dayStr, "machine", machineId, "prefixUsed", usedPrefix, "objects", objects.length);

  if (objects.length === 0) return { events: [], states: [] };

  const w0 = new Date(windowStart).getTime();
  const w1 = new Date(windowEnd).getTime();

  const events = [];
  const states = [];

  // Lee todos los JSONL bajo el prefijo del día.
  // Si tienes ficheros grandes, conviene filtrar por key (p.ej. includes('/events') o '/states')
  for (const obj of objects) {
    const key = obj.key;

    // Heurística ligera para evitar leer basura si hay otros artefactos en el mismo prefijo
    if (key.includes("__heartbeat")) continue;

    const recs = await readJsonLines(bucket, key);

    for (const r of recs) {
      if (isEventRec(r)) {
        const t = new Date(r.time).getTime();
        if (t >= w0 && t < w1) events.push({ ...r, machine_id: r.machine_id || machineId });
      } else if (isStateRec(r)) {
        const s0 = new Date(r.start_time).getTime();
        // end_time puede ser null/undefined si está abierto
        const s1 = r.end_time ? new Date(r.end_time).getTime() : w1;
        // solapa ventana
        if (s0 < w1 && s1 > w0) states.push({ ...r, machine_id: r.machine_id || machineId });
      }
    }
  }

  return { events, states };
}

/** ---------------- D1 helpers: máquinas y asignaciones ---------------- */
async function getMachines(DB) {
  // Ajusta nombres de columnas si difieren
  // Necesitamos client_id + machine_id para construir el path en R2
  const res = await DB.prepare(
    `SELECT machine_id, client_id
     FROM machines
     WHERE machine_id IS NOT NULL AND client_id IS NOT NULL`
  ).all();

  return (res.results ?? []).map(r => ({ machine_id: r.machine_id, client_id: r.client_id }));
}


async function listClients(DB) {
  const res = await DB.prepare(
    `SELECT DISTINCT client_id
     FROM machines
     WHERE client_id IS NOT NULL
     ORDER BY client_id ASC`
  ).all();

  return (res.results ?? []).map(r => r.client_id).filter(Boolean);
}

async function getRecalcFrom(DB, clientId) {
  const row = await DB.prepare(
    `SELECT recalc_from
     FROM yarn_kpis_cursor
     WHERE client_id = ?
     LIMIT 1`
  )
    .bind(clientId)
    .first();

  return row?.recalc_from ?? null;
}

async function clearRecalcFrom(DB, clientId) {
  await DB.prepare(
    `UPDATE yarn_kpis_cursor
     SET recalc_from = NULL
     WHERE client_id = ?`
  )
    .bind(clientId)
    .run();
}

async function getYarnAssignmentsOverlappingForClient(DB, clientId, windowStart, windowEnd) {
  const res = await DB.prepare(
    `SELECT ya.yarn_id, ya.machine_id, ya.start_time, ya.end_time
     FROM yarn_assignments ya
     JOIN machines m ON m.machine_id = ya.machine_id
     WHERE m.client_id = ?
       AND ya.start_time < ?
       AND (ya.end_time IS NULL OR ya.end_time > ?)`
  )
    .bind(clientId, windowEnd, windowStart)
    .all();

  return (res.results ?? []).map(r => ({
    yarn_id: r.yarn_id,
    machine_id: r.machine_id,
    start_time: r.start_time,
    end_time: r.end_time,
  }));
}

/** ---------------- KPI core: compute per yarn for a day from R2 + yarn_assignments ---------------- */

function computeProdSecondsForYarn({ states, assignments, yarnId, windowStart, windowEnd }) {
  const w0 = new Date(windowStart).getTime();
  const w1 = new Date(windowEnd).getTime();

  let sum = 0;

  // Para cada asignación (por máquina) del yarn, recortamos estados EN_MARCHA por solape
  for (const a of assignments) {
    if (a.yarn_id !== yarnId) continue;

    const a0 = new Date(a.start_time).getTime();
    const a1 = a.end_time ? new Date(a.end_time).getTime() : w1;

    const segLo = Math.max(w0, a0);
    const segHi = Math.min(w1, a1);
    if (segLo >= segHi) continue;

    for (const s of states) {
      if (s.machine_id !== a.machine_id) continue;
      if (s.status !== "EN_MARCHA") continue;

      const s0 = new Date(s.start_time).getTime();
      const s1 = s.end_time ? new Date(s.end_time).getTime() : w1;

      // intersección: [max(starts), min(ends)]
      const lo = Math.max(segLo, s0);
      const hi = Math.min(segHi, s1);
      if (lo < hi) sum += (hi - lo);
    }
  }

  return Math.floor(sum / 1000);
}

function countEventsForYarn({ events, assignments, yarnId, windowStart, windowEnd, eventName }) {
  const w0 = new Date(windowStart).getTime();
  const w1 = new Date(windowEnd).getTime();

  let c = 0;
  for (const e of events) {
    if (e.event !== eventName) continue;
    const t = new Date(e.time).getTime();
    if (t < w0 || t >= w1) continue;

    // El evento cuenta para yarnId si en ese instante hay asignación activa en su máquina
    const mid = e.machine_id;
    for (const a of assignments) {
      if (a.yarn_id !== yarnId) continue;
      if (a.machine_id !== mid) continue;

      const a0 = new Date(a.start_time).getTime();
      const a1 = a.end_time ? new Date(a.end_time).getTime() : w1;

      if (t >= a0 && t < a1) {
        c++;
        break;
      }
    }
  }
  return c;
}

function countStopsForYarn({ states, assignments, yarnId, windowStart, windowEnd }) {
  // "PARADA" por start_time dentro de ventana, asignación activa en ese instante
  const w0 = new Date(windowStart).getTime();
  const w1 = new Date(windowEnd).getTime();

  let c = 0;
  for (const s of states) {
    if (s.status !== "PARADA") continue;

    const t = new Date(s.start_time).getTime();
    if (t < w0 || t >= w1) continue;

    const mid = s.machine_id;
    for (const a of assignments) {
      if (a.yarn_id !== yarnId) continue;
      if (a.machine_id !== mid) continue;

      const a0 = new Date(a.start_time).getTime();
      const a1 = a.end_time ? new Date(a.end_time).getTime() : w1;

      if (t >= a0 && t < a1) {
        c++;
        break;
      }
    }
  }
  return c;
}


async function computeDayForClient({ env, clientId, dayStartIso, dayEndIso, dayStr }) {
  const DB = env.DB;

  const yarnsRes = await DB.prepare(
    `SELECT DISTINCT ya.yarn_id
     FROM yarn_assignments ya
     JOIN machines m ON m.machine_id = ya.machine_id
     WHERE m.client_id = ?
       AND ya.start_time < ?
       AND (ya.end_time IS NULL OR ya.end_time > ?)
     ORDER BY ya.yarn_id`
  ).bind(clientId, dayEndIso, dayStartIso).all();

  const yarns = (yarnsRes.results ?? []).map(r => r.yarn_id).filter(Boolean);
  if (!yarns.length) return { upserts: 0, errors: 0 };

  let totalUpserts = 0;
  let totalErrors = 0;

  for (const yarnId of yarns) {
    try {
      const failsRow = await DB.prepare(
        `SELECT COUNT(*) AS fails
         FROM machine_events e
         JOIN machines m ON m.machine_id = e.machine_id AND m.client_id = ?
         JOIN yarn_assignments ya
           ON ya.machine_id = e.machine_id
          AND ya.yarn_id = ?
          AND ya.start_time <= e.time
          AND (ya.end_time IS NULL OR ya.end_time > e.time)
         WHERE LOWER(e.event) = 'defect'
           AND e.time >= ?
           AND e.time < ?`
      ).bind(clientId, yarnId, dayStartIso, dayEndIso).first();

      const fails = Number(failsRow?.fails ?? 0);

      const rollsRow = await DB.prepare(
        `SELECT COUNT(*) AS rolls
         FROM machine_events e
         JOIN machines m ON m.machine_id = e.machine_id AND m.client_id = ?
         JOIN yarn_assignments ya
           ON ya.machine_id = e.machine_id
          AND ya.yarn_id = ?
          AND ya.start_time <= e.time
          AND (ya.end_time IS NULL OR ya.end_time > e.time)
         WHERE LOWER(e.event) = 'roll_change'
           AND e.time >= ?
           AND e.time < ?`
      ).bind(clientId, yarnId, dayStartIso, dayEndIso).first();

      const rolls = Number(rollsRow?.rolls ?? 0);

      const paradasRow = await DB.prepare(
        `SELECT COUNT(*) AS paradas_raw
         FROM machine_states s
         JOIN machines m ON m.machine_id = s.machine_id AND m.client_id = ?
         JOIN yarn_assignments ya
           ON ya.machine_id = s.machine_id
          AND ya.yarn_id = ?
          AND ya.start_time <= s.start_time
          AND (ya.end_time IS NULL OR ya.end_time > s.start_time)
         WHERE (REPLACE(UPPER(s.status), ' ', '_') IN ('PARADA', 'STOP', 'OFF', 'OFFLINE'))
           AND s.start_time >= ?
           AND s.start_time < ?`
      ).bind(clientId, yarnId, dayStartIso, dayEndIso).first();

      const paradasRaw = Number(paradasRow?.paradas_raw ?? 0);
      const stops = Math.max(0, paradasRaw - fails);

      const prodRow = await DB.prepare(
        `
        SELECT
          COALESCE(SUM(
            MAX(
              0,
              (
                strftime('%s',
                  MIN(
                    MIN(
                      COALESCE(s.end_time, ?),
                      ?
                    ),
                    COALESCE(ya.end_time, ?)
                  )
                )
                -
                strftime('%s',
                  MAX(
                    MAX(s.start_time, ?),
                    ya.start_time
                  )
                )
              )
            )
          ), 0) AS prod_seconds
        FROM machine_states s
        JOIN machines m ON m.machine_id = s.machine_id AND m.client_id = ?
        JOIN yarn_assignments ya
          ON ya.machine_id = s.machine_id
         AND ya.yarn_id = ?
         AND ya.start_time < ?
         AND (ya.end_time IS NULL OR ya.end_time > ?)
        WHERE (REPLACE(UPPER(s.status), ' ', '_') IN ('EN_MARCHA', 'RUN') OR UPPER(s.status) LIKE 'RUN%')
          AND s.start_time < ?
          AND (s.end_time IS NULL OR s.end_time > ?)
        `
      ).bind(
        dayEndIso,
        dayEndIso,
        dayEndIso,
        dayStartIso,
        clientId,
        yarnId,
        dayEndIso,
        dayStartIso,
        dayEndIso,
        dayStartIso
      ).first();

      const prodSeconds = Number(prodRow?.prod_seconds ?? 0);

      const upd = await DB.prepare(
        `UPDATE yarns_kpis
         SET rolls = ?, stops = ?, defects = ?, run_time = ?
         WHERE yarn_id = ? AND time = ?`
      ).bind(rolls, stops, fails, prodSeconds, yarnId, dayStr).run();

      if ((upd?.meta?.changes ?? 0) === 0) {
        await DB.prepare(
          `INSERT INTO yarns_kpis (yarn_id, rolls, stops, defects, run_time, time)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(yarnId, rolls, stops, fails, prodSeconds, dayStr).run();
      }

      totalUpserts++;
    } catch (err) {
      totalErrors++;
      console.log("[yarn_kpis] ERROR yarn", yarnId, "day", dayStr, ":", err?.stack || err);
    }
  }

  return { upserts: totalUpserts, errors: totalErrors };
}

/** ---------------- JOB 2: Yarn KPIs incremental ---------------- */

async function runYarnKpis(env) {
  const DB = env.DB;
  if (!DB) throw new Error("Missing D1 binding: DB");

  console.log("[yarn_kpis] USING_D1_KPIS");

  const now = new Date();
  const today0 = dayStartUTCFromIso(now.toISOString());
  const yesterday0 = addDaysUTC(today0, -1);

  const clients = await listClients(DB);
  if (!clients.length) return;

  let totalUpserts = 0;
  let totalErrors = 0;

  for (const clientId of clients) {
    const recalcFrom = await getRecalcFrom(DB, clientId);
    let startDay = yesterday0;

    if (recalcFrom) {
      const parsed = dayStartUTCFromIso(`${recalcFrom}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime())) {
        startDay = parsed;
      }
    }

    if (startDay > yesterday0) {
      if (recalcFrom) await clearRecalcFrom(DB, clientId);
      continue;
    }

    for (let day = startDay; day <= yesterday0; day = addDaysUTC(day, 1)) {
      const dayStr = dayStringUTC(day);
      const dayStartIso = isoZ(day);
      const dayEndIso = isoZ(addDaysUTC(day, 1));

      const out = await computeDayForClient({
        env,
        clientId,
        dayStartIso,
        dayEndIso,
        dayStr,
      });

      totalUpserts += out.upserts;
      totalErrors += out.errors;
    }

    if (recalcFrom) {
      await clearRecalcFrom(DB, clientId);
    }
  }

  console.log("[yarn_kpis] DONE upserts=", totalUpserts, "errors=", totalErrors);
}

/** ---------------- Scheduler entrypoint ---------------- */


export default {
  async scheduled(event, env, ctx) {
    const now = new Date();
    console.log("[scheduler] fired", isoZ(now), "cron=", event.cron);

    // Heartbeats: no bloquea el KPI si falla
    ctx.waitUntil(
      cleanHeartbeats(env).catch(err => {
        console.log("[scheduler] cleanHeartbeats FAILED:", err?.stack || err);
      })
    );

    // Yarn KPIs
    ctx.waitUntil(
      runYarnKpis(env).catch(err => {
        console.log("[scheduler] yarn_kpis FAILED:", err?.stack || err);
        throw err;
      })
    );
  }
};
