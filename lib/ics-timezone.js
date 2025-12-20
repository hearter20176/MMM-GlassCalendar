function resolveTimeZone(ev, source) {
  const sourceTz = source && source.timeZone ? source.timeZone : null;
  if (source && source.forceTimeZone && sourceTz) return sourceTz;

  const rruleTz =
    ev &&
    ev.rrule &&
    ev.rrule.origOptions &&
    ev.rrule.origOptions.tzid;
  if (rruleTz) return rruleTz;

  if (ev && ev.start && ev.start.tz) return ev.start.tz;
  return sourceTz;
}

function getTimeZoneOffset(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const formatted = dtf.formatToParts(date);
  const filled = {};
  formatted.forEach(({ type, value }) => {
    if (type !== "literal") filled[type] = value;
  });

  const asUTC = Date.UTC(
    Number(filled.year),
    Number(filled.month) - 1,
    Number(filled.day),
    Number(filled.hour),
    Number(filled.minute),
    Number(filled.second)
  );

  return asUTC - date.getTime();
}

function convertToTimeZone(date, timeZone) {
  if (!timeZone || !(date instanceof Date)) return date;
  const utcDate = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
  try {
    const offset = getTimeZoneOffset(utcDate, timeZone);
    return new Date(utcDate.getTime() - offset);
  } catch (err) {
    console.error("[MMM-GlassCalendar] Failed to apply timezone", timeZone, err);
    return date;
  }
}

function shiftToTimeZone(date, timeZone) {
  if (!timeZone || !(date instanceof Date)) return date;
  try {
    const targetOffset = getTimeZoneOffset(date, timeZone);
    const localOffset = -date.getTimezoneOffset() * 60 * 1000;
    return new Date(date.getTime() + targetOffset - localOffset);
  } catch (err) {
    console.error("[MMM-GlassCalendar] Failed to shift timezone", timeZone, err);
    return date;
  }
}

module.exports = {
  resolveTimeZone,
  getTimeZoneOffset,
  convertToTimeZone,
  shiftToTimeZone
};
