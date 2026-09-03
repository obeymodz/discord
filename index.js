// ---------------------------------------------------------------------------
//  aurora relay — self-hosted gateway bot + heartbeat endpoint
// ---------------------------------------------------------------------------
//
//  One process doing two things:
//    * HTTP  POST /heartbeat   <- the DLL, every 30s
//    * Discord gateway bot     -> slash commands, live
//
//  Versus the Cloudflare version this drops the KV write quota entirely (state
//  is a local file), and because the bot holds a real gateway connection it can
//  also push messages on its own rather than only replying to commands.
//
//  The bot token lives in the environment and never reaches the DLL. Anything
//  you ship is readable by whoever runs it; a token compiled into the client
//  would hand every user control of the bot, including revoking everyone else.
//
//  Env:
//    BOT_TOKEN    required
//    APP_ID       required (slash-command registration)
//    GUILD_ID     optional — instant command registration in one server
//    ADMIN_ROLE   optional — role id allowed to run commands
//    PORT         optional — default 8080
//    LOG_CHANNEL  optional — channel id to announce new machines in
// ---------------------------------------------------------------------------

import http from 'node:http';
import crypto from 'node:crypto';
import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
} from 'discord.js';
import { store } from './store.js';
import { chat } from './chat.js';

const {
  BOT_TOKEN, APP_ID, GUILD_ID, ADMIN_ROLE,
  PORT = 8080, LOG_CHANNEL, SIGN_KEY,
} = process.env;

if (!BOT_TOKEN || !APP_ID) {
  console.error('Set BOT_TOKEN and APP_ID.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
//  Response signing (ECDSA P-256)
//
//  SIGN_KEY is the PEM private key from `node gen-keys.js`, newlines as \n.
//  Without it the server replies unsigned and the client (also unconfigured)
//  trusts it -- fine for first setup, but set it before you rely on blocking.
//
//  Only the security fields are signed, as "<nonce>|<allow>|<unload>", matching
//  Remote::VerifyReply in the DLL byte for byte.
// ---------------------------------------------------------------------------
let signKey = null;
if (SIGN_KEY) {
  try {
    signKey = crypto.createPrivateKey(SIGN_KEY.replace(/\\n/g, '\n'));
    console.log('[sign] response signing ENABLED');
  } catch (e) {
    console.error('[sign] bad SIGN_KEY, signing disabled:', e.message);
  }
} else {
  console.log('[sign] SIGN_KEY not set -- replies are UNSIGNED');
}

function signReply(nonce, allow, unload) {
  if (!signKey) return '';
  const msg = `${nonce}|${allow ? 1 : 0}|${unload ? 1 : 0}`;
  // ieee-p1363 => raw r||s (64 bytes), which is what the client's BCrypt
  // verify expects. The default DER encoding would NOT verify.
  return crypto
    .sign('sha256', Buffer.from(msg), { key: signKey, dsaEncoding: 'ieee-p1363' })
    .toString('hex');
}

// ---------------------------------------------------------------------------
//  HTTP: the DLL heartbeat
// ---------------------------------------------------------------------------
// A client counts as online if it has beaten recently. 90s is three heartbeat
// intervals, so one dropped request does not make someone flicker offline.
const ONLINE_MS = 90_000;
function onlineCount() {
  const now = Date.now();
  let n = 0;
  for (const [, rec] of store.all()) {
    if (!rec.blocked && rec.last && now - rec.last < ONLINE_MS) n++;
  }
  return n;
}

function readBody(req, res, limit, done) {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > limit) req.destroy();   // nothing legitimate is this big
  });
  req.on('end', () => done(raw));
}

const server = http.createServer((req, res) => {
  const send = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };

  // -------------------------------------------------------------------------
  //  General chat: one poll doubles as send + receive + presence.
  //
  //  The message text is never parsed here or anywhere downstream -- see
  //  chat.js. A blocked client is silently read-only rather than told, because
  //  telling it would just confirm the block.
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && req.url.startsWith('/chat')) {
    readBody(req, res, 2048, (raw) => {
      let body;
      try { body = JSON.parse(raw); }
      catch { return send({ online: onlineCount(), messages: [] }); }

      const hwid = String(body.hwid || '').slice(0, 64);
      if (!hwid) return send({ online: onlineCount(), messages: [] });

      const rec = store.get(hwid);
      let error = '';
      if (typeof body.text === 'string' && body.text.trim() && !rec?.blocked) {
        const r = chat.post(hwid, body.name, body.text);
        if (!r.ok) error = r.error;
      }

      const since = Number(body.since);
      send({
        online: onlineCount(),
        head: chat.head(),
        error,
        messages: chat.since(since),
      });
    });
    return;
  }

  if (req.method !== 'POST' || !req.url.startsWith('/heartbeat')) {
    res.writeHead(200).end('aurora relay');
    return;
  }

  readBody(req, res, 4096, (raw) => {

    let body;
    try { body = JSON.parse(raw); }
    catch { return send({ allow: true }); }   // malformed -> fail open

    const hwid = String(body.hwid || '').slice(0, 64);
    if (!hwid) return send({ allow: true });

    const now = Date.now();
    const prev = store.get(hwid);

    const rec = {
      name: String(body.name || '').slice(0, 64),
      ver: String(body.ver || '').slice(0, 32),
      blocked: prev?.blocked ?? false,
      unload: prev?.unload ?? false,
      msg: prev?.msg ?? '',
      level: prev?.level ?? 'info',
      first: prev?.first ?? now,
      last: now,
      beats: (prev?.beats ?? 0) + 1,
    };

    const allow = !rec.blocked;
    const unload = rec.unload;
    const nonce = String(body.nonce || '').slice(0, 64);

    const reply = {
      allow,
      unload,
      msg: rec.msg,
      level: rec.level,
      online: onlineCount(),          // shown in the menu header
      nonce,                          // echo it back inside the signed data
      sig: signReply(nonce, allow, unload),
    };

    // One-shot: clear after delivery so an /unload fires once rather than on
    // every heartbeat forever.
    rec.unload = false;
    rec.msg = '';
    store.set(hwid, rec);

    if (!prev) announceNew(hwid, rec);
    send(reply);
  });
});

server.listen(PORT, () => console.log(`[http] heartbeat on :${PORT}`));

// ---------------------------------------------------------------------------
//  Discord
// ---------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function announceNew(hwid, rec) {
  if (!LOG_CHANNEL || !client.isReady()) return;
  client.channels.fetch(LOG_CHANNEL).then((ch) =>
    ch?.send({
      embeds: [new EmbedBuilder()
        .setTitle('New machine')
        .setColor(0x22c55e)
        .addFields(
          { name: 'hwid', value: `\`${hwid}\``, inline: true },
          { name: 'name', value: rec.name || '?', inline: true },
          { name: 'build', value: rec.ver || '?', inline: true },
        )],
    })
  ).catch(() => {});
}

const age = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const hwidOpt = (o) =>
  o.setName('hwid').setDescription('Client hardware id (see /list)').setRequired(true);

const commands = [
  new SlashCommandBuilder().setName('list').setDescription('Show all clients'),
  new SlashCommandBuilder().setName('block').setDescription('Stop a client running')
    .addStringOption(hwidOpt),
  new SlashCommandBuilder().setName('unblock').setDescription('Allow a client again')
    .addStringOption(hwidOpt),
  new SlashCommandBuilder().setName('unload').setDescription('Unload a client now')
    .addStringOption(hwidOpt),
  new SlashCommandBuilder().setName('forget').setDescription('Delete a client record')
    .addStringOption(hwidOpt),
  new SlashCommandBuilder().setName('msg').setDescription('Send an on-screen message')
    .addStringOption(hwidOpt)
    .addStringOption((o) => o.setName('text').setDescription('Message').setRequired(true))
    .addStringOption((o) => o.setName('level').setDescription('Style').addChoices(
      { name: 'info', value: 'info' }, { name: 'success', value: 'success' },
      { name: 'warn', value: 'warn' }, { name: 'error', value: 'error' })),
  new SlashCommandBuilder().setName('broadcast').setDescription('Message every client')
    .addStringOption((o) => o.setName('text').setDescription('Message').setRequired(true)),
].map((c) => c.toJSON());

client.once('clientReady', async () => {
  console.log(`[bot] ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(
      GUILD_ID ? Routes.applicationGuildCommands(APP_ID, GUILD_ID)
               : Routes.applicationCommands(APP_ID),
      { body: commands });
    console.log(`[bot] registered ${commands.length} commands${GUILD_ID ? ' (guild)' : ' (global)'}`);
  } catch (e) {
    console.error('[bot] command registration failed:', e.message);
  }
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (ADMIN_ROLE && !i.member?.roles?.cache?.has(ADMIN_ROLE))
    return i.reply({ content: 'Not authorised.', flags: 64 });

  const hwid = i.options.getString('hwid');
  const ok = (m) => i.reply({ content: m, flags: 64 });

  const edit = (fn, msg) => {
    const rec = store.get(hwid);
    if (!rec) return ok(`Unknown hwid \`${hwid}\`. Try \`/list\`.`);
    fn(rec);
    store.set(hwid, rec);
    return ok(msg);
  };

  switch (i.commandName) {
    case 'list': {
      const rows = store.all()
        .sort((a, b) => b[1].last - a[1].last)
        .slice(0, 40)
        .map(([id, r]) => {
          const live = Date.now() - r.last < 90_000 ? '🟢' : '⚪';
          return `${live} \`${id}\`  ${r.name || '?'}  ` +
                 `${r.blocked ? '**BLOCKED**' : 'ok'}  ${age(Date.now() - r.last)} ago`;
        });
      return ok(rows.length ? rows.join('\n').slice(0, 1900) : 'No clients yet.');
    }
    case 'block':
      return edit((r) => (r.blocked = true), `Blocked \`${hwid}\` — applies within 30s.`);
    case 'unblock':
      return edit((r) => (r.blocked = false), `Unblocked \`${hwid}\`.`);
    case 'unload':
      return edit((r) => (r.unload = true), `Unload queued for \`${hwid}\`.`);
    case 'msg':
      return edit((r) => {
        r.msg = i.options.getString('text').slice(0, 200);
        r.level = i.options.getString('level') || 'info';
      }, `Message queued for \`${hwid}\`.`);
    case 'forget':
      store.delete(hwid);
      return ok(`Removed \`${hwid}\`.`);
    case 'broadcast': {
      const text = i.options.getString('text').slice(0, 200);
      let n = 0;
      for (const [id, r] of store.all()) {
        r.msg = text; r.level = 'info';
        store.set(id, r); n++;
      }
      return ok(`Queued for ${n} client${n === 1 ? '' : 's'}.`);
    }
  }
});

client.login(BOT_TOKEN);
