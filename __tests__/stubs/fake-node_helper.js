// Minimal stand-in for MagicMirror's real `node_helper` module, which only
// resolves inside a full MagicMirror install. `NodeHelper.create(obj)` in
// the real module returns an object with `obj` mixed in as its prototype;
// for tests it's enough to just hand back what was passed in.
module.exports = {
  create(definition) {
    return definition;
  }
};
