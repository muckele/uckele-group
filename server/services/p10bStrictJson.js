// JSON.parse accepts duplicate keys. This closed IPC protocol does not. Parse
// strings using JSON itself, then walk the already syntax-checked structure.
export function strictP10bJson(text) {
  const parsed = JSON.parse(text); let offset = 0;
  const space = () => { while (/\s/.test(text[offset] || '') && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) { const c = text[offset++]; if (c === '\\') offset++; else if (c === '"') return JSON.parse(text.slice(start, offset)); }
    throw Error();
  };
  const value = (depth = 0) => {
    if (depth > 32) throw Error();
    space(); const c = text[offset];
    if (c === '"') { string(); return; }
    if (c === '{') {
      offset++; space(); const keys = new Set();
      if (text[offset] === '}') { offset++; return; }
      do { space(); const key = string(); if (keys.has(key)) throw Error(); keys.add(key); space(); offset++; value(depth + 1); space(); } while (text[offset++] === ',');
      return;
    }
    if (c === '[') { offset++; space(); if (text[offset] === ']') { offset++; return; } do { value(depth + 1); space(); } while (text[offset++] === ','); return; }
    const token = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!token) throw Error(); offset += token[0].length;
  };
  value(); return parsed;
}
