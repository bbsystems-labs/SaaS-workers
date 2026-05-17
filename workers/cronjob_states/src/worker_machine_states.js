export default {
  async scheduled(event, env, ctx) {
    const db = env.DB;
    if (!db) throw new Error("Missing D1 binding: env.DB");

    console.log("[cron] fired", new Date().toISOString(), "cron=", event.cron);

    ctx.waitUntil(run(db, env));
  },
};

async function run(db, env) {
  console.log("[cron] run() start");

  const machineIds = await getMachinesToProcess(db);
  console.log("[cron] machines to process:", machineIds);

  for (const machine_id of machineIds) {
    const client_id = await getClientIdForMachine(db, machine_id);
    if (!client_id) {
      console.log(`[cron] machine ${machine_id} has no client_id, skipping`);
      continue;
    }

    console.log("[cron] processing machine", machine_id);
    await ingestMachineStatesForMachine(db, env, client_id, machine_id);
  }
}

async function getMachinesToProcess(db) {
  const { results } = await db
    .prepare(
      `SELECT machine_id
       FROM machines
       WHERE machine_id IS NOT NULL
         AND machine_id NOT LIKE 'Aracne_%'
       UNION
       SELECT machine_id
       FROM ingestion_cursor
       WHERE table_name = 'machine_states'
         AND machine_id NOT LIKE 'Aracne_%'
       ORDER BY machine_id`
    )
    .all();

  return (results || []).map((r) => r.machine_id).filter(Boolean);
}

async function getClientIdForMachine(db, machine_id) {
  const row = await db
    .prepare(`SELECT client_id FROM machines WHERE machine_id = ?`)
    .bind(machine_id)
    .first();

  return row?.client_id || null;
}

function isHeartbeatKey(key) {
  const filename = key.split("/").pop() || "";
  return filename.toLowerCase().includes("heartbeat");
}

function isLatestStateKey(key) {
  return (key.split("/").pop() || "").toLowerCase() === "latest.json";
}

const FAR_FUTURE_ISO = "9999-12-31T23:59:59.999Z";
const DEFAULT_TIME_ZONE = "Europe/Madrid";
const HAS_TIME_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LATEST_CURSOR_RECOVERY_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const INITIAL_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeStatus(status) {
  return String(status || "").trim().toUpperCase();
}

function normalizeTimestamp(value, defaultTimeZone = DEFAULT_TIME_ZONE) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const normalizedForParse = normalized.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (HAS_TIME_ZONE_RE.test(normalized)) {
    return dateToIso(normalizedForParse);
  }

  return localDateTimeToUtcIso(normalized, defaultTimeZone);
}

function dateToIso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function localDateTimeToUtcIso(value, timeZone) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/
  );
  if (!match) return dateToIso(value);

  const [, y, mo, d, h, mi, s = "0", frac = "0"] = match;
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  const utcGuess = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    ms
  );
  let offsetMs = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  let utcMs = utcGuess - offsetMs;
  offsetMs = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
  utcMs = utcGuess - offsetMs;
  return new Date(utcMs).toISOString();
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function buildStateSegments(observations) {
  const segments = [];
  let current = null;

  for (const obs of observations) {
    const status = normalizeStatus(obs.status);
    if (!status) continue;

    if (!current) {
      current = {
        status,
        start: obs.at,
        startMs: obs.atMs,
        end: obs.heartbeat ? obs.at : null,
        endMs: obs.heartbeat ? obs.atMs : null,
      };
      continue;
    }

    if (current.status === status) {
      if (current.endMs === null || obs.atMs > current.endMs) {
        current.end = obs.at;
        current.endMs = obs.atMs;
      }
      continue;
    }

    if (current.endMs === null || obs.atMs > current.endMs) {
      current.end = obs.at;
      current.endMs = obs.atMs;
    }
    segments.push(current);

    current = {
      status,
      start: obs.at,
      startMs: obs.atMs,
      end: obs.heartbeat ? obs.at : null,
      endMs: obs.heartbeat ? obs.atMs : null,
    };
  }

  if (current) {
    current.end = null;
    current.endMs = null;
    segments.push(current);
  }
  return segments;
}

async function insertStateRow(db, machine_id, status, start_time, end_time = null) {
  await db
    .prepare(
      `INSERT INTO machine_states (machine_id, status, start_time, end_time)
       VALUES (?, ?, ?, ?)`
    )
    .bind(machine_id, status, start_time, end_time)
    .run();
}

async function mergeAdjacentRows(db, machine_id) {
  while (true) {
    const { results } = await db
      .prepare(
        `SELECT rowid, status, start_time, end_time
         FROM machine_states
         WHERE machine_id = ?
         ORDER BY datetime(start_time) ASC, rowid ASC`
      )
      .bind(machine_id)
      .all();

    const rows = results || [];
    let merged = false;

    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
    if (normalizeStatus(prev.status) !== normalizeStatus(curr.status)) continue;

    const prevEndMs = prev.end_time ? Date.parse(prev.end_time) : null;
    const currStartMs = Date.parse(curr.start_time);
    if (prevEndMs !== null && prevEndMs < currStartMs) continue;

    const mergedEnd =
      prev.end_time === null || curr.end_time === null
        ? null
        : (Date.parse(prev.end_time) >= Date.parse(curr.end_time) ? prev.end_time : curr.end_time);

    await db
      .prepare(`UPDATE machine_states SET end_time = ? WHERE rowid = ?`)
      .bind(mergedEnd, prev.rowid)
      .run();
    await deleteRowById(db, curr.rowid);
      merged = true;
      break;
    }

    if (!merged) break;
  }
}

async function getLatestOpenRow(db, machine_id) {
  return await db
    .prepare(
      `SELECT rowid, machine_id, status, start_time, end_time
       FROM machine_states
       WHERE machine_id = ? AND end_time IS NULL
       ORDER BY datetime(start_time) DESC, rowid DESC
       LIMIT 1`
    )
    .bind(machine_id)
    .first();
}

async function closeOpenRow(db, rowid, endTime) {
  await db
    .prepare(`UPDATE machine_states SET end_time = ? WHERE rowid = ? AND end_time IS NULL`)
    .bind(endTime, rowid)
    .run();
}

async function applyObservationsIncrementally(db, machine_id, observations) {
  let openRow = await getLatestOpenRow(db, machine_id);
  let processed = 0;

  for (const obs of observations) {
    const obsStatus = normalizeStatus(obs.status);
    const obsAtMs = Number(obs.atMs);
    if (!obsStatus || !Number.isFinite(obsAtMs)) continue;

    if (!openRow) {
      await insertStateRow(db, machine_id, obsStatus, obs.at, null);
      openRow = await getLatestOpenRow(db, machine_id);
      processed++;
      continue;
    }

    const openStatus = normalizeStatus(openRow.status);
    const openStartMs = Date.parse(openRow.start_time || "");
    if (!Number.isFinite(openStartMs)) {
      openRow = null;
      continue;
    }

    if (obsAtMs < openStartMs) {
      continue;
    }

    if (openStatus === obsStatus) {
      processed++;
      continue;
    }

    if (obsAtMs === openStartMs) {
      await db
        .prepare(`UPDATE machine_states SET status = ? WHERE rowid = ?`)
        .bind(obsStatus, openRow.rowid)
        .run();
      openRow = await getLatestOpenRow(db, machine_id);
      processed++;
      continue;
    }

    await closeOpenRow(db, openRow.rowid, obs.at);
    await insertStateRow(db, machine_id, obsStatus, obs.at, null);
    openRow = await getLatestOpenRow(db, machine_id);
    processed++;
  }

  return processed;
}

async function refreshCurrentStatus(db, machine_id) {
  const latestOpen = await db
    .prepare(
      `SELECT status
       FROM machine_states
       WHERE machine_id = ? AND end_time IS NULL
       ORDER BY datetime(start_time) DESC
       LIMIT 1`
    )
    .bind(machine_id)
    .first();

  const latestAny = latestOpen || await db
    .prepare(
      `SELECT status
       FROM machine_states
       WHERE machine_id = ?
       ORDER BY datetime(start_time) DESC
       LIMIT 1`
    )
    .bind(machine_id)
    .first();

  if (latestAny?.status) {
    await db
      .prepare(`UPDATE machines SET current_status = ? WHERE machine_id = ?`)
      .bind(latestAny.status, machine_id)
      .run();
  }
}

async function ingestMachineStatesForMachine(db, env, client_id, machine_id) {
  const t0 = Date.now();
  console.log(`[machine_states] START machine=${machine_id} client=${client_id}`);

  // 1) Leer cursor
  const cursorRow = await db
    .prepare(
      `SELECT last_key
       FROM ingestion_cursor
       WHERE table_name='machine_states' AND machine_id=?`
    )
    .bind(machine_id)
    .first();

  let last_key = cursorRow?.last_key || null;

  // Sanear cursors antiguos
  if (last_key && last_key.startsWith("balux-monitor-operativa/")) {
    last_key = last_key.replace("balux-monitor-operativa/", "");
  }

  // latest.json is mutable and is usually uploaded just after the immutable
  // historical state. If an old cursor points there, look slightly backwards
  // from latest.uploaded so the matching historical files are not skipped.
  const recoverFromLatestCursor = Boolean(last_key && isLatestStateKey(last_key));

  console.log(`[machine_states] cursor last_key=${last_key ?? "NULL"}`);

  // 2) Timestamp del cursor en R2
  let cursorUploadedMs = null;
  if (last_key) {
    const head = await env.R2_BUCKET.head(last_key);
    if (head?.uploaded) {
      cursorUploadedMs = head.uploaded.getTime();
    }
  }

  if (recoverFromLatestCursor && cursorUploadedMs !== null) {
    cursorUploadedMs -= LATEST_CURSOR_RECOVERY_LOOKBACK_MS;
    last_key = "";
    console.log(`[machine_states] cursor latest.json recovery lookback_ms=${LATEST_CURSOR_RECOVERY_LOOKBACK_MS}`);
  } else if (recoverFromLatestCursor) {
    last_key = null;
    console.log(`[machine_states] cursor latest.json recovery without head; historical rescan`);
  }

  // 3) Listar objetos R2
  const prefix = `${client_id}/${machine_id}/`;
  const effectiveStartMs = cursorUploadedMs !== null
    ? cursorUploadedMs
    : Date.now() - INITIAL_LOOKBACK_MS;
  const shouldUseDateWindow = true;
  const objects = shouldUseDateWindow
    ? await listObjectsByDateWindow(env.R2_BUCKET, client_id, machine_id, effectiveStartMs, Date.now())
    : await listAllObjects(env.R2_BUCKET, prefix);

  console.log(
    `[machine_states] R2 objects=${objects.length} source=${shouldUseDateWindow ? "date_window" : "full_prefix"}`
  );

  // 4) Filtrar candidatos
  const candidates = [];
  for (const obj of objects) {
    if (isLatestStateKey(obj.key)) continue;

    const uploadedMs = obj.uploaded?.getTime?.();
    if (!uploadedMs) continue;

    if (!last_key || cursorUploadedMs === null) {
      candidates.push({ key: obj.key, uploadedMs });
      continue;
    }

    if (
      uploadedMs > cursorUploadedMs ||
      (uploadedMs === cursorUploadedMs && obj.key > last_key)
    ) {
      candidates.push({ key: obj.key, uploadedMs });
    }
  }

  console.log(`[machine_states] candidates=${candidates.length}`);

  if (candidates.length === 0) {
    console.log(`[machine_states] DONE no candidates (${Date.now() - t0} ms)`);
    return;
  }

  const parsedCandidates = [];
  for (const c of candidates) {
    const obj = await env.R2_BUCKET.get(c.key);
    if (!obj) continue;

    let data;
    try {
      data = JSON.parse(await obj.text());
    } catch {
      continue;
    }

    const atRaw = data?.at;
    const at = normalizeTimestamp(atRaw);
    const mid = data?.machine_id;
    const status = data?.status;
    const atMs = Date.parse(at);
    if (!at || !mid || !status || !Number.isFinite(atMs)) continue;

    parsedCandidates.push({
      key: c.key,
      uploadedMs: c.uploadedMs,
      at,
      atMs,
      mid,
      status,
      heartbeat: Boolean(data?.heartbeat) || isHeartbeatKey(c.key),
    });
  }

  parsedCandidates.sort((a, b) => (a.atMs !== b.atMs ? a.atMs - b.atMs : a.key.localeCompare(b.key)));

  let processedOk = 0;
  let failedSegments = 0;

  try {
    processedOk = await applyObservationsIncrementally(db, machine_id, parsedCandidates);
    console.log(`[machine_states] applied_observations machine=${machine_id} count=${processedOk}`);
  } catch (e) {
    console.error(`[machine_states] FAILED_INCREMENTAL machine=${machine_id}`, e);
    failedSegments = 1;
  }

  await mergeAdjacentRows(db, machine_id);
  await refreshCurrentStatus(db, machine_id);

  // 6) Actualizar cursor SOLO si hubo éxito
  const lastProcessed = failedSegments === 0 ? maxUploadedCandidate(parsedCandidates) : null;
  if (lastProcessed) {
    const updateResult = await db
      .prepare(
        `UPDATE ingestion_cursor
         SET last_key = ?
         WHERE table_name='machine_states' AND machine_id=?`
      )
      .bind(lastProcessed.key, machine_id)
      .run();

    if (!updateResult?.meta?.changes) {
      await db
        .prepare(
          `INSERT INTO ingestion_cursor (table_name, machine_id, last_key)
           VALUES ('machine_states', ?, ?)`
        )
        .bind(machine_id, lastProcessed.key)
        .run();
    }

    console.log(`[machine_states] cursor UPDATED ${lastProcessed.key}`);
  } else if (failedSegments > 0) {
    console.log(`[machine_states] cursor NOT updated failedSegments=${failedSegments}`);
  }

  console.log(
    `[machine_states] DONE machine=${machine_id} processed=${processedOk} elapsed=${Date.now() - t0} ms`
  );
}

function maxUploadedCandidate(candidates) {
  let best = null;
  for (const c of candidates) {
    if (
      !best ||
      c.uploadedMs > best.uploadedMs ||
      (c.uploadedMs === best.uploadedMs && c.key > best.key)
    ) {
      best = c;
    }
  }
  return best;
}

async function listAllObjects(r2, prefix) {
  const all = [];
  let cursor;

  while (true) {
    const res = await r2.list({ prefix, cursor });
    if (res?.objects?.length) all.push(...res.objects);
    if (!res.truncated) break;
    cursor = res.cursor;
  }

  return all;
}

async function listObjectsByDateWindow(r2, client_id, machine_id, startMs, endMs) {
  const all = [];
  for (const prefix of datePrefixesForWindow(client_id, machine_id, startMs, endMs)) {
    all.push(...await listAllObjects(r2, prefix));
  }
  return all;
}

function datePrefixesForWindow(client_id, machine_id, startMs, endMs) {
  const dayMs = 24 * 60 * 60 * 1000;
  const startDay = Math.floor((startMs - dayMs) / dayMs) * dayMs;
  const endDay = Math.floor((endMs + dayMs) / dayMs) * dayMs;
  const prefixes = new Set();

  for (let t = startDay; t <= endDay; t += dayMs) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    prefixes.add(`${client_id}/${machine_id}/${y}/${m}/${day}/`);
  }

  return [...prefixes];
}




