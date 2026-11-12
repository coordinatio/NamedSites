"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { matchUrl, normalizePrefix, validateRule } = require("../src/matcher.js");

// Rule factory with sensible defaults.
function makeRule(overrides = {}) {
  return {
    id: "r1",
    type: "domain",
    pattern: "rc.contentai.ru",
    prefix: "RC:",
    enabled: true,
    ...overrides,
  };
}

describe("normalizePrefix", () => {
  test('appends a trailing space: "RC:" -> "RC: "', () => {
    assert.equal(normalizePrefix("RC:"), "RC: ");
  });

  test("trims surrounding whitespace and adds exactly one space", () => {
    assert.equal(normalizePrefix("  RC:  "), "RC: ");
    assert.equal(normalizePrefix("RC: "), "RC: ");
  });

  test("is idempotent", () => {
    assert.equal(normalizePrefix(normalizePrefix("RC:")), "RC: ");
  });

  test("keeps inner whitespace", () => {
    assert.equal(normalizePrefix("My site:"), "My site: ");
  });

  test('empty and whitespace-only become ""', () => {
    assert.equal(normalizePrefix(""), "");
    assert.equal(normalizePrefix("   "), "");
  });

  test("non-string input becomes empty string", () => {
    assert.equal(normalizePrefix(null), "");
    assert.equal(normalizePrefix(undefined), "");
    assert.equal(normalizePrefix(42), "");
  });
});

describe("validateRule", () => {
  test("accepts a valid domain rule", () => {
    assert.deepEqual(validateRule(makeRule()), { ok: true });
  });

  test("accepts a valid glob rule", () => {
    assert.deepEqual(
      validateRule(makeRule({ type: "glob", pattern: "https://*.contentai.ru/*" })),
      { ok: true }
    );
  });

  test("accepts a rule without enabled (treated as enabled)", () => {
    const rule = makeRule();
    delete rule.enabled;
    assert.deepEqual(validateRule(rule), { ok: true });
  });

  test("rejects non-objects", () => {
    for (const bad of [null, undefined, "rule", 42, []]) {
      assert.equal(validateRule(bad).ok, false);
    }
  });

  test("rejects unknown type", () => {
    assert.equal(validateRule(makeRule({ type: "regex" })).ok, false);
    assert.equal(validateRule(makeRule({ type: "" })).ok, false);
  });

  test("rejects empty or non-string pattern", () => {
    assert.equal(validateRule(makeRule({ pattern: "" })).ok, false);
    assert.equal(validateRule(makeRule({ pattern: "   " })).ok, false);
    assert.equal(validateRule(makeRule({ pattern: 42 })).ok, false);
  });

  test("rejects domain patterns with scheme, path, spaces or inner wildcards", () => {
    for (const pattern of [
      "https://rc.contentai.ru",
      "rc.contentai.ru/mail",
      "rc contentai.ru",
      "rc.*.ru",
      "rc..ru",
      "-rc.contentai.ru",
    ]) {
      assert.equal(validateRule(makeRule({ pattern })).ok, false, pattern);
    }
  });

  test('accepts domain pattern with leading "*." and single-label hosts', () => {
    assert.equal(validateRule(makeRule({ pattern: "*.contentai.ru" })).ok, true);
    assert.equal(validateRule(makeRule({ pattern: "localhost" })).ok, true);
    assert.equal(validateRule(makeRule({ pattern: "192.168.1.1" })).ok, true);
  });

  test("rejects empty or non-string prefix", () => {
    assert.equal(validateRule(makeRule({ prefix: "" })).ok, false);
    assert.equal(validateRule(makeRule({ prefix: "   " })).ok, false);
    assert.equal(validateRule(makeRule({ prefix: null })).ok, false);
  });

  test("rejects non-boolean enabled", () => {
    assert.equal(validateRule(makeRule({ enabled: "yes" })).ok, false);
    assert.equal(validateRule(makeRule({ enabled: 1 })).ok, false);
  });

  test("error messages are non-empty strings", () => {
    const res = validateRule(makeRule({ prefix: "" }));
    assert.equal(typeof res.error, "string");
    assert.ok(res.error.length > 0);
  });
});

describe("matchUrl: domain rules", () => {
  const rules = [makeRule()];

  test("matches the exact hostname", () => {
    assert.equal(matchUrl("https://rc.contentai.ru/", rules), rules[0]);
  });

  test("matches subdomains", () => {
    assert.equal(matchUrl("https://mail.rc.contentai.ru/", rules), rules[0]);
    assert.equal(matchUrl("https://a.b.rc.contentai.ru/x", rules), rules[0]);
  });

  test("ignores port, path, query and fragment", () => {
    assert.equal(
      matchUrl("https://rc.contentai.ru:8443/mail?x=1#frag", rules),
      rules[0]
    );
  });

  test("is case-insensitive for hostname and pattern", () => {
    assert.equal(matchUrl("https://RC.ContentAI.RU/", rules), rules[0]);
    const upperPattern = makeRule({ pattern: "RC.ContentAI.RU" });
    assert.equal(matchUrl("https://rc.contentai.ru/", [upperPattern]), upperPattern);
  });

  test('accepts patterns with leading "*." and trailing dot', () => {
    const starRule = makeRule({ pattern: "*.rc.contentai.ru" });
    assert.equal(matchUrl("https://rc.contentai.ru/", [starRule]), starRule);
    const dotRule = makeRule({ pattern: "rc.contentai.ru." });
    assert.equal(matchUrl("https://rc.contentai.ru/", [dotRule]), dotRule);
  });

  test("does not match the parent domain", () => {
    assert.equal(matchUrl("https://contentai.ru/", rules), null);
  });

  test("does not match suffix or prefix tricks", () => {
    assert.equal(matchUrl("https://rc.contentai.ru.evil.com/", rules), null);
    assert.equal(matchUrl("https://xrc.contentai.ru/", rules), null);
    assert.equal(matchUrl("https://notrc.contentai.ru/", rules), null);
  });

  test("does not match a different domain", () => {
    assert.equal(matchUrl("https://example.com/", rules), null);
  });
});

describe("matchUrl: glob rules", () => {
  const globRule = makeRule({
    id: "g1",
    type: "glob",
    pattern: "https://*.contentai.ru/*",
    prefix: "AI:",
  });

  test("matches a wildcard pattern over the full URL", () => {
    assert.equal(matchUrl("https://rc.contentai.ru/inbox?x=1", [globRule]), globRule);
    assert.equal(matchUrl("https://www.contentai.ru/", [globRule]), globRule);
  });

  test('"*" can match an empty sequence', () => {
    const rule = makeRule({ type: "glob", pattern: "https://example.com/*" });
    assert.equal(matchUrl("https://example.com/", [rule]), rule);
  });

  test("matches an exact URL without wildcards", () => {
    const rule = makeRule({ type: "glob", pattern: "https://example.com/a" });
    assert.equal(matchUrl("https://example.com/a", [rule]), rule);
    assert.equal(matchUrl("https://example.com/ab", [rule]), null);
  });

  test("does not match other hosts or schemes", () => {
    assert.equal(matchUrl("https://contentai.ru/", [globRule]), null);
    assert.equal(matchUrl("http://rc.contentai.ru/", [globRule]), null);
  });

  test("regex metacharacters are literal", () => {
    const rule = makeRule({ type: "glob", pattern: "https://example.com/a+b" });
    assert.equal(matchUrl("https://example.com/a+b", [rule]), rule);
    assert.equal(matchUrl("https://example.com/aab", [rule]), null);
  });

  test("is case-sensitive", () => {
    const rule = makeRule({ type: "glob", pattern: "https://EXAMPLE.com/*" });
    assert.equal(matchUrl("https://example.com/", [rule]), null);
  });
});

describe("matchUrl: rule selection", () => {
  test("first enabled matching rule in list order wins", () => {
    const specific = makeRule({ id: "specific", prefix: "RC:" });
    const general = makeRule({ id: "general", pattern: "contentai.ru", prefix: "AI:" });
    assert.equal(matchUrl("https://rc.contentai.ru/", [specific, general]), specific);
    assert.equal(matchUrl("https://rc.contentai.ru/", [general, specific]), general);
  });

  test("disabled rules are skipped", () => {
    const disabled = makeRule({ id: "off", enabled: false });
    const fallback = makeRule({ id: "on", pattern: "contentai.ru" });
    assert.equal(matchUrl("https://rc.contentai.ru/", [disabled, fallback]), fallback);
    assert.equal(matchUrl("https://rc.contentai.ru/", [disabled]), null);
  });

  test("invalid rules are skipped without throwing", () => {
    const bad = makeRule({ id: "bad", pattern: "https://not-a-hostname" });
    const good = makeRule({ id: "good", pattern: "contentai.ru" });
    assert.equal(matchUrl("https://rc.contentai.ru/", [bad, good]), good);
  });

  test("garbage entries in the rules array are skipped", () => {
    const good = makeRule();
    assert.equal(matchUrl("https://rc.contentai.ru/", [null, 42, "x", good]), good);
  });

  test("empty or non-array rules produce null", () => {
    assert.equal(matchUrl("https://rc.contentai.ru/", []), null);
    assert.equal(matchUrl("https://rc.contentai.ru/", null), null);
    assert.equal(matchUrl("https://rc.contentai.ru/", "rules"), null);
  });

  test("returns the rule object itself", () => {
    const rule = makeRule();
    assert.equal(matchUrl("https://rc.contentai.ru/", [rule]), rule);
  });
});

describe("matchUrl: bad URLs", () => {
  const rules = [makeRule()];

  test("empty and non-string URLs produce null", () => {
    assert.equal(matchUrl("", rules), null);
    assert.equal(matchUrl(null, rules), null);
    assert.equal(matchUrl(undefined, rules), null);
    assert.equal(matchUrl(42, rules), null);
  });

  test("garbage URLs produce null", () => {
    assert.equal(matchUrl("not a url", rules), null);
    assert.equal(matchUrl("ht!tp://%%%", rules), null);
  });

  test("special pages do not match domain rules", () => {
    assert.equal(matchUrl("about:blank", rules), null);
    assert.equal(matchUrl("about:config", rules), null);
  });
});