/* MMM-GlassCalendar node_helper
 *  - Fetches ICS feeds using node-ical
 *  - Expands RRULE
 *  - Filters to current month (with offset)
 */

const NodeHelper = require("node_helper");
const ical = require("node-ical");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

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

    Object.keys(data).forEach(key => {
      const ev = data[key];
      if (!ev || ev.type !== "VEVENT") return;

      const start = ev.start;
      const end = ev.end || ev.start;
      if (!start) return;

      const allDay =
        ev.datetype === "date" ||
        (!ev.start.tz && ev.start.getHours() === 0 && end.getHours() === 0);

      if (ev.rrule) {
        const dates = ev.rrule.between(rangeStart, rangeEnd, true);
        dates.forEach(d => {
          const occurrenceEnd = new Date(d.getTime() + (end - start));
          events.push({
            title: ev.summary || "",
            calendarName: source.name || "",
            startDate: d.toISOString(),
            endDate: occurrenceEnd.toISOString(),
            allDay,
            color: source.color || null,
            colorSource: source.color || null
          });
        });
        return;
      }

      if (end < rangeStart || start > rangeEnd) return;

      events.push({
        title: ev.summary || "",
        calendarName: source.name || "",
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        allDay,
        color: source.color || null,
        colorSource: source.color || null
      });
    });

    console.log("[MMM-GlassCalendar] Parsed", events.length, "events from", source.url);
    return events;
  }
});
