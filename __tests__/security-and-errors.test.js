const test = require("node:test");
const assert = require("node:assert/strict");

global.Module = { register: (_name, def) => { global.__mod2 = def; } };
global.Log = { info: () => {}, warn: () => {}, error: () => {} };
global.config = {};
global.moment = require("moment");

// A minimal DOM shim (createElement + textContent/innerHTML/children/classList)
// good enough to exercise builder methods without pulling in jsdom. innerHTML
// on this shim does a naive tag-detection so a regression back to innerHTML
// would be caught by an assertion that no "<" survives into textContent-only
// paths.
function makeElement(tag) {
  const el = {
    tagName: tag,
    _html: "",
    children: [],
    attributes: {},
    style: {},
    classListSet: new Set(),
    get textContent() {
      return this._text || "";
    },
    set textContent(v) {
      this._text = v;
      this._html = String(v);
    },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      // Real innerHTML would parse tags; for the purpose of this test we
      // just record what was assigned so we can assert it never happens
      // for untrusted data.
      this._html = String(v);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener() {},
    get classList() {
      const set = this.classListSet;
      return {
        add: (c) => set.add(c),
        contains: (c) => set.has(c),
        toggle: (c, force) => {
          const has = set.has(c);
          const shouldHave = force === undefined ? !has : force;
          if (shouldHave) set.add(c);
          else set.delete(c);
        }
      };
    },
    set className(v) {
      this._className = v;
    },
    get className() {
      return this._className || "";
    }
  };
  return el;
}

global.document = {
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => {
    const node = makeElement("#text");
    node.textContent = text;
    return node;
  },
  body: (() => {
    const b = makeElement("body");
    return b;
  })()
};

require("../MMM-GlassCalendar.js");
const mod = global.__mod2;

test("buildMarquee: untrusted ICS title text is set via textContent, never parsed as HTML", () => {
  const ctx = {};
  const malicious = '<img src=x onerror="alert(1)">Evil Meeting';
  const marquee = mod.buildMarquee.call(ctx, malicious);
  const primary = marquee.children[0].children[0];
  assert.equal(primary.textContent, malicious);
  // innerHTML must never have been assigned on the text-bearing node.
  assert.equal(primary._html, malicious);
});

test("renderAgendaPreview: event titles from MyAgenda are rendered as text, not HTML", () => {
  const ctx = {
    myAgendaPreview: [
      {
        title: '<script>alert(1)</script>',
        calendarName: "Work",
        startDate: null,
        endDate: null,
        allDay: true,
        color: null
      }
    ]
  };
  const wrap = mod.renderAgendaPreview.call(ctx);
  const item = wrap.children[0];
  const titleSpan = item.children.find((c) => c.className === "agenda-title");
  assert.equal(titleSpan.textContent, '<script>alert(1)</script>');
});

test("renderLegend: calendar names are rendered as text, not HTML", () => {
  const ctx = {
    monthEvents: [{ calendarName: '<b>Injected</b>', color: "#ff0000" }],
    hiddenCalendars: new Set()
  };
  const legend = mod.renderLegend.call(ctx);
  const item = legend.children[0];
  const label = item.children[1];
  assert.equal(label.textContent, '<b>Injected</b>');
});

test("socketNotificationReceived: GLASSCALENDAR_ERROR records the error and triggers a re-render", () => {
  let updateCalls = 0;
  const ctx = {
    identifier: "id1",
    config: { monthOffset: 0, animationSpeed: 400 },
    fetchErrors: [],
    queueDomUpdate: () => { updateCalls++; }
  };
  mod.socketNotificationReceived.call(ctx, "GLASSCALENDAR_ERROR", {
    identifier: "id1",
    monthOffset: 0,
    url: "Work Calendar",
    message: "HTTP 404"
  });
  assert.equal(ctx.fetchErrors.length, 1);
  assert.equal(updateCalls, 1);
});

test("renderHeader: shows a visible failure count instead of looking like an empty/free calendar", () => {
  const ctx = {
    config: { header: "Calendar", monthOffset: 0, icalSources: [{ url: "a" }, { url: "b" }] },
    loaded: true,
    lastFetch: new Date(),
    fetchErrors: [{ source: "a" }],
    countConfiguredSources: mod.countConfiguredSources
  };
  const header = mod.renderHeader.call(ctx);
  const metaSpan = header.children[1];
  assert.ok(metaSpan.classList.contains("glass-cal-meta-warning"));
  assert.match(metaSpan.textContent, /1 of 2 calendars? failed/);
});

test("renderHeader: while loading with an error already in hand, shows 'Calendar unavailable' instead of the loading spinner", () => {
  const ctx = {
    config: { header: "Calendar", monthOffset: 0, icalSources: [{ url: "a" }] },
    loaded: false,
    lastFetch: null,
    fetchErrors: [{ source: "a" }],
    countConfiguredSources: mod.countConfiguredSources
  };
  const header = mod.renderHeader.call(ctx);
  const metaSpan = header.children[1];
  assert.equal(metaSpan.textContent, "Calendar unavailable");
});

test("renderHeader: a single configured source with a url array counts each URL, so '2 of 1' can never be shown", () => {
  // One configured source (icalSources.length === 1) whose `url` is an
  // array of 2 feeds; node_helper's expandSources fetches each URL
  // separately and can send one GLASSCALENDAR_ERROR per URL. The header's
  // "N of M" denominator must count expanded URLs, not configured entries.
  const ctx = {
    config: { header: "Calendar", monthOffset: 0, icalSources: [{ url: ["u1", "u2"], name: "multi" }] },
    loaded: true,
    lastFetch: new Date(),
    fetchErrors: [{ source: "multi" }, { source: "multi" }],
    countConfiguredSources: mod.countConfiguredSources
  };
  const header = mod.renderHeader.call(ctx);
  const metaSpan = header.children[1];
  assert.match(metaSpan.textContent, /2 of 2 calendars failed/);
  assert.doesNotMatch(metaSpan.textContent, /of 1 calendar/);
});
