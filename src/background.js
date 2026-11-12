"use strict";

// NamedSites background engine (MV3 event page, classic script).
//
// Prefixes each browser window's title via browser.windows.update
// ({titlePreface}) according to rules matching the ACTIVE tab's URL.
// Rules live in browser.storage.local (key "rules") and are written by the
// options page; we react via storage.onChanged — no runtime messaging.
//
// Event-page constraints (Firefox suspends the page after ~30s idle):
//   - All listeners are registered synchronously at top level so they can
//     wake the page.
//   - No in-memory state is trusted across suspensions: rules are re-read
//     from storage on every recompute. The "last applied preface" cache is
//     only an optimization — an empty cache just means we apply again
//     (windows.update is idempotent). titlePreface itself lives on the
//     window and survives suspension, but NOT a browser restart;
//     runtime.onStartup performs a full resync to cover that.
//
// matcher.js is loaded before this script (manifest background.scripts)
// and provides the globals matchUrl / normalizePrefix / validateRule.

// --- In-memory state (pure optimizations, rebuildable after suspension) ---

// windowId -> last successfully applied titlePreface string.
const lastAppliedPreface = new Map();

// windowId -> tail of that window's recompute promise chain. Serializing
// per window ensures interleaved events cannot apply stale prefixes out of
// order: each task reads fresh state only after the previous one finished.
const recomputeChains = new Map();

// --- Storage helpers ---

// Read the rule list fresh from storage on every recompute (lists are
// small). Never cached, so suspension can never leave us with stale rules.
async function readRules() {
  const data = await browser.storage.local.get("rules");
  return Array.isArray(data.rules) ? data.rules : [];
}

// Seed the example rule on first install. Temporary add-on reloads also
// report reason "install" while storage survives them, so the "rules" key
// being present (even as an empty list) must never be overwritten.
async function seedDefaultRules() {
  const data = await browser.storage.local.get(["rules", "schemaVersion"]);
  const updates = {};
  if (data.rules === undefined) {
    updates.rules = [
      {
        id: crypto.randomUUID(),
        type: "domain",
        pattern: "rc.contentai.ru",
        prefix: "RC:",
        enabled: true,
      },
    ];
  }
  if (data.schemaVersion === undefined) {
    updates.schemaVersion = 1;
  }
  if (Object.keys(updates).length > 0) {
    await browser.storage.local.set(updates);
  }
}

// --- Core recompute ---

// Recompute and apply the preface for one window from its active tab.
// Never throws: every browser API call that can reject is guarded.
async function recomputeWindow(windowId) {
  try {
    const tabs = await browser.tabs.query({ active: true, windowId });
    const tab = tabs[0];
    // No visible active tab: the window is already closed, or it is a
    // private window invisible to us (extensions are disallowed in private
    // windows unless the user grants access). Nothing to do either way.
    if (!tab) {
      return;
    }
    if (
      tab.incognito &&
      !(await browser.extension.isAllowedIncognitoAccess())
    ) {
      return;
    }

    const rules = await readRules();
    // tab.url may be undefined on privileged pages -> matchUrl returns null.
    const rule = matchUrl(tab.url, rules);
    const desired = rule ? normalizePrefix(rule.prefix) : "";

    // Skip redundant updates. "" clears the preface; omitting the property
    // would leave it unchanged, so always pass it explicitly.
    if (lastAppliedPreface.get(windowId) === desired) {
      return;
    }
    try {
      await browser.windows.update(windowId, { titlePreface: desired });
      lastAppliedPreface.set(windowId, desired);
    } catch (error) {
      // e.g. "Invalid window ID" for a window closed between query and
      // update. Drop the cache entry so a later event retries instead of
      // trusting a value that was never applied.
      lastAppliedPreface.delete(windowId);
      console.warn("NamedSites: windows.update failed", windowId, error);
    }
  } catch (error) {
    console.warn("NamedSites: recompute failed", windowId, error);
  }
}

// Queue a recompute for a window, serialized after any in-flight one.
function enqueueRecompute(windowId) {
  const previous = recomputeChains.get(windowId) || Promise.resolve();
  const task = previous
    .then(() => recomputeWindow(windowId))
    .catch((error) => {
      // Safety net: recomputeWindow guards itself, but a rejection must
      // never escape the chain as an unhandled promise rejection.
      console.warn("NamedSites: recompute task failed", windowId, error);
    });
  recomputeChains.set(windowId, task);
  // Forget the chain once it settles and nothing newer was queued, so the
  // map does not accumulate entries over a long session.
  task.then(() => {
    if (recomputeChains.get(windowId) === task) {
      recomputeChains.delete(windowId);
    }
  });
}

// Full resync: recompute every window (startup, install, rules changes,
// tab attached to another window).
async function resyncAllWindows() {
  try {
    const windows = await browser.windows.getAll();
    const incognitoAllowed =
      await browser.extension.isAllowedIncognitoAccess();
    for (const window of windows) {
      if (window.incognito && !incognitoAllowed) {
        continue;
      }
      enqueueRecompute(window.id);
    }
  } catch (error) {
    console.warn("NamedSites: full resync failed", error);
  }
}

// --- Event wiring (all listeners registered synchronously at top level) ---

browser.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    // The activation payload carries no URL; fetch the tab itself. This
    // also rejects for tabs invisible to us (private windows without
    // access), which we then silently skip. The recompute re-queries the
    // window's active tab, so it always applies to current state.
    const tab = await browser.tabs.get(activeInfo.tabId);
    enqueueRecompute(tab.windowId);
  } catch {
    // Tab already closed or invisible; nothing to do.
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only a URL change on the active tab can affect its window's preface.
  if (changeInfo.url === undefined || !tab.active) {
    return;
  }
  enqueueRecompute(tab.windowId);
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // The window may have a new active tab now; recompute it. If the window
  // itself is closing, the query finds nothing and onRemoved cleans up.
  enqueueRecompute(removeInfo.windowId);
});

browser.tabs.onAttached.addListener(() => {
  // A tab moved between windows; both the source and the target window may
  // need updating. Simplest correct approach: resync all windows.
  resyncAllWindows();
});

browser.windows.onCreated.addListener((window) => {
  // Private windows without access are invisible here; recomputeWindow
  // skips them via the active-tab query / incognito check.
  enqueueRecompute(window.id);
});

browser.windows.onFocusChanged.addListener((windowId) => {
  // WINDOW_ID_NONE (-1) arrives when all windows lose focus (and on some
  // platforms immediately before every window switch); not a real window.
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    return;
  }
  enqueueRecompute(windowId);
});

browser.windows.onRemoved.addListener((windowId) => {
  lastAppliedPreface.delete(windowId);
});

browser.runtime.onStartup.addListener(() => {
  // titlePreface does not survive a browser restart; re-apply everywhere.
  resyncAllWindows();
});

browser.runtime.onInstalled.addListener(async (details) => {
  try {
    if (details.reason === "install") {
      await seedDefaultRules();
    }
  } catch (error) {
    console.warn("NamedSites: seeding default rules failed", error);
  }
  resyncAllWindows();
});

browser.storage.onChanged.addListener((changes, areaName) => {
  // The options page writes rules; react instantly, no messaging needed.
  if (areaName === "local" && changes.rules) {
    resyncAllWindows();
  }
});
