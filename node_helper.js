/* MMM-GlassCalendar node_helper
 *  - Fetches ICS feeds using node-ical
 *  - Expands RRULE
 *  - Filters to current month (with offset)
 */

const NodeHelper = require("node_helper");
const ical = require("node-ical");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const {
  resolveTimeZone,
  convertToTimeZone,
  convertFloatingToTimeZone,
  shiftToTimeZone
} = require("./lib/ics-timezone");

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

module.exports = NodeHelper.create({
  start() {
    console.log("[MMM-GlassCalendar] node_helper started");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "GLASSCALENDAR_FETCH") {
      this.fetchCalendars(payload);
    }
  },

  async fetchCalendars(payload) {
    try {
      const identifier = payload && payload.identifier;
      const icalSources = (payload && payload.icalSources) || [];
      const rawOffset = payload && payload.monthOffset;
      const monthOffset = Number.isFinite(Number(rawOffset))
        ? Number(rawOffset)
        : 0;

      if (!Array.isArray(icalSources) || icalSources.length === 0) return;

      const now = new Date();
      const ref = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
      const monthStart = new Date(ref.getFullYear(), ref.getMonth(), 1);
      const monthEnd = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59, 999);

      const allEvents = [];

      for (const source of icalSources) {
        if (!source || !source.url) continue;
        try {
          const events = await this.fetchIcs(source, monthStart, monthEnd);
          allEvents.push(...events);
        } catch (err) {
          console.error("[MMM-GlassCalendar] ICS fetch error for", source.url, err);
          this.sendSocketNotification("GLASSCALENDAR_ERROR", {
            identifier,
            monthOffset,
            url: source.url,
            message: err && err.message ? err.message : String(err)
          });
        }
      }

      this.sendSocketNotification("GLASSCALENDAR_EVENTS", {
        identifier,
        monthOffset,
        events: allEvents
      });
    } catch (err) {
      console.error("[MMM-GlassCalendar] fetchCalendars fatal error", err);
      this.sendSocketNotification("GLASSCALENDAR_ERROR", {
        identifier,
        monthOffset,
        message: err && err.message ? err.message : String(err)
      });
    }
  },

  async fetchIcs(source, rangeStart, rangeEnd) {
    console.log("[MMM-GlassCalendar] Fetching ICS:", source.url);

    const response = await fetch(source.url, {
      headers: { "User-Agent": "MagicMirror-GlassCalendar" }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const text = await response.text();
    if (!text || text.indexOf("BEGIN:VCALENDAR") === -1) {
      throw new Error("Invalid ICS content");
    }

    let data;
    try {
      data = ical.sync.parseICS(text);
    } catch (err) {
      console.error("[MMM-GlassCalendar] parseICS failed:", err);
      throw err;
    }

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

    Object.keys(data).forEach(key => {
      const ev = data[key];
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

        dates.forEach(d => {
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
            occurrenceEnd = new Date(
              occurrenceStart.getTime() + durationMs
            );
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
            calendarName: source.name || "",
            startDate: displayStart.toISOString(),
            endDate: displayEnd.toISOString(),
            allDay,
            color: source.color || null,
            colorSource: source.color || null
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
        calendarName: source.name || "",
        startDate: displayStart.toISOString(),
        endDate: displayEnd.toISOString(),
        allDay,
        color: source.color || null,
        colorSource: source.color || null
      });
    });

    console.log("[MMM-GlassCalendar] Parsed", events.length, "events from", source.url);
    return events;
  }
});
