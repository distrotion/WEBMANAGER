'use strict';
// One deploy per site at a time — shared by the manual "Pull & Deploy" button,
// the CI/CD watcher, and rollback. Without a shared lock these race on the same
// working tree: `git reset --hard` from one while `npm install` writes from the
// other leaves a half-updated repo that neither side reports as broken.
//
// The lock is in memory and is released in the job's `.finally`, so it survives
// only as long as the job. That is correct, but it used to be INVISIBLE: a job
// that never settled held the lock forever, every later deploy answered 409, and
// the panel showed nothing at all — the only cure was restarting the manager.
// So the state is now readable (the site page shows who is deploying and since
// when) and an admin can force it open. runner.js's timeout means a stuck job
// should no longer happen; forcing is the escape hatch for when it does anyway.
const locks = new Map(); // site id -> { who, since }

function acquire(siteId, who) {
  const id = Number(siteId);
  if (locks.has(id)) return null;
  const held = { who, since: Date.now() };
  locks.set(id, held);
  return () => {
    // only the holder may release (a late callback must not free someone else's
    // lock — including one taken after this lock was forced open)
    if (locks.get(id) === held) locks.delete(id);
  };
}

function held(siteId) {
  return locks.get(Number(siteId)) || null;
}

// Break the lock by hand. Deliberately NOT automatic on a timer: if the original
// job is genuinely still writing the working tree, letting a second one in is
// exactly the corruption this lock exists to prevent. A human who can see how
// long it has been held decides.
function forceRelease(siteId) {
  const id = Number(siteId);
  const was = locks.get(id) || null;
  locks.delete(id);
  return was;
}

// Every site currently deploying, as { [siteId]: {who, since} } — one query for
// the site list instead of one call per row.
function allHeld() {
  const out = {};
  for (const [id, v] of locks) out[id] = { who: v.who, since: v.since };
  return out;
}

module.exports = { acquire, held, forceRelease, allHeld };
