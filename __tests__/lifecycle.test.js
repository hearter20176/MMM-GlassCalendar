/* Lifecycle tests for the title-marquee Web Animations in MMM-GlassCalendar.js: animations must
 * never outlive the render tree they were created for (a running Web Animation keeps its detached
 * target, and the whole old tree, alive), must keep running when MagicMirror skips a swap, and
 * must honour suspend()/resume(). Uses a minimal fake DOM, a fake ResizeObserver, a fake
 * element.animate() and a fake clock - there is no browser here. Each setup() builds an
 * independent module instance in its own vm context, so two instances can be driven side by side.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const moment = require("moment");

const MODULE_PATH = path.join(__dirname, "..", "MMM-GlassCalendar.js");

class FakeElement {
  constructor(tag, hooks) {
    this.tagName = tag;
    this.hooks = hooks;
    this.children = [];
    this.parentNode = null;
    this.attached = false; // only meaningful on a root node
    this.classes = new Set();
    this.styleProps = {};
    this.style = new Proxy(this.styleProps, {
      get: (t, k) => (k === "setProperty" ? (a, b) => (t[a] = b) : t[k]),
      set: (t, k, v) => ((t[k] = v), true)
    });
    this.textContent = "";
    this.innerHTML = "";
    const owner = this;
    this.classList = {
      add: (...names) => names.forEach((n) => owner.classes.add(n)),
      remove: (...names) => names.forEach((n) => owner.classes.delete(n)),
      toggle(name, force) {
        const on = force === undefined ? !owner.classes.has(name) : force;
        if (on) owner.classes.add(name);
        else owner.classes.delete(name);
        return on;
      },
      contains: (n) => owner.classes.has(n)
    };
  }
  get className() {
    return [...this.classes].join(" ");
  }
  set className(v) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  setAttribute() {}
  addEventListener() {}
  querySelectorAll(sel) {
    const cls = String(sel).replace(/^\./, "");
    const out = [];
    this.children.forEach((c) =>
      c.walk((n) => {
        if (n.classes.has(cls)) out.push(n);
      })
    );
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  get clientWidth() {
    return this.classes.has("glass-marquee") ? 100 : 0;
  }
  get scrollWidth() {
    return this.classes.has("glass-marquee-track") ? 300 : 0;
  }
  animate() {
    const anim = {
      track: this,
      state: "running",
      cancelled: false,
      cancel() {
        this.cancelled = true;
        this.state = "idle";
      },
      pause() {
        if (!this.cancelled) this.state = "paused";
      },
      play() {
        if (!this.cancelled) this.state = "running";
      }
    };
    this.hooks.marquees.push(anim);
    return anim;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.attached === true;
  }
  walk(fn) {
    fn(this);
    this.children.forEach((c) => c.walk(fn));
  }
}

let instanceSeq = 0;

function setup(configOverrides = {}) {
  const clock = { now: 0, timers: new Map(), seq: 0 };
  const marquees = []; // every Animation created by track.animate()
  const observers = [];
  const warnings = [];
  const hooks = { marquees };
  const moduleWrapper = new FakeElement("div", hooks); // MM per-module wrapper element
  const sandbox = {
    Module: { register: (name, def) => (sandbox.def = def) },
    Log: { info() {}, log() {}, warn: (...a) => warnings.push(a.join(" ")), error() {} },
    config: {},
    moment,
    window: undefined,
    navigator: undefined,
    console,
    document: {
      body: new FakeElement("body", hooks),
      createElement: (tag) => new FakeElement(tag, hooks),
      createTextNode: (text) => {
        const node = new FakeElement("#text", hooks);
        node.textContent = String(text);
        return node;
      },
      getElementById: () => moduleWrapper
    },
    setTimeout(fn, ms) {
      const id = ++clock.seq;
      clock.timers.set(id, { fn, at: clock.now + (ms || 0) });
      return id;
    },
    clearTimeout(id) {
      clock.timers.delete(id);
    },
    setInterval() {
      return ++clock.seq;
    },
    clearInterval() {},
    ResizeObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.boxes = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(el) {
        this.boxes.push(el);
      }
      disconnect() {
        this.disconnected = true;
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, "utf8"), sandbox, { filename: MODULE_PATH });
  const id = ++instanceSeq;
  const inst = Object.assign({}, sandbox.def, {
    name: "MMM-GlassCalendar",
    identifier: `module_${id}_MMM-GlassCalendar`,
    config: Object.assign({}, sandbox.def.defaults, {
      performanceProfile: "full",
      reduceMotion: false,
      theme: "dark",
      icalSources: [],
      showAgendaPreview: false
    }, configOverrides),
    file: (f) => `/modules/MMM-GlassCalendar/${f}`,
    sendSocketNotification() {},
    sendNotification() {},
    updateDom() {}
  });
  inst.start();
  inst.loaded = true;
  // Two long-titled events today; both overflow the 100px box of the fake layout.
  const t0 = moment().startOf("day").add(9, "hours");
  inst.handleMyAgendaEvents(
    [1, 2].map((i) => ({
      title: `A very long event title number ${i} that needs a marquee`,
      startDate: t0.clone().add(i, "hours").toISOString(),
      endDate: t0.clone().add(i + 1, "hours").toISOString(),
      calendarName: "Cal"
    }))
  );
  const tick = (ms) => {
    const end = clock.now + ms;
    for (;;) {
      let next = null;
      for (const [tid, t] of clock.timers) {
        if (t.at <= end && (!next || t.at < next.t.at)) next = { id: tid, t };
      }
      if (!next) break;
      clock.timers.delete(next.id);
      clock.now = Math.max(clock.now, next.t.at);
      next.t.fn();
    }
    clock.now = end;
  };
  // Runs each live observer callback for its attached boxes (a layout pass in the browser).
  const layout = () =>
    observers.forEach((o) => {
      if (o.disconnected) return;
      const entries = o.boxes.filter((b) => b.isConnected).map((b) => ({ target: b }));
      if (entries.length) o.cb(entries);
    });
  return { inst, clock, tick, marquees, observers, warnings, layout, moduleWrapper };
}

function marqueeTracks(root) {
  const out = [];
  root.walk((n) => {
    if (n.classes.has("glass-marquee-track")) out.push(n);
  });
  return out;
}

// Mimics MagicMirror updateDom: the new tree is built while the old one is attached, then swapped.
function swapIn(prev, next) {
  if (prev) prev.attached = false;
  next.attached = true;
}

const live = (marquees) => marquees.filter((a) => !a.cancelled);

test("sanity: the fixture renders several overflowing marquee tracks", () => {
  const { inst } = setup();
  assert.ok(marqueeTracks(inst.getDom()).length >= 2);
});

test("N re-renders keep only on-screen animations, detached ones are cancelled", () => {
  const { inst, marquees, layout, tick } = setup();
  let current = null;
  for (let i = 0; i < 8; i++) {
    const next = inst.getDom();
    tick(300); // old tree still attached during the fade
    swapIn(current, next);
    layout();
    inst.notificationReceived("MODULE_DOM_UPDATED");
    current = next;
  }
  const tracks = marqueeTracks(current);
  assert.ok(tracks.length >= 2);
  const running = live(marquees);
  assert.equal(running.length, tracks.length);
  for (const a of running) {
    assert.ok(a.track.isConnected, "live marquee on a detached track");
    assert.ok(tracks.includes(a.track));
  }
  assert.equal(marquees.length, tracks.length * 8);
  assert.equal(inst.marqueeAnims.length, tracks.length);
});

test("getDom() never cancels: a pending swap keeps the visible titles scrolling", () => {
  const { inst, marquees, layout, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const n = live(marquees).length;
  inst.getDom(); // new tree built, old one still on screen
  tick(300);
  assert.equal(live(marquees).length, n);
  assert.ok(live(marquees).every((x) => x.track.isConnected && x.state === "running"));
});

test("a skipped swap keeps the visible titles animating and the poll is bounded", () => {
  const { inst, marquees, layout, tick, clock } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const n = live(marquees).length;
  assert.ok(n >= 2);
  for (let i = 0; i < 4; i++) {
    inst.getDom(); // never attached: MM saw identical markup and kept the old DOM
    layout();
    inst.notificationReceived("MODULE_DOM_UPDATED");
    tick(10000);
  }
  assert.equal(live(marquees).length, n);
  assert.ok(live(marquees).every((x) => x.track.isConnected && x.state === "running"));
  assert.equal(clock.timers.size, 0, "poll must give up");
  assert.equal(inst.marqueeAnims.length, n);
});

test("swap landing after the poll gave up is reaped on MODULE_DOM_UPDATED", () => {
  const { inst, marquees, layout, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const b = inst.getDom();
  tick(6000); // poll exhausted while the old tree is still attached
  swapIn(a, b);
  layout();
  inst.notificationReceived("MODULE_DOM_UPDATED");
  const tracks = marqueeTracks(b);
  assert.equal(live(marquees).length, tracks.length);
  assert.ok(live(marquees).every((x) => tracks.includes(x.track)));
});

test("the fallback poll reaps the old tree when MODULE_DOM_UPDATED never arrives", () => {
  const { inst, marquees, layout, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const b = inst.getDom();
  tick(300);
  swapIn(a, b);
  layout();
  tick(300);
  const tracks = marqueeTracks(b);
  assert.equal(live(marquees).length, tracks.length);
  assert.ok(live(marquees).every((x) => x.track.isConnected));
});

test("pending polls from an older render do nothing", () => {
  const { inst, marquees, layout, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const stale = inst.getDom(); // superseded before MagicMirror swapped it in
  const fresh = inst.getDom();
  swapIn(a, fresh);
  layout();
  tick(2000);
  assert.equal(live(marquees).length, marqueeTracks(fresh).length);
  assert.ok(!marqueeTracks(stale).some((t) => t._marqueeAnim));
});

test("a resize re-measure replaces the track animation without leaking", () => {
  const { inst, marquees, layout } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const n = live(marquees).length;
  layout();
  layout();
  assert.equal(live(marquees).length, n);
  assert.equal(inst.marqueeAnims.length, n);
  assert.equal(marquees.length, n * 3);
});

test("nothing is started on a track that is already detached", () => {
  const { inst, marquees, layout } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  a.attached = false; // swapped out before the observer fired
  layout();
  assert.equal(marquees.length, 0);
});

test("suspend pauses, resume plays, and animations created while hidden stay paused", () => {
  const { inst, marquees, layout } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  inst.suspend();
  assert.ok(live(marquees).length >= 2);
  assert.ok(live(marquees).every((x) => x.state === "paused"));
  inst.resume();
  assert.ok(live(marquees).every((x) => x.state === "running"));
  inst.suspend();
  inst.hidden = true;
  const b = inst.getDom();
  swapIn(a, b); // MM swaps immediately while hidden
  layout();
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(live(marquees).length, marqueeTracks(b).length);
  assert.ok(live(marquees).every((x) => x.state === "paused"));
  inst.hidden = false;
  inst.resume();
  assert.ok(live(marquees).every((x) => x.state === "running"));
});

test("hidden renders schedule no timers and play nothing", () => {
  const { inst, marquees, layout, clock, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  inst.suspend();
  inst.hidden = true;
  let current = a;
  for (let i = 0; i < 5; i++) {
    const next = inst.getDom();
    swapIn(current, next);
    layout();
    inst.notificationReceived("MODULE_DOM_UPDATED");
    tick(3000);
    current = next;
  }
  assert.equal(clock.timers.size, 0);
  assert.equal(live(marquees).length, marqueeTracks(current).length);
  assert.ok(live(marquees).every((x) => x.state === "paused" && x.track.isConnected));
});

test("suspend stops a pending poll", () => {
  const { inst, clock, layout } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  inst.getDom(); // leaves a pending poll for the never-attached tree
  assert.ok(clock.timers.size >= 1);
  inst.suspend();
  assert.equal(clock.timers.size, 0);
});

test("dropped resume(): a render while MM reports the module visible plays the animations", () => {
  const { inst, marquees, layout } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  inst.suspend();
  inst.hidden = false; // MM started showing the module; its resume() call was then dropped
  const b = inst.getDom();
  swapIn(a, b);
  layout();
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(inst.suspended, false);
  assert.ok(live(marquees).length >= 2);
  assert.ok(live(marquees).every((x) => x.state === "running" && x.track.isConnected));
});

test("resume plays survivors left on screen by a dropped swap", () => {
  const { inst, marquees, layout, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const n = live(marquees).length;
  inst.getDom(); // swap dropped (module hidden within the fade)
  tick(200);
  inst.suspend();
  inst.hidden = true;
  assert.ok(live(marquees).every((x) => x.state === "paused"));
  inst.hidden = false;
  inst.resume();
  assert.equal(live(marquees).length, n);
  assert.ok(live(marquees).every((x) => x.state === "running"));
});

test("the previous render ResizeObserver is disconnected on every getDom()", () => {
  const { inst, observers } = setup();
  inst.getDom();
  inst.getDom();
  inst.getDom();
  assert.equal(observers.length, 3);
  assert.ok(observers.slice(0, 2).every((o) => o.disconnected));
  assert.ok(!observers[2].disconnected);
});

test("a throwing animation cancel is contained", () => {
  const { inst, marquees, layout, warnings } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  marquees[0].cancel = () => {
    throw new Error("boom");
  };
  const b = inst.getDom();
  swapIn(a, b);
  layout();
  assert.doesNotThrow(() => inst.notificationReceived("MODULE_DOM_UPDATED"));
  assert.ok(warnings.some((w) => /Failed to cancel marquee/.test(w)));
  assert.ok(inst.marqueeAnims.every((e) => e.track.isConnected));
});

test("suspend/resume toggles the CSS pause class on the module wrapper", () => {
  const { inst, moduleWrapper } = setup();
  inst.suspend();
  assert.ok(moduleWrapper.classes.has("glass-calendar-suspended"));
  inst.resume();
  assert.ok(!moduleWrapper.classes.has("glass-calendar-suspended"));
  inst.suspend();
  inst.hidden = false; // dropped resume: the next update clears the flag and the class
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.ok(!moduleWrapper.classes.has("glass-calendar-suspended"));
});

test("two instances are independent", () => {
  const A = setup();
  const B = setup();
  const a1 = A.inst.getDom();
  const b1 = B.inst.getDom();
  swapIn(null, a1);
  swapIn(null, b1);
  A.layout();
  B.layout();
  const nB = live(B.marquees).length;
  assert.ok(nB >= 2);
  A.inst.suspend();
  assert.ok(live(A.marquees).every((x) => x.state === "paused"));
  assert.ok(live(B.marquees).every((x) => x.state === "running"));
  assert.equal(B.inst.suspended, false);
  // Re-render A repeatedly; B animations and tracking stay untouched.
  let cur = a1;
  for (let i = 0; i < 4; i++) {
    const next = A.inst.getDom();
    swapIn(cur, next);
    A.layout();
    A.inst.notificationReceived("MODULE_DOM_UPDATED");
    cur = next;
  }
  assert.equal(live(B.marquees).length, nB);
  assert.equal(B.inst.marqueeAnims.length, nB);
  assert.equal(live(A.marquees).length, marqueeTracks(cur).length);
  assert.notEqual(A.inst.marqueeAnims, B.inst.marqueeAnims);
});
