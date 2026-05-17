export default {
  async scheduled(event, env, ctx) {
    const db = env.DB; // <-- usa el binding real
    if (!db) throw new Error('Missing D1 binding: env.DB');

    console.log("[cron] fired", new Date().toISOString(), "cron=", event.cron);
    ctx.waitUntil(run(db, env));
  },
};

const DEFAULT_TIME_ZONE = "Europe/Madrid";
const HAS_TIME_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

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
    await ingestMachineEventsForMachine(db, env, client_id, machine_id);
  }
}

async function getMachinesToProcess(db) {
  const { results } = await db
    .prepare(
      `SELECT machine_id
       FROM machines
       WHERE machine_id IS NOT NULL
       UNION
       SELECT machine_id
       FROM ingestion_cursor
       WHERE table_name = 'machine_events'
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

async function ingestMachineEventsForMachine(db, env, client_id, machine_id) {
  const t0 = Date.now();
  console.log(`[machine_events] START machine=${machine_id} client=${client_id}`);

  // 1) Cursor
  const cursorRow = await db
    .prepare(
      `SELECT last_key
       FROM ingestion_cursor
       WHERE table_name='machine_events' AND machine_id=?`
    )
    .bind(machine_id)
    .first();

  let last_key = cursorRow?.last_key || null;

  // Sanear cursor antiguo si alguna vez guardaste el bucket name dentro de la key
  if (last_key && last_key.startsWith("balux-events/")) {
    last_key = last_key.replace("balux-events/", "");
  }

  console.log(`[machine_events] cursor last_key=${last_key ?? "NULL"}`);

  // 2) Uploaded timestamp del cursor
  let cursorUploadedMs = null;
  if (last_key) {
    const head = await env.R2_BUCKET.head(last_key);
    if (head?.uploaded) cursorUploadedMs = head.uploaded.getTime();
  }

  // 3) Prefijos R2 (sin nombre de bucket)
  const prefixes = [
    { prefix: `logs/defectos/${client_id}/${machine_id}/`, type: "defect" },
    { prefix: `logs/roll_change/${client_id}/${machine_id}/`, type: "roll_change" },
  ];

  // 4) Candidatos
  const candidates = [];

  for (const p of prefixes) {
    const objects = await listAllObjects(env.R2_BUCKET, p.prefix);

    for (const obj of objects) {
      if (!shouldProcessEventKey(obj.key, p.type)) continue;

      const uploadedMs = obj.uploaded?.getTime?.() ?? null;
      if (uploadedMs === null) continue;

      // Si no hay cursor (o head no se pudo leer), ingerimos todo
      if (!last_key || cursorUploadedMs === null) {
        candidates.push({ key: obj.key, uploadedMs, type: p.type });
        continue;
      }

      // Orden estable: (uploadedMs, key) > (cursorUploadedMs, last_key)
      if (
        uploadedMs > cursorUploadedMs ||
        (uploadedMs === cursorUploadedMs && obj.key > last_key)
      ) {
        candidates.push({ key: obj.key, uploadedMs, type: p.type });
      }
    }
  }

  console.log(`[machine_events] candidates=${candidates.length}`);

  if (candidates.length === 0) {
    console.log(`[machine_events] DONE no candidates (${Date.now() - t0} ms)`);
    return;
  }

  // 5) Orden determinista
  candidates.sort((a, b) => {
    if (a.uploadedMs !== b.uploadedMs) return a.uploadedMs - b.uploadedMs;
    return a.key.localeCompare(b.key);
  });

  let lastProcessedKey = null;
  let ok = 0;
  let badJson = 0;
  let missing = 0;
  let insertErrors = 0;

  for (const c of candidates) {
    const obj = await env.R2_BUCKET.get(c.key);
    if (!obj) continue;

    let data;
    try {
      data = JSON.parse(await obj.text());
    } catch {
      badJson++;
      continue;
    }

    const atRaw = data?.at || data?.datetime || data?.timestamp;
    const at = normalizeTimestamp(atRaw);
    const mid = data?.machine_id;
    if (!at || !mid) {
      missing++;
      continue;
    }

    const event = c.type; // "defect" | "roll_change"

    try {
      const existing = await db
        .prepare(
          `SELECT rowid
           FROM machine_events
           WHERE machine_id = ? AND event = ? AND time = ?
           LIMIT 1`
        )
        .bind(mid, event, at)
        .first();

      if (!existing) {
        await db
          .prepare(`INSERT INTO machine_events (machine_id, event, time) VALUES (?, ?, ?)`)
          .bind(mid, event, at)
          .run();
      }

      lastProcessedKey = c.key;
      ok++;
      console.log(`[machine_events] OK mid=${mid} event=${event} at=${at} duplicate=${existing ? 1 : 0}`);
    } catch (e) {
      insertErrors++;
      console.error(
        `[machine_events] INSERT FAILED key=${c.key} mid=${mid} event=${event} at=${at}`,
        e
      );
    }
  }

  // 6) Actualizar cursor
  if (lastProcessedKey) {
    const updateResult = await db
      .prepare(
        `UPDATE ingestion_cursor
         SET last_key = ?
         WHERE table_name='machine_events' AND machine_id=?`
      )
      .bind(lastProcessedKey, machine_id)
      .run();

    if (!updateResult?.meta?.changes) {
      await db
        .prepare(
          `INSERT INTO ingestion_cursor (table_name, machine_id, last_key)
           VALUES ('machine_events', ?, ?)`
        )
        .bind(machine_id, lastProcessedKey)
        .run();
    }

    console.log(`[machine_events] cursor UPDATED ${lastProcessedKey}`);
  } else {
    console.log(`[machine_events] cursor NOT updated (no successful processed record)`);
  }

  console.log(
    `[machine_events] DONE machine=${machine_id} ok=${ok} badJson=${badJson} missing=${missing} insertErrors=${insertErrors} elapsed=${Date.now() - t0} ms`
  );
}

function shouldProcessEventKey(key, type) {
  const lower = key.toLowerCase();
  if (type === "defect") return lower.endsWith("/meta.json");
  return lower.endsWith(".json");
}

async function listAllObjects(r2, prefix) {
  const all = [];
  let cursor = undefined;

  while (true) {
    const res = await r2.list({ prefix, cursor });
    if (res?.objects?.length) all.push(...res.objects);
    if (!res.truncated) break;
    cursor = res.cursor;
  }

  return all;
}
