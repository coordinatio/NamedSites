"use strict";

// NamedSites options page.
// Talks to the background engine only through browser.storage.local:
// every mutation writes the whole "rules" array plus schemaVersion: 1,
// and the background applies changes via storage.onChanged. No messaging.
//
// All user data is rendered through textContent / createElement / input.value.
// innerHTML is never used. Validation comes from the shared matcher.js
// (validateRule, normalizePrefix are globals loaded before this script).

(() => {
  const SCHEMA_VERSION = 1;

  const DOMAIN_HINT =
    "Hostname, e.g. rc.contentai.ru — matches the domain and all its subdomains.";
  const GLOB_HINT =
    "Wildcards over the full URL, e.g. https://*.contentai.ru/* — * matches any characters, case-sensitive.";
  const PREFIX_HINT =
    "“RC:” is applied as “RC: ” (a trailing space is added automatically).";
  const SAMPLE_TITLE = "Example page — Mozilla Firefox";

  const state = {
    rules: [],            // last known persisted rules (source of truth for the UI)
    drafts: new Map(),    // rule id -> { type, pattern, prefix } unsaved field edits
    errors: new Map(),    // rule id -> validation error shown after a failed Save
  };

  // ---------- DOM references ----------

  const listEl = document.getElementById("rules-list");
  const emptyEl = document.getElementById("empty-state");
  const countEl = document.getElementById("rule-count");
  const previewTitleEl = document.getElementById("preview-title");
  const previewCaptionEl = document.getElementById("preview-caption");
  const privateStatusEl = document.getElementById("private-status");

  const addForm = document.getElementById("add-form");
  const addType = document.getElementById("add-type");
  const addPattern = document.getElementById("add-pattern");
  const addPrefix = document.getElementById("add-prefix");
  const addTypeHint = document.getElementById("add-type-hint");
  const addWarn = document.getElementById("add-warn");
  const addError = document.getElementById("add-error");
  let addErrorShown = false;

  const toastEl = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-msg");
  const toastAction = document.getElementById("toast-action");
  const toastClose = document.getElementById("toast-close");
  let toastTimer = 0;
  let toastOnAction = null;

  const flashTimers = new Map(); // rule id -> timeout id for the "Saved" chip

  // ---------- tiny DOM helpers (no innerHTML anywhere) ----------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "hidden") node.hidden = Boolean(value);
      else if (key === "disabled") node.disabled = Boolean(value);
      else if (key === "checked") node.checked = Boolean(value);
      else if (key === "value") node.value = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child != null) node.append(child);
    }
    return node;
  }

  const ICON_PATHS = {
    up: "M6 14l6-6 6 6",
    down: "M6 10l6 6 6-6",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  };

  function icon(name) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", ICON_PATHS[name]);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function iconButton(field, iconName, label, extraClass) {
    return el(
      "button",
      {
        type: "button",
        class: "icon-btn" + (extraClass ? " " + extraClass : ""),
        "data-field": field,
        "aria-label": label,
        title: label,
      },
      icon(iconName)
    );
  }

  // ---------- rule helpers ----------

  function sanitizeRules(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const r of value) {
      if (
        r === null ||
        typeof r !== "object" ||
        typeof r.id !== "string" ||
        (r.type !== "domain" && r.type !== "glob") ||
        typeof r.pattern !== "string" ||
        typeof r.prefix !== "string" ||
        (r.enabled !== undefined && typeof r.enabled !== "boolean")
      ) {
        continue;
      }
      if (seen.has(r.id)) continue; // ignore duplicate ids from external data
      seen.add(r.id);
      // Normalize like the matcher: a missing "enabled" means enabled.
      out.push({ ...r, enabled: r.enabled !== false });
    }
    return out;
  }

  function findRule(id) {
    return state.rules.find((r) => r.id === id) || null;
  }

  function effectiveRule(rule) {
    const draft = state.drafts.get(rule.id);
    return draft ? { ...rule, ...draft } : rule;
  }

  // Candidate for validation/saving: trimmed pattern and prefix.
  function candidateOf(rule, fields) {
    return {
      id: rule.id,
      type: fields.type,
      pattern: fields.pattern.trim(),
      prefix: fields.prefix.trim(),
      enabled: rule.enabled,
    };
  }

  // Duplicate detection key. Domains: case-insensitive, leading "*." and
  // trailing dots ignored (same semantics as the matcher). Globs: exact,
  // trimmed.
  function ruleKey(type, pattern) {
    if (type === "domain") {
      // Reuse the matcher's normalization so duplicate detection can't drift.
      return "domain:" + normalizeDomainPattern(pattern);
    }
    return "glob:" + pattern.trim();
  }

  function findDuplicate(rule) {
    const key = ruleKey(rule.type, rule.pattern);
    if (key === "domain:" || key === "glob:") return null;
    for (let i = 0; i < state.rules.length; i++) {
      const other = state.rules[i];
      if (other.id !== rule.id && ruleKey(other.type, other.pattern) === key) {
        return { index: i, type: other.type };
      }
    }
    return null;
  }

  function duplicateText(dup) {
    return (
      "Same " + dup.type + " pattern as rule #" + (dup.index + 1) +
      ". The first enabled rule in the list wins."
    );
  }

  function prefixHintFor(prefix) {
    const trimmed = prefix.trim();
    if (trimmed === "") return PREFIX_HINT;
    return (
      "“" + trimmed + "” is applied as “" + normalizePrefix(trimmed) +
      "” (a trailing space is added automatically)."
    );
  }

  function patternPlaceholder(type) {
    return type === "domain" ? "rc.contentai.ru" : "https://*.contentai.ru/*";
  }

  // ---------- storage ----------

  // Optimistic write: update the UI immediately, roll back on failure.
  // Resolves to true on success.
  async function persist(nextRules) {
    const prev = state.rules;
    state.rules = nextRules;
    render();
    try {
      await browser.storage.local.set({
        rules: nextRules,
        schemaVersion: SCHEMA_VERSION,
      });
      return true;
    } catch (err) {
      state.rules = prev;
      render();
      showToast("Couldn’t save changes: " + errorMessage(err), {
        kind: "error",
        sticky: true,
      });
      return false;
    }
  }

  function errorMessage(err) {
    return err && err.message ? err.message : String(err);
  }

  // ---------- rendering ----------

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !listEl.contains(active)) return null;
    const row = active.closest("[data-id]");
    const field = active.dataset ? active.dataset.field : null;
    if (!row || !field) return null;
    const snap = { id: row.dataset.id, field };
    if (active instanceof HTMLInputElement && active.type === "text") {
      snap.start = active.selectionStart;
      snap.end = active.selectionEnd;
    }
    return snap;
  }

  function restoreFocus(snap) {
    if (!snap) return;
    const row = listEl.querySelector('[data-id="' + CSS.escape(snap.id) + '"]');
    let target = row && row.querySelector('[data-field="' + snap.field + '"]');
    if (target && target.disabled && snap.field === "save") {
      // After Save the button disables; keep focus in the row, not the add form.
      target = row.querySelector('[data-field="pattern"]');
    }
    if (target && target.disabled && (snap.field === "up" || snap.field === "down")) {
      // Moved to an end: keep focus on the still-usable direction button.
      target = row.querySelector(
        '[data-field="' + (snap.field === "up" ? "down" : "up") + '"]'
      );
    }
    if (!target || target.disabled) {
      addPattern.focus({ preventScroll: true });
      return;
    }
    target.focus({ preventScroll: true });
    if (snap.start != null && target.setSelectionRange) {
      target.setSelectionRange(snap.start, snap.end);
    }
  }

  function render() {
    const focusSnap = captureFocus();

    // Drop drafts/errors of rules that no longer exist.
    const ids = new Set(state.rules.map((r) => r.id));
    for (const id of state.drafts.keys()) if (!ids.has(id)) state.drafts.delete(id);
    for (const id of state.errors.keys()) if (!ids.has(id)) state.errors.delete(id);
    for (const [id, timer] of flashTimers) {
      clearTimeout(timer);
      flashTimers.delete(id);
    }

    countEl.textContent = String(state.rules.length);
    emptyEl.hidden = state.rules.length !== 0;

    const rows = state.rules.map((rule, index) => createRow(rule, index));
    listEl.replaceChildren(...rows);

    updatePreview();
    updateFormMeta();
    restoreFocus(focusSnap);
  }

  function createRow(rule, index) {
    const eff = effectiveRule(rule);
    const n = index + 1;
    const id = rule.id;

    const num = el("span", {
      class: "rule-num",
      "aria-hidden": "true",
      text: String(n),
    });

    const toggle = el("input", {
      type: "checkbox",
      class: "switch-input",
      "data-field": "enabled",
      checked: rule.enabled,
      "aria-label": "Enable rule " + n,
      title: "Enable rule " + n,
    });

    const typeSelect = el(
      "select",
      {
        id: "rule-" + id + "-type",
        "data-field": "type",
        value: eff.type,
      },
      el("option", { value: "domain", text: "Domain" }),
      el("option", { value: "glob", text: "Glob" })
    );
    typeSelect.value = eff.type;

    const patternInput = el("input", {
      type: "text",
      id: "rule-" + id + "-pattern",
      "data-field": "pattern",
      value: eff.pattern,
      autocomplete: "off",
      spellcheck: "false",
      placeholder: patternPlaceholder(eff.type),
    });

    const prefixInput = el("input", {
      type: "text",
      id: "rule-" + id + "-prefix",
      "data-field": "prefix",
      value: eff.prefix,
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "RC:",
    });

    const actions = el(
      "div",
      { class: "row-actions" },
      iconButton("up", "up", "Move rule " + n + " up"),
      iconButton("down", "down", "Move rule " + n + " down"),
      iconButton("delete", "trash", "Delete rule " + n, "danger"),
      el("button", {
        type: "button",
        class: "btn primary save-btn",
        "data-field": "save",
        text: "Save",
        title: "Save changes (Enter)",
      })
    );
    const upBtn = actions.querySelector('[data-field="up"]');
    const downBtn = actions.querySelector('[data-field="down"]');
    upBtn.disabled = index === 0;
    downBtn.disabled = index === state.rules.length - 1;

    const main = el(
      "div",
      { class: "row-main" },
      num,
      el("span", { class: "switch" }, toggle),
      el(
        "div",
        { class: "field field-type" },
        el("label", { class: "sr-only", for: "rule-" + id + "-type", text: "Type" }),
        typeSelect
      ),
      el(
        "div",
        { class: "field field-pattern" },
        el("label", { class: "sr-only", for: "rule-" + id + "-pattern", text: "Pattern" }),
        patternInput
      ),
      el(
        "div",
        { class: "field field-prefix" },
        el("label", { class: "sr-only", for: "rule-" + id + "-prefix", text: "Prefix" }),
        prefixInput
      ),
      actions
    );

    const notes = el(
      "div",
      { class: "row-notes" },
      el("p", { class: "hint type-hint" }),
      el("p", { class: "hint prefix-hint" }),
      el("p", { class: "notice warn row-warn", role: "status", hidden: true }),
      el("p", { class: "notice error row-error", role: "alert", hidden: true }),
      el(
        "div",
        { class: "editbar", hidden: true },
        el("span", { class: "dirty-chip", text: "Unsaved changes" }),
        el("button", {
          type: "button",
          class: "link-btn",
          "data-field": "discard",
          text: "Discard",
          title: "Discard unsaved edits (Esc)",
        })
      )
    );

    const row = el(
      "li",
      {
        class: "rule-row",
        "data-id": id,
        dataset: { disabled: String(!rule.enabled) },
      },
      main,
      notes
    );
    updateRowMeta(row, rule);
    return row;
  }

  // Refresh everything in a row that depends on the current field values,
  // without rebuilding the row (keeps caret and focus intact while typing).
  function updateRowMeta(row, rule) {
    const eff = effectiveRule(rule);
    const dirty = state.drafts.has(rule.id);

    row.dataset.dirty = String(dirty);
    row.querySelector('[data-field="save"]').disabled = !dirty;
    row.querySelector(".editbar").hidden = !dirty;

    const patternInput = row.querySelector('[data-field="pattern"]');
    patternInput.placeholder = patternPlaceholder(eff.type);
    row.querySelector(".type-hint").textContent =
      eff.type === "domain" ? DOMAIN_HINT : GLOB_HINT;
    row.querySelector(".prefix-hint").textContent = prefixHintFor(eff.prefix);

    const dup = findDuplicate(eff);
    const warnEl = row.querySelector(".row-warn");
    warnEl.hidden = !dup;
    warnEl.textContent = dup ? duplicateText(dup) : "";

    const errorMsg = state.errors.get(rule.id);
    const errorEl = row.querySelector(".row-error");
    errorEl.hidden = !errorMsg;
    errorEl.textContent = errorMsg || "";
  }

  function updatePreview() {
    const first = state.rules.find((r) => r.enabled && validateRule(r).ok);
    if (first) {
      const preface = normalizePrefix(first.prefix);
      previewTitleEl.replaceChildren(el("strong", { text: preface }), SAMPLE_TITLE);
      previewCaptionEl.textContent =
        "Example window title with rule #" + (state.rules.indexOf(first) + 1) + " applied.";
    } else {
      previewTitleEl.replaceChildren(SAMPLE_TITLE);
      previewCaptionEl.textContent = "No enabled rules — window titles stay unchanged.";
    }
  }

  function flashRow(id, kind) {
    const row = listEl.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (!row) return;
    row.classList.add(kind === "new" ? "flash-new" : "flash-success");
    if (kind !== "new") {
      const notes = row.querySelector(".row-notes");
      const chip = el("span", { class: "save-flash", text: "Saved ✓" });
      notes.prepend(chip);
      const timer = setTimeout(() => {
        chip.remove();
        row.classList.remove("flash-success");
        flashTimers.delete(id);
      }, 1800);
      flashTimers.set(id, timer);
    } else {
      const timer = setTimeout(() => {
        row.classList.remove("flash-new");
        flashTimers.delete(id);
      }, 1800);
      flashTimers.set(id, timer);
    }
  }

  // ---------- row interactions ----------

  function readRowFields(row) {
    return {
      type: row.querySelector('[data-field="type"]').value,
      pattern: row.querySelector('[data-field="pattern"]').value,
      prefix: row.querySelector('[data-field="prefix"]').value,
    };
  }

  function onFieldInput(row) {
    const rule = findRule(row.dataset.id);
    if (!rule) return;
    const fields = readRowFields(row);
    const dirty =
      fields.type !== rule.type ||
      fields.pattern !== rule.pattern ||
      fields.prefix !== rule.prefix;
    if (dirty) state.drafts.set(rule.id, fields);
    else state.drafts.delete(rule.id);

    // Once a Save attempt has shown an error, keep it live-updated.
    if (state.errors.has(rule.id)) {
      const result = validateRule(candidateOf(rule, fields));
      if (result.ok) state.errors.delete(rule.id);
      else state.errors.set(rule.id, result.error);
    }
    updateRowMeta(row, rule);
  }

  async function onToggle(row, checked) {
    const rule = findRule(row.dataset.id);
    if (!rule || rule.enabled === checked) return;
    await persist(
      state.rules.map((r) => (r.id === rule.id ? { ...r, enabled: checked } : r))
    );
  }

  async function onMove(row, direction) {
    const index = state.rules.findIndex((r) => r.id === row.dataset.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= state.rules.length) return;
    const next = state.rules.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    await persist(next);
  }

  async function onDelete(row) {
    const index = state.rules.findIndex((r) => r.id === row.dataset.id);
    if (index < 0) return;
    const removed = state.rules[index];
    const draftBackup = state.drafts.get(removed.id);
    const errorBackup = state.errors.get(removed.id);
    state.drafts.delete(removed.id);
    state.errors.delete(removed.id);
    const ok = await persist(state.rules.filter((r) => r.id !== removed.id));
    if (!ok) {
      // Write failed: restore the rule's unsaved edits (mirrors onSave).
      if (draftBackup !== undefined) state.drafts.set(removed.id, draftBackup);
      if (errorBackup !== undefined) state.errors.set(removed.id, errorBackup);
      render();
      return;
    }
    showToast("Deleted rule #" + (index + 1) + " (“" + removed.pattern + "”).", {
      actionLabel: "Undo",
      onAction: async () => {
        if (state.rules.some((r) => r.id === removed.id)) return;
        const next = state.rules.slice();
        next.splice(Math.min(index, next.length), 0, removed);
        if (await persist(next)) flashRow(removed.id, "new");
      },
    });
  }

  async function onSave(row) {
    const rule = findRule(row.dataset.id);
    if (!rule) return;
    const fields = readRowFields(row);
    const candidate = candidateOf(rule, fields);
    const result = validateRule(candidate);
    if (!result.ok) {
      state.errors.set(rule.id, result.error);
      updateRowMeta(row, rule);
      const field = /prefix/i.test(result.error) ? "prefix" : "pattern";
      row.querySelector('[data-field="' + field + '"]').focus();
      return;
    }
    state.errors.delete(rule.id);
    const draftBackup = state.drafts.get(rule.id);
    state.drafts.delete(rule.id);
    const ok = await persist(
      state.rules.map((r) =>
        r.id === rule.id
          ? { ...r, type: candidate.type, pattern: candidate.pattern, prefix: candidate.prefix }
          : r
      )
    );
    if (ok) {
      flashRow(rule.id, "success");
    } else if (draftBackup) {
      // Write failed: give the user their unsaved edits back.
      state.drafts.set(rule.id, draftBackup);
      render();
    }
  }

  function onDiscard(row) {
    const rule = findRule(row.dataset.id);
    if (!rule) return;
    state.drafts.delete(rule.id);
    state.errors.delete(rule.id);
    render();
  }

  // ---------- add form ----------

  function addCandidate() {
    return {
      id: "",
      type: addType.value,
      pattern: addPattern.value.trim(),
      prefix: addPrefix.value.trim(),
      enabled: true,
    };
  }

  function updateFormMeta() {
    const type = addType.value;
    addTypeHint.textContent = type === "domain" ? DOMAIN_HINT : GLOB_HINT;
    addPattern.placeholder = patternPlaceholder(type);

    const candidate = addCandidate();
    const dup = candidate.pattern !== "" ? findDuplicate(candidate) : null;
    addWarn.hidden = !dup;
    addWarn.textContent = dup
      ? "Heads up: " + duplicateText(dup) + " You can still add this rule."
      : "";

    if (addErrorShown) {
      const result = validateRule(candidate);
      addErrorShown = !result.ok;
      addError.hidden = result.ok;
      addError.textContent = result.ok ? "" : result.error;
    }
  }

  async function onAddSubmit(event) {
    event.preventDefault();
    const candidate = addCandidate();
    const result = validateRule(candidate);
    if (!result.ok) {
      addErrorShown = true;
      addError.hidden = false;
      addError.textContent = result.error;
      const field = /prefix/i.test(result.error) ? addPrefix : addPattern;
      field.focus();
      return;
    }
    addErrorShown = false;
    addError.hidden = true;
    addError.textContent = "";

    const rule = { ...candidate, id: crypto.randomUUID(), enabled: true };
    const ok = await persist([...state.rules, rule]);
    if (!ok) return;

    addForm.reset();
    updateFormMeta();
    showToast("Rule added at the bottom of the list.", { kind: "success" });
    flashRow(rule.id, "new");
    const row = listEl.querySelector('[data-id="' + CSS.escape(rule.id) + '"]');
    if (row) row.scrollIntoView({ block: "nearest" });
    addPattern.focus({ preventScroll: true });
  }

  // ---------- toast ----------

  function showToast(message, options) {
    const opts = options || {};
    clearTimeout(toastTimer);
    toastOnAction = opts.onAction || null;
    toastEl.dataset.kind = opts.kind || "info";
    toastMsg.textContent = message;
    toastAction.hidden = !opts.actionLabel;
    toastAction.textContent = opts.actionLabel || "";
    toastEl.hidden = false;
    if (!opts.sticky) {
      toastTimer = setTimeout(hideToast, opts.actionLabel ? 8000 : 4000);
    }
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
    toastOnAction = null;
  }

  // ---------- private-window status ----------

  async function updatePrivateStatus() {
    try {
      const allowed = await browser.extension.isAllowedIncognitoAccess();
      privateStatusEl.textContent = allowed
        ? "Currently: allowed."
        : "Currently: not allowed.";
      privateStatusEl.dataset.state = allowed ? "ok" : "warn";
    } catch {
      privateStatusEl.textContent = "";
    }
  }

  // ---------- event wiring (delegation: rows are rebuilt on render) ----------

  listEl.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.field === "enabled") return;
    const row = target.closest("[data-id]");
    if (row) onFieldInput(row);
  });

  listEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest("[data-id]");
    if (!row) return;
    if (target.dataset.field === "enabled") {
      onToggle(row, target.checked);
    } else if (target.dataset.field === "type") {
      onFieldInput(row);
    }
  });

  listEl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-field]");
    if (!button || button.disabled) return;
    const row = button.closest("[data-id]");
    if (!row) return;
    switch (button.dataset.field) {
      case "up": onMove(row, -1); break;
      case "down": onMove(row, 1); break;
      case "delete": onDelete(row); break;
      case "save": onSave(row); break;
      case "discard": onDiscard(row); break;
    }
  });

  listEl.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "text") return;
    const row = target.closest("[data-id]");
    if (!row) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onSave(row);
    } else if (event.key === "Escape" && state.drafts.has(row.dataset.id)) {
      event.preventDefault();
      onDiscard(row);
    }
  });

  addForm.addEventListener("submit", onAddSubmit);
  addForm.addEventListener("input", updateFormMeta);
  addForm.addEventListener("change", updateFormMeta);

  document.getElementById("use-example").addEventListener("click", () => {
    addType.value = "domain";
    addPattern.value = "rc.contentai.ru";
    addPrefix.value = "RC:";
    updateFormMeta();
    addForm.scrollIntoView({ block: "nearest" });
    addPattern.focus({ preventScroll: true });
  });

  toastClose.addEventListener("click", hideToast);
  toastAction.addEventListener("click", () => {
    const action = toastOnAction;
    hideToast();
    if (action) action();
  });

  // External changes (background seeding, another options tab): re-render,
  // preserving unsaved drafts. Our own writes compare equal and are skipped.
  if (typeof browser !== "undefined" && browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.rules) return;
      const next = sanitizeRules(changes.rules.newValue);
      if (JSON.stringify(next) === JSON.stringify(state.rules)) return;
      state.rules = next;
      render();
    });
  }

  window.addEventListener("focus", updatePrivateStatus);

  // ---------- init ----------

  async function init() {
    if (typeof browser === "undefined" || !browser.storage || !browser.storage.local) {
      render();
      showToast(
        "This page must be opened as the NamedSites options page inside Firefox.",
        { kind: "error", sticky: true }
      );
      return;
    }
    try {
      const data = await browser.storage.local.get(["rules"]);
      state.rules = sanitizeRules(data.rules);
    } catch (err) {
      state.rules = [];
      showToast("Couldn’t load saved rules: " + errorMessage(err), {
        kind: "error",
        sticky: true,
      });
    }
    render();
    updatePrivateStatus();
  }

  init();
})();