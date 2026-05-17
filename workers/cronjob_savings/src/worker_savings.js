// worker.js
// Savings job (Opción A): 1 fila en `savings` por rollo con DEFECT, usando `time = rollEnd`
// Cursor guarda también rollEnd (último rollo cerrado procesado)

export default {
  async scheduled(event, env, ctx) {
    const DB = env.DB;
    if (!DB) throw new Error('Missing D1 binding: env.DB');
    ctx.waitUntil(run(DB, env));
  },
};

const SOURCE = "savings";
const ROLL_KG = 20;

function toMs(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Bad ISO datetime: ${iso}`);
  return ms;
}

/** ---------- Machines (DB-driven, scalable to 40+) ---------- */
async function listActiveMachines(DB) {
  const res = await DB.prepare(
    `SELECT machine_id
     FROM machines
     ORDER BY machine_id`
  ).all();

  return (res.results ?? []).map((r) => r.machine_id).filter(Boolean);
}

/** ---------- Cursor ---------- */
async function getCursor(DB, machineId) {
  const row = await DB.prepare(
    `SELECT last_dt
     FROM derived_cursor
     WHERE table_name = ? AND machine_id = ?
     LIMIT 1`
  )
    .bind(SOURCE, machineId)
    .first();

  return row?.last_dt ?? "1970-01-01T00:00:00Z";
}

async function setCursor(DB, machineId, lastTime) {
  // 1) intenta UPDATE
  const upd = await DB.prepare(
    `UPDATE derived_cursor
     SET last_dt = ?
     WHERE table_name = ? AND machine_id = ?`
  ).bind(lastTime, SOURCE, machineId).run();

  // 2) si no existía fila, INSERT
  const changed = upd?.meta?.changes ?? 0;
  if (changed === 0) {
    await DB.prepare(
      `INSERT INTO derived_cursor (table_name, machine_id, last_dt)
       VALUES (?, ?, ?)`
    ).bind(SOURCE, machineId, lastTime).run();
  }
}

/** ---------- Data fetchers ---------- */
/**
 * IMPORTANTE:
 * - El cursor guarda rollEnd (que es también el rollStart del siguiente rollo).
 * - Por tanto debemos pedir ROLL_CHANGE con time >= cursor (no >).
 */
async function listRollChanges(DB, machineId, fromTimeInclusive, limit = 2000) {
  const res = await DB.prepare(
    `SELECT time
     FROM machine_events
     WHERE machine_id = ?
       AND event = 'roll_change'
       AND time >= ?
     ORDER BY time ASC
     LIMIT ?`
  )
    .bind(machineId, fromTimeInclusive, limit)
    .all();

  return res.results ?? [];
}

async function getProdStart(DB, machineId, rollStart, rollEnd) {
  const row = await DB.prepare(
    `SELECT start_time
     FROM machine_states
     WHERE machine_id = ?
       AND (UPPER(status) = 'EN_MARCHA' OR UPPER(status) LIKE 'RUN%')
       AND start_time >= ?
       AND start_time < ?
     ORDER BY start_time ASC
     LIMIT 1`
  )
    .bind(machineId, rollStart, rollEnd)
    .first();

  return row?.start_time ?? null;
}

async function getFirstDefect(DB, machineId, prodStart, rollEnd) {
  const row = await DB.prepare(
    `SELECT time
     FROM machine_events
     WHERE machine_id = ?
       AND event = 'defect'
       AND time >= ?
       AND time < ?
     ORDER BY time ASC
     LIMIT 1`
  )
    .bind(machineId, prodStart, rollEnd)
    .first();

  return row?.time ?? null;
}

async function listRunSegments(DB, machineId, prodStart, rollEnd) {
  const res = await DB.prepare(
    `SELECT start_time, end_time
     FROM machine_states
     WHERE machine_id = ?
       AND (UPPER(status) = 'EN_MARCHA' OR UPPER(status) LIKE 'RUN%')
       AND start_time >= ?
       AND start_time < ?
     ORDER BY start_time ASC`
  )
    .bind(machineId, prodStart, rollEnd)
    .all();

  return res.results ?? [];
}

async function getYarnAt(DB, machineId, tIso) {
  const row = await DB.prepare(
    `SELECT yarn_id
     FROM yarn_assignments
     WHERE machine_id = ?
       AND datetime(start_time) <= datetime(?)
       AND (
         end_time IS NULL
         OR TRIM(end_time) = ''
         OR datetime(end_time) > datetime(?)
       )
     ORDER BY start_time DESC
     LIMIT 1`
  )
    .bind(machineId, tIso, tIso)
    .first();

  return row?.yarn_id ?? null;
}

/** ---------- Computation ---------- */
function computeTotalRunSeconds(segments) {
  let totalMs = 0;
  for (const seg of segments) {
    if (!seg.end_time) continue; // si está abierto, no computamos aún
    const a = toMs(seg.start_time);
    const b = toMs(seg.end_time);
    if (b > a) totalMs += b - a;
  }
  return Math.floor(totalMs / 1000);
}

function computeRemainingRunSeconds(segments, defectTimeIso) {
  const t0 = toMs(defectTimeIso);
  let remMs = 0;

  for (const seg of segments) {
    if (!seg.end_time) continue;
    const a = toMs(seg.start_time);
    const b = toMs(seg.end_time);

    if (b <= t0) continue;
    const from = Math.max(a, t0);
    if (b > from) remMs += b - from;
  }

  return Math.floor(remMs / 1000);
}

/** ---------- Persistence ----------
 * Opción A: 1 fila por rollo (rollEnd)
 * Requiere: UNIQUE(machine_id, time) en savings, donde time = rollEnd
 */
async function insertSavingByRollEnd(DB, machineId, yarnId, savingRatio, rollEndIso) {
  // En SQLite/D1: INSERT OR IGNORE funciona si hay UNIQUE(machine_id, time)
  await DB.prepare(
    `INSERT OR IGNORE INTO savings (machine_id, yarn_id, saved_kg, time)
     VALUES (?, ?, ?, ?)`
  )
    .bind(machineId, yarnId, savingRatio, rollEndIso)
    .run();
}

/** ---------- Worker runner ---------- */
async function run(DB, env) {
  const machines = await listActiveMachines(DB);
  if (!machines.length) return;

  for (const machineId of machines) {
    try {
      const cursor = await getCursor(DB, machineId);

      // Fetch roll changes desde cursor INCLUSIVO (crítico)
      const rollChanges = await listRollChanges(DB, machineId, cursor, 2000);

      // Necesitamos al menos 2 ROLL_CHANGE para formar un rollo [start, end)
      if (rollChanges.length < 2) continue;

      let maxRollEnd = cursor;

      // Procesa pares consecutivos: rollStart = i, rollEnd = i+1
      for (let i = 0; i < rollChanges.length - 1; i++) {
        const rollStart = rollChanges[i].time;
        const rollEnd = rollChanges[i + 1].time;

        // Guard rail: tiempos mal ordenados o iguales
        if (!rollStart || !rollEnd || toMs(rollEnd) <= toMs(rollStart)) {
          maxRollEnd = rollEnd || maxRollEnd;
          continue;
        }

        // Determina inicio de producción dentro del rollo
        const prodStart = await getProdStart(DB, machineId, rollStart, rollEnd);
        if (!prodStart) {
          maxRollEnd = rollEnd;
          continue;
        }

        // Primer defecto dentro de ventana productiva del rollo
        const defectTime = await getFirstDefect(DB, machineId, prodStart, rollEnd);
        if (!defectTime) {
          maxRollEnd = rollEnd;
          continue; // rollo no intervenido => no saving
        }

        // Segmentos EN_MARCHA dentro del rollo
        const segments = await listRunSegments(DB, machineId, prodStart, rollEnd);

        const totalRun = computeTotalRunSeconds(segments);
        if (totalRun <= 0) {
          maxRollEnd = rollEnd;
          continue;
        }

        const remainingRun = computeRemainingRunSeconds(segments, defectTime);
        const savingRatio = (remainingRun / totalRun) * ROLL_KG; // 0..1

        // Hilo activo en el momento del defecto
        const yarnId = await getYarnAt(DB, machineId, defectTime);

        // Inserta 1 registro por rollo (keyed por rollEnd)
        await insertSavingByRollEnd(DB, machineId, yarnId, savingRatio, rollEnd);

        // Avanza cursor hasta el rollEnd procesado
        maxRollEnd = rollEnd;
      }

      // Solo escribe cursor si avanzó (opcional, pero más limpio)
      if (maxRollEnd !== cursor) {
        await setCursor(DB, machineId, maxRollEnd);
      }
    } catch (err) {
      // No dejamos que una máquina rompa el job entero
      console.log(`[savings_job] machine=${machineId} error:`, err?.stack || err);
    }
  }
}

