/**
 * Case time. Cases hold no calendar dates: every time is an ISO 8601 duration
 * relative to the case clock (`PT0M` is the moment of the run, `-P3D` three
 * days before it). Where a fact must carry a date or a timestamp, its data
 * holds a marker the runner resolves against the clock before the model sees
 * it: `{ "$case_time": "PT2H" }` or `{ "$case_date": "-P7D" }`.
 */

const DURATION = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
const MAX_DAYS = 36_600;
const DAY_MS = 86_400_000;

/**
 * Parses a signed duration of weeks, days, hours, minutes, and seconds into
 * milliseconds. Years and months are refused: their length depends on the
 * calendar, and a case must mean the same span on every clock.
 */
export function parseCaseDuration(value: string): number {
  const match = typeof value === "string" ? DURATION.exec(value) : null;
  if (!match || value === "P" || value === "-P" || value.endsWith("T")) {
    throw new Error(`not a case duration: ${String(value)}`);
  }
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms =
    Number(weeks ?? 0) * 7 * DAY_MS +
    Number(days ?? 0) * DAY_MS +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000;
  if (ms > MAX_DAYS * DAY_MS) throw new Error(`case duration exceeds ${MAX_DAYS} days: ${value}`);
  return sign ? -ms : ms;
}

export function isCaseDuration(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    parseCaseDuration(value);
    return true;
  } catch {
    return false;
  }
}

/** Formats a millisecond offset as a case duration (`-PT90M`). */
export function toCaseDuration(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error("offset must be finite");
  const sign = ms < 0 ? "-" : "";
  let rest = Math.round(Math.abs(ms) / 1000);
  const days = Math.floor(rest / 86_400);
  rest -= days * 86_400;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  const seconds = rest - minutes * 60;
  let time = "";
  if (hours) time += `${hours}H`;
  if (minutes) time += `${minutes}M`;
  if (seconds) time += `${seconds}S`;
  if (!days && !time) return "PT0M";
  return `${sign}P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
}

export const MARKER_KEYS = ["$case_time", "$case_date"] as const;

/** True for `{ "$case_time": <duration> }` or `{ "$case_date": <duration> }`. */
export function isTimeMarker(value: unknown): value is Record<"$case_time" | "$case_date", string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (MARKER_KEYS as readonly string[]).includes(keys[0] ?? "") &&
    isCaseDuration((value as Record<string, unknown>)[keys[0] ?? ""]);
}

function localDate(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Replaces every marker in `value` against the clock. A `$case_date` moves by
 * calendar days in `timeZone`, so a span across a daylight-saving change still
 * lands on the right local day.
 */
export function resolveTimeMarkers<T>(value: T, clockMs: number, timeZone = "UTC"): T {
  if (Array.isArray(value)) return value.map((item) => resolveTimeMarkers(item, clockMs, timeZone)) as T;
  if (value && typeof value === "object") {
    if (isTimeMarker(value)) {
      const record = value as Record<string, string>;
      if ("$case_time" in record) return new Date(clockMs + parseCaseDuration(record["$case_time"] ?? "")).toISOString() as T;
      const offset = parseCaseDuration(record["$case_date"] ?? "");
      const days = Math.trunc(offset / DAY_MS);
      // Step from local noon so the day count is immune to a one-hour shift.
      const today = localDate(clockMs, timeZone);
      const noon = Date.parse(`${today}T12:00:00Z`);
      return localDate(noon + days * DAY_MS, "UTC") as T;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = resolveTimeMarkers(item, clockMs, timeZone);
    return out as T;
  }
  return value;
}
