// A tiny, dependency-free XML parser — just enough for the Bundesrat iOS feeds.
//
// The feeds are shallow `<iOS><list>…</list></iOS>` documents whose leaf elements
// hold either plain text or an HTML fragment inside a CDATA section. This parser
// turns such a document into a plain JS value:
//
//   - a leaf element becomes its (entity-decoded, trimmed) text — CDATA content is
//     kept verbatim (not re-parsed, not entity-decoded);
//   - an element with child elements becomes an object keyed by child tag name;
//   - repeated sibling elements of the same name become an array;
//   - attributes become `@name` keys (only `<iOS version="…">` uses one);
//   - an empty element becomes an empty string.
//
// It is deliberately NOT a general-purpose parser (no namespaces, no DTDs, no
// mixed-content reconstruction beyond a `#text` catch-all). It is exercised hard
// in xml.test.ts against the real feed shapes.

export type XmlValue = string | XmlObject | Array<string | XmlObject>;
export interface XmlObject {
  [key: string]: XmlValue;
}

/**
 * Maximum element-nesting depth accepted by {@link parseXml}. The real Bundesrat
 * feeds are shallow (`<iOS><list>…</list></iOS>` plus a couple of levels), so a far
 * lower bound would do; this leaves generous headroom while still rejecting a
 * pathological body long before the tree gets deep enough to blow up a *downstream*
 * `JSON.stringify` (which recurses natively and throws a RangeError). Exceeding it
 * throws — surfaced by the engine as a typed BundesratParseError, not a raw
 * "Unexpected error". (BR-01.)
 */
const MAX_DEPTH = 512;

/** Decode the five predefined XML entities plus numeric (`&#NN;` / `&#xNN;`) refs. */
export function decodeEntities(text: string): string {
  // Hex (`#x…`) and decimal (`#…`) forms use separate character classes so a
  // malformed decimal ref that contains hex letters (`&#1F;`) does NOT match the
  // decimal branch and is left untouched, rather than being truncated at the first
  // non-digit by `parseInt(…, 10)`.
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Reject out-of-range and UTF-16 surrogate-range (0xD800–0xDFFF) code points:
      // decoding a lone surrogate would yield an ill-formed string. Leave the
      // original reference untouched instead.
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    // Unknown named entity: leave it untouched rather than dropping information.
    return whole;
  });
}

interface Frame {
  attrs: Record<string, string>;
  /** Ordered child (name, value) pairs; repeats are folded into arrays at close. */
  children: Array<[string, XmlValue]>;
  /** Accumulated text/CDATA content of this element. */
  text: string;
  hasElements: boolean;
}

// Tag/attribute names that would reparent or shadow a built-in if used as an object
// key. We key parsed nodes by attacker-controlled names, so we skip these outright
// (belt-and-braces alongside the `Object.create(null)` node objects below).
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** An XML name at a given offset (sticky, so it never scans ahead). */
const NAME = /[A-Za-z_:][\w.:-]*/y;

function parseAttrs(raw: string): Record<string, string> {
  // Null-proto so an attribute named `__proto__` becomes an own property rather
  // than invoking the Object.prototype setter and reparenting the object.
  const attrs: Record<string, string> = Object.create(null);
  // A hand-written scan rather than a global regex: `name\s*=\s*"…"` retried at every
  // offset of a long run of name characters with no `=` is quadratic. Here every
  // step moves forward, so the cost is linear in the tag's length. Anything that is
  // not `name="value"` / `name='value'` is skipped, as before.
  let i = 0;
  while (i < raw.length) {
    NAME.lastIndex = i;
    const m = NAME.exec(raw);
    if (m === null) {
      i += 1;
      continue;
    }
    const name = m[0];
    i = NAME.lastIndex;
    while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
    if (raw[i] !== "=") continue;
    i += 1;
    while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
    const quote = raw[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = raw.indexOf(quote, i + 1);
    if (end === -1) break;
    if (!DANGEROUS_KEYS.has(name)) attrs[name] = decodeEntities(raw.slice(i + 1, end));
    i = end + 1;
  }
  return attrs;
}

/** Finalise a frame into its JS value. */
function frameValue(frame: Frame): XmlValue {
  const attrEntries = Object.entries(frame.attrs);
  if (!frame.hasElements) {
    const text = frame.text.trim();
    if (attrEntries.length === 0) return text;
    // Leaf with attributes: keep both under an object. Null-proto so an attacker
    // tag/attr name can never reparent it or shadow a built-in method.
    const obj: XmlObject = Object.create(null);
    for (const [k, v] of attrEntries) obj[`@${k}`] = v;
    if (text.length > 0) obj["#text"] = text;
    return obj;
  }

  // Null-proto result object: keying by an attacker-controlled tag name such as
  // `__proto__` then creates an own property instead of walking the prototype
  // chain, so the node is never reparented and no built-in method is shadowed.
  const obj: XmlObject = Object.create(null);
  for (const [k, v] of attrEntries) obj[`@${k}`] = v;
  for (const [name, value] of frame.children) {
    if (DANGEROUS_KEYS.has(name)) continue; // belt-and-braces (attrs are `@`-prefixed and safe)
    if (name in obj) {
      const existing = obj[name];
      if (Array.isArray(existing)) existing.push(value as string | XmlObject);
      else obj[name] = [existing as string | XmlObject, value as string | XmlObject];
    } else {
      obj[name] = value;
    }
  }
  const text = frame.text.trim();
  if (text.length > 0) obj["#text"] = text;
  return obj;
}

/**
 * Find `needle` from `from` on, or throw: a construct that is opened but never
 * closed is malformed XML. Throwing (instead of skipping the opener and scanning
 * on, as the old single-regex tokenizer effectively did at every `<`) keeps the
 * tokenizer linear — a body of 250 000 unterminated `<?` once took 21 s to parse.
 */
function endOf(xml: string, needle: string, from: number, what: string): number {
  const end = xml.indexOf(needle, from);
  if (end === -1) throw new Error(`Unterminated ${what} at offset ${from}`);
  return end;
}

/**
 * Parse an XML document and return the root element's value. Throws on an empty or
 * root-less document and on an unterminated comment, CDATA section, processing
 * instruction, declaration or tag. Unbalanced close tags are ignored defensively
 * rather than throwing, so a slightly malformed feed still yields its data.
 *
 * The tokenizer is a single forward scan (`indexOf` for every terminator), so
 * parsing time is linear in the size of the body, whatever it contains.
 */
export function parseXml(xml: string): XmlValue {
  const stack: Frame[] = [];
  const names: string[] = [];
  let root: XmlValue | undefined;
  let rootName: string | undefined;

  const attach = (name: string, value: XmlValue): void => {
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push([name, value]);
      parent.hasElements = true;
    } else if (root === undefined) {
      root = value;
      rootName = name;
    }
  };

  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] !== "<") {
      // Text — decode entities; only meaningful inside an element.
      const next = xml.indexOf("<", i);
      const end = next === -1 ? n : next;
      if (stack.length > 0) stack[stack.length - 1]!.text += decodeEntities(xml.slice(i, end));
      i = end;
    } else if (xml.startsWith("<![CDATA[", i)) {
      // CDATA — verbatim, no entity decoding.
      const end = endOf(xml, "]]>", i + 9, "CDATA section");
      if (stack.length > 0) stack[stack.length - 1]!.text += xml.slice(i + 9, end);
      i = end + 3;
    } else if (xml.startsWith("<!--", i)) {
      i = endOf(xml, "-->", i + 4, "comment") + 3;
    } else if (xml.startsWith("<?", i)) {
      i = endOf(xml, "?>", i + 2, "processing instruction") + 2;
    } else if (xml.startsWith("<!", i)) {
      // A declaration such as <!DOCTYPE …>, skipped. An internal subset
      // (`<!DOCTYPE x [ … ]>`) may itself contain `>`, so skip past its `]` first.
      // Entities declared there are never expanded.
      const close = endOf(xml, ">", i + 2, "declaration");
      const open = xml.slice(i + 2, close).indexOf("[");
      const from = open === -1 ? close : endOf(xml, "]", i + 2 + open + 1, "declaration");
      i = endOf(xml, ">", from, "declaration") + 1;
    } else if (xml[i + 1] === "/") {
      // Close tag — pop the matching frame.
      NAME.lastIndex = i + 2;
      const m = NAME.exec(xml);
      let j = NAME.lastIndex;
      while (m !== null && j < n && /\s/.test(xml[j]!)) j += 1;
      if (m === null || xml[j] !== ">") {
        i += 1; // not a close tag: skip the "<" and read on (as the old tokenizer did)
        continue;
      }
      const name = m[0];
      const top = stack[stack.length - 1];
      if (top && names[names.length - 1] === name) {
        stack.pop();
        names.pop();
        attach(name, frameValue(top));
      }
      // else: stray/unbalanced close tag — ignore.
      i = j + 1;
    } else {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(xml);
      if (m === null) {
        i += 1; // a lone "<" that starts nothing: skip it and read on
        continue;
      }
      // Open (or self-closing) tag: find its ">" outside quoted attribute values.
      let j = NAME.lastIndex;
      while (j < n && xml[j] !== ">") {
        const c = xml[j];
        if (c === '"' || c === "'") j = endOf(xml, c, j + 1, "attribute value");
        j += 1;
      }
      if (j >= n) throw new Error(`Unterminated tag <${m[0]}> at offset ${i}`);
      const name = m[0];
      let raw = xml.slice(NAME.lastIndex, j);
      const selfClosing = raw.endsWith("/");
      if (selfClosing) raw = raw.slice(0, -1);
      const attrs = parseAttrs(raw);
      if (selfClosing) {
        attach(name, frameValue({ attrs, children: [], text: "", hasElements: false }));
      } else {
        if (stack.length >= MAX_DEPTH) {
          throw new Error(`XML nesting too deep (exceeded ${MAX_DEPTH} levels)`);
        }
        stack.push({ attrs, children: [], text: "", hasElements: false });
        names.push(name);
      }
      i = j + 1;
    }
  }

  if (root === undefined || rootName === undefined) {
    throw new Error("No root element found in XML document");
  }
  return root;
}
