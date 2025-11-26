const test = require("node:test");
const assert = require("node:assert/strict");
const ical = require("node-ical");
const { resolveTimeZone, convertToTimeZone } = require("../lib/ics-timezone");

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

const expandEvents = (icsContent, source, rangeStart, rangeEnd) => {
  const data = ical.sync.parseICS(icsContent);
  const events = [];

  Object.values(data).forEach((ev) => {
    if (!ev || ev.type !== "VEVENT") return;
    const start = ev.start;
    const end = ev.end || ev.start;
    if (!start) return;

    const allDay =
      ev.datetype === "date" ||
      (!ev.start.tz && ev.start.getHours() === 0 && end.getHours() === 0);

    const tzid = resolveTimeZone(ev, source);
    const adjustedStart = start;
    const adjustedEnd = end;

    if (ev.rrule) {
      const dates = ev.rrule.between(rangeStart, rangeEnd, true);
      const durationMs = adjustedEnd - adjustedStart;
      dates.forEach((d) => {
        const occurrenceStart =
          !allDay && tzid ? convertToTimeZone(d, tzid) : d;
        const occurrenceEnd = new Date(occurrenceStart.getTime() + durationMs);
        events.push({
          title: ev.summary || "",
          start: occurrenceStart,
          end: occurrenceEnd,
          tzid
        });
      });
      return;
    }

    if (end < rangeStart || start > rangeEnd) return;

    events.push({
      title: ev.summary || "",
      start: adjustedStart,
      end: adjustedEnd,
      tzid
    });
  });

  return events;
};

test("keeps TZ-aware recurring events at their local wall time", () => {
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
    wallTime(events[0].start, "America/New_York"),
    "2025-11-12 13:00"
  );
  assert.equal(
    wallTime(events[1].start, "America/New_York"),
    "2025-11-13 13:00"
  );
});

test("applies forced timezone to floating events", () => {
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
    wallTime(events[0].start, "America/New_York"),
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
