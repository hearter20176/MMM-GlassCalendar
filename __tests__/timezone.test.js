const test = require("node:test");
const assert = require("node:assert/strict");
const ical = require("node-ical");
const {
  resolveTimeZone,
  convertToTimeZone,
  convertFloatingToTimeZone,
  shiftToTimeZone
} = require("../lib/ics-timezone");

const monthRange = (
  year,
  monthIndex // 0-based
) => {
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
  return { start, end };
};

const wallTime = (date, timeZone) => {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = {};
  dtf.formatToParts(date).forEach(({ type, value }) => {
    if (type !== "literal") parts[type] = value;
  });
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

const wallTimeLocal = (date) => {
  const dtf = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = {};
  dtf.formatToParts(date).forEach(({ type, value }) => {
    if (type !== "literal") parts[type] = value;
  });
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

const isCancelled = (ev) =>
  ev && ev.status && String(ev.status).toUpperCase() === "CANCELLED";

const getRecurrenceKey = (date) => date.toISOString().slice(0, 10);

const getDisplayShiftMs = (date, timeZone) => {
  if (!date || !timeZone) return 0;
  const shifted = shiftToTimeZone(date, timeZone);
  return shifted.getTime() - date.getTime();
};

const normalizeEventDate = (date, tzid, allDay, hasTimeZone) => {
  if (!date || allDay || !tzid) return date;
  return hasTimeZone ? date : convertFloatingToTimeZone(date, tzid);
};

const applyDisplayTimeZone = (date, tzid, forceTimeZone, allDay) => {
  if (!date || allDay || !forceTimeZone || !tzid) return date;
  return shiftToTimeZone(date, tzid);
};

const isInRange = (start, end, rangeStart, rangeEnd) =>
  !!start && !!end && !(end < rangeStart || start > rangeEnd);

const expandEvents = (icsContent, source, rangeStart, rangeEnd) => {
  const data = ical.sync.parseICS(icsContent);
  const events = [];
  const forceTimeZone =
    !!(source && source.forceTimeZone && source.timeZone);
  const padMs = forceTimeZone && source.timeZone
    ? Math.max(
      Math.abs(getDisplayShiftMs(rangeStart, source.timeZone)),
      Math.abs(getDisplayShiftMs(rangeEnd, source.timeZone))
    )
    : 0;
  const rangeStartPadded = padMs
    ? new Date(rangeStart.getTime() - padMs)
    : rangeStart;
  const rangeEndPadded = padMs
    ? new Date(rangeEnd.getTime() + padMs)
    : rangeEnd;

  Object.values(data).forEach((ev) => {
    if (!ev || ev.type !== "VEVENT") return;
    if (isCancelled(ev)) return;
    const start = ev.start;
    const end = ev.end || ev.start;
    if (!start) return;

    const allDay =
      ev.datetype === "date" ||
      (!ev.start.tz && ev.start.getHours() === 0 && end.getHours() === 0);

    const tzid = resolveTimeZone(ev, source);
    const normalizedStart = normalizeEventDate(
      start,
      tzid,
      allDay,
      !!(start && start.tz)
    );
    const normalizedEnd = normalizeEventDate(
      end,
      tzid,
      allDay,
      !!(end && end.tz)
    );
    const durationMs =
      normalizedStart && normalizedEnd
        ? Math.max(0, normalizedEnd - normalizedStart)
        : 0;

    if (ev.rrule) {
      const dates = ev.rrule.between(rangeStartPadded, rangeEndPadded, true);
      dates.forEach((d) => {
        const recurrenceKey = getRecurrenceKey(d);
        if (ev.exdate && ev.exdate[recurrenceKey]) return;

        const recurrence =
          ev.recurrences && ev.recurrences[recurrenceKey];
        if (recurrence && isCancelled(recurrence)) return;

        let occurrenceStart;
        let occurrenceEnd;

        if (recurrence) {
          const recStart = recurrence.start || d;
          const recEnd = recurrence.end || null;
          occurrenceStart = normalizeEventDate(
            recStart,
            tzid,
            allDay,
            !!(recStart && recStart.tz)
          );
          occurrenceEnd = recEnd
            ? normalizeEventDate(
              recEnd,
              tzid,
              allDay,
              !!(recEnd && recEnd.tz)
            )
            : new Date(occurrenceStart.getTime() + durationMs);
        } else {
          occurrenceStart =
            !allDay && tzid ? convertToTimeZone(d, tzid) : d;
          occurrenceEnd = new Date(occurrenceStart.getTime() + durationMs);
        }

        const displayStart = applyDisplayTimeZone(
          occurrenceStart,
          tzid,
          forceTimeZone,
          allDay
        );
        const displayEnd = applyDisplayTimeZone(
          occurrenceEnd,
          tzid,
          forceTimeZone,
          allDay
        );

        if (!isInRange(displayStart, displayEnd, rangeStart, rangeEnd)) {
          return;
        }

        events.push({
          title: ev.summary || "",
          start: displayStart,
          end: displayEnd,
          tzid
        });
      });
      return;
    }

    const displayStart = applyDisplayTimeZone(
      normalizedStart,
      tzid,
      forceTimeZone,
      allDay
    );
    const displayEnd = applyDisplayTimeZone(
      normalizedEnd,
      tzid,
      forceTimeZone,
      allDay
    );

    if (!isInRange(displayStart, displayEnd, rangeStart, rangeEnd)) return;

    events.push({
      title: ev.summary || "",
      start: displayStart,
      end: displayEnd,
      tzid
    });
  });

  return events;
};

test("pins TZ-aware recurring events to local display time when forced", () => {
  const ics = `
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//GlassCalendar//Test//EN
BEGIN:VEVENT
UID:nyc-recurring@test
DTSTART;TZID=America/New_York:20251112T130000
DTEND;TZID=America/New_York:20251112T140000
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:NYC Recurrence
END:VEVENT
END:VCALENDAR
`;

  const source = { name: "NYC", timeZone: "America/New_York", forceTimeZone: true };
  const { start, end } = monthRange(2025, 10); // November 2025
  const events = expandEvents(ics, source, start, end);

  assert.equal(events.length, 2);
  assert.equal(
    wallTimeLocal(events[0].start),
    "2025-11-12 13:00"
  );
  assert.equal(
    wallTimeLocal(events[1].start),
    "2025-11-13 13:00"
  );
});

test("pins floating events to local display time when forced", () => {
  const ics = `
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//GlassCalendar//Test//EN
BEGIN:VEVENT
UID:floating@test
DTSTART:20251112T090000
DTEND:20251112T100000
SUMMARY:Floating Event
END:VEVENT
END:VCALENDAR
`;

  const source = { name: "Floating", timeZone: "America/New_York", forceTimeZone: true };
  const { start, end } = monthRange(2025, 10);
  const events = expandEvents(ics, source, start, end);

  assert.equal(events.length, 1);
  assert.equal(
    wallTimeLocal(events[0].start),
    "2025-11-12 09:00"
  );
});

test("respects source events in other timezones without shifting them", () => {
  const ics = `
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//GlassCalendar//Test//EN
BEGIN:VEVENT
UID:denver@test
DTSTART;TZID=America/Denver:20251112T080000
DTEND;TZID=America/Denver:20251112T090000
SUMMARY:Denver Event
END:VEVENT
END:VCALENDAR
`;

  const source = { name: "Denver", timeZone: "America/Denver", forceTimeZone: false };
  const { start, end } = monthRange(2025, 10);
  const events = expandEvents(ics, source, start, end);

  assert.equal(events.length, 1);
  // 8:00 in Denver should stay 8:00 in Denver, and appear as 10:00 in New York.
  assert.equal(
    wallTime(events[0].start, "America/Denver"),
    "2025-11-12 08:00"
  );
  assert.equal(
    wallTime(events[0].start, "America/New_York"),
    "2025-11-12 10:00"
  );
});
