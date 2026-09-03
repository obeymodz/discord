// ---------------------------------------------------------------------------
//  General chat relay
// ---------------------------------------------------------------------------
//
//  Deliberately dumb. A message is stored and echoed back verbatim; nothing in
//  this file parses the text. There are no commands, no prefixes, no way for a
//  client to make the server do anything by typing. The only client-supplied
//  values that change behaviour at all are the hwid (identity, for rate
//  limiting) and the `since` cursor (paging) -- both numbers/opaque strings,
//  never interpreted as instructions.
//
//  Ephemeral on purpose: the log lives in memory and resets on redeploy. It is
//  a chat, not a record. Keeping it out of clients.json also means chat volume
//  can never bloat the file that actually matters.
// ---------------------------------------------------------------------------

const MAX_LOG = 200;        // messages retained
const MAX_TEXT = 240;       // characters per message
const MAX_NAME = 24;
const MIN_GAP_MS = 1500;    // minimum spacing between one client's messages
const BURST_WINDOW = 30000;
const BURST_MAX = 12;       // messages per client per BURST_WINDOW

let seq = 0;
const log = [];
const posters = new Map();  // hwid -> { last, stamps[] }

// Keep printable characters only. Control bytes can smuggle ANSI escapes into
// a console, and newlines would let one message impersonate several lines of
// chat. Codepoint-wise so multi-byte characters survive intact.
function clean(value, max) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
    if (out.length >= max) break;
  }
  return out.trim();
}

export const chat = {
  post(hwid, name, text) {
    const body = clean(text, MAX_TEXT);
    if (!body) return { ok: false, error: 'empty message' };

    const now = Date.now();
    const rec = posters.get(hwid) || { last: 0, stamps: [] };

    if (now - rec.last < MIN_GAP_MS) return { ok: false, error: 'sending too fast' };
    rec.stamps = rec.stamps.filter((t) => now - t < BURST_WINDOW);
    if (rec.stamps.length >= BURST_MAX) return { ok: false, error: 'rate limited' };

    rec.last = now;
    rec.stamps.push(now);
    posters.set(hwid, rec);

    log.push({
      id: ++seq,
      name: clean(name, MAX_NAME) || 'anon',
      text: body,
      t: now,
    });
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
    return { ok: true };
  },

  // Everything newer than `since`. A client further behind than the buffer just
  // gets the whole buffer -- no error, it silently resyncs.
  since(id) {
    const from = Number.isFinite(id) ? id : 0;
    return log.filter((m) => m.id > from);
  },

  head() {
    return seq;
  },
};
