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
- **Terminal UI** — sidebar contacts with unread badges, chat bubbles, scrollback,
  add/edit-contact modal, online (`●`) / offline (`○`) indicator, server errors as
  transient toasts. Reconnects with backoff and keeps retrying.
- **Durable local data** — SQLite in your OS data dir (survives npm updates) plus a
  device identity key. Automatic schema migrations.

## Requirements

- Node.js ≥ 22
- A running yapr-server (TLS). For local dev, its self-signed cert.

## Quickstart

```bash
npm install -g @sprunkzzz/yapr   # or: npm ci && npm run build && npm link
cp .env.example .env             # dev scripts need a .env file present
```

Edit `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `9000` | Server endpoint (TLS only) |
| `YAPR_CA_FILE` | — | Server CA/cert for self-signed dev setups (copy the server's `dev-cert.pem`) |
| `YAPR_INSECURE` | — | Set `1` to skip verification. Localhost dev only, never elsewhere |
| `YAPR_DATA_DIR` | OS data dir | Override for the database + identity key |

Then:

```bash
npm run dev    # tsx + TUI
```

Keys:

- `Tab` cycles sidebar → thread → textbox. `q` quits (outside the textbox).
- Sidebar (open chats): `↑/↓` move, `→`/`Enter` open, `c` or `≡ Contacts…` opens the
  browser, `x` closes a chat (stays a contact), `d` deletes a contact (two-step confirm,
  history is kept).
- Thread: `↑/↓` scroll. Opening a thread marks it read (sends receipts). Every message
  shows its local time (`14:32 ✓✓`); older ones get a day prefix.
- Composer: `Enter` sends, `Ctrl+J` inserts a newline (multiline drafts grow to 8 rows),
  `Shift+Enter` also inserts a newline on terminals that report it.
- `s` opens Settings (nickname + what you reveal where + theme). First run registers you
  automatically (identity key created locally) and identifies on every later start.
  Your numeric ID is in the header — share it so people can add you.

## Formatting and themes

Mark emphasis inline — it travels inside your encrypted text and renders in each
reader's own theme, so everyone agrees on *what* is emphasized:

- `$C1[...]`, `$C2[...]`, `$C3[...]` — three emphasis levels (strongest first)
- `**bold**`, `` `code` `` — a lone `*` needs no escape; `\` escapes `$`, `*`, backtick
- Unclosed markers render literally; no nesting in this version

Pick a theme in Settings (`moss`, `amber`, `ocean`, `mono`). Every theme keeps the
emphasis ramp ordered brightest-first, so `$C1` always outshines `$C3`.

## Contacts and keys

The sidebar holds **open chats**; **Contacts** (`c`) holds everyone. There you can start
a chat, rename, delete, or add by ID. Add contacts by their server user ID with any
alias you like (IDs can't be renamed later — they anchor history; aliases can).
Unknown senders appear automatically so replies just work. Public keys are fetched
from the server directory on demand and cached locally; if a message can't be
decrypted you see `[encrypted message — update yapr to read it]` instead of garbage.

Your **nickname** and reveal toggles (Settings, `s`) are stored locally in preparation
for group chats: the nickname will travel inside your encrypted envelopes — never
visible to the server — once groups land. Until then they change nothing.

## Troubleshooting

- `yapr needs an interactive terminal` — run in a real terminal, not a pipe.
- Stuck `○` offline — check `HOST`/`PORT` and that the server is up; TLS failures
  (wrong CA, expired cert) also present as offline.
- `UPGRADE_REQUIRED` toast — client/server protocol mismatch; upgrade both.
- `Alias already taken` / `ID already exists` — pick another alias; IDs are unique.
- Lost `identity.key` (see below) means new messages from others can't be decrypted —
  back it up.

## Data and files

| Location | Contents |
|---|---|
| Linux `~/.local/share/yapr`, macOS `~/Library/Application Support/yapr`, Windows `%APPDATA%/yapr` (or `$YAPR_DATA_DIR`) | `yapr.db` (history, contacts, key cache), `identity.key` (device private key, `0600`) |

`identity.key` is the crown jewel: anyone holding it can read your incoming history.
Back it up encrypted, never share it. Deleting the data dir logs you out and orphans
readable history (re-registering creates a new account).

## Scripts

- `npm run dev` / `npm start` (after `npm run build`) — run the TUI
- `npm run db:seed` — 60 faker messages for UI testing (never wipes, append-only)
- `npm run typecheck` / `npm test` / `npm run build`

## License

ISC
