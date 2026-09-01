// Flat-file store. No database, no quotas, no per-write billing — which is the
// whole reason for self-hosting instead of Workers KV.
//
// Writes are debounced and atomic: heartbeats arrive constantly and rewriting
// the file on every one would hammer the disk, while writing in place risks a
// truncated file if the process dies mid-write. We write to a temp file and
// rename, which is atomic on every OS that matters.

import fs from 'node:fs';
import path from 'node:path';

// Configurable because many free hosts have an ephemeral filesystem — point
// DATA_DIR at a mounted volume if you have one, or accept that the list resets
// on redeploy (clients simply re-register on their next heartbeat).
const DIR = process.env.DATA_DIR || '.';
const FILE = path.join(DIR, 'clients.json');
const TMP = FILE + '.tmp';

let data = {};
let dirty = false;

try {
  data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  console.log(`[store] loaded ${Object.keys(data).length} clients`);
} catch {
  console.log('[store] starting empty');
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(TMP, JSON.stringify(data, null, 1));
    fs.renameSync(TMP, FILE);          // atomic swap
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
}

setInterval(flush, 5000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flush(); process.exit(0); });
}

export const store = {
  get: (hwid) => data[hwid],
  all: () => Object.entries(data),
  set(hwid, rec) { data[hwid] = rec; dirty = true; },
  delete(hwid) { delete data[hwid]; dirty = true; },
  flush,
};
