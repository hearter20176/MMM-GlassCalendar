# MMM-GlassCalendar

An iOS-style "liquid glass" monthly calendar module for MagicMirror with ICS/MyAgenda/Calendar support, fuzzy dedupe, heatmap, weather/agenda preview, rich icon mapping, and per-day backgrounds.

## Highlights
- ICS via node_helper (RRULE aware) plus optional Calendar/MyAgenda/AmbientWeather payloads.
- Full-day + timed events with keyword icon mapping (Font Awesome, Boxicons, Iconoir SVGs, Iconify).
- Per-calendar visibility toggles, fuzzy dedupe across sources, and heatmap overlay.
- Auto themes (dark/light/autoSun), contrast-aware icons, and adjustable day backgrounds by date or calendar+keyword rules.
- Optional weather row and agenda preview chips; renders all events (no overflow truncation).

## Requirements
- MagicMirror.
- Local assets:
  - `lib/boxicons/boxicons.min.css` and fonts in `lib/boxicons/fonts/`.
  - `lib/iconoir/` with `iconoir.css` or SVGs (recommended: SVGs as shipped in this repo); reference Iconoir icons by filename without extension.
  - Font Awesome loaded via CDN (default) unless you restore local fonts.

## Installation
```bash
cd ~/MagicMirror/modules
git clone https://github.com/your-user/MMM-GlassCalendar.git
cd MMM-GlassCalendar
npm install
```

Ensure the `lib/` assets above are present. If running offline, host Font Awesome locally and update `MMM-GlassCalendar.js` styles array accordingly.

## Configuration
In `config/config.js`:
```js
{
  module: "MMM-GlassCalendar",
  position: "middle_center",
  config: {
    header: "Monthly Calendar",
    locale: "en",
    firstDayOfWeek: 0,

    // Sources
    useCalendarModule: false,
    useMyAgenda: true,
    useAmbientWeather: true,
    icalSources: [
      { url: "https://example.com/holidays.ics", name: "Holidays", color: "#38bdf8" }
    ],

    // Visuals
    theme: "autoSun",            // "dark" | "light" | "auto" | "autoSun"
    sunriseHour: 7,
    sunsetHour: 19,
    heatmapEnabled: true,
    heatmapMaxEvents: 6,
    showWeekNumbers: false,
    highlightToday: true,
    dimPastDays: true,
    performanceProfile: "auto",  // "auto" | "pi" | "full"
    reduceMotion: false,         // true disables marquee/heatmap on Pi or reduced-motion

    // Events
    maxEventsPerDay: 6,
    showOverflowIndicator: false, // all events are shown by default
    eventIcons: {
      birthday: { type: "fa", icon: "fa-solid fa-cake-candles" },
      flight:   { type: "box", icon: "bx bx-plane-alt" },
      office:   { type: "iconoir", icon: "briefcase" },
      run:      { type: "iconify", icon: "mdi:run" }
    },
    calendarVisibility: { "Holidays": true },

    // Day backgrounds
    dayBackgrounds: {
      "2025-12-25": "/img/christmas.jpg"
    },
    dayBackgroundRules: [
      { calendar: "holiday", keyword: "christmas", image: "/img/christmas.jpg" }
    ],

    // Extras
    showAgendaPreview: true,
    maxAgendaPreviewItems: 4,
    showWeatherRow: true,
    updateInterval: 15 * 60 * 1000,
    animationSpeed: 400
  }
}
```

### Icon types
- `fa`: Font Awesome class string, e.g. `fa-solid fa-car`.
- `box`: Boxicons class string, e.g. `bx bx-run`.
- `iconoir`: Iconoir SVG filename (no extension), e.g. `calendar-check`; ensure the SVG exists in `lib/iconoir/`.
- `iconify`: Any Iconify icon id, e.g. `mdi:airplane`.

### Day backgrounds
- `dayBackgrounds`: map of `YYYY-MM-DD` -> image path/URL (string). If not wrapped with `url()`, it will be auto-wrapped.
- `dayBackgroundRules`: array of `{ calendar?, keyword?, image }`. If any event for that day matches the calendar substring and keyword in the title, the image is applied.
- Use browser-visible paths (e.g., `/modules/MMM-GlassCalendar/img/snow.jpg` or another served URL).

### Performance options
- `performanceProfile`: `"auto"` (detect Pi/ARM), `"pi"` (force low-motion, debounce DOM, cap per-day events), `"full"` (keep all visuals).
- `reduceMotion`: Force-disable marquee/heatmap motion even on non-Pi devices (also triggered by `prefers-reduced-motion`).
- `maxEventsPerDay` + `showOverflowIndicator`: lowering the cap reduces DOM nodes on low-power devices.

## Timezone handling
- ICS parsing applies calendar timezones to recurring and floating events, preventing early/late shifts across calendars.
- Set `timeZone` plus `forceTimeZone: true` on a source to pin floating times (DTSTART without TZ) and render times in that zone even if the host timezone differs.

## Tests
- Install dependencies: `npm install`
- Run all tests (timezone coverage): `npm test`
- Run a specific file: `node --test __tests__/timezone.test.js`

## Styling Notes
- Card uses a liquid glass shimmer and full-width layout in `middle_center`.
- Heatmap and day backgrounds sit behind content; all events render with contrast-aware icons.
- Legend uses brighter text with a subtle shadow for readability.

## Release Checklist (manual)
1. Verify assets present (`lib/boxicons`, `lib/iconoir` SVGs, Font Awesome CDN/local).
2. Run a quick MagicMirror load to ensure no console errors.
3. Update version in `package.json` (and `package-lock.json` if used): `npm version <new>` (skip git tagging if undesired).
4. Commit changes, tag release: `git tag vX.Y.Z`.
5. Publish GitHub release with changelog (features, fixes, breaking changes, asset requirements).

## License
MIT
