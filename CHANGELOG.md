# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `package.json`: repository, homepage, bugs, license and keywords fields.
- README: Update section and trailing commas in the config examples.
- Node built-ins are imported with the `node:` scheme (for example `node:https`).
- ESLint (flat config) with an `npm run lint` script.
- Added CHANGELOG, CODE_OF_CONDUCT and a Dependabot configuration.

## [4.1.0]

Released before this changelog was started. Commit history, newest first:

### 2026-10-03

- README: current screenshot and documentation review

### 2026-10-01

- Stop leaking marquee animations and pause them while hidden

### 2026-09-29

- Follow page theme, render event text safely, mask ICS URLs, show fetch errors

### 2026-09-25

- Readable, independent title scrolling
- Support sources that list several feeds (url array)
- Make ICS fetching resilient: retries, cache fallback, webcal support

### 2026-09-24

- Mask private calendar URLs in logs and trim fetch error output
- Add holiday images and smoother shimmer/marquee animation (from deployed Pi)

### 2025-12-20

- modified:   __tests__/timezone.test.js 	modified:   lib/ics-timezone.js 	modified:   node_helper.js
- modified:   README.md 	modified:   __tests__/timezone.test.js 	modified:   lib/ics-timezone.js 	modified:   node_helper.js

### 2025-12-13

- modified:   MMM-GlassCalendar.css 	modified:   MMM-GlassCalendar.js
- deleted:    img/new_years_eve.jpg
- modified:   MMM-GlassCalendar.css 	modified:   MMM-GlassCalendar.js

### 2025-11-29

- modified:   MMM-GlassCalendar.js 	modified:   README.md

### 2025-11-26

- Fix timezone handling and add automated tests

### 2025-11-23

- Map partly cloudy to cloud-sun icon
- Fix weather text color
- Add weather text color fallback
- Align weather text styling
- Align calendar loading text color with other modules
- Match spinner text with MyAgenda and daily calendar
- Align spinner styling to MyAgenda
- Match calendar title styling to daily calendar
- Align text styling with glass modules
- Fix multi-calendar event fetch handling

### 2025-11-19

- modified:   MMM-GlassCalendar.js 	modified:   node_helper.js 	modified:   package-lock.json 	modified:   package.json
- docs: add README and bump version to 4.1.0
- new file:   MMM-GlassCalendar.css 	new file:   MMM-GlassCalendar.js 	new file:   node_helper.js 	new file:   package-lock.json 	new file:   package.json

### 2025-11-18

- Initial commit
