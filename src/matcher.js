"use strict";

// NamedSites rule matcher — pure functions, no browser APIs.
// Shared by the background event page, the options page and the unit tests.
//
// Rule format (browser.storage.local, key "rules"):
//   { id: "uuid", type: "domain" | "glob", pattern: string,
//     prefix: string, enabled: boolean }
//
// Matching semantics:
//   domain — the tab hostname equals the pattern or is a subdomain of it
//            (case-insensitive; a leading "*." in the pattern is ignored,
//            as is a trailing dot).
//   glob   — the full URL matches a wildcard pattern where "*" stands for
//            any sequence of characters (case-sensitive, anchored at both
//            ends; all other characters are literal).
// The first enabled, valid rule in list order wins.

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Lowercase, drop a leading "*." and any trailing dots.
function normalizeDomainPattern(pattern) {
  let p = String(pattern).trim().toLowerCase();
  if (p.startsWith("*.")) {
    p = p.slice(2);
  }
  while (p.endsWith(".")) {
    p = p.slice(0, -1);
  }
  return p;
}

// A hostname: dot-separated labels of letters/digits/hyphens (no leading or
// trailing hyphen per label). Single-label hosts such as "localhost" and
// IPv4 addresses are allowed.
function isValidDomainPattern(pattern) {
  if (pattern === "") {
    return false;
  }
  return pattern.split(".").every((label) => DOMAIN_LABEL_RE.test(label));
}

// Compile a glob ("*" = any sequence) into an anchored RegExp.
// Every character except "*" is escaped, so regex metacharacters are literal.
function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

// Normalize a user-entered prefix for use as windows.update titlePreface:
// trim surrounding whitespace, append exactly one trailing space.
// "RC:" -> "RC: ", "  RC:  " -> "RC: ", "" / whitespace-only -> "".
function normalizePrefix(prefix) {
  const text = typeof prefix === "string" ? prefix.trim() : "";
  return text === "" ? "" : text + " ";
}

// Validate a rule object. Returns { ok: true } or { ok: false, error }.
// Used by the options UI before saving and covered by the unit tests.
// "enabled" may be omitted (treated as enabled); "id" is not validated.
function validateRule(rule) {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
    return { ok: false, error: "Rule must be an object." };
  }
  if (rule.type !== "domain" && rule.type !== "glob") {
    return { ok: false, error: 'Rule type must be "domain" or "glob".' };
  }
  const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
  if (pattern === "") {
    return { ok: false, error: "Pattern must not be empty." };
  }
  if (
    rule.type === "domain" &&
    !isValidDomainPattern(normalizeDomainPattern(pattern))
  ) {
    return {
      ok: false,
      error:
        "Domain pattern must be a hostname like rc.contentai.ru (no scheme, path or spaces).",
    };
  }
  const prefix = typeof rule.prefix === "string" ? rule.prefix.trim() : "";
  if (prefix === "") {
    return { ok: false, error: "Prefix must not be empty." };
  }
  if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
    return { ok: false, error: '"enabled" must be a boolean.' };
  }
  return { ok: true };
}

// Return the first enabled, valid rule matching the URL, or null.
// Never throws on malformed input: bad URLs and bad rules are skipped.
function matchUrl(url, rules) {
  if (typeof url !== "string" || url === "" || !Array.isArray(rules)) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object" || rule.enabled === false) {
      continue;
    }
    if (!validateRule(rule).ok) {
      continue;
    }
    if (rule.type === "domain") {
      const pattern = normalizeDomainPattern(rule.pattern);
      if (hostname === pattern || hostname.endsWith("." + pattern)) {
        return rule;
      }
    } else if (globToRegExp(rule.pattern.trim()).test(url)) {
      return rule;
    }
  }
  return null;
}

// Export for Node (unit tests). In the browser this file is loaded as a
// classic script and the functions above become globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { matchUrl, normalizePrefix, validateRule };
}