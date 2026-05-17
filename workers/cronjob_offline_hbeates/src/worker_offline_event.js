export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      console.log(`[offline] start ${new Date().toISOString()} cron=${event.cron}`);
      try {
        await run(env);
        console.log(`[offline] ok ${new Date().toISOString()}`);
      } catch (err) {
        console.error(`[offline] FAIL`, err?.stack || err);
        throw err;
      }
    })());
  },
};

const OFFLINE_AFTER_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TIME_ZONE = "Europe/Madrid";
const HAS_TIME_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function normalizeTimestamp(value, defaultTimeZone = DEFAULT_TIME_ZONE) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  if (HAS_TIME_ZONE_RE.test(normalized)) {
    return dateToIso(normalized);
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

async function run(env) {
  const machines = await getMachines(env);
  const now = Date.now();

  let offlineWritten = 0;
  let skippedAlreadyOffline = 0;
  let skippedNoHeartbeat = 0;

  for (const m of machines) {
    const { machine_id, client_id } = m;
    if (!machine_id || !client_id) continue;

    const lastState = await readLatestState(env.R2_BUCKET, client_id, machine_id);

    if (!lastState) {
      skippedNoHeartbeat++;
      const changed = await writeOffline(env, client_id, machine_id, now, "no_latest_state");
      if (changed) offlineWritten++;
      else skippedAlreadyOffline++;
      continue;
    }

    if (lastState.status === "OFFLINE") {
      skippedAlreadyOffline++;
      continue;
    }

    const ageMs = now - lastState.atMs;

    if (ageMs > OFFLINE_AFTER_MS) {
      const offlineAtMs = Math.min(lastState.atMs + OFFLINE_AFTER_MS, now);
      const changed = await writeOffline(env, client_id, machine_id, offlineAtMs, `stale_latest last_at=${lastState.at} last_status=${lastState.status}`);
      if (changed) offlineWritten++;
      else skippedAlreadyOffline++;

      console.log(
        `[offline] stale latest machine=${machine_id} client=${client_id} last_at=${lastState.at} last_status=${lastState.status} age_s=${Math.round(ageMs/1000)}`
      );
    }
  }

  console.log(
    `[offline] summary machines=${machines.length} offlineWritten=${offlineWritten} skippedAlreadyOffline=${skippedAlreadyOffline} skippedNoHeartbeat=${skippedNoHeartbeat}`
  );
}

async function getMachines(env) {
  // Need: machine_id, client_id, current_status
  const { results } = await env.DB
    .prepare(
      `SELECT machine_id, client_id, current_status
       FROM machines
       WHERE machine_id NOT LIKE 'Aracne_%'`
    )
    .all();

  return results || [];
}

async function readLatestState(r2, client_id, machine_id) {
  const key = `${client_id}/${machine_id}/latest.json`;
  const obj = await r2.get(key);
  if (!obj) return null;

  return parseStateObject(key, await obj.text());
}

function parseStateObject(key, rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return null;
  }

  const at = normalizeTimestamp(data?.at || data?.timestamp || data?.datetime);
  const atMs = Date.parse(at || "");
  const status = String(data?.status || "").trim().toUpperCase();
  if (!at || !Number.isFinite(atMs) || !status) return null;

  return { key, at, atMs, status };
}

async function writeOffline(env, client_id, machine_id, requestedOfflineAtMs, reason) {
  const openRow = await env.DB
    .prepare(
      `SELECT start_time, status
       FROM machine_states
       WHERE machine_id = ? AND end_time IS NULL
       ORDER BY start_time DESC
       LIMIT 1`
    )
    .bind(machine_id)
    .first();

  const openStartMs = Date.parse(openRow?.start_time || "");
  const offlineAtMs =
    Number.isFinite(openStartMs) && openStartMs > requestedOfflineAtMs
      ? openStartMs
      : requestedOfflineAtMs;
  const offlineAt = new Date(offlineAtMs).toISOString().replace(".000Z", "Z");
  const key = buildOfflineKey(client_id, machine_id, offlineAt);
  const latestKey = `${client_id}/${machine_id}/latest.json`;
  const payload = {
    client: client_id,
    machine_id: machine_id,
    status: "OFFLINE",
    at: offlineAt,
    heartbeat: false,
    reason,
  };

  const openStatus = String(openRow?.status || "").toUpperCase();
  if (openStatus !== "OFFLINE") {
    await env.R2_BUCKET.put(key, JSON.stringify(payload, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.R2_BUCKET.put(latestKey, JSON.stringify(payload, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });

    if (openRow?.start_time) {
      await env.DB
        .prepare(
          `UPDATE machine_states
           SET end_time = ?
           WHERE machine_id = ? AND start_time = ? AND end_time IS NULL`
        )
        .bind(offlineAt, machine_id, openRow.start_time)
        .run();
    }

    await env.DB
      .prepare(
        `INSERT INTO machine_states (machine_id, status, start_time, end_time)
         VALUES (?, 'OFFLINE', ?, NULL)`
      )
      .bind(machine_id, offlineAt)
      .run();
    await env.DB
      .prepare(`UPDATE machines SET current_status = ? WHERE machine_id = ?`)
      .bind("OFFLINE", machine_id)
      .run();

    console.log(`[offline] wrote OFFLINE machine=${machine_id} client=${client_id} reason=${reason} key=${key} latest=${latestKey}`);
    return true;
  }

  await env.R2_BUCKET.put(latestKey, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  await env.DB
    .prepare(`UPDATE machines SET current_status = ? WHERE machine_id = ?`)
    .bind("OFFLINE", machine_id)
    .run();

  console.log(`[offline] already OFFLINE machine=${machine_id} client=${client_id} reason=${reason} latest=${latestKey}`);
  return false;
}

function buildOfflineKey(client_id, machine_id, atIsoZ) {
  // atIsoZ: "2026-01-08T12:34:00Z"
  const dt = new Date(atIsoZ);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const mm = String(dt.getUTCMinutes()).padStart(2, "0");
  const ss = String(dt.getUTCSeconds()).padStart(2, "0");

  // IMPORTANT: filename must NOT include "heartbeat"
  return `${client_id}/${machine_id}/${y}/${m}/${d}/${hh}${mm}${ss}_offline.json`;
}

function isLatestStateKey(key) {
  return (key.split("/").pop() || "").toLowerCase() === "latest.json";
}
