import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, decodeEntities, type XmlObject } from "../src/client/xml.js";
import * as fx from "./fixtures.js";

/**
 * Round-trip a parsed value through JSON so structural `deepEqual` assertions
 * compare data only. Parsed nodes are intentionally null-proto (BR-02 hardening),
 * which `assert.deepStrictEqual` treats as unequal to a plain-object literal;
 * JSON.parse re-materialises them with the default prototype without changing
 * their shape.
 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("decodeEntities handles named, decimal and hex references", () => {
  assert.equal(decodeEntities("A &amp; B &lt;x&gt; &quot;q&quot; &apos;a&apos;"), `A & B <x> "q" 'a'`);
  assert.equal(decodeEntities("Bundesratspr&#228;sident"), "Bundesratspräsident");
  assert.equal(decodeEntities("caf&#xE9;"), "café");
  assert.equal(decodeEntities("dots &#8230;"), "dots …");
});

test("decodeEntities leaves an unknown named entity untouched", () => {
  assert.equal(decodeEntities("a &nbsp; b"), "a &nbsp; b");
});

test("decodeEntities accepts upper-case hex and rejects malformed/surrogate refs", () => {
  assert.equal(decodeEntities("caf&#XE9;"), "café"); // upper-case X hex form
  // A decimal ref that (illegally) contains hex letters must be left untouched,
  // not truncated to code point 1.
  assert.equal(decodeEntities("x&#1F;y"), "x&#1F;y");
  // A UTF-16 surrogate-range code point must not decode to a lone surrogate.
  assert.equal(decodeEntities("x&#xD800;y"), "x&#xD800;y");
});

test("parses a simple nested document to an object with leaf text", () => {
  const v = parseXml("<iOS><list><a>x</a><b>y</b></list></iOS>") as XmlObject;
  assert.deepEqual(plain(v), { list: { a: "x", b: "y" } });
});

test("captures attributes as @-prefixed keys", () => {
  const v = parseXml('<iOS version="1.0"><a>x</a></iOS>') as XmlObject;
  assert.equal(v["@version"], "1.0");
  assert.equal(v["a"], "x");
});

test("repeated sibling elements become an array; a single one does not", () => {
  const many = parseXml("<r><item>1</item><item>2</item><item>3</item></r>") as XmlObject;
  assert.deepEqual(many["item"], ["1", "2", "3"]);
  const one = parseXml("<r><item>1</item></r>") as XmlObject;
  assert.equal(one["item"], "1"); // NOT an array
});

test("CDATA content is kept verbatim — not entity-decoded, not parsed as markup", () => {
  const v = parseXml("<r><d><![CDATA[A & B < C <p>raw</p>]]></d></r>") as XmlObject;
  assert.equal(v["d"], "A & B < C <p>raw</p>");
});

test("text entities are decoded but CDATA is not", () => {
  const v = parseXml("<r><t>A &amp; B</t><d><![CDATA[A &amp; B]]></d></r>") as XmlObject;
  assert.equal(v["t"], "A & B"); // decoded
  assert.equal(v["d"], "A &amp; B"); // verbatim
});

test("empty and self-closing elements become empty strings", () => {
  const v = parseXml("<r><a></a><b/></r>") as XmlObject;
  assert.equal(v["a"], "");
  assert.equal(v["b"], "");
});

test("whitespace between elements is ignored (no stray #text)", () => {
  const v = parseXml("<r>\n  <a>x</a>\n  <b>y</b>\n</r>") as XmlObject;
  assert.deepEqual(plain(v), { a: "x", b: "y" });
});

test("nested repeated structure (tops/subtops) parses correctly", () => {
  const v = parseXml(fx.nestedXml) as XmlObject;
  const list = v["list"] as XmlObject;
  const tops = list["tops"] as XmlObject;
  const top = tops["top"] as XmlObject;
  assert.equal(top["nr"], "1");
  assert.deepEqual(plain(top["subtop"]), [
    { type: "a", name: "N1" },
    { type: "b", name: "N2" },
  ]);
});

test("parses the members feed: two <employee> entries with decoded/CDATA fields", () => {
  const v = parseXml(fx.membersXml) as XmlObject;
  const employees = (v["list"] as XmlObject)["employee"] as XmlObject[];
  assert.equal(employees.length, 2);
  assert.equal(employees[0]!["name"], "Özdemir");
  assert.equal(employees[0]!["state"], "Baden-Württemberg");
  assert.equal(employees[0]!["detail"], "<p><strong>Ministerpräsident</strong></p>");
  assert.equal(employees[1]!["party"], "CSU");
});

test("parses the session feed: title, header and two <top> items with Drucksachen", () => {
  const v = parseXml(fx.sessionXml) as XmlObject;
  const list = v["list"] as XmlObject;
  assert.match(list["title"] as string, /^1067\. Sitzung/);
  const tops = list["top"] as XmlObject[];
  assert.equal(tops.length, 2);
  assert.equal(tops[0]!["topdrucksache"], "Drucksache 371/26");
  assert.equal(tops[0]!["topheader"], "Ernennung von Bundesanwältinnen"); // &#228; decoded
});

test("throws on a document with no root element", () => {
  assert.throws(() => parseXml("   \n  "), /No root element/);
});

// --- Security: deep-nesting depth cap (BR-01) ---

test("a pathologically deep document is rejected with a typed parse error", () => {
  // Well past the 512-level cap. The parser itself is iterative and would not
  // overflow, but the resulting tree blows up a downstream JSON.stringify; the cap
  // turns that into a clean, typed failure instead of a raw RangeError.
  const deep = "<x>".repeat(5000) + "leaf" + "</x>".repeat(5000);
  assert.throws(() => parseXml(`<r>${deep}</r>`), /nesting too deep/);
});

test("a document at a normal depth still parses", () => {
  const nested = "<a><b><c><d>leaf</d></c></b></a>";
  const v = parseXml(`<r>${nested}</r>`) as XmlObject;
  assert.equal((((v["a"] as XmlObject)["b"] as XmlObject)["c"] as XmlObject)["d"], "leaf");
});

// --- Security: prototype-pollution defence-in-depth (BR-02) ---

test("a <__proto__> / <constructor> tag does not pollute Object.prototype", () => {
  parseXml("<r><__proto__><polluted>yes</polluted></__proto__></r>");
  parseXml("<r><constructor><polluted>yes</polluted></constructor></r>");
  parseXml('<r __proto__="evil"><a>x</a></r>');
  // A brand-new, unrelated object must be unaffected.
  const probe = {} as Record<string, unknown>;
  assert.equal(probe["polluted"], undefined);
  assert.equal(({} as Record<string, unknown>)["__proto__"], Object.prototype);
});

test("parsed nodes are null-proto: no reparenting, safe to string-coerce and stringify", () => {
  // A <__proto__> child previously reparented the node; a <toString> child shadowed
  // its method so String(node) threw. With null-proto nodes both are just own keys.
  const v = parseXml("<r><__proto__>x</__proto__><toString>y</toString><a>z</a></r>") as XmlObject;
  assert.equal(Object.getPrototypeOf(v), null);
  // The dangerous key is dropped; the real child survives.
  assert.equal(v["a"], "z");
  assert.equal(v["__proto__"], undefined);
  // String-coercion and JSON.stringify (used by renderJson) must not throw.
  assert.doesNotThrow(() => JSON.stringify(v));
  assert.doesNotThrow(() => `${JSON.stringify(v)}`);
});
