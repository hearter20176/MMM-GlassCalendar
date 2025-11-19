/* MMM-GlassCalendar
 * Full-featured monthly glass-style calendar for MagicMirror²
 * Features:
 *  - ICS / iCal via node-ical (node_helper)
 *  - Full-day events at top, timed events with start–end times
 *  - Mini heatmap background for busy days
 *  - Day cell background images
 *  - Keyword-based icons (Font Awesome, Boxicons, Iconoir, Iconify)
 *  - Per-calendar visibility toggles (clickable legend)
 *  - Dark/light theme + autoSun (based on sunrise/sunset or fixed hours)
 *  - Optional weather row (from MMM-AmbientWeather) with icon mapping
 *  - Optional agenda preview (from MMM-MyAgenda)
 */

/* global Module, Log, config, moment */

Module.register("MMM-GlassCalendar", {
  // ---------------------------------------------------------------------------
  // Default configuration
  // ---------------------------------------------------------------------------
  defaults: {
    header: "Monthly Calendar",
    locale: config.locale || "en",
    firstDayOfWeek: 0, // 0 = Sunday, 1 = Monday

    // Data sources
    useCalendarModule: false, // listens to CALENDAR_EVENTS
    useMyAgenda: true,        // listens to MYAGENDA_EVENTS
    useAmbientWeather: true,  // listens to AMBIENT_WEATHER_DATA

    // Direct ICS sources (node_helper)
    icalSources: [],

    // Display behavior
    monthOffset: 0,           // 0 = current, -1 previous, +1 next
    highlightToday: true,
    dimPastDays: true,
    showWeekNumbers: false,

    maxEventsPerDay: 3,
    showOverflowIndicator: true,

    showAgendaPreview: true,
    maxAgendaPreviewItems: 4,
    showWeatherRow: true,

    // Heatmap
    heatmapEnabled: true,
    heatmapMaxEvents: 6,      // saturate heat at this many events
    heatmapColor: "#38bdf8",

    // Day backgrounds
    // { "2025-12-25": "url('modules/MMM-GlassCalendar/img/christmas.jpg')" }
    dayBackgrounds: {},

    // Event icons per keyword
    // "flight": { type: "box", icon: "bx bx-plane-alt" }
    eventIcons: {},

    // Per-calendar visibility (optional default state)
    // { "Work": true, "Home": false }
    calendarVisibility: {},

    // Theming
    // "dark" | "light" | "auto" (MM default heuristics) | "autoSun"
    theme: "autoSun",
    // Used when theme === "autoSun" and weather doesn't provide sunrise/sunset
    sunriseHour: 7,
    sunsetHour: 19,

    // Refresh intervals
    updateInterval: 15 * 60 * 1000, // 15 minutes
    animationSpeed: 400
  },

  // ---------------------------------------------------------------------------
  // Script & style loading
  // ---------------------------------------------------------------------------
  getScripts() {
    return [
      "moment.js",
      "moment-timezone.js",
      // Local Iconify runtime (user must place in lib/iconify/)
      this.file("lib/iconify/iconify-icon.min.js")
    ];
  },

  getStyles() {
    return [
      "MMM-GlassCalendar.css",
      // Local icon libraries (user provides files)
      this.file("lib/fontawesome/css/all.min.css"),
      this.file("lib/boxicons/css/boxicons.min.css"),
      this.file("lib/iconoir/iconoir.css")
    ];
  },

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------
  start() {
    Log.info(`[${this.name}] starting`);

    this.loaded = false;
    this.monthEvents = [];      // merged event list
    this.weatherSummary = null; // from MMM-AmbientWeather
    this.myAgendaPreview = [];  // from MMM-MyAgenda
    this.lastFetch = null;
    this.hiddenCalendars = new Set(); // per-calendar toggles

    moment.locale(this.config.locale);

    // Initialize hiddenCalendars from config.calendarVisibility (false => hidden)
    Object.keys(this.config.calendarVisibility || {}).forEach(name => {
      if (this.config.calendarVisibility[name] === false) {
        this.hiddenCalendars.add(name);
      }
    });

    if (this.config.icalSources && this.config.icalSources.length > 0) {
      this.scheduleFetch();
    } else {
      this.updateDom();
    }
  },

  // ---------------------------------------------------------------------------
  // Schedule ICS fetch
  // ---------------------------------------------------------------------------
  scheduleFetch() {
    this.monthEvents = []; // reset before new month fetch
    this.sendSocketNotification("GLASSCALENDAR_FETCH", {
      icalSources: this.config.icalSources,
      monthOffset: this.config.monthOffset
    } );
    
    setTimeout(() => this.scheduleFetch(), this.config.updateInterval);
  },
  
  // ---------------------------------------------------------------------------
  // Notifications from other modules
  // ---------------------------------------------------------------------------
  notificationReceived(notification, payload, sender) {
    if (notification === "CALENDAR_EVENTS" && this.config.useCalendarModule) {
      this.handleCalendarEvents(payload || []);
    }

    if (notification === "AMBIENT_WEATHER_DATA" && this.config.useAmbientWeather) {
      this.handleAmbientWeather(payload);
    }

    if (notification === "MYAGENDA_EVENTS" && this.config.useMyAgenda) {
      this.handleMyAgendaEvents(payload || []);
    }
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "GLASSCALENDAR_EVENTS") {
      this.handleIcalEvents(payload);
    } else if (notification === "GLASSCALENDAR_ERROR") {
      Log.error(`[${this.name}] node_helper error`, payload);
    }
  },

  // ---------------------------------------------------------------------------
  // Data handlers
  // ---------------------------------------------------------------------------
  handleCalendarEvents(events) {
    if (!Array.isArray(events)) return;
    this.mergeEvents(events, "calendar");
  },

  handleIcalEvents(payload) {
    if (!payload || !Array.isArray(payload.events)) return;
    this.mergeEvents(payload.events, "ical");
    this.lastFetch = new Date();
  },

  handleMyAgendaEvents(events) {
    if (!Array.isArray(events)) return;

    this.myAgendaPreview = events
      .slice(0, this.config.maxAgendaPreviewItems)
      .map(ev => ({
        title: ev.title || ev.summary || "",
        calendarName: ev.calendarName || ev.calendar || "",
        startDate: ev.startDate ? moment(ev.startDate) : null,
        endDate: ev.endDate ? moment(ev.endDate) : null,
        allDay: !!ev.allDay,
        color: ev.color || ev.calendarColor || null
      }));

    this.mergeEvents(events, "myagenda");
  },

  handleAmbientWeather(payload) {
    // Expect roughly:
    // { temperature, condition, conditionCode, icon, aqi, uv, sunrise, sunset }
    this.weatherSummary = payload || null;
    this.updateDom(this.config.animationSpeed);
  },

  // ---------------------------------------------------------------------------
  // Event normalization / merge
  // ---------------------------------------------------------------------------
  mergeEvents(events, sourceType) {
    if (!Array.isArray(events)) return;
  
    const monthMoment = moment().add(this.config.monthOffset, "months");
    const monthStart = monthMoment.clone().startOf("month").startOf("day");
    const monthEnd = monthMoment.clone().endOf("month").endOf("day");
  
    const normalized = events
      .map(ev => {
        const start = ev.startDate || ev.start || ev.date;
        const end = ev.endDate || ev.end || start;
        if (!start) return null;
  
        const mStart = moment(start);
        const mEnd = moment(end);
  
        if (!mStart.isValid() || !mEnd.isValid()) return null;
        if (mEnd.isBefore(monthStart) || mStart.isAfter(monthEnd)) return null;
  
        return {
          title: ev.title || ev.summary || "",
          calendarName: ev.calendarName || ev.calendarName || ev.calendar || "",
          startDate: mStart,
          endDate: mEnd,
          allDay: !!ev.allDay,
          color: ev.color || ev.calendarColor || ev.colorSource || null,
          source: sourceType
        };
      })
      .filter(Boolean);
  
    // Merge with existing & dedupe across ALL sources
    this.monthEvents = this.deduplicateEvents(
      this.monthEvents.concat(normalized)
    );
  
    this.loaded = true;
    this.updateDom(this.config.animationSpeed);
  },
  
  deduplicateEvents(events) {
    const seen = new Set();
    const out = [];
  
    events.forEach(ev => {
      const title = (ev.title || "").toLowerCase().trim();
      const startISO = moment(ev.startDate).toISOString();
      const endISO = moment(ev.endDate || ev.startDate).toISOString();
      const key = `${title}|${startISO}|${endISO}`;
  
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          ...ev,
          startDate: moment(ev.startDate),
          endDate: moment(ev.endDate || ev.startDate)
        });
      }
    });
  
    return out;
  },
      
  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "glass-calendar-wrapper";

    const card = document.createElement("div");
    card.className = "glass-calendar-card";

    console.log("[MMM-GlassCalendar] events in month:", this.monthEvents.length);

    const themeName =
      this.config.theme === "auto"
        ? this.determineThemeAuto()
        : this.config.theme === "autoSun"
        ? this.determineThemeSun()
        : this.config.theme;

    card.classList.add("glass-theme-" + (themeName === "light" ? "light" : "dark"));

    card.appendChild(this.renderHeader());

    if (this.config.showWeatherRow && this.weatherSummary) {
      card.appendChild(this.renderWeatherRow());
    }

    if (this.config.showAgendaPreview && this.myAgendaPreview.length > 0) {
      card.appendChild(this.renderAgendaPreview());
    }

    card.appendChild(this.renderMonthGrid());
    card.appendChild(this.renderLegend());

    wrapper.appendChild(card);
    return wrapper;
  },

  renderHeader() {
    const header = document.createElement("div");
    header.className = "glass-cal-header";

    const monthMoment = moment().add(this.config.monthOffset, "months");

    const titleSpan = document.createElement("span");
    titleSpan.className = "glass-cal-title";
    titleSpan.innerHTML =
      (this.config.header || "") +
      (this.config.header ? " · " : "") +
      monthMoment.format("MMMM YYYY");

    const metaSpan = document.createElement("span");
    metaSpan.className = "glass-cal-meta";

    if (!this.loaded && this.config.icalSources && this.config.icalSources.length > 0) {
      const spin = document.createElement("span");
      spin.className = "glass-spinner";
      metaSpan.appendChild(spin);
      const txt = document.createElement("span");
      txt.innerHTML = "Loading calendars...";
      metaSpan.appendChild(txt);
    } else if (this.lastFetch) {
      metaSpan.innerHTML = "Updated " + moment(this.lastFetch).fromNow();
    } else {
      metaSpan.innerHTML = "";
    }

    header.appendChild(titleSpan);
    header.appendChild(metaSpan);
    return header;
  },

  renderWeatherRow() {
    const row = document.createElement("div");
    row.className = "glass-cal-weather-row";

    const iconSpan = document.createElement("span");
    iconSpan.className = "weather-icon";

    const iconClass = this.mapWeatherToIcon(this.weatherSummary);
    if (iconClass) {
      iconSpan.className = "weather-icon " + iconClass;
    } else {
      iconSpan.className = "weather-icon fa-solid fa-cloud";
    }

    const textSpan = document.createElement("span");
    textSpan.className = "weather-text";

    if (this.weatherSummary) {
      const t = this.weatherSummary.temperature;
      const cond = this.weatherSummary.condition || "";
      const aqi = this.weatherSummary.aqi;
      const uv = this.weatherSummary.uv;
      const parts = [];
      if (typeof t !== "undefined") parts.push(Math.round(t) + "°");
      if (cond) parts.push(cond);
      if (typeof aqi !== "undefined") parts.push("AQI " + aqi);
      if (typeof uv !== "undefined") parts.push("UV " + uv);
      textSpan.innerHTML = parts.join(" · ");
    } else {
      textSpan.innerHTML = "Weather unavailable";
    }

    row.appendChild(iconSpan);
    row.appendChild(textSpan);
    return row;
  },

  renderAgendaPreview() {
    const wrap = document.createElement("div");
    wrap.className = "glass-cal-agenda-preview";

    this.myAgendaPreview.forEach(ev => {
      const item = document.createElement("div");
      item.className = "glass-cal-agenda-item";

      const dot = document.createElement("span");
      dot.className = "agenda-dot";
      if (ev.color) dot.style.backgroundColor = ev.color;

      const titleSpan = document.createElement("span");
      titleSpan.className = "agenda-title";
      titleSpan.innerHTML = ev.title || "(no title)";

      const timeSpan = document.createElement("span");
      timeSpan.className = "agenda-time";

      if (ev.allDay) {
        timeSpan.innerHTML = "All day";
      } else if (ev.startDate) {
        let t = ev.startDate.format("LT");
        if (ev.endDate && !ev.endDate.isSame(ev.startDate, "minute")) {
          t += " – " + ev.endDate.format("LT");
        }
        timeSpan.innerHTML = t;
      }

      item.appendChild(dot);
      item.appendChild(titleSpan);
      item.appendChild(timeSpan);
      wrap.appendChild(item);
    });

    return wrap;
  },

  renderLegend() {
    const legend = document.createElement("div");
    legend.className = "glass-cal-legend";

    const colors = {};

    this.monthEvents.forEach(ev => {
      const name = ev.calendarName || "Calendar";
      if (!colors[name] && ev.color) {
        colors[name] = ev.color;
      }
    });

    Object.keys(colors).forEach(name => {
      const item = document.createElement("div");
      item.className = "glass-cal-legend-item";
      if (this.hiddenCalendars.has(name)) {
        item.classList.add("hidden-calendar");
      }

      const swatch = document.createElement("span");
      swatch.className = "glass-cal-legend-color";
      swatch.style.backgroundColor = colors[name];

      const label = document.createElement("span");
      label.innerHTML = name;

      item.appendChild(swatch);
      item.appendChild(label);

      item.addEventListener("click", () => {
        if (this.hiddenCalendars.has(name)) {
          this.hiddenCalendars.delete(name);
        } else {
          this.hiddenCalendars.add(name);
        }
        this.updateDom(this.config.animationSpeed);
      });

      legend.appendChild(item);
    });

    return legend;
  },

  renderMonthGrid() {
    const grid = document.createElement("div");
    grid.className = "glass-cal-grid";

    const monthMoment = moment().add(this.config.monthOffset, "months");
    const monthStart = monthMoment.clone().startOf("month");
    const monthEnd = monthMoment.clone().endOf("month");

    const firstDay = this.config.firstDayOfWeek;
    const firstGridDay = monthStart.clone().startOf("week").add(firstDay, "days");
    while (firstGridDay.day() !== firstDay) {
      firstGridDay.subtract(1, "day");
    }

    const dowRow = document.createElement("div");
    dowRow.className = "glass-cal-row glass-cal-dow";

    const dayNames = [];
    for (let i = 0; i < 7; i++) {
      dayNames.push(moment().weekday((i + firstDay) % 7).format("dd"));
    }

    if (this.config.showWeekNumbers) {
      const blank = document.createElement("div");
      blank.className = "glass-cal-cell glass-cal-weeknum-header";
      dowRow.appendChild(blank);
    }

    dayNames.forEach(name => {
      const cell = document.createElement("div");
      cell.className = "glass-cal-cell glass-cal-dow-cell";
      cell.innerHTML = name;
      dowRow.appendChild(cell);
    });

    grid.appendChild(dowRow);

    let current = firstGridDay.clone();
    for (let week = 0; week < 6; week++) {
      const row = document.createElement("div");
      row.className = "glass-cal-row";

      if (this.config.showWeekNumbers) {
        const weekCell = document.createElement("div");
        weekCell.className = "glass-cal-cell glass-cal-weeknum";
        weekCell.innerHTML = current.isoWeek();
        row.appendChild(weekCell);
      }

      for (let day = 0; day < 7; day++) {
        row.appendChild(this.renderDayCell(current.clone(), monthStart, monthEnd));
        current.add(1, "day");
      }

      grid.appendChild(row);
    }

    return grid;
  },

  renderDayCell(date, monthStart, monthEnd) {
    const cell = document.createElement("div");
    cell.className = "glass-cal-cell glass-cal-day";

    const isOtherMonth = date.month() !== monthStart.month();

    const today = moment();
    const isToday = date.isSame(today, "day");
    const isPast = date.isBefore(today, "day");

    if (isOtherMonth) cell.classList.add("other-month");
    if (isToday && this.config.highlightToday) cell.classList.add("today");
    if (isPast && this.config.dimPastDays && !isToday) cell.classList.add("past-day");

    const dateKey = date.format("YYYY-MM-DD");
    if (this.config.dayBackgrounds[dateKey]) {
      cell.style.backgroundImage = this.config.dayBackgrounds[dateKey];
      cell.style.backgroundSize = "cover";
      cell.style.backgroundPosition = "center";
    }

    const eventsForDay = this.getEventsForDay(date);
    const eventCount = eventsForDay.length;

    if (this.config.heatmapEnabled && eventCount > 0) {
      const intensity = Math.min(1, eventCount / this.config.heatmapMaxEvents);
      const overlay = document.createElement("div");
      overlay.className = "glass-cal-heatmap-overlay";
      overlay.style.opacity = (0.15 + 0.35 * intensity).toFixed(2);
      cell.appendChild(overlay);
    }

    const dayNum = document.createElement("div");
    dayNum.className = "glass-cal-daynum";
    dayNum.innerHTML = date.date();
    cell.appendChild(dayNum);

    const eventsWrap = document.createElement("div");
    eventsWrap.className = "glass-cal-events";

    eventsForDay.sort((a, b) => {
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return a.startDate - b.startDate;
    });

    const maxShow = this.config.maxEventsPerDay;

    eventsForDay.slice(0, maxShow).forEach(ev => {
      if (ev.allDay) {
        const fullItem = document.createElement("div");
        fullItem.className = "glass-cal-event-item glass-full-day";
        if (ev.color) {
          fullItem.style.backgroundColor = ev.color + "66";
        }

        const iconEl = this.getEventIcon(ev);
        if (iconEl) fullItem.appendChild(iconEl);

        const title = ev.title || "(no title)";
        if (title.length > 14) {
          fullItem.classList.add("glass-marquee");
          const span = document.createElement("span");
          span.innerHTML = title;
          fullItem.appendChild(span);
        } else {
          fullItem.appendChild(document.createTextNode(title));
        }

        eventsWrap.appendChild(fullItem);
        return;
      }

      const evItem = document.createElement("div");
      evItem.className = "glass-cal-event-item";

      const dot = document.createElement("span");
      dot.className = "glass-cal-event-dot";
      if (ev.color) dot.style.backgroundColor = ev.color;
      evItem.appendChild(dot);

      const iconEl = this.getEventIcon(ev);
      if (iconEl) evItem.appendChild(iconEl);

      const label = document.createElement("span");
      label.className = "glass-cal-event-label";

      const title = ev.title || "(no title)";
      let timeStr = ev.startDate.format("LT");
      if (ev.endDate && !ev.endDate.isSame(ev.startDate, "minute")) {
        timeStr += " – " + ev.endDate.format("LT");
      }

      const fullText = `${timeStr} · ${title}`;

      if (fullText.length > 18) {
        const marquee = document.createElement("div");
        marquee.className = "glass-marquee";
        const span = document.createElement("span");
        span.innerHTML = fullText;
        marquee.appendChild(span);
        label.appendChild(marquee);
      } else {
        label.innerHTML = fullText;
      }

      evItem.appendChild(label);
      eventsWrap.appendChild(evItem);
    });

    if (this.config.showOverflowIndicator && eventsForDay.length > maxShow) {
      const more = document.createElement("div");
      more.className = "glass-cal-event-more";
      more.innerHTML = "+" + (eventsForDay.length - maxShow);
      eventsWrap.appendChild(more);
    }

    cell.appendChild(eventsWrap);
    return cell;
  },

  getEventsForDay(date) {
    const start = date.clone().startOf("day");
    const end = date.clone().endOf("day");
  
    // 1) Filter events that overlap this day AND respect hidden calendars
    const sameDayEvents = this.monthEvents.filter(ev => {
      if (this.hiddenCalendars && this.hiddenCalendars.has(ev.calendarName || "Calendar")) {
        return false;
      }
      return ev.startDate.isBefore(end) && ev.endDate.isAfter(start);
    });
  
    if (date.format("YYYY-MM-DD") === "2025-11-22") {
      console.log("RAW EVENTS for Nov 22 >>>>");
      sameDayEvents.forEach((ev, i) => {
        console.log(`#${i+1}`, {
          title: ev.title,
          cal: ev.calendarName,
          allDay: ev.allDay,
          start: ev.startDate.format(),
          end: ev.endDate.format()
        });
      });
    }
    

    // 2) Per-day, per-title deduplication across ALL calendars
    const seen = new Set();
    const result = [];
  
    sameDayEvents.forEach(ev => {
      const title = (ev.title || "").toLowerCase().trim();
      const dayKey = start.format("YYYY-MM-DD");
  
      let key;
  
      if (ev.allDay) {
        // All-day: only care about title + date
        key = `allday|${title}|${dayKey}`;
      } else {
        // Timed: normalize/round times so tiny differences don't break dedupe
        const roundedStart = ev.startDate
          .clone()
          .minutes(Math.floor(ev.startDate.minutes() / 15) * 15)
          .seconds(0)
          .milliseconds(0);
  
        const durationMinutes = ev.endDate
          ? ev.endDate.diff(ev.startDate, "minutes")
          : 0;
  
        const durationBucket = Math.round(durationMinutes / 15) * 15;
  
        key = `timed|${title}|${dayKey}|${roundedStart.format("HH:mm")}|${durationBucket}`;
      }
  
      if (!seen.has(key)) {
        seen.add(key);
        result.push(ev);
      }
    });
  
    return result;
  },
  
  canonicalEventKey(ev) {
    const name = (ev.calendarName || ev.calendar || "").toLowerCase().trim();
    const title = (ev.title || "").toLowerCase().trim();
    return `${name}|${title}|${ev.startDate.toISOString()}|${ev.endDate.toISOString()}`;
  },
  

  // ---------------------------------------------------------------------------
  // Icon mapping
  // ---------------------------------------------------------------------------
  getEventIcon(ev) {
    const title = (ev.title || "").toLowerCase();
    for (let key in this.config.eventIcons || {}) {
      if (title.includes(key.toLowerCase())) {
        const mapping = this.config.eventIcons[key];
        return this.renderIcon(mapping);
      }
    }
    return null;
  },

  renderIcon(mapping) {
    if (!mapping) return null;
    const { type, icon } = mapping;

    if (type === "fa") {
      const el = document.createElement("i");
      el.className = icon + " glass-event-icon";
      return el;
    }

    if (type === "box") {
      const el = document.createElement("i");
      el.className = icon + " glass-event-icon";
      return el;
    }

    if (type === "iconoir") {
      const el = document.createElement("i");
      el.className = "iconoir-" + icon;
      el.classList.add("glass-event-icon");
      return el;
    }

    if (type === "iconify") {
      const el = document.createElement("iconify-icon");
      el.setAttribute("icon", icon);
      el.classList.add("glass-event-icon");
      return el;
    }

    return null;
  },

  // ---------------------------------------------------------------------------
  // Weather icon mapping
  // ---------------------------------------------------------------------------
  mapWeatherToIcon(summary) {
    if (!summary) return null;

    if (summary.icon) return summary.icon;

    const code = summary.conditionCode;
    const cond = (summary.condition || "").toLowerCase();

    if (typeof code === "number") {
      if (code >= 200 && code < 300) return "fa-solid fa-cloud-bolt";
      if (code >= 300 && code < 600) return "fa-solid fa-cloud-rain";
      if (code >= 600 && code < 700) return "fa-solid fa-snowflake";
      if (code >= 700 && code < 800) return "fa-solid fa-smog";
      if (code === 800) return "fa-solid fa-sun";
      if (code > 800) return "fa-solid fa-cloud-sun";
    }

    if (cond.includes("thunder")) return "fa-solid fa-cloud-bolt";
    if (cond.includes("rain")) return "fa-solid fa-cloud-showers-heavy";
    if (cond.includes("snow")) return "fa-solid fa-snowflake";
    if (cond.includes("fog") || cond.includes("mist")) return "fa-solid fa-smog";
    if (cond.includes("sun") || cond.includes("clear")) return "fa-solid fa-sun";
    if (cond.includes("cloud")) return "fa-solid fa-cloud-sun";

    return "fa-solid fa-cloud";
  },

  // ---------------------------------------------------------------------------
  // Theme helpers
  // ---------------------------------------------------------------------------
  determineThemeAuto() {
    // Simple: MagicMirror tends to be dark; keep dark as default
    return "dark";
  },

  determineThemeSun() {
    let sunrise = this.config.sunriseHour;
    let sunset = this.config.sunsetHour;

    if (this.weatherSummary && this.weatherSummary.sunrise && this.weatherSummary.sunset) {
      try {
        sunrise = moment(this.weatherSummary.sunrise).hour();
        sunset = moment(this.weatherSummary.sunset).hour();
      } catch (e) {
        // ignore parse failure, use config values
      }
    }

    const now = moment().hour();
    if (now >= sunrise && now < sunset) {
      return "light";
    }
    return "dark";
  }
});
