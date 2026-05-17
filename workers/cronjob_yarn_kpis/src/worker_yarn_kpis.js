// yarn_kpis_job.js
// Daily cron: compute KPIs per (yarn_id, day) with UTC day clipping.
// Backfill: if a client has recalc_from set, recompute from that day up to yesterday.

function mustGetDB(env) {
  if (!env?.DB) throw new Error("Missing D1 binding: DB");
  return env.DB;
}

function isoZ(d) {
  return d.toISOString().replace(".000Z", "Z");
}

function midnightUTC(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0));
}

function dayStringUTC(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysUTC(date, deltaDays) {
  return new Date(date.getTime() + deltaDays * 24 * 60 * 60 * 1000);
}

function parseDayUTC(dayStr) {
  const d = new Date(`${dayStr}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function listClients(DB) {
  const res = await DB.prepare(
    `SELECT DISTINCT client_id
     FROM machines
     WHERE client_id IS NOT NULL
     ORDER BY client_id ASC`
  ).all();

  return (res.results ?? []).map((r) => r.client_id).filter(Boolean);
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

export default {
  async scheduled(event, env, ctx) {
    const DB = mustGetDB(env);

    const now = new Date();
    const today0 = midnightUTC(now);
    const yesterday0 = addDaysUTC(today0, -1);

    const clients = await listClients(DB);
    if (!clients.length) return;

    for (const clientId of clients) {
      let startDay = yesterday0;
      const recalcFrom = await getRecalcFrom(DB, clientId);
      if (recalcFrom) {
        const parsed = parseDayUTC(recalcFrom);
        if (parsed) startDay = parsed;
      }

      if (startDay > yesterday0) {
        if (recalcFrom) await clearRecalcFrom(DB, clientId);
        continue;
      }

      for (let day = startDay; day <= yesterday0; day = addDaysUTC(day, 1)) {
        const dayEnd = addDaysUTC(day, 1);
        const dayStartIso = isoZ(day);
        const dayEndIso = isoZ(dayEnd);
        const dayStr = dayStringUTC(day);

        const yarnsRes = await DB.prepare(
          `SELECT DISTINCT ya.yarn_id
           FROM yarn_assignments ya
           JOIN machines m ON m.machine_id = ya.machine_id
           WHERE m.client_id = ?
             AND ya.start_time < ?
             AND (ya.end_time IS NULL OR ya.end_time > ?)
           ORDER BY ya.yarn_id`
        ).bind(clientId, dayEndIso, dayStartIso).all();

        const yarns = (yarnsRes.results ?? []).map((r) => r.yarn_id).filter(Boolean);
        if (!yarns.length) continue;

        for (const yarnId of yarns) {
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
             WHERE REPLACE(UPPER(s.status), ' ', '_') IN ('PARADA', 'STOP', 'OFF', 'OFFLINE')
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

          await DB.prepare(
            `INSERT OR REPLACE INTO yarns_kpis
             (yarn_id, rolls, stops, defects, run_time, time)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            yarnId,
            rolls,
            stops,
            fails,
            prodSeconds,
            dayStr
          ).run();
        }
      }

      if (recalcFrom) {
        await clearRecalcFrom(DB, clientId);
      }
    }
  }
};
