// RFC 8259 permits insignificant ASCII whitespace outside JSON strings.
// Keep the original lexical tokens, never stringify the parsed value: that
// would round large numbers, normalize -0/exponents, and discard duplicate keys.
export function jsonCompact(input) {
  if (typeof input !== "string" || !/^[ \t\r\n]*[\[{]/.test(input)) return null;
  try { JSON.parse(input); } catch { return null; }

  const pieces = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    if (quoted) {
      if (char === 92) i++; // A validated escape consumes the next code unit.
      else if (char === 34) quoted = false;
    } else if (char === 34) {
      quoted = true;
    } else if (char === 32 || char === 9 || char === 10 || char === 13) {
      if (i > start) pieces.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (start === 0) return input;
  if (start < input.length) pieces.push(input.slice(start));
  return pieces.join("");
}

jsonCompact.filterName = "json-compact";
jsonCompact.semanticPreserving = true;
