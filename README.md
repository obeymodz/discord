# aurora relay — self-hosted

One Node process doing both jobs:

- **HTTP** `POST /heartbeat` — the DLL checks in every 30s
- **Discord gateway bot** — live slash commands

Versus the Cloudflare Worker version this has **no write quota** (state is a
local file) and the bot can push messages on its own instead of only replying
to commands.

---

## Run it

```bash
cd bot
npm install
cp .env.example .env      # fill it in
npm start
```

Your host needs to expose the port publicly and give you a hostname. Whatever
that hostname is goes into the DLL.

## Discord app

<https://discord.com/developers/applications> → **New Application**

- **Bot** → **Reset Token** → put it in `.env` as `BOT_TOKEN`
  (the token pasted in chat is burned — reset it)
- **General Information** → copy **Application ID** → `APP_ID`
- **OAuth2 → URL Generator** → scopes `bot` + `applications.commands` → invite it

No intents or Interactions Endpoint URL needed — this is a gateway bot, so it
connects out to Discord rather than being called.

`GUILD_ID` registers commands instantly in one server. Leave it blank to go
global, which can take up to an hour to appear.

## Point the DLL at it

In `remote.h`:

```cpp
inline std::wstring g_Host = L"your-host.example.com";   // host only, no https://
inline std::wstring g_Path = L"/heartbeat";
```

The console prints the machine's `hwid` on startup; it shows in `/list` within
30 seconds.

> `remote.h` uses `WINHTTP_FLAG_SECURE`, so the endpoint **must be HTTPS**. If
> your host only gives you plain HTTP, put Cloudflare in front of it (free) or
> the request fails silently and the client just fails open.

---

## Commands

| command | effect |
|---|---|
| `/list` | all clients — live dot, name, blocked state, last seen |
| `/block <hwid>` | client stops running on its next heartbeat |
| `/unblock <hwid>` | allow it again |
| `/unload <hwid>` | client unloads itself cleanly, once |
| `/msg <hwid> <text> [level]` | on-screen toast on that client |
| `/broadcast <text>` | same message to every known client |
| `/forget <hwid>` | delete the record |

`unload` and `msg` are **one-shot** — delivered on the next heartbeat then
cleared, so an unload fires once rather than every 30s forever.

Set `LOG_CHANNEL` to a channel id and the bot posts an embed the first time each
new machine checks in.

Set `ADMIN_ROLE` to a role id to restrict who can run commands. Without it,
anyone who can see the commands can block your users.

---

## Notes

**Ephemeral filesystems.** Many free hosts wipe the disk on redeploy, which
loses `clients.json`. Not fatal — every client re-registers on its next
heartbeat — but blocks are forgotten. Point `DATA_DIR` at a mounted volume if
your host offers one.

**Sleeping hosts.** Free tiers often idle a service out after inactivity. The
heartbeat traffic keeps it awake once clients exist; the first request after a
sleep may time out, and the client fails open, so nothing breaks.

**It fails open.** Relay down or unreachable → clients keep running. Deliberate:
fail-closed means your own downtime bricks everyone at once, and a firewall rule
defeats the check anyway.

**It is not anti-tamper.** Anyone with the DLL can patch the check out. This is
a kill switch for cooperative clients, not protection against a determined one.
