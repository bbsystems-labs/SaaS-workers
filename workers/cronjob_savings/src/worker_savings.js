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
  "first_defect_piece_pct",
];
const PIECE_RECALC_TABLE = "piece_recalc_cursor";
const MACHINE_EVENTS_OPTIONAL_COLUMNS = [
  "event_id",
  "stop_signal_sent",
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

function buildFallbackDefectId(time) {
  const digits = String(time || "").replace(/\D/g, "");
  return digits ? `defect_${digits}` : null;
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
  const hasEventId = await hasMachineEventsColumn(DB, "event_id");
  const select = hasEventId ? "time, event_id" : "time";
  const row = await DB.prepare(
    `SELECT ${select}
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

  return row
    ? {
        time: row.time ?? null,
        event_id: row.event_id || buildFallbackDefectId(row.time),
      }
    : null;
}

async function getDefects(DB, machineId, rollStart, rollEnd) {
  const hasEventId = await hasMachineEventsColumn(DB, "event_id");
  const hasStopSignalSent = await hasMachineEventsColumn(DB, "stop_signal_sent");
  const select = [
    "time",
    hasEventId ? "event_id" : null,
    hasStopSignalSent ? "stop_signal_sent" : null,
  ].filter(Boolean).join(", ");

  const res = await DB.prepare(
    `SELECT ${select}
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
    id: row.event_id || buildFallbackDefectId(row.time),
    time: row.time || null,
    stop_signal_sent: hasStopSignalSent ? toBool(row.stop_signal_sent) : false,
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
    `SELECT ya.yarn_id, y.yarn_name
     FROM yarn_assignments ya
     LEFT JOIN machines m ON m.machine_id = ya.machine_id
     LEFT JOIN yarns y
       ON y.yarn_id = ya.yarn_id
      AND y.client_id = m.client_id
     WHERE ya.machine_id = ?
       AND datetime(ya.start_time) <= datetime(?)
       AND (
         ya.end_time IS NULL
         OR TRIM(ya.end_time) = ''
         OR datetime(ya.end_time) > datetime(?)
       )
     ORDER BY ya.start_time DESC
     LIMIT 1`
  )
    .bind(machineId, tIso, tIso)
    .first();

  return {
    id: row?.yarn_id ?? null,
    name: row?.yarn_name ?? null,
  };
}

async function getPreviousRollChange(DB, machineId, beforeTimeExclusive) {
  const row = await DB.prepare(
    `SELECT time
     FROM machine_events
     WHERE machine_id = ?
       AND event = 'roll_change'
       AND time < ?
     ORDER BY time DESC
     LIMIT 1`
  )
    .bind(machineId, beforeTimeExclusive)
    .first();

  return row?.time ?? null;
}

async function deleteSavingsFrom(DB, machineId, fromTimeInclusive) {
  await DB.prepare(
    `DELETE FROM savings
     WHERE machine_id = ?
       AND time >= ?`
  )
    .bind(machineId, fromTimeInclusive)
    .run();
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

async function uploadPieceReport(env, summary) {
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
  const key = `${PIECE_BUCKET_PREFIX}/${clientId}/${machineId}/${year}/${month}/${day}/${pieceId}/piece_report.pdf`;

  const pdfBytes = buildPieceReportPdfBytes(summary);
  await bucket.put(key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" },
  });

  return true;
}

function escapePdfText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function formatMadridDateTime(iso, includeSeconds = true) {
  if (!iso) return "-";
  try {
    const parts = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: includeSeconds ? "2-digit" : undefined,
      hourCycle: "h23",
    }).formatToParts(new Date(iso));
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const date = `${map.day}/${map.month}/${map.year}`;
    const time = includeSeconds
      ? `${map.hour}:${map.minute}:${map.second}`
      : `${map.hour}:${map.minute}`;
    return `${date} ${time}`;
  } catch {
    return String(iso).replace("T", " ").replace("Z", "");
  }
}

async function ensurePieceRecalcTable(DB) {
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${PIECE_RECALC_TABLE} (
       machine_id TEXT PRIMARY KEY,
       recalc_from TEXT,
       updated_at TEXT
     )`
  ).run();
}

async function getPieceRecalcFrom(DB, machineId) {
  const row = await DB.prepare(
    `SELECT recalc_from
     FROM ${PIECE_RECALC_TABLE}
     WHERE machine_id = ?
     LIMIT 1`
  )
    .bind(machineId)
    .first();

  return row?.recalc_from ?? null;
}

async function setPieceRecalcFrom(DB, machineId, recalcFrom) {
  const updatedAt = new Date().toISOString();
  const upd = await DB.prepare(
    `UPDATE ${PIECE_RECALC_TABLE}
     SET recalc_from = ?, updated_at = ?
     WHERE machine_id = ?`
  )
    .bind(recalcFrom, updatedAt, machineId)
    .run();

  if ((upd?.meta?.changes ?? 0) === 0) {
    await DB.prepare(
      `INSERT INTO ${PIECE_RECALC_TABLE} (machine_id, recalc_from, updated_at)
       VALUES (?, ?, ?)`
    )
      .bind(machineId, recalcFrom, updatedAt)
      .run();
  }
}

async function clearPieceRecalcFrom(DB, machineId) {
  await DB.prepare(
    `UPDATE ${PIECE_RECALC_TABLE}
     SET recalc_from = NULL, updated_at = ?
     WHERE machine_id = ?`
  )
    .bind(new Date().toISOString(), machineId)
    .run();
}

function formatDurationShort(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, "0")} min`;
}

function formatPercent(value) {
  const pct = Number(value || 0);
  return `${Math.round(pct * 10) / 10}%`;
}

function buildPieceReportPdfBytes(summary) {
  const piece = summary?.piece || {};
  const defects = Array.isArray(summary?.defects) ? summary.defects : [];
  const machineId = String(summary?.machine_id || "-");
  const yarnName = String(summary?.yarn_name || summary?.yarn_id || "-");
  const pieceId = String(piece.id || "-");
  const startTime = formatMadridDateTime(piece.start_time, false);
  const endTime = formatMadridDateTime(piece.end_time, false);
  const productiveTime = formatDurationShort(piece.productive_time_seconds);
  const defectsCount = defects.length;
  const totalPct = 100;

  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 28;
  const gap = 12;

  const commands = [];

  const drawRect = (x, y, w, h, stroke = null, fill = null, lineWidth = 1) => {
    if (fill) {
      commands.push("q");
      commands.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`);
      commands.push(`${x} ${y} ${w} ${h} re f`);
      commands.push("Q");
    }
    if (stroke) {
      commands.push("q");
      commands.push(`${lineWidth} w`);
      commands.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG`);
      commands.push(`${x} ${y} ${w} ${h} re S`);
      commands.push("Q");
    }
  };

  const drawLine = (x1, y1, x2, y2, stroke = [0, 0, 0], lineWidth = 1) => {
    commands.push("q");
    commands.push(`${lineWidth} w`);
    commands.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG`);
    commands.push(`${x1} ${y1} m ${x2} ${y2} l S`);
    commands.push("Q");
  };

  const drawText = (x, y, text, options = {}) => {
    const {
      size = 12,
      font = "F1",
      color = [0.08, 0.19, 0.27],
      centered = false,
    } = options;
    const safe = escapePdfText(text);
    const approxWidth = safe.length * size * 0.46;
    const finalX = centered ? x - approxWidth / 2 : x;
    commands.push("BT");
    commands.push(`/${font} ${size} Tf`);
    commands.push(`${color[0]} ${color[1]} ${color[2]} rg`);
    commands.push(`1 0 0 1 ${finalX.toFixed(2)} ${y.toFixed(2)} Tm`);
    commands.push(`(${safe}) Tj`);
    commands.push("ET");
  };

  commands.push("q");
  commands.push("1 1 1 rg");
  commands.push(`0 0 ${pageWidth} ${pageHeight} re f`);
  commands.push("Q");

  drawText(margin, 552, "Resumen de pieza", { size: 26, font: "F2", color: [0.07, 0.14, 0.24] });
  drawText(margin, 526, pieceId, { size: 15, font: "F1", color: [0.23, 0.31, 0.39] });

  const cards = [
    { label: "Maquina", value: machineId },
    { label: "Hilo", value: yarnName || "-" },
    { label: "Inicio", value: startTime },
    { label: "Fin", value: endTime },
    { label: "Tiempo productivo", value: productiveTime },
    { label: "Defectos", value: String(defectsCount) },
  ];

  const cardW = (pageWidth - margin * 2 - gap * 2) / 3;
  const cardH = 64;
  const cardTop = 485;
  for (let i = 0; i < cards.length; i++) {
    const row = i < 3 ? 0 : 1;
    const col = i % 3;
    const x = margin + col * (cardW + gap);
    const y = cardTop - row * (cardH + 12);
    drawRect(x, y - cardH, cardW, cardH, [0.83, 0.87, 0.9], [0.97, 0.98, 0.99], 1);
    drawText(x + 14, y - 16, cards[i].label, {
      size: 10,
      font: "F2",
      color: [0.46, 0.54, 0.6],
    });
    drawText(x + 14, y - 40, cards[i].value, {
      size: i === 0 ? 12 : 13,
      font: "F2",
      color: [0.08, 0.19, 0.27],
    });
  }

  const barX = 76;
  const barY = 165;
  const barW = pageWidth - 152;
  const barH = 26;

  drawText(margin, 232, "PIEZA", { size: 12, font: "F2", color: [0.46, 0.54, 0.6] });
  drawRect(barX, barY, barW, barH, [0.78, 0.82, 0.86], [0.92, 0.95, 0.98], 1);
  drawLine(barX, barY + barH + 10, barX + barW, barY + barH + 10, [0.16, 0.34, 0.48], 2);

  if (defects.length === 0) {
    drawText(barX + barW / 2, barY + 7, "Sin defectos", {
      size: 12,
      font: "F2",
      color: [0.36, 0.46, 0.55],
      centered: true,
    });
  }

  for (const defect of defects) {
    const pct = Math.max(0, Math.min(100, Number(defect.piece_progress_pct || 0)));
    const x = barX + (pct / totalPct) * barW;
    const stamp = formatMadridDateTime(defect.timestamp || defect.time, true);
    drawText(x, 212, stamp, { size: 9, font: "F2", color: [0.6, 0.11, 0.11], centered: true });
    drawRect(x - 4, barY + barH - 2, 8, 12, [0.75, 0.07, 0.07], [0.9, 0.24, 0.24], 1);
    drawText(x, barY + 7, formatPercent(defect.piece_progress_pct || 0), {
      size: 9,
      font: "F2",
      color: [1, 1, 1],
      centered: true,
    });
  }

  drawText(barX, 124, "0%", { size: 11, font: "F2", color: [0.32, 0.39, 0.46] });
  drawText(barX + barW, 124, "100%", {
    size: 11,
    font: "F2",
    color: [0.32, 0.39, 0.46],
    centered: true,
  });
  drawText(barX + barW / 2, 124, "Tiempo productivo", {
    size: 11,
    font: "F2",
    color: [0.32, 0.39, 0.46],
    centered: true,
  });

  const content = commands.join("\n");
  const contentBytes = new TextEncoder().encode(content);
  const header = "%PDF-1.4\n%BALUX\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
  ];

  const encoder = new TextEncoder();
  const chunks = [encoder.encode(header)];
  const offsets = [0];
  let total = encoder.encode(header).length;
  for (let i = 0; i < objects.length; i++) {
    const obj = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    offsets.push(total);
    const bytes = encoder.encode(obj);
    chunks.push(bytes);
    total += bytes.length;
  }
  const xrefStart = total;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  chunks.push(encoder.encode(xref));

  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function buildPieceProgressPct(productiveSecondsFromPieceStart, totalRunSeconds) {
  if (!totalRunSeconds || totalRunSeconds <= 0) return 0;
  const pct = (Number(productiveSecondsFromPieceStart || 0) / Number(totalRunSeconds || 0)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 100) / 100));
}

function computeSavedKgFromPiecePct(firstDefectPct) {
  if (firstDefectPct == null) return 0;
  const remainingPct = Math.max(0, Math.min(100, 100 - Number(firstDefectPct || 0)));
  return Math.round(ROLL_KG * (remainingPct / 100) * 100) / 100;
}

function buildSavingsPayload(firstDefect, savingKg, firstDefectPct) {
  if (!firstDefect || !firstDefect.time || savingKg == null) return null;

  const estimatedKg = Number(savingKg);
  const estimatedEur = Math.round(estimatedKg * PRICE_PER_KG_EUR * 100) / 100;

  return {
    calculation: "first_defect_only",
    first_defect_id: firstDefect.id || null,
    first_defect_piece_pct: firstDefectPct,
    kg_estimation_method: "time_from_piece_start",
    price_per_kg_eur: PRICE_PER_KG_EUR,
    estimated_kg: Math.round(estimatedKg * 100) / 100,
    estimated_eur: estimatedEur,
  };
}

function buildPieceSummary({
  clientId,
  machineId,
  yarnId,
  yarnName,
  rollStart,
  rollEnd,
  totalRun,
  defects,
  firstDefect,
  savingKg,
}) {
  const pieceId = buildPieceId(machineId, rollEnd);
  const defectsWithPct = defects.map((defect) => {
    const productiveSecondsFromPieceStart = Math.max(
      0,
      Math.floor((toMs(defect.time) - toMs(rollStart)) / 1000)
    );
    return {
      id: defect.id,
      timestamp: defect.time,
      productive_seconds_from_piece_start: productiveSecondsFromPieceStart,
      piece_progress_pct: buildPieceProgressPct(productiveSecondsFromPieceStart, totalRun),
      stop_signal_sent: defect.stop_signal_sent,
    };
  });

  const firstDefectPct = defectsWithPct.length > 0 ? defectsWithPct[0].piece_progress_pct : null;
  const savings = firstDefect ? buildSavingsPayload(firstDefect, savingKg, firstDefectPct) : null;
  return {
    client_id: clientId,
    machine_id: machineId,
    yarn_id: yarnId,
    yarn_name: yarnName,
    piece: {
      id: pieceId,
      start_time: rollStart,
      end_time: rollEnd,
      productive_time_seconds: totalRun,
    },
    defects: defectsWithPct,
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
    if (column === "first_defect_piece_pct") ddlType = "REAL";

    await DB.prepare(`ALTER TABLE savings ADD COLUMN ${column} ${ddlType}`).run();
  }
}

async function hasMachineEventsColumn(DB, columnName) {
  if (!MACHINE_EVENTS_OPTIONAL_COLUMNS.includes(columnName)) return false;

  const info = await DB.prepare(`PRAGMA table_info(machine_events)`).all();
  const existing = new Set((info.results ?? []).map((r) => String(r.name || "")));
  return existing.has(columnName);
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
  await ensurePieceRecalcTable(DB);

  const machines = await listActiveMachines(DB);
  if (!machines.length) return;

  for (const machineId of machines) {
    try {
      const cursor = await getCursor(DB, machineId);
      const recalcFrom = await getPieceRecalcFrom(DB, machineId);
      let scanFrom = cursor;
      let recalcMode = false;
      if (recalcFrom && recalcFrom <= cursor) {
        const seed = await getPreviousRollChange(DB, machineId, recalcFrom);
        scanFrom = seed || recalcFrom;
        await deleteSavingsFrom(DB, machineId, scanFrom);
        recalcMode = true;
      }

      // Fetch roll changes desde cursor INCLUSIVO (crítico)
      const rollChanges = await listRollChanges(DB, machineId, scanFrom, 2000);

      // Necesitamos al menos 2 ROLL_CHANGE para formar un rollo [start, end)
      if (rollChanges.length < 2) {
        if (recalcMode) {
          await clearPieceRecalcFrom(DB, machineId);
        }
        continue;
      }

      let maxRollEnd = scanFrom;

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
        const firstDefect = await getFirstDefect(DB, machineId, rollStart, rollEnd);
        const segments = prodStart ? await listRunSegments(DB, machineId, prodStart, rollEnd) : [];
        const totalRun = prodStart ? computeTotalRunSeconds(segments) : 0;

        const firstDefectTime = firstDefect?.time || null;
        const defects = await getDefects(DB, machineId, rollStart, rollEnd);
        const firstDefectElapsedSeconds = firstDefectTime
          ? Math.max(0, Math.floor((toMs(firstDefectTime) - toMs(rollStart)) / 1000))
          : 0;
        const firstDefectPct = firstDefectTime
          ? buildPieceProgressPct(firstDefectElapsedSeconds, totalRun)
          : null;
        const savingKg = firstDefectTime ? computeSavedKgFromPiecePct(firstDefectPct) : 0;

        // Hilo activo al inicio de la pieza (referencia estable y retroactiva)
        const yarn = await getYarnAt(DB, machineId, rollStart);
        const yarnId = yarn.id;

        const pieceSummary = buildPieceSummary({
            clientId: (await getClientIdFromMachine(DB, machineId)) || null,
            machineId,
            yarnId,
            yarnName: yarn.name,
            rollStart,
            rollEnd,
            totalRun,
            defects,
            firstDefect: firstDefectTime ? { id: firstDefect.event_id, time: firstDefectTime } : null,
            savingKg,
          });

        await uploadPieceSummary(env, pieceSummary);
        await uploadPieceReport(env, pieceSummary);

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
              first_defect_time,
              first_defect_piece_pct
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
              firstDefectTime,
              pieceSummary.defects?.[0]?.piece_progress_pct ?? null
            )
            .run();

        // Avanza cursor hasta el rollEnd procesado
        maxRollEnd = rollEnd;
      }

      // Solo escribe cursor si avanzó (opcional, pero más limpio)
      if (maxRollEnd !== cursor) {
        await setCursor(DB, machineId, maxRollEnd);
      }
      if (recalcMode) {
        await clearPieceRecalcFrom(DB, machineId);
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

