const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

// node_helper.js does `require("node_helper")`, which only resolves inside a
// real MagicMirror install. Redirect that one bare specifier to a minimal
// stub (NodeHelper.create just returns the object it's given) so the file
// can be required standalone in this test.
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "node_helper") {
    return path.join(__dirname, "stubs", "fake-node_helper.js");
  }
  return originalResolveFilename.call(this, request, ...rest);
};

const helperModule = require("../node_helper.js");

const makeHelper = () => Object.create(helperModule);

test("fetchCalendars: a fatal error after monthOffset/identifier are computed still sends GLASSCALENDAR_ERROR (no ReferenceError)", async () => {
  const helper = makeHelper();
  const sent = [];
  helper.sendSocketNotification = (notification, payload) => {
    sent.push({ notification, payload });
    if (notification === "GLASSCALENDAR_EVENTS") {
      throw new Error("boom downstream");
    }
  };
  helper.fetchIcs = async () => [];

  await assert.doesNotReject(() =>
    helper.fetchCalendars({
      identifier: "cal-1",
      monthOffset: 2,
      icalSources: [{ url: "https://calendar.google.com/private-abc123/basic.ics" }]
    })
  );

  const errorCall = sent.find((s) => s.notification === "GLASSCALENDAR_ERROR");
  assert.ok(errorCall, "the fatal catch should send GLASSCALENDAR_ERROR");
  assert.equal(errorCall.payload.identifier, "cal-1");
  assert.equal(errorCall.payload.monthOffset, 2);
});

test("fetchCalendars: a per-source fetch error never leaks the raw private ICS URL to the front end", async () => {
  const helper = makeHelper();
  const sent = [];
  helper.sendSocketNotification = (notification, payload) => {
    sent.push({ notification, payload });
  };
  helper.fetchIcs = async () => {
    throw new Error("HTTP 404");
  };

  await helper.fetchCalendars({
    identifier: "cal-1",
    monthOffset: 0,
    icalSources: [
      {
        url: "https://calendar.google.com/calendar/ical/private-verysecrettoken1234/basic.ics",
        name: "Work"
      }
    ]
  });

  const errorCall = sent.find((s) => s.notification === "GLASSCALENDAR_ERROR");
  assert.ok(errorCall);
  assert.ok(
    !errorCall.payload.url.includes("verysecrettoken1234"),
    `raw private ICS URL leaked to the front end: ${errorCall.payload.url}`
  );
});
