/**
 * The timezone the admin dashboard reasons in.
 *
 * An IANA zone and NOT a fixed offset: Latvia is UTC+3 in summer and UTC+2 in
 * winter, so a hardcoded +3 would move "today" by an hour at the end of
 * October and quietly mislabel a day's worth of signups.
 */
export const ANALYTICS_TIMEZONE = "Europe/Riga";

/** The zone's wall-clock reading of `at`, as a UTC timestamp in ms. */
function wallClockMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ANALYTICS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // h23 rather than hour12:false - some ICU builds render midnight as "24"
    // under the latter, which would push the computed day forward by one.
    hourCycle: "h23",
  }).formatToParts(at);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
}

/**
 * The instant at which the local day containing `at` began.
 *
 * Derives the zone's offset from `at` itself rather than from the current date,
 * so a timestamp from the other side of a DST change is still bucketed by the
 * rules that were in force when it happened.
 */
export function startOfLocalDay(at: Date = new Date()): Date {
  const wall = wallClockMs(at);
  // Seconds resolution: wallClockMs cannot see milliseconds, so comparing it
  // against the raw timestamp would fold the sub-second remainder into the
  // offset and shift midnight by up to 999ms.
  const offsetMs = wall - Math.floor(at.getTime() / 1000) * 1000;
  const localMidnight = wall - (wall % 86_400_000);
  return new Date(localMidnight - offsetMs);
}

/** Whether `at` falls inside the local day that `now` is in. */
export function isLocalToday(at: Date, now: Date = new Date()): boolean {
  const start = startOfLocalDay(now).getTime();
  const t = at.getTime();
  return t >= start && t < start + 86_400_000;
}
