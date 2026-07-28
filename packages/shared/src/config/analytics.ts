/**
 * The timezone the admin dashboard reasons in.
 *
 * An IANA zone and NOT a fixed offset: Latvia is UTC+3 in summer and UTC+2 in
 * winter, so a hardcoded +3 would move "today" by an hour at the end of
 * October and quietly mislabel a day's worth of signups.
 */
export const ANALYTICS_TIMEZONE = "Europe/Riga";

// The options are static, so build the formatter once and reuse it.
const WALL_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-CA", {
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
});

/** The zone's wall-clock reading of `at`, as a UTC timestamp in ms. */
function wallClockMs(at: Date): number {
  const parts = WALL_CLOCK_FORMATTER.formatToParts(at);

  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl gave no ${type} for ${ANALYTICS_TIMEZONE}`);
    return Number(part.value);
  };

  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
}

/** The zone's offset from UTC at `instant`, in ms. */
function offsetMsAt(instant: Date): number {
  // Seconds resolution: formatToParts cannot see milliseconds, so comparing it
  // against the raw timestamp would fold the sub-second remainder into the
  // offset and shift midnight by up to 999ms.
  return wallClockMs(instant) - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the local day containing `at` began.
 *
 * The offset is measured at the candidate midnight rather than at `at`, because
 * on the two days a year Riga shifts, those two instants sit on opposite sides
 * of the transition. Measuring at `at` put the boundary an hour out on exactly
 * the days this function exists to get right.
 *
 * One correction pass is enough only because of WHERE Riga's transition sits.
 * The shift is an hour, so the first guess is never more than an hour from true
 * midnight, and the transition happens at 01:00 UTC - three hours later. The
 * guess therefore cannot land on the far side of it. A zone whose transition
 * fell near midnight would need to iterate to a fixed point instead, so this
 * assumption has to be rechecked if ANALYTICS_TIMEZONE ever changes.
 */
export function startOfLocalDay(at: Date = new Date()): Date {
  const wall = wallClockMs(at);
  // Math.floor, not `%`: JS keeps the sign of the dividend, so a wall-clock
  // reading before 1970 would round up to the next day instead of down.
  const localMidnightWall = Math.floor(wall / 86_400_000) * 86_400_000;
  const guess = new Date(localMidnightWall - offsetMsAt(at));
  return new Date(localMidnightWall - offsetMsAt(guess));
}

/** Whether `at` falls inside the local day that `now` is in. */
export function isLocalToday(at: Date, now: Date = new Date()): boolean {
  return startOfLocalDay(at).getTime() === startOfLocalDay(now).getTime();
}
