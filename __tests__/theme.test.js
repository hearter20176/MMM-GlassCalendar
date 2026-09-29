const test = require("node:test");
const assert = require("node:assert/strict");

global.Module = { register: (_name, def) => { global.__mod = def; } };
global.Log = { info: () => {}, warn: () => {}, error: () => {} };
global.config = {};
global.moment = require("moment");

const makeClassList = (owner) => ({
  toggle(name, force) {
    const has = owner.classes.has(name);
    const shouldHave = force === undefined ? !has : force;
    if (shouldHave) owner.classes.add(name);
    else owner.classes.delete(name);
    return shouldHave;
  },
  contains(name) {
    return owner.classes.has(name);
  }
});
const makeBody = (classes = []) => {
  const body = { classes: new Set(classes) };
  body.classList = makeClassList(body);
  return body;
};
global.document = { body: makeBody() };

require("../MMM-GlassCalendar.js");
const mod = global.__mod;

const makeContext = (overrides = {}) =>
  Object.assign(
    {
      config: { theme: "autoSun", sunriseHour: 7, sunsetHour: 19, animationSpeed: 400 },
      weatherSummary: null,
      performanceTuning: { domUpdateDebounce: 0 },
      domUpdateTimer: null,
      queueDomUpdate: mod.queueDomUpdate,
      updateDom: () => { global.__updateDomCalls = (global.__updateDomCalls || 0) + 1; }
    },
    overrides
  );

test("determineThemeSun: follows body.mm-day when present", () => {
  document.body = makeBody(["mm-day"]);
  const ctx = makeContext();
  assert.equal(mod.determineThemeSun.call(ctx), "light");
});

test("determineThemeSun: follows body.mm-night when present", () => {
  document.body = makeBody(["mm-night"]);
  const ctx = makeContext();
  assert.equal(mod.determineThemeSun.call(ctx), "dark");
});

test("determineThemeSun: falls back to hour logic when neither body class is present", () => {
  document.body = makeBody([]);
  // sunriseHour/sunsetHour spanning the full day makes the fallback
  // deterministic regardless of the real wall-clock time the test runs at.
  const ctx = makeContext({ config: { theme: "autoSun", sunriseHour: 0, sunsetHour: 24 } });
  assert.equal(mod.determineThemeSun.call(ctx), "light");
});

test("determineThemeSun: body classes override the hour-based fallback (disagreement case)", () => {
  // Body says night even though sunriseHour/sunsetHour spans the whole day
  // (which the hour-based fallback would read as "light") — the page theme
  // set by MMM-GlassClock must win.
  document.body = makeBody(["mm-night"]);
  const ctx = makeContext({ config: { theme: "autoSun", sunriseHour: 0, sunsetHour: 24 } });
  assert.equal(mod.determineThemeSun.call(ctx), "dark");
});

test("notificationReceived: PAGE_THEME_CHANGED re-renders when theme is autoSun", () => {
  document.body = makeBody(["mm-day"]);
  global.__updateDomCalls = 0;
  const ctx = makeContext();
  mod.notificationReceived.call(ctx, "PAGE_THEME_CHANGED", { mode: "day" }, {});
  assert.equal(global.__updateDomCalls, 1);
});

test("notificationReceived: PAGE_THEME_CHANGED is ignored when theme is not autoSun", () => {
  global.__updateDomCalls = 0;
  const ctx = makeContext({ config: { theme: "dark" } });
  mod.notificationReceived.call(ctx, "PAGE_THEME_CHANGED", { mode: "night" }, {});
  assert.equal(global.__updateDomCalls, 0);
});
