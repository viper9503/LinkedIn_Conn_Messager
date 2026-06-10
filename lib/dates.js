// Date parsing for LinkedIn connection captions — the fragile, correctness-
// critical part, isolated here so it can be unit-tested in Node without a
// browser. Hardened per an adversarial review:
//   * Dates are compared as integer YMD triples (Y*10000+M*100+D). We NEVER
//     round-trip a bare calendar date through Date/ISO/timezone, which is the
//     classic +UTC-offset off-by-one that silently drops a boundary day.
//   * Relative captions ("2 weeks ago") are COARSE — represented as a [oldest,
//     newest] range, never a single point — so we never early-stop the scroll
//     on a bucket that might still contain in-range people.
//   * "Nmo" = months; a lone "Nm" = MINUTES (=> today), never months.
//   * Month subtraction clamps the day (Mar 31 − 1mo => Feb 28, not Mar 03).
//   * A <time datetime="..."> attribute, when present, is authoritative.

// --- month-name lookup, accent-stripped lowercase keys (en/es/fr/de/it) ---
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  // es
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, abr: 4, ago: 8, dic: 12,
  // fr
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  janv: 1, fevr: 2, juil: 7,
  // de
  januar: 1, februar: 2, marz: 3, dezember: 12, oktober: 10, mai_de: 5, juni: 6, juli: 7, dez: 12, okt: 10,
  // it
  gennaio: 1, febbraio: 2, aprile: 4, maggio: 5, giugno: 6, luglio: 7, settembre: 9, ottobre: 10, dicembre: 12,
};

const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const monthOf = (token) => {
  const k = deaccent(String(token).toLowerCase()).replace(/\.+$/, '');
  return MONTHS[k] ?? null;
};

export const toYMD = (y, m, d) => y * 10000 + m * 100 + d;
export const formatYMD = (ymd) => {
  const y = Math.floor(ymd / 10000);
  const m = Math.floor((ymd % 10000) / 100);
  const d = ymd % 100;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const daysInMonth = (y, m) =>
  [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

// All calendar math is done in UTC and read back in UTC — never crosses a
// timezone, so no off-by-one. Inputs/outputs are [Y, M(1-12), D] triples.
export function shiftDays([y, m, d], n) {
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}
function subMonthsClamped([y, m, d], n) {
  let tm = m - n;
  let ty = y;
  while (tm <= 0) {
    tm += 12;
    ty -= 1;
  }
  return [ty, tm, Math.min(d, daysInMonth(ty, tm))]; // clamp: avoids Mar31-1mo => Mar03
}

// Parse one caption into one of:
//   { kind: 'abs',   ymd }                     — a confident calendar date
//   { kind: 'range', oldest, newest }          — a coarse relative bucket
//   { kind: 'unknown' }                        — unparseable / not yet hydrated
// `now` is the reference [Y, M, D], captured once at script start.
export function parseCaption(rawText, datetime, now) {
  // 1) Machine-readable datetime attribute wins.
  if (datetime) {
    const m = String(datetime).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { kind: 'abs', ymd: toYMD(+m[1], +m[2], +m[3]) };
  }
  if (!rawText) return { kind: 'unknown' };
  const text = deaccent(String(rawText).toLowerCase()).replace(/\s+/g, ' ').trim();
  if (!text || text === 'connected') return { kind: 'unknown' }; // skeleton / placeholder

  // 2) Absolute "Month D, YYYY"
  let m = text.match(/([a-z.]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const mo = monthOf(m[1]);
    if (mo) return { kind: 'abs', ymd: toYMD(+m[3], mo, +m[2]) };
  }
  // 3) Absolute "D Month YYYY" / "D de Mmonth de YYYY"
  m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+)?([a-z.]+)\.?\s+(?:de\s+)?(\d{4})/);
  if (m) {
    const mo = monthOf(m[2]);
    if (mo) return { kind: 'abs', ymd: toYMD(+m[3], mo, +m[1]) };
  }
  // 4) today / yesterday (a few locales)
  if (/\b(today|hoy|aujourd|heute|oggi)\b/.test(text)) return { kind: 'abs', ymd: toYMD(...now) };
  if (/\b(yesterday|ayer|hier|gestern|ieri)\b/.test(text)) return { kind: 'abs', ymd: toYMD(...shiftDays(now, -1)) };

  // 5) Relative "N unit ago" and bare badges ("3w", "2mo", "5m"...).
  //    Order matters: longer tokens first so "mo"/"months" beat a lone "m".
  m = text.match(/(\d+)\s*(years?|yrs?|y|months?|mo|weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/);
  if (m) {
    const n = +m[1];
    const u = m[2];
    if (/^(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)$/.test(u)) return { kind: 'abs', ymd: toYMD(...now) }; // sub-day => today
    if (/^(days?|d)$/.test(u)) return { kind: 'abs', ymd: toYMD(...shiftDays(now, -n)) };
    if (/^(weeks?|w)$/.test(u)) {
      return { kind: 'range', newest: toYMD(...shiftDays(now, -Math.max(0, 7 * n - 3))), oldest: toYMD(...shiftDays(now, -(7 * n + 3))) };
    }
    if (/^(months?|mo)$/.test(u)) {
      const base = subMonthsClamped(now, n);
      return { kind: 'range', newest: toYMD(...shiftDays(base, 15)), oldest: toYMD(...shiftDays(base, -15)) };
    }
    if (/^(years?|yrs?|y)$/.test(u)) {
      const base = subMonthsClamped(now, 12 * n);
      return { kind: 'range', newest: toYMD(...shiftDays(base, 30)), oldest: toYMD(...shiftDays(base, -30)) };
    }
  }
  return { kind: 'unknown' };
}

// Should this connection be INCLUDED in the harvested list (cutoff is inclusive)?
// Unknown dates are kept (flagged) rather than silently dropped.
export function keepCard(parsed, cutoffYMD) {
  if (parsed.kind === 'abs') return parsed.ymd >= cutoffYMD;
  if (parsed.kind === 'range') return parsed.newest >= cutoffYMD; // could be in range
  return true;
}

// Is this connection CONFIDENTLY older than the stop threshold? Only such cards
// may end the scroll early. Ranges qualify only if even their newest bound is
// older; unknown never qualifies.
export function isOlderThan(parsed, thresholdYMD) {
  if (parsed.kind === 'abs') return parsed.ymd < thresholdYMD;
  if (parsed.kind === 'range') return parsed.newest < thresholdYMD;
  return false;
}

// Sort key / human label for a parsed date.
export function sortKeyOf(parsed, fallbackYMD) {
  if (parsed.kind === 'abs') return parsed.ymd;
  if (parsed.kind === 'range') return parsed.newest;
  return fallbackYMD;
}
export function labelOf(parsed) {
  if (parsed.kind === 'abs') return formatYMD(parsed.ymd);
  if (parsed.kind === 'range') return `≈ ${formatYMD(parsed.newest)} (approx)`;
  return 'date unknown';
}

export function parseSince(s) {
  const m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) throw new Error(`--since must be YYYY-MM-DD, got "${s}"`);
  return { parts: [+m[1], +m[2], +m[3]], ymd: toYMD(+m[1], +m[2], +m[3]) };
}

// --- name / company extraction from a free-form headline ---
export function firstNameOf(name) {
  if (!name) return '';
  const cleaned = String(name)
    .replace(/[^\p{L}\p{M}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(' ')[0] || '';
}

// Best-effort. English " at " / " @ " only — deliberately NOT the multi-locale
// separators (the review showed " en " etc. produce garbage). Returns null when
// no company is confidently present; callers substitute a graceful fallback.
export function extractCompany(headline) {
  if (!headline) return null;
  const h = String(headline).replace(/\s+/g, ' ').trim();
  const m = h.match(/\s(?:at|@)\s+(.+)$/i); // first " at " — candidate may itself contain " at "
  if (!m) return null;
  let c = m[1].split(/\s[|•·—–\-]\s/)[0]; // drop a trailing " - clause"
  c = c.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}).]+$/u, '').trim();
  return c || null;
}
