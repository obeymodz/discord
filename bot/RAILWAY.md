# Deploying the relay to Railway

Follow top to bottom. ~15 minutes, mostly waiting on Discord.

---

## 1. Discord app first (you need three values from here)

<https://discord.com/developers/applications> → **New Application**, name it anything.

- **General Information** → copy **Application ID**  → this is `APP_ID`
- **Bot** (left menu) → **Reset Token** → **Copy** → this is `BOT_TOKEN`
  - The token pasted in chat earlier is burned. Reset gives you a fresh one.
  - You do **not** need to toggle any Privileged Gateway Intents. Leave them off.
- **OAuth2 → URL Generator**:
  - Scopes: check **`bot`** and **`applications.commands`**
  - Copy the generated URL at the bottom, open it, add the bot to your server

To get `GUILD_ID` (optional but recommended for testing): in Discord, User
Settings → Advanced → enable **Developer Mode**, then right-click your server
icon → **Copy Server ID**.

Keep `BOT_TOKEN`, `APP_ID`, `GUILD_ID` handy for step 3.

---

## 2. Get the code onto Railway

**Easiest — deploy from GitHub:**

1. Put this `bot/` folder in a GitHub repo (the `.gitignore` already excludes
   `.env`, `node_modules`, and `clients.json`, so nothing secret is committed).
2. <https://railway.app> → sign in with GitHub → **New Project** →
   **Deploy from GitHub repo** → pick the repo.
3. If the repo root is not the `bot/` folder, open the service →
   **Settings → Root Directory** → set it to `bot`.

Railway auto-detects Node from `package.json` and runs `npm install` then
`npm start`. `railway.json` in this folder pins that plus the health check and
restart policy.

**Or without GitHub — the CLI:**

```bash
npm i -g @railway/cli
railway login
cd bot
railway init          # creates a project
railway up            # uploads and builds this folder
```

---

## 3. Environment variables

Service → **Variables** tab → add these (raw values, no quotes):

| name | value |
|---|---|
| `BOT_TOKEN` | the token from step 1 |
| `APP_ID` | the Application ID |
| `GUILD_ID` | your server id (optional; instant command registration) |
| `ADMIN_ROLE` | a role id allowed to run commands (optional but recommended) |
| `LOG_CHANNEL` | a channel id to announce new machines in (optional) |
| `DATA_DIR` | `/data` — **only if you add the volume in step 4** |

Do **not** set `PORT` — Railway injects it, and `index.js` already reads it.

Adding variables triggers a redeploy. Watch **Deployments → View Logs** for:

```
[http] heartbeat on :XXXX
[bot] YourBot#1234
[bot] registered 7 commands (guild)
```

That third line means it worked. Run `/list` in your server — it replies
"No clients yet." until the DLL checks in.

---

## 4. Persistent storage (do this — it matters)

Railway's container filesystem is **wiped on every redeploy**. Without a volume,
`clients.json` resets each deploy, which means **machines you blocked come back
allowed**. Clients re-register automatically, but your blocks silently vanish.

Service → **Settings → Volumes** → **New Volume** → mount path `/data`.
Then set the `DATA_DIR = /data` variable from step 3.

Now blocks survive redeploys.

---

## 5. Make it public + get the hostname

Service → **Settings → Networking → Public Networking** → **Generate Domain**.

You get something like `aurora-relay-production.up.railway.app`. Railway
terminates HTTPS for it automatically — which the DLL requires.

**Verify before touching the DLL:** open
`https://<your-domain>/` in a browser. You must see the plain text
**`aurora relay`**. If you do, the endpoint is live and reachable.

---

## 6. Point the DLL at it

In `remote.h`:

```cpp
inline std::wstring g_Host = L"aurora-relay-production.up.railway.app";  // host ONLY
inline std::wstring g_Path = L"/heartbeat";
```

- Host only — no `https://`, no trailing slash, no `/heartbeat` in `g_Host`.
- Rebuild the DLL and inject.
- The debug console prints `remote: hwid=... name=...` on startup.
- Within 30s the machine shows in `/list`.

---

## Cost

Railway's starter grant covers a small always-on service for a while; after
that this bot runs at roughly the platform minimum (~$5/mo) because it stays
awake 24/7 by design. There is no sleeping tier that would work for a gateway
bot, so this is the trade for not fighting a free tier.

## Commands

`/list` · `/block` · `/unblock` · `/unload` · `/msg` · `/broadcast` · `/forget`

`unload` and `msg` fire **once** on the client's next heartbeat, then clear.

---

## 7. Response signing (do this before you rely on blocking)

Until this is set up, a user can point your domain at their own PC and serve a
fake `{"allow":true}` to defeat a block. Signing closes that.

**Generate the keypair (once):**

```bash
cd bot
node gen-keys.js
```

It prints two blocks:

1. **`SIGN_KEY=...`** — add it as a Railway **Variable** (the private key; keep it secret).
2. A **`g_ServerPubKey[64]`** C++ array — paste it over the placeholder in
   `remote.h`, then rebuild the DLL.

Redeploy the bot. Its log should say `[sign] response signing ENABLED`, and the
DLL console (if you build a debug copy) prints `heartbeat ok (signed)`.

Once the real public key is in `remote.h`, the client **fails closed**: it must
receive a validly-signed "allow" every so often or it unloads. Default grace is
10 minutes (`kAuthGraceMs` in `remote.h`), so a short relay outage is fine but a
sustained one — or anyone suppressing/forging the heartbeat — shuts clients down.

Re-running `gen-keys.js` makes a NEW pair and invalidates every deployed client,
so keep the output safe.
