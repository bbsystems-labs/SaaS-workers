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
const PRICE_PER_KG_EUR = 7.0;
const PIECE_BUCKET_PREFIX = "savings";
const SAVINGS_COLUMNS = [
  "piece_id",
  "piece_start_time",
  "piece_end_time",
  "productive_time_seconds",
  "defects_count",
  "first_defect_id",
  "first_defect_time",
];

function toMs(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Bad ISO datetime: ${iso}`);
  return ms;
}

function buildPieceId(machineId, endTimeIso) {
  const digits = String(endTimeIso || "").replace(/\D/g, "");
  return `${machineId}_P${digits}`;
}

function toBool(value) {
  return value === 1 || value === "1" || value === true;
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
    `SELECT time, event_id
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

  return row ? { time: row.time ?? null, event_id: row.event_id ?? null } : null;
}

async function getDefects(DB, machineId, rollStart, rollEnd) {
  const res = await DB.prepare(
    `SELECT time, event_id, stop_signal_sent
     FROM machine_events
     WHERE machine_id = ?
       AND event = 'defect'
       AND time >= ?
       AND time < ?
     ORDER BY time ASC`
  )
    .bind(machineId, rollStart, rollEnd)
    .all();

  return (res.results ?? []).map((row) => ({
    id: row.event_id || null,
    time: row.time || null,
    stop_signal_sent: toBool(row.stop_signal_sent),
  }));
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

async function uploadPieceSummary(env, summary) {
  const bucket = env.R2_BUCKET;
  if (!bucket) return false;

  const piece = summary?.piece || {};
  const clientId = String(summary?.client_id || "");
  const machineId = String(summary?.machine_id || "");
  const pieceId = String(piece.id || "");
  const endTime = String(piece.end_time || "");

  if (!clientId || !machineId || !pieceId || !endTime) return false;

  const year = endTime.slice(0, 4);
  const month = endTime.slice(5, 7);
  const day = endTime.slice(8, 10);
  const key = `${PIECE_BUCKET_PREFIX}/${clientId}/${machineId}/${year}/${month}/${day}/${pieceId}/piece_summary.json`;

  await bucket.put(key, JSON.stringify(summary, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  return true;
}

function buildSavingsPayload(firstDefect, savingKg) {
  if (!firstDefect || !firstDefect.time || savingKg == null) return null;

  const estimatedKg = Number(savingKg);
  const estimatedEur = Math.round(estimatedKg * PRICE_PER_KG_EUR * 100) / 100;

  return {
    calculation: "first_defect_only",
    first_defect_id: firstDefect.id || null,
    kg_estimation_method: "time_from_piece_start",
    price_per_kg_eur: PRICE_PER_KG_EUR,
    estimated_kg: Math.round(estimatedKg * 100) / 100,
    estimated_eur: estimatedEur,
  };
}

function buildPieceSummary({
  clientId,
  machineId,
  rollStart,
  rollEnd,
  totalRun,
  defects,
  firstDefect,
  savingKg,
}) {
  const pieceId = buildPieceId(machineId, rollEnd);
  const savings = firstDefect ? buildSavingsPayload(firstDefect, savingKg) : null;
  return {
    client_id: clientId,
    machine_id: machineId,
    piece: {
      id: pieceId,
      start_time: rollStart,
      end_time: rollEnd,
      productive_time_seconds: totalRun,
    },
    defects: defects.map((defect) => ({
      id: defect.id,
      timestamp: defect.time,
      productive_seconds_from_piece_start: Math.max(0, Math.floor((toMs(defect.time) - toMs(rollStart)) / 1000)),
      stop_signal_sent: defect.stop_signal_sent,
    })),
    savings,
  };
}

async function ensureSavingsColumns(DB) {
  const info = await DB.prepare(`PRAGMA table_info(savings)`).all();
  const existing = new Set((info.results ?? []).map((r) => String(r.name || "")));

  for (const column of SAVINGS_COLUMNS) {
    if (existing.has(column)) continue;

    let ddlType = "TEXT";
    if (column === "productive_time_seconds") ddlType = "INTEGER";

    await DB.prepare(`ALTER TABLE savings ADD COLUMN ${column} ${ddlType}`).run();
  }
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
async function insertSavingByRollEnd(DB, machineId, yarnId, savingRatio, rollEndIso, defectsCount = 0) {
  // En SQLite/D1: INSERT OR IGNORE funciona si hay UNIQUE(machine_id, time)
  await DB.prepare(
    `INSERT OR IGNORE INTO savings (
       machine_id,
       yarn_id,
       saved_kg,
       time,
       piece_id,
       piece_start_time,
       piece_end_time,
       productive_time_seconds,
       defects_count,
       first_defect_id,
       first_defect_time
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      machineId,
      yarnId,
      savingRatio,
      rollEndIso,
      buildPieceId(machineId, rollEndIso),
      null,
      rollEndIso,
      null,
      defectsCount,
      null,
      null
    )
    .run();
}

/** ---------- Worker runner ---------- */
async function run(DB, env) {
  await ensureSavingsColumns(DB);

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

        // Determina inicio de producción dentro del rollo.
        const prodStart = await getProdStart(DB, machineId, rollStart, rollEnd);
        const firstDefect = prodStart ? await getFirstDefect(DB, machineId, prodStart, rollEnd) : null;
        const segments = prodStart ? await listRunSegments(DB, machineId, prodStart, rollEnd) : [];
        const totalRun = prodStart ? computeTotalRunSeconds(segments) : 0;

        const firstDefectTime = firstDefect?.time || null;
        const defects = await getDefects(DB, machineId, rollStart, rollEnd);
        const savingKg = firstDefectTime
          ? (totalRun > 0 ? computeRemainingRunSeconds(segments, firstDefectTime) / totalRun : 0) * ROLL_KG
          : 0;

        // Hilo activo en el momento del primer defecto
        const yarnId = firstDefectTime ? await getYarnAt(DB, machineId, firstDefectTime) : null;

        const pieceSummary = buildPieceSummary({
          clientId: (await getClientIdFromMachine(DB, machineId)) || null,
          machineId,
          rollStart,
          rollEnd,
          totalRun,
          defects,
          firstDefect: firstDefectTime ? { id: firstDefect.event_id, time: firstDefectTime } : null,
          savingKg,
        });

        await uploadPieceSummary(env, pieceSummary);

        const pieceId = pieceSummary.piece.id;
        const pieceProductiveSeconds = totalRun;
        const pieceDefectsCount = defects.length;

        // Inserta 1 registro por pieza (keyed por rollEnd)
        await DB.prepare(
          `INSERT OR IGNORE INTO savings (
             machine_id,
             yarn_id,
             saved_kg,
             time,
             piece_id,
             piece_start_time,
             piece_end_time,
             productive_time_seconds,
             defects_count,
             first_defect_id,
             first_defect_time
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            machineId,
            yarnId,
            firstDefectTime ? savingKg : 0,
            rollEnd,
            pieceId,
            rollStart,
            rollEnd,
            pieceProductiveSeconds,
            pieceDefectsCount,
            firstDefect?.event_id || null,
            firstDefectTime
          )
          .run();

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

async function getClientIdFromMachine(DB, machineId) {
  const row = await DB.prepare(
    `SELECT client_id
     FROM machines
     WHERE machine_id = ?
     LIMIT 1`
  )
    .bind(machineId)
    .first();

  return row?.client_id ?? null;
}

