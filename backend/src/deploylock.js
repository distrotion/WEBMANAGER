'use strict';
// One deploy per site at a time — shared by the manual "Pull & Deploy" button,
// the CI/CD watcher, and rollback. Without a shared lock these race on the same
// working tree: `git reset --hard` from one while `npm install` writes from the
// other leaves a half-updated repo that neither side reports as broken.
const locks = new Map(); // site id -> { who, since }

function acquire(siteId, who) {
  const id = Number(siteId);
  if (locks.has(id)) return null;
  const held = { who, since: Date.now() };
  locks.set(id, held);
  return () => {
    // only the holder may release (a late callback must not free someone else's lock)
    if (locks.get(id) === held) locks.delete(id);
  };
}

function held(siteId) {
  return locks.get(Number(siteId)) || null;
}

module.exports = { acquire, held };
