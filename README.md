# yapr

Terminal SMS-style messenger with end-to-end encryption. This is the client;
it talks to [yapr-server](../yapr-server), a relay that routes opaque encrypted
envelopes it cannot read and holds them while you are offline.

## Features

- **End-to-end encrypted** — X25519 + AES-256-GCM per message (stdlib only, no extra
  crypto deps). The server and the network see ciphertext only; plaintext lives on
  your device alone.
- **SMS-like reliability** — persistent outbox with automatic resend (same IDs, so the
  server dedupes), offline inbox replay with paging, delivery acks and read receipts
  (`…` sending → `✓` sent → `✓✓` read).
- **Terminal UI** — sidebar chats with unread badges, chat bubbles, scrollback,
  contacts browser, group threads with sender names and seen-by ticks, details pane
  (`i`), online (`●`) / offline (`○`) indicator, server errors as transient toasts.
  Reconnects with backoff and keeps retrying, always showing the latest retry
  reason under the header so a dead server never looks like a hang.
- **Group chats** — creator-admin groups up to 50, pairwise E2EE per member, offline
  replay, per-member read tracking, nicknames (advertised or local-only), and
  automatic silent history backfill for newcomers.
- **Durable local data** — SQLite in your OS data dir (survives npm updates) plus a
  device identity key. Automatic schema migrations.

## Requirements

- Node.js ≥ 22
- A running yapr-server (TLS). For local dev, its self-signed cert.

## Quickstart

```bash
npm install -g @sprunkzzz/yapr   # just run `yapr`: it targets the staging
                                 # relay out of the box and registers on first launch
```

For local dev from a checkout:

```bash
npm ci && npm run build && npm link
cp .env.example .env             # dev scripts need a .env file present
```

Edit `.env` (dev only — the packaged defaults already point at staging):

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | staging relay / explicit override wins | Server endpoint (TLS only) |
| `YAPR_CA_FILE` | — | Verify the server against this CA/cert instead of the insecure staging default |
| `YAPR_INSECURE` | — | `1` keeps the explicit insecure escape hatch (equivalent to the default) |
| `YAPR_DATA_DIR` | OS data dir | Override for the database + identity key |

Staging transport note: until the relay gets its domain, the client skips TLS
certificate verification by default (it says so on every launch). Message content
stays E2EE-confidential regardless — only relay authentication is conceded.
Run one client per user at a time: the relay single-sessions, so a second
client signs the first out (`UNAUTH: signed in from another device`).

Then:

```bash
npm run dev    # tsx + TUI
```

Keys (shortcuts stand down while typing in any text field, except `Tab`):

- Global: `Tab` cycles sidebar → thread → details → textbox, `t` jumps straight to
  the textbox, `q` quits, `c` contacts, `s` settings, `g` new group, `i` toggles
  details. All but `Tab` are disabled outside the textbox while editing text.
- Sidebar (open chats, `◈` = group): `↑/↓` move, `→`/`Enter` open, `x` closes a chat
  (stays a contact), `d` deletes a contact — or leaves a group — with `y` to confirm.
- Thread: `↑/↓` scroll. Opening a thread marks it read (sends receipts). Every message
  shows its local time (`3:25 PM ✓✓`); older ones get a day prefix. Group messages show
  the sender and who has seen them.
- Composer: `Enter` sends, `Ctrl+J` inserts a newline (multiline drafts grow to 8 rows),
  `Shift+Enter` also inserts a newline on terminals that report it, `Backspace` erases,
  arrows move the cursor.
- Details (`i`): `↑/↓` move, `Enter` runs the action, `y` confirms destructive ones,
  `i`/`Esc` close.
- Contacts (`c`): `Enter` chat/add, `e` rename, `d` delete (`y` confirms), `a` add,
  `/` starts filtering (plain keys act otherwise), `Backspace` edits the filter,
  `Esc` clears the filter, then goes back.
- Contact form: `Tab` cycles fields, `Enter` submits, `Esc` cancels.
- Settings (`s`): `↑/↓` move, `Enter` toggles/switches/edits, `Esc` goes back. Theme
  opens a picker: `↑/↓` preview, `Enter` applies, `Esc` cancels.
- Group create (`g`): name first (`Enter` continues, `Esc` cancels), then members
  (`Enter` adds, `Tab` creates, `Esc` back).
- Group members/details views: `a` add (admin), `d` remove with `y` to confirm
  (admin), `Enter` edits a nickname in the nicks view, `Esc` goes back.
- History-share prompt: `y` shares the last 20 messages re-encrypted for the
  requester, `n`/`Esc` declines; other keys are ignored.
- First run registers you automatically (identity key created locally) and
  identifies on every later start. Your numeric ID is in the header — share it
  so people can add you.

## Formatting and themes

Mark emphasis inline — it travels inside your encrypted text and renders in each
reader's own theme, so everyone agrees on *what* is emphasized:

- `$C1[...]`, `$C2[...]`, `$C3[...]` — three emphasis levels (strongest first)
- `**bold**`, `` `code` `` — a lone `*` needs no escape; `\` escapes `$`, `*`, backtick
- Unclosed markers render literally; no nesting in this version

Pick a theme in Settings → Theme picker, with a live preview of each
(`moss`, `amber`, `ocean`, `mono`, `plum`, `ember`, `slate`, `contrast`,
`monokai`, `dracula`, `nord`, `gruvbox`). Every theme keeps the
emphasis ramp ordered brightest-first, so `$C1` always outshines `$C3`.

## Contacts and keys
The sidebar holds **open chats**; **Contacts** (`c`) holds everyone. There you can start
a chat, rename, delete, or add by ID. Add contacts by their server user ID with any
alias you like (IDs can't be renamed later — they anchor history; aliases can).
Unknown senders appear automatically so replies just work. Public keys are fetched
from the server directory on demand and cached locally; if a message can't be
decrypted you see `[encrypted message — update yapr to read it]` instead of garbage.

Your **nickname** and reveal toggles (Settings, `s`) travel inside your encrypted
envelopes — never visible to the server. The group default applies everywhere unless
you set a per-group override; DMs include it only if you enable that toggle.
A DM newcomer's advertised name is adopted as their contact alias while none is
saved (your renames always win). Anyone can claim any name, so treat adopted
aliases as unverified — rename anyone you need to trust.

## Group chats

Create with `g`: name it, pick members (rapid `Enter`-to-add, type to filter,
`Ctrl+A` adds a raw user ID without needing them as a contact, `Tab` creates
with the selection). Each message is sealed separately per member — the server
only routes opaque blobs. The creator admins: adding/removing members, renaming.
Leaving passes admin to the longest-tenured member; the last one out dissolves it.

- **Details (`i`)**: info, member list, nicknames, leave. Your own nickname row sets
  what you advertise to that group; other rows set local pet names (never sent).
- **History for newcomers**: automatic and silent. When you join a group with no
  local history, your client asks for the missing window; the server relays to
  the oldest online member, whose client re-sends those rows re-encrypted for
  you with their original authors and timestamps. They file in place — no new
  messages, no unread bump, one quiet `Loaded N older messages` line. Deep gaps
  walk forward automatically (up to 100 rows per group). Both sides need the
  update; older clients fall back to the previous manual behavior.
- **Removed members** keep whatever is already on their device — like any messenger,
  leaving removes future messages, not the past.

## Troubleshooting

- `yapr needs an interactive terminal` — run in a real terminal, not a pipe.
- Stuck `○` offline — check `HOST`/`PORT` (packaged default is staging; a stale
  override points at nothing) and that the server is up; with `YAPR_CA_FILE` set,
  TLS failures (wrong CA, expired cert) also present as offline.
- `UPGRADE_REQUIRED` toast — client/server protocol mismatch; upgrade both.
- `Alias already taken` / `ID already exists` — pick another alias; IDs are unique.
- Lost `identity.key` (see below) means new messages from others can't be decrypted —
  back it up.

## Data and files

| Location | Contents |
|---|---|
| Linux `~/.local/share/yapr`, macOS `~/Library/Application Support/yapr`, Windows `%APPDATA%/yapr` (or `$YAPR_DATA_DIR`) | `yapr.db` (history, contacts, key cache), `identity.key` (device private key, `0600`), `reclaim.token` (server-sealed account-recovery token, `0600`) |

`identity.key` is the crown jewel: anyone holding it can read your incoming history.
Back it up encrypted, never share it. Deleting the data dir logs you out and orphans
readable history (re-registering creates a new account).

## Account recovery

If the server loses its database, you don't fork to a new account: the client
silently reclaims your previous user id using `reclaim.token`, then logs in
normally — contacts and history on other devices resolve again because ids
anchor both. No prompts, no manual steps.

Rules worth knowing:

- The token is password-equivalent: whoever holds it can claim your id on a
  fresh server. Back it up encrypted, alongside `identity.key`.
- Recovery only works when the id is absent server-side. It never resets a
  live account, and the client never auto-registers a new id while a token
  exists — a failed recovery shows a persistent `account recovery failed …
  contact operator` line instead of silently forking your identity.
- Group memberships are not restored (a stale token must not re-admit a
  removed member); ask a group admin to re-add you. Messages in flight when
  the data was lost stay lost.

## Scripts

- `npm run dev` / `npm start` (after `npm run build`) — run the TUI
- `npm run db:seed` — 60 faker messages for UI testing (never wipes, append-only)
- `npm run typecheck` / `npm test` / `npm run build`

## License

ISC
