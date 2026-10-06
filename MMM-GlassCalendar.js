/* MMM-GlassCalendar
 * Glass-style monthly calendar for MagicMirror²
 * Features:
 *  - ICS via node-ical (node_helper)
 *  - Full-day events at top, timed events with start–end times
 *  - Mini heatmap for busy days
 *  - Day cell background images
 *  - Keyword-based icons (Font Awesome, Boxicons, Iconoir, Iconify)
 *  - Per-calendar visibility toggles (clickable legend)
 *  - Dark/light theme with autoSun (sunrise/sunset or configured hours)
 *  - Optional weather row + agenda preview (payloads from other modules)
 *  - Fuzzy per-day deduplication for similar titles
 */

/* global Module, Log, config, moment */

Module.register("MMM-GlassCalendar", {
  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------
  defaults: {
    header: "Monthly Calendar",
    locale:
      typeof config !== "undefined" && config.locale ? config.locale : "en",
    firstDayOfWeek: 0, // 0 = Sunday, 1 = Monday

    // Sources
    useCalendarModule: false,
    useMyAgenda: true,
    useAmbientWeather: true,
    icalSources: [],

    // Month view
    monthOffset: 0,
    highlightToday: true,
    dimPastDays: true,
    showWeekNumbers: false,

    // Events per day
    maxEventsPerDay: 3,
    showOverflowIndicator: true,

    // Extras
    showAgendaPreview: true,
    maxAgendaPreviewItems: 4,
    showWeatherRow: true,

    // Heatmap
    heatmapEnabled: true,
    heatmapMaxEvents: 6,
    heatmapColor: "#38bdf8",

    // Custom per-day backgrounds: { "YYYY-MM-DD": "url('...')" }
    dayBackgrounds: {},
    // Backgrounds by calendar + keyword: [{ calendar: "Holidays", keyword: "christmas", image: "url('...')" }]
    dayBackgroundRules: [],

    // Keyword icon mapping
    // e.g. "birthday": { type: "fa", icon: "fa-solid fa-cake-candles" }
    eventIcons: {},

    // Calendar visibility defaults: { "Family": true, "Work": false }
    calendarVisibility: {},

    // Theme: "dark" | "light" | "auto" | "autoSun"
    theme: "autoSun",
    // Scroll speed (px/s) for titles too long to fit
    marqueeSpeed: 20,
    sunriseHour: 7,
    sunsetHour: 19,

    // Performance
    performanceProfile: "auto", // auto | pi | full
    reduceMotion: false,

    // Intervals
    updateInterval: 15 * 60 * 1000,
    animationSpeed: 400
  },

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------
  getScripts() {
    return [
      // MagicMirror's shared moment (with locales). A module-local copy would
      // replace the global and strip the moment-timezone MMM-GlassClock relies on.
      "moment.js",
      // Iconify runtime (served locally from node_modules)
      this.file("node_modules/iconify-icon/dist/iconify-icon.min.js")
    ];
  },

  getStyles() {
    return [
      "MMM-GlassCalendar.css",
      // Icon packs
      this.file("node_modules/@fortawesome/fontawesome-free/css/all.min.css"),
      this.file("lib/boxicons/boxicons.min.css"),
      this.file("lib/iconoir/iconoir.css")
    ];
  },

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  start() {
    if (typeof moment === "undefined") {
      if (!this._momentRequested) {
        this._momentRequested = true;
        const script = document.createElement("script");
        script.src = this.file(
          "node_modules/moment/min/moment-with-locales.min.js"
        );
        script.onload = () => {
          this.start();
        };
        document.body.appendChild(script);
      }
      return;
    }

    Log.info(`[${this.name}] starting`);
    this.loaded = false;
    this.fetchErrors = [];
    this.monthEvents = [];
    this.weatherSummary = null;
    this.myAgendaPreview = [];
    this.lastFetch = null;
    this.hiddenCalendars = new Set();
    this.domUpdateTimer = null;
    this.marqueeAnims = []; // every live title-marquee Web Animation: { anim, track, gen }
    this.renderGen = 0; // bumped on every getDom(); invalidates the poll timer of older renders
    this.animTimer = null;
    this.suspended = false;
    this.performanceProfile = this.resolvePerformanceProfile();
    this.performanceTuning = {
      domUpdateDebounce: this.performanceProfile === "pi" ? 700 : 0,
      maxEventsPerDay:
        this.performanceProfile === "pi"
          ? Math.min(this.config.maxEventsPerDay, 2)
          : this.config.maxEventsPerDay,
      heatmapEnabled: this.performanceProfile === "pi" ? false : this.config.heatmapEnabled,
      allowMarquee:
        this.config.reduceMotion !== true &&
        this.performanceProfile !== "pi" &&
        !(
          typeof window !== "undefined" &&
          window.matchMedia &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        )
    };

    moment.locale(this.config.locale);

    // Set initial hidden calendars from config
    Object.keys(this.config.calendarVisibility || {}).forEach((name) => {
      if (this.config.calendarVisibility[name] === false) {
        this.hiddenCalendars.add(name);
      }
    });

    if (this.config.icalSources && this.config.icalSources.length > 0) {
      this.scheduleFetch();
    } else {
      this.queueDomUpdate();
    }
  },

  // ---------------------------------------------------------------------------
  // Fetch ICS
  // ---------------------------------------------------------------------------
  scheduleFetch() {
    const monthOffset =
      typeof this.config.monthOffset === "number"
        ? this.config.monthOffset
        : parseInt(this.config.monthOffset, 10) || 0;

    // Errors accumulate per fetch cycle: reset before kicking off a new one
    // so a stale failure count doesn't linger after a source recovers.
    this.fetchErrors = [];

    this.sendSocketNotification("GLASSCALENDAR_FETCH", {
      identifier: this.identifier,
      icalSources: this.config.icalSources,
      monthOffset
    });

    setTimeout(() => this.scheduleFetch(), this.config.updateInterval);
  },

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  notificationReceived(notification, payload, sender) {
    if (notification === "CALENDAR_EVENTS" && this.config.useCalendarModule) {
      this.handleCalendarEvents(payload || []);
    }

    if (
      notification === "AMBIENT_WEATHER_DATA" &&
      this.config.useAmbientWeather
    ) {
      this.handleAmbientWeather(payload);
    }

    if (notification === "MYAGENDA_EVENTS" && this.config.useMyAgenda) {
      this.handleMyAgendaEvents(payload || []);
    }

    if (notification === "PAGE_THEME_CHANGED" && this.config.theme === "autoSun") {
      this.queueDomUpdate(this.config.animationSpeed);
    }

    // MagicMirror sends this to the module after every updateDom() resolves (swapped or
    // skipped), so it is the deterministic moment to reap the animations of the outgoing tree.
    // The bounded poll in _startAnimations() is only a fallback.
    if (notification === "MODULE_DOM_UPDATED") this._startAnimations();
  },

  // Called by MagicMirror when the module is hidden (e.g. MMM-pages rotation). MM hides with
  // opacity 0, so the tree stays laid out and composited: pause everything this module animates.
  suspend() {
    this.suspended = true;
    this._pauseAnimations();
  },

  resume() {
    this.suspended = false;
    this._startAnimations();
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "GLASSCALENDAR_EVENTS") {
      if (
        payload &&
        payload.identifier &&
        payload.identifier !== this.identifier
      ) {
        return;
      }
      if (
        payload &&
        typeof payload.monthOffset !== "undefined"
      ) {
        const msgOffset = Number(payload.monthOffset);
        const cfgOffset =
          typeof this.config.monthOffset === "number"
            ? this.config.monthOffset
            : parseInt(this.config.monthOffset, 10) || 0;
        if (Number.isFinite(msgOffset) && msgOffset !== cfgOffset) {
          return;
        }
      }
      this.handleIcalEvents(payload);
    } else if (notification === "GLASSCALENDAR_ERROR") {
      if (payload && payload.identifier && payload.identifier !== this.identifier) {
        return;
      }
      // payload.url is already masked/name-only by node_helper; never log
      // the full payload in case that guarantee changes upstream.
      Log.error(`[${this.name}] node_helper error for ${(payload && payload.url) || "a calendar"}: ${payload && payload.message}`);
      this.fetchErrors = this.fetchErrors || [];
      this.fetchErrors.push({
        source: (payload && payload.url) || "calendar",
        message: payload && payload.message
      });
      this.queueDomUpdate(this.config.animationSpeed);
    }
  },

  // ---------------------------------------------------------------------------
  // Data handlers
  // ---------------------------------------------------------------------------
  handleCalendarEvents(events) {
    if (!Array.isArray(events)) return;
    // Replace existing calendar-sourced events before merging new ones
    this.pruneEventsBySource("calendar");
    this.mergeEvents(events, "calendar");
  },

  handleIcalEvents(payload) {
    if (!payload || !Array.isArray(payload.events)) return;
    // Replace existing ical-sourced events before merging new ones
    this.pruneEventsBySource("ical");
    this.mergeEvents(payload.events, "ical");
    this.lastFetch = new Date();
  },

  handleMyAgendaEvents(events) {
    if (!Array.isArray(events)) return;

    this.myAgendaPreview = events
      .slice(0, this.config.maxAgendaPreviewItems)
      .map((ev) => ({
        title: ev.title || ev.summary || "",
        calendarName: ev.calendarName || ev.calendar || "",
        startDate: ev.startDate ? moment(ev.startDate) : null,
        endDate: ev.endDate ? moment(ev.endDate) : null,
        allDay: !!ev.allDay,
        color: ev.color || ev.calendarColor || null
      }));

    // Replace existing myagenda-sourced events before merging new ones
    this.pruneEventsBySource("myagenda");
    this.mergeEvents(events, "myagenda");
  },

  handleAmbientWeather(payload) {
    this.weatherSummary = payload || null;
    this.queueDomUpdate(this.config.animationSpeed);
  },

  // ---------------------------------------------------------------------------
  // Normalization & merge
  // ---------------------------------------------------------------------------
  normalizeTitle(raw) {
    if (!raw) return "";
    let t = raw
      .toLowerCase()
      .normalize("NFKD") // strip diacritics
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'") // curly apostrophes to straight
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"'); // curly quotes to straight

    // Remove punctuation and symbols
    t = t.replace(/['"’“”\-–—:,.;!?/\\()[\]{}<>*_~`^|]/g, " ");
    // Remove possessive 's
    t = t.replace(/\b(\w+)'s\b/g, "$1");
    // Remove any remaining non-word characters
    t = t.replace(/[^\w\s]/g, " ");

    // Stopwords tuned for event titles
    const stop = [
      "the",
      "of",
      "for",
      "and",
      "a",
      "an",
      "mr",
      "mrs",
      "ms",
      "life",
      "celebration",
      "service",
      "memorial",
      "meeting",
      "event"
    ];

    t = t
      .split(/\s+/)
      .filter((w) => w && !stop.includes(w))
      .join(" ");

    // Sort words to ignore order
    t = t.split(/\s+/).sort().join(" ");
    return t.trim();
  },

  mergeEvents(events, sourceType) {
    if (!Array.isArray(events)) return;

    const monthMoment = moment().add(this.config.monthOffset, "months");
    const monthStart = monthMoment.clone().startOf("month").startOf("day");
    const monthEnd = monthMoment.clone().endOf("month").endOf("day");

    const normalized = events
      .map((ev) => {
        const startRaw = ev.startDate || ev.start || ev.date;
        const endRaw = ev.endDate || ev.end || startRaw;
        if (!startRaw) return null;

        const mStart = moment(startRaw);
        const mEnd = moment(endRaw);
        if (!mStart.isValid() || !mEnd.isValid()) return null;
        if (mEnd.isBefore(monthStart) || mStart.isAfter(monthEnd)) return null;

        const title = (ev.title || ev.summary || "")
          .replace(/\s+/g, " ")
          .trim();

        return {
          title,
          calendarName: ev.calendarName || ev.calendar || "",
          startDate: mStart,
          endDate: mEnd,
          allDay: !!ev.allDay,
          color: ev.color || ev.calendarColor || ev.colorSource || null,
          source: sourceType
        };
      })
      .filter(Boolean);

    // Append and let day-level dedupe handle cross-source duplicates
    this.monthEvents = this.monthEvents.concat(normalized);
    this.pruneDayDuplicates(monthStart, monthEnd);
    this.loaded = true;
    this.queueDomUpdate(this.config.animationSpeed);
  },

  pruneEventsBySource(sourceType) {
    if (!this.monthEvents || !this.monthEvents.length) return;
    this.monthEvents = this.monthEvents.filter(
      (ev) => ev.source !== sourceType
    );
  },

  pruneDayDuplicates(monthStart, monthEnd) {
    if (!this.monthEvents || !this.monthEvents.length) return;
    const seen = new Set();

    this.monthEvents = this.monthEvents.filter((ev) => {
      const normTitle = this.normalizeTitle(ev.title);
      if (!normTitle) return true;

      const dayKey = moment
        .max(ev.startDate.clone().startOf("day"), monthStart)
        .format("YYYY-MM-DD");
      const startBucket = ev.allDay
        ? "all"
        : ev.startDate
            .clone()
            .minutes(Math.floor(ev.startDate.minutes() / 15) * 15)
            .seconds(0)
            .milliseconds(0)
            .format("HH:mm");
      const durationBucket = ev.allDay
        ? "allday"
        : Math.round((ev.endDate.diff(ev.startDate, "minutes") || 0) / 15) * 15;

      const key = `${dayKey}|${normTitle}|${startBucket}|${durationBucket}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  // ---------------------------------------------------------------------------
  // Rendering root
  // ---------------------------------------------------------------------------
  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "glass-calendar-wrapper";

    const card = document.createElement("div");
    card.className = "glass-calendar-card";

    const themeName =
      this.config.theme === "auto"
        ? this.determineThemeAuto()
        : this.config.theme === "autoSun"
          ? this.determineThemeSun()
          : this.config.theme;

    card.classList.add(
      "glass-theme-" + (themeName === "light" ? "light" : "dark")
    );

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
    try {
      this._beginRender();
      this._startMarquees(wrapper);
    } catch (err) {
      Log.warn(`[${this.name}] Failed to set up title marquees:`, err);
    }
    return wrapper;
  },

  // ---------------------------------------------------------------------------
  // Header / weather / agenda
  // ---------------------------------------------------------------------------
  // Mirrors node_helper's expandSources: a configured source with an array
  // `url` is fetched (and can fail) once per URL, so the "N of M failed"
  // denominator must count expanded URLs, not configured entries, or a
  // single 2-URL source can misreport as "2 of 1".
  countConfiguredSources(icalSources) {
    if (!Array.isArray(icalSources)) return 0;
    return icalSources.reduce((sum, source) => {
      if (!source) return sum;
      if (Array.isArray(source.url)) return sum + source.url.filter(Boolean).length;
      return sum + (source.url ? 1 : 0);
    }, 0);
  },

  renderHeader() {
    const header = document.createElement("div");
    header.className = "glass-cal-header";

    const monthMoment = moment().add(this.config.monthOffset, "months");

    const titleSpan = document.createElement("span");
    titleSpan.className = "glass-cal-title";
    titleSpan.appendChild(document.createTextNode(this.config.header || ""));
    if (this.config.header) {
      const bullet = document.createElement("span");
      bullet.className = "glass-separator";
      bullet.setAttribute("aria-hidden", "true");
      bullet.textContent = " • ";
      titleSpan.appendChild(bullet);
    }
    titleSpan.appendChild(document.createTextNode(monthMoment.format("MMMM YYYY")));

    const metaSpan = document.createElement("span");
    metaSpan.className = "glass-cal-meta";

    const totalSources = this.countConfiguredSources(this.config.icalSources);
    const hasSources = totalSources > 0;
    const errorCount = (this.fetchErrors && this.fetchErrors.length) || 0;

    if (!this.loaded && hasSources && errorCount === 0) {
      const spin = document.createElement("span");
      spin.className = "glass-spinner";
      metaSpan.appendChild(spin);
      const txt = document.createElement("span");
      txt.className = "loading-text";
      txt.textContent = "Loading calendars...";
      metaSpan.appendChild(txt);
    } else if (!this.loaded && hasSources && errorCount > 0) {
      // Every source has failed and there's nothing cached yet: say so
      // instead of leaving the card looking like an empty, event-free month.
      metaSpan.classList.add("glass-cal-meta-warning");
      metaSpan.textContent = "Calendar unavailable";
    } else if (errorCount > 0) {
      metaSpan.classList.add("glass-cal-meta-warning");
      metaSpan.textContent =
        totalSources > 0
          ? `${errorCount} of ${totalSources} calendar${totalSources === 1 ? "" : "s"} failed`
          : `${errorCount} calendar${errorCount === 1 ? "" : "s"} failed`;
    } else if (this.lastFetch) {
      metaSpan.textContent = "Updated " + moment(this.lastFetch).fromNow();
    } else {
      metaSpan.textContent = "";
    }

    header.appendChild(titleSpan);
    header.appendChild(metaSpan);
    return header;
  },

  renderWeatherRow() {
    const row = document.createElement("div");
    row.className = "glass-cal-weather-row";

    const iconSpan = document.createElement("span");
    const iconClass = this.mapWeatherToIcon(this.weatherSummary);
    iconSpan.className = "weather-icon " + (iconClass || "fa-solid fa-cloud");

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
      // cond comes from another module's payload (e.g. weather.gov via
      // MMM-AmbientWeather) and is untrusted; textContent keeps it inert.
      textSpan.textContent = parts.join(" • ");
    } else {
      textSpan.textContent = "Weather unavailable";
    }

    row.appendChild(iconSpan);
    row.appendChild(textSpan);
    return row;
  },

  renderAgendaPreview() {
    const wrap = document.createElement("div");
    wrap.className = "glass-cal-agenda-preview";

    this.myAgendaPreview.forEach((ev) => {
      const item = document.createElement("div");
      item.className = "glass-cal-agenda-item";

      const dot = document.createElement("span");
      dot.className = "agenda-dot";
      if (ev.color) dot.style.backgroundColor = ev.color;

      const titleSpan = document.createElement("span");
      titleSpan.className = "agenda-title";
      // ev.title may come straight from MMM-MyAgenda / a synced calendar;
      // treat it as untrusted and never parse it as HTML.
      titleSpan.textContent = ev.title || "(no title)";

      const timeSpan = document.createElement("span");
      timeSpan.className = "agenda-time";

      if (ev.allDay) {
        timeSpan.textContent = "All day";
      } else if (ev.startDate) {
        let t = ev.startDate.format("LT");
        if (ev.endDate && !ev.endDate.isSame(ev.startDate, "minute")) {
          t += " – " + ev.endDate.format("LT");
        }
        timeSpan.textContent = t;
      }

      item.appendChild(dot);
      item.appendChild(titleSpan);
      item.appendChild(timeSpan);
      wrap.appendChild(item);
    });

    return wrap;
  },

  // ---------------------------------------------------------------------------
  // Legend
  // ---------------------------------------------------------------------------
  renderLegend() {
    const legend = document.createElement("div");
    legend.className = "glass-cal-legend";

    const colors = {};

    this.monthEvents.forEach((ev) => {
      const name = ev.calendarName || "Calendar";
      if (!colors[name] && ev.color) {
        colors[name] = ev.color;
      }
    });

    Object.keys(colors).forEach((name) => {
      const item = document.createElement("div");
      item.className = "glass-cal-legend-item";
      if (this.hiddenCalendars.has(name)) {
        item.classList.add("hidden-calendar");
      }

      const swatch = document.createElement("span");
      swatch.className = "glass-cal-legend-color";
      swatch.style.backgroundColor = colors[name];

      const label = document.createElement("span");
      // name is a calendar name from config or a MyAgenda/AmbientWeather
      // payload; keep it as plain text.
      label.textContent = name;

      item.appendChild(swatch);
      item.appendChild(label);

      item.addEventListener("click", () => {
        if (this.hiddenCalendars.has(name)) {
          this.hiddenCalendars.delete(name);
        } else {
          this.hiddenCalendars.add(name);
        }
        this.queueDomUpdate(this.config.animationSpeed);
      });

      legend.appendChild(item);
    });

    return legend;
  },

  // ---------------------------------------------------------------------------
  // Month grid
  // ---------------------------------------------------------------------------
  renderMonthGrid() {
    const grid = document.createElement("div");
    grid.className = "glass-cal-grid";

    const monthMoment = moment().add(this.config.monthOffset, "months");
    const monthStart = monthMoment.clone().startOf("month");
    const monthEnd = monthMoment.clone().endOf("month");

    const firstDay = this.config.firstDayOfWeek;
    const firstGridDay = monthStart
      .clone()
      .startOf("week")
      .add(firstDay, "days");
    while (firstGridDay.day() !== firstDay) {
      firstGridDay.subtract(1, "day");
    }

    const dowRow = document.createElement("div");
    dowRow.className = "glass-cal-row glass-cal-dow";

    const dayNames = [];
    for (let i = 0; i < 7; i++) {
      dayNames.push(
        moment()
          .weekday((i + firstDay) % 7)
          .format("dd")
      );
    }

    if (this.config.showWeekNumbers) {
      const blank = document.createElement("div");
      blank.className = "glass-cal-cell glass-cal-weeknum-header";
      dowRow.appendChild(blank);
    }

    dayNames.forEach((name) => {
      const cell = document.createElement("div");
      cell.className = "glass-cal-cell glass-cal-dow-cell";
      cell.textContent = name;
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
        weekCell.textContent = current.isoWeek();
        row.appendChild(weekCell);
      }

      for (let day = 0; day < 7; day++) {
        row.appendChild(
          this.renderDayCell(current.clone(), monthStart, monthEnd)
        );
        current.add(1, "day");
      }

      grid.appendChild(row);
    }

    return grid;
  },

  renderDayCell(date, monthStart, monthEnd) {
    const cell = document.createElement("div");
    cell.className = "glass-cal-cell glass-cal-day";
    cell.style.setProperty("--day-bg-image", "none");
    cell.style.setProperty("--day-bg-opacity", "0");

    const isOtherMonth = date.month() !== monthStart.month();
    const today = moment();
    const isToday = date.isSame(today, "day");
    const isPast = date.isBefore(today, "day");

    if (isOtherMonth) cell.classList.add("other-month");
    if (isToday && this.config.highlightToday) cell.classList.add("today");
    if (isPast && this.config.dimPastDays && !isToday)
      cell.classList.add("past-day");

    const eventsForDay = this.getEventsForDay(date);
    const eventCount = eventsForDay.length;

    const dateKey = date.format("YYYY-MM-DD");
    const bgImage = this.getDayBackgroundForDate(dateKey, eventsForDay);
    if (bgImage) {
      const value = this.normalizeImageUrl(bgImage);
      if (value) cell.style.setProperty("--day-bg-image", `url('${value}')`);
      cell.style.setProperty("--day-bg-opacity", "0.35");
    }

    if (this.performanceTuning.heatmapEnabled && eventCount > 0) {
      const intensity = Math.min(1, eventCount / this.config.heatmapMaxEvents);
      const overlay = document.createElement("div");
      overlay.className = "glass-cal-heatmap-overlay";
      overlay.style.opacity = (0.15 + 0.35 * intensity).toFixed(2);
      cell.appendChild(overlay);
    }

    const dayNum = document.createElement("div");
    dayNum.className = "glass-cal-daynum";
    dayNum.textContent = date.date();
    cell.appendChild(dayNum);

    const eventsWrap = document.createElement("div");
    eventsWrap.className = "glass-cal-events";

    eventsForDay.sort((a, b) => {
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return a.startDate - b.startDate;
    });

    const maxEvents = this.performanceTuning.maxEventsPerDay || this.config.maxEventsPerDay;
    const limitedEvents = eventsForDay.slice(0, maxEvents);
    const hasOverflow = eventsForDay.length > limitedEvents.length && this.config.showOverflowIndicator;

    limitedEvents.forEach((ev) => {
      if (ev.allDay) {
        const fullItem = document.createElement("div");
        fullItem.className = "glass-cal-event-item glass-full-day";
        if (ev.color) fullItem.style.backgroundColor = ev.color + "66";

        const iconEl = this.getEventIcon(ev);
        if (iconEl) {
          const iconColor = ev.color ? this.getContrastColor(ev.color) : null;
          if (iconColor) iconEl.style.color = iconColor;
          fullItem.appendChild(iconEl);
        }

        const title = ev.title || "(no title)";
        const allowMarquee = this.performanceTuning.allowMarquee;
        if (allowMarquee && title.length > 14) {
          fullItem.appendChild(this.buildMarquee(title));
        } else {
          fullItem.appendChild(document.createTextNode(title));
        }

        eventsWrap.appendChild(fullItem);
        return;
      }

      const evItem = document.createElement("div");
      evItem.className = "glass-cal-event-item";

      const iconEl = this.getEventIcon(ev);
      if (iconEl) {
        const baseText = ev.color || null;
        if (baseText) {
          const contrasted = this.getContrastColor(baseText);
          if (contrasted) iconEl.style.color = contrasted;
        }
        evItem.appendChild(iconEl);
      } else {
        const dot = document.createElement("span");
        dot.className = "glass-cal-event-dot";
        if (ev.color) dot.style.backgroundColor = ev.color;
        evItem.appendChild(dot);
      }

      const label = document.createElement("span");
      label.className = "glass-cal-event-label";
      if (ev.color) label.style.color = ev.color;

      const title = ev.title || "(no title)";
      let timeStr = ev.startDate.format("LT");
      if (ev.endDate && !ev.endDate.isSame(ev.startDate, "minute")) {
        timeStr += " - " + ev.endDate.format("LT");
      }

      const fullText = `${timeStr} • ${title}`;

      const allowMarquee = this.performanceTuning.allowMarquee;
      if (allowMarquee && fullText.length > 18) {
        label.appendChild(this.buildMarquee(fullText));
      } else {
        // title is untrusted ICS/agenda data; build the row from separate
        // nodes so it can never be parsed as HTML.
        label.appendChild(document.createTextNode(timeStr));
        const sep = document.createElement("span");
        sep.className = "glass-separator";
        sep.textContent = " • ";
        label.appendChild(sep);
        label.appendChild(document.createTextNode(title));
      }

      evItem.appendChild(label);
      eventsWrap.appendChild(evItem);
    });

    if (hasOverflow) {
      const overflow = document.createElement("div");
      overflow.className = "glass-cal-event-item glass-cal-overflow";
      overflow.textContent = `+${eventsForDay.length - limitedEvents.length} more`;
      eventsWrap.appendChild(overflow);
    }

    cell.appendChild(eventsWrap);
    return cell;
  },

  buildMarquee(text) {
    const marquee = document.createElement("div");
    marquee.className = "glass-marquee";

    const track = document.createElement("div");
    track.className = "glass-marquee-track";

    const primary = document.createElement("span");
    // text is derived from untrusted ICS event titles; never parse as HTML.
    primary.textContent = text;

    track.appendChild(primary);
    marquee.appendChild(track);
    return marquee;
  },

  // ---- Marquee animation lifecycle ------------------------------------------------------
  //
  // getDom() builds a brand-new tree on every render while MagicMirror keeps the previous one
  // attached for the fade-out, and MagicMirror may skip the swap entirely when the markup is
  // identical. A running Web Animation keeps its detached target (and the whole old render tree)
  // alive, so animations are NOT cancelled in getDom() (a skipped swap would freeze the visible
  // titles); they are cancelled once their track is actually detached, in
  // _reapDetachedAnimations(). this.marqueeAnims holds { anim, track, gen } for every live
  // animation. renderGen invalidates the fallback poll of older renders.

  _clearAnimTimer() {
    if (this.animTimer) {
      clearTimeout(this.animTimer);
      this.animTimer = null;
    }
  },

  _cancelMarquee(entry) {
    try {
      entry.anim.cancel();
    } catch (err) {
      Log.warn(`[${this.name}] Failed to cancel marquee animation:`, err);
    }
    if (entry.track._marqueeAnim === entry.anim) entry.track._marqueeAnim = null;
  },

  // Cancels marquee animations whose track is no longer in the document (the swapped-out tree).
  _reapDetachedAnimations() {
    this.marqueeAnims = (this.marqueeAnims || []).filter((entry) => {
      if (entry.track.isConnected) return true;
      this._cancelMarquee(entry);
      return false;
    });
  },

  // Starts a new render generation: drops the previous poll timer. Live animations are left alone.
  _beginRender() {
    this.renderGen = (this.renderGen || 0) + 1;
    this._clearAnimTimer();
  },

  // Reaps detached marquees and plays the survivors unless the module is suspended. While an
  // older render's animations are still on screen (swap pending, skipped or dropped) a short,
  // bounded poll waits for their tree to be swapped out.
  _startAnimations(attempts = 50) {
    this._clearAnimTimer();
    this._reapDetachedAnimations();
    // MM sets hidden=false when a show starts but calls resume() only when its fade ends; a
    // data render inside that window clears MM's shared timer and resume() never comes. A
    // module that MM reports visible is not suspended.
    if (this.suspended && this.hidden === false) this.suspended = false;
    this._syncPausedClass();
    if (this.suspended) return;
    this.marqueeAnims.forEach((entry) => {
      if (typeof entry.anim.play === "function") entry.anim.play();
    });
    const gen = this.renderGen;
    const staleLeft = this.marqueeAnims.some((entry) => entry.gen !== gen);
    if (staleLeft && attempts > 0) {
      this.animTimer = setTimeout(() => {
        this.animTimer = null;
        if (gen !== this.renderGen) return;
        this._startAnimations(attempts - 1);
      }, 100);
    }
  },

  _pauseAnimations() {
    this._clearAnimTimer();
    this._syncPausedClass();
    (this.marqueeAnims || []).forEach((entry) => {
      if (typeof entry.anim.pause === "function") entry.anim.pause();
    });
  },

  // Mirrors the suspended state onto the module wrapper so the infinite CSS animations on the
  // card (shimmer/float/spinner) pause while hidden. The wrapper survives content swaps.
  _syncPausedClass() {
    try {
      const el = typeof document !== "undefined" && document.getElementById
        ? document.getElementById(this.identifier)
        : null;
      if (el && el.classList) el.classList.toggle("glass-calendar-suspended", !!this.suspended);
    } catch (err) {
      // cosmetic only
    }
  },

  // Scroll each overflowing title on its own loop: hold, scroll at marqueeSpeed px/s,
  // hold, repeat. Each loop starts at a random point so titles don't move in lockstep,
  // and titles that fit stay still. A ResizeObserver measures once a title is actually
  // laid out (modules on hidden pages have no size) and re-measures on changes. The observer
  // is disconnected on the next render, so at most the current and previous tree are retained.
  _startMarquees(root) {
    if (this._marqueeObserver) {
      this._marqueeObserver.disconnect();
      this._marqueeObserver = null;
    }
    if (typeof ResizeObserver === "undefined") return;
    const gen = this.renderGen;
    const speed = Number(this.config.marqueeSpeed) > 0 ? Number(this.config.marqueeSpeed) : 20;
    const holdStartMs = 2500;
    const holdEndMs = 2000;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.target;
        const track = box.querySelector(".glass-marquee-track");
        if (!track) continue;
        if (track._marqueeAnim) {
          const old = track._marqueeAnim;
          const prior = (this.marqueeAnims || []).find((e) => e.anim === old);
          if (prior) {
            this.marqueeAnims = this.marqueeAnims.filter((e) => e !== prior);
            this._cancelMarquee(prior);
          } else {
            old.cancel();
            track._marqueeAnim = null;
          }
        }
        // Never start an animation on an element that is already detached.
        if (!track.isConnected) continue;
        const distance = track.scrollWidth - box.clientWidth;
        if (box.clientWidth === 0 || distance <= 2) continue;
        const moveMs = (distance / speed) * 1000;
        const total = holdStartMs + moveMs + holdEndMs;
        const anim = track.animate(
          [
            { transform: "translateX(0)", offset: 0 },
            { transform: "translateX(0)", offset: holdStartMs / total },
            { transform: `translateX(${-distance}px)`, offset: (holdStartMs + moveMs) / total },
            { transform: `translateX(${-distance}px)`, offset: 1 }
          ],
          { duration: total, iterations: Infinity }
        );
        anim.currentTime = Math.random() * total;
        // Created while the module is hidden: stay paused until resume().
        if (this.suspended && this.hidden !== false && typeof anim.pause === "function") anim.pause();
        track._marqueeAnim = anim;
        this.marqueeAnims = this.marqueeAnims || [];
        this.marqueeAnims.push({ anim, track, gen });
      }
    });
    root.querySelectorAll(".glass-marquee").forEach((box) => observer.observe(box));
    this._marqueeObserver = observer;
    // Older renders' animations still on screen are reaped once their tree is swapped out.
    if ((this.marqueeAnims || []).length && !this.suspended) this._startAnimations();
  },

  getDayBackgroundForDate(dateKey, eventsForDay) {
    if (this.config.dayBackgrounds && this.config.dayBackgrounds[dateKey]) {
      return this.config.dayBackgrounds[dateKey];
    }

    const rules = this.config.dayBackgroundRules || [];
    if (!rules.length || !eventsForDay || !eventsForDay.length) return null;

    const lowerRules = rules.map((r) => ({
      calendar: r.calendar ? r.calendar.toLowerCase() : null,
      keyword: r.keyword ? r.keyword.toLowerCase() : null,
      image: r.image
    }));

    for (let rule of lowerRules) {
      if (!rule.image) continue;
      const match = eventsForDay.some((ev) => {
        const cal = (ev.calendarName || ev.calendar || "").toLowerCase();
        const title = (ev.title || "").toLowerCase();
        const calendarOk = rule.calendar ? cal.includes(rule.calendar) : true;
        const keywordOk = rule.keyword ? title.includes(rule.keyword) : true;
        return calendarOk && keywordOk;
      });
      if (match) return rule.image;
    }

    return null;
  },

  normalizeImageUrl(input) {
    if (!input) return null;
    // Accept both the documented url('...') form and a bare path/URL: strip
    // a leading url(...) wrapper before resolving, since the caller always
    // re-wraps the result in url('...') itself.
    const unwrapped = input
      .toString()
      .trim()
      .replace(/^url\((['"]?)([\s\S]*)\1\)$/i, "$2");
    const val = unwrapped.trim();
    const lower = val.toLowerCase();
    const isAbs =
      lower.startsWith("http://") ||
      lower.startsWith("https://") ||
      lower.startsWith("//") ||
      lower.startsWith("data:") ||
      lower.startsWith("/");
    if (lower.startsWith("modules/")) {
      return "/" + val.replace(/^\/+/, "");
    }
    if (isAbs) return val;
    try {
      return this.file(val);
    } catch (e) {
      return val;
    }
  },

  // ---------------------------------------------------------------------------
  // Fuzzy per-day dedupe
  // ---------------------------------------------------------------------------
  getEventsForDay(date) {
    const start = date.clone().startOf("day");
    const end = date.clone().endOf("day");

    const sameDayEvents = this.monthEvents.filter((ev) => {
      if (
        this.hiddenCalendars &&
        this.hiddenCalendars.has(ev.calendarName || "Calendar")
      ) {
        return false;
      }
      return ev.startDate.isBefore(end) && ev.endDate.isAfter(start);
    });

    const seen = new Set();
    const result = [];

    sameDayEvents.forEach((ev) => {
      const normTitle = this.normalizeTitle(ev.title);
      const dayKey = start.format("YYYY-MM-DD");
      const key = `event|${normTitle}|${dayKey}`;

      if (seen.has(key)) return;

      // Fuzzy dedupe: skip if similar title/time already added for this day
      const isDuplicate = result.some((existing) =>
        this.isDuplicateEventForDay(ev, existing, start)
      );

      if (!isDuplicate) {
        seen.add(key);
        result.push(ev);
      }
    });

    return result;
  },

  isDuplicateEventForDay(evA, evB, dayStart) {
    const titleA = this.normalizeTitle(evA.title);
    const titleB = this.normalizeTitle(evB.title);
    if (!titleA || !titleB) return false;

    const titleScore = this.titleSimilarity(titleA, titleB);
    if (titleScore < 0.7) return false;

    // If either is all-day, consider them duplicates when titles are close
    if (evA.allDay || evB.allDay) return true;

    // Timed: consider duplicates if start times are within 45 minutes
    const diffMinutes = Math.abs(evA.startDate.diff(evB.startDate, "minutes"));
    if (diffMinutes > 45) return false;

    // Also align on the same day (should already be true from caller)
    return (
      evA.startDate.isSame(dayStart, "day") ||
      evB.startDate.isSame(dayStart, "day")
    );
  },

  titleSimilarity(a, b) {
    const tokensA = a.split(/\s+/).filter(Boolean);
    const tokensB = b.split(/\s+/).filter(Boolean);
    if (!tokensA.length || !tokensB.length) return 0;

    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    let intersect = 0;
    setA.forEach((t) => {
      if (setB.has(t)) intersect += 1;
    });

    const denom = Math.max(setA.size, setB.size);
    return denom === 0 ? 0 : intersect / denom;
  },

  getContrastColor(color, fallback) {
    const fb = fallback || "#7dd3fc";
    const parsed = this.parseColor(color);
    if (!parsed) return fb;

    const { r, g, b } = parsed;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const { h, s } = this.rgbToHsl(r, g, b);

    const targetL = luminance > 0.55 ? 0.25 : 0.82;
    const clampedS = Math.min(0.9, Math.max(0.35, s));
    return this.hslToHex(h, clampedS, targetL);
  },

  parseColor(input) {
    if (!input) return null;
    let str = input.toString().trim();
    if (str.startsWith("#")) {
      const hex = str.slice(1);
      if (hex.length === 3) {
        const r = parseInt(hex[0] + hex[0], 16);
        const g = parseInt(hex[1] + hex[1], 16);
        const b = parseInt(hex[2] + hex[2], 16);
        if ([r, g, b].some((v) => Number.isNaN(v))) return null;
        return { r, g, b };
      }
      if (hex.length === 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if ([r, g, b].some((v) => Number.isNaN(v))) return null;
        return { r, g, b };
      }
      if (hex.length === 8) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if ([r, g, b].some((v) => Number.isNaN(v))) return null;
        return { r, g, b };
      }
      return null;
    }
    if (str.startsWith("rgb")) {
      const nums = str
        .replace(/[rgba()]/g, " ")
        .split(/[\s,/]+/)
        .filter(Boolean)
        .slice(0, 3)
        .map((n) => parseInt(n, 10));
      if (nums.length === 3 && nums.every((v) => !Number.isNaN(v))) {
        return { r: nums[0], g: nums[1], b: nums[2] };
      }
    }
    return null;
  },

  rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        default:
          h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return { h, s, l };
  },

  hslToHex(h, s, l) {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    const toHex = (x) => {
      const v = Math.round(x * 255)
        .toString(16)
        .padStart(2, "0");
      return v;
    };

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  },

  // ---------------------------------------------------------------------------
  // Icon helpers
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
      const name = (icon || "").replace(/^iconoir-/, "").replace(/\.svg$/i, "");
      const img = document.createElement("img");
      img.src = this.file(`lib/iconoir/${name}.svg`);
      img.alt = "";
      img.classList.add("glass-event-icon", "iconoir-img");
      img.onerror = () => {
        const fallback = document.createElement("i");
        fallback.className = `iconoir-${name} glass-event-icon iconoir-css-fallback`;
        img.replaceWith(fallback);
      };
      return img;
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
    if (cond.includes("fog") || cond.includes("mist"))
      return "fa-solid fa-smog";
    if (cond.includes("partly") || cond.includes("mostly"))
      return "fa-solid fa-cloud-sun";
    if (cond.includes("sun") || cond.includes("clear"))
      return "fa-solid fa-sun";
    if (cond.includes("cloud")) return "fa-solid fa-cloud-sun";

    return "fa-solid fa-cloud";
  },

  // ---------------------------------------------------------------------------
  // Theme helpers
  // ---------------------------------------------------------------------------
  determineThemeAuto() {
    // "auto" defers to the OS/browser color-scheme preference, distinct from
    // "autoSun" which derives day/night from real sunrise/sunset.
    if (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: light)").matches
    ) {
      return "light";
    }
    return "dark";
  },

  determineThemeSun() {
    // Prefer the page-wide theme set by MMM-GlassClock (mm-day / mm-night on
    // <body>), which is computed from real sunrise/sunset for the current
    // calendar date. This keeps the card in lockstep with the rest of the
    // page instead of drifting from a separate whole-hour estimate.
    if (typeof document !== "undefined" && document.body) {
      if (document.body.classList.contains("mm-day")) return "light";
      if (document.body.classList.contains("mm-night")) return "dark";
    }

    let sunrise = this.config.sunriseHour;
    let sunset = this.config.sunsetHour;

    if (
      this.weatherSummary &&
      this.weatherSummary.sunrise &&
      this.weatherSummary.sunset
    ) {
      try {
        sunrise = moment(this.weatherSummary.sunrise).hour();
        sunset = moment(this.weatherSummary.sunset).hour();
      } catch (e) {
        // ignore
      }
    }

    const now = moment().hour();
    if (now >= sunrise && now < sunset) {
      return "light";
    }
    return "dark";
  },

  queueDomUpdate(speed = this.config.animationSpeed) {
    const debounce = this.performanceTuning.domUpdateDebounce;
    if (!debounce) {
      this.updateDom(speed);
      return;
    }

    if (this.domUpdateTimer) {
      clearTimeout(this.domUpdateTimer);
    }
    this.domUpdateTimer = setTimeout(() => {
      this.updateDom(speed);
      this.domUpdateTimer = null;
    }, debounce);
  },

  resolvePerformanceProfile() {
    const requested = (this.config.performanceProfile || "auto").toLowerCase();
    if (requested === "pi" || requested === "full") return requested;
    const ua =
      typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "";
    const isPi =
      ua.includes("raspberry") ||
      ua.includes("armv7") ||
      ua.includes("aarch64") ||
      ua.includes("linux arm");
    return isPi ? "pi" : "full";
  }
});
