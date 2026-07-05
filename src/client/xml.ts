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

/** Decode the five predefined XML entities plus numeric (`&#NN;` / `&#xNN;`) refs. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
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
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
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

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w.:-]*)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) attrs[m[1]] = decodeEntities(m[2] ?? "");
    else if (m[3] !== undefined) attrs[m[3]] = decodeEntities(m[4] ?? "");
  }
  return attrs;
}

/** Finalise a frame into its JS value. */
function frameValue(frame: Frame): XmlValue {
  const attrEntries = Object.entries(frame.attrs);
  if (!frame.hasElements) {
    const text = frame.text.trim();
    if (attrEntries.length === 0) return text;
    // Leaf with attributes: keep both under an object.
    const obj: XmlObject = {};
    for (const [k, v] of attrEntries) obj[`@${k}`] = v;
    if (text.length > 0) obj["#text"] = text;
    return obj;
  }

  const obj: XmlObject = {};
  for (const [k, v] of attrEntries) obj[`@${k}`] = v;
  for (const [name, value] of frame.children) {
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

// One regex, alternation-ordered so specials (CDATA/comment/PI) win over tags:
//   1 CDATA body · 2 close name · 3 open name · 4 open attrs · 5 self-close slash · 6 text
const TOKEN =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_:][\w.:-]*)\s*>|<([A-Za-z_:][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

/**
 * Parse an XML document and return the root element's value. Throws on an empty or
 * root-less document. Unbalanced close tags are ignored defensively rather than
 * throwing, so a slightly malformed feed still yields its data.
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

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(xml)) !== null) {
    if (m[1] !== undefined) {
      // CDATA — verbatim, no entity decoding.
      if (stack.length > 0) stack[stack.length - 1]!.text += m[1];
    } else if (m[2] !== undefined) {
      // Close tag — pop the matching frame.
      const name = m[2];
      const top = stack[stack.length - 1];
      if (top && names[names.length - 1] === name) {
        stack.pop();
        names.pop();
        attach(name, frameValue(top));
      }
      // else: stray/unbalanced close tag — ignore.
    } else if (m[3] !== undefined) {
      // Open (or self-closing) tag.
      const name = m[3];
      const attrs = parseAttrs(m[4] ?? "");
      if (m[5] === "/") {
        attach(name, frameValue({ attrs, children: [], text: "", hasElements: false }));
      } else {
        stack.push({ attrs, children: [], text: "", hasElements: false });
        names.push(name);
      }
    } else if (m[6] !== undefined) {
      // Text — decode entities; only meaningful inside an element.
      if (stack.length > 0) stack[stack.length - 1]!.text += decodeEntities(m[6]);
    }
    // comments (no capture group set) and PIs fall through and are skipped.
  }

  if (root === undefined || rootName === undefined) {
    throw new Error("No root element found in XML document");
  }
  return root;
}
