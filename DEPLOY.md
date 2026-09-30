# Deploying Vouch

Vouch is a single Streamlit container plus a local Ollama model server. All mutable state (users, expert
resolutions, the gap log) is in one SQLite file on the `/data` volume; the corpus, claims and config are baked
into the image and read-only.

## 1. Run it

```bash
cp .env.example .env            # review the settings below
docker compose up -d --build
docker compose exec ollama ollama pull qwen2.5:7b          # once, ~4.7 GB (optional: the app works without it)
docker compose exec vouch python -m vouch.accounts create-user \
    --username admin --display-name "Your Name" --role admin   # prompts for the password
```

Open http://localhost:8501 and log in as the admin. Colleagues register themselves (as **consultants**); on the
**Admin** page you promote experts and link them to their profile in the people directory
(`data/people.json`), which is what expert routing uses.

## 2. Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `VOUCH_ALLOW_REGISTRATION` | `true` | Self-registration (always as consultant). Set `false` to create accounts only via the CLI. |
| `VOUCH_SESSION_IDLE_MINUTES` | `60` | Idle time before a session is logged out. |
| `VOUCH_DEMO_MODE` | `false` | Shows the demo account names on the login page and the admin **Reset demo** button. Keep `false` in production. |
| `VOUCH_DEMO_PASSWORD` | — | Only for `python -m vouch.accounts seed-demo`. |
| `VOUCH_MODEL` | `qwen2.5:7b` | Ollama model. |
| `OLLAMA_HOST` | `http://ollama:11434` (in compose) | Model server. Not published outside the compose network. |
| `VOUCH_DB_PATH` | `/data/vouch.db` (in the image) | SQLite file. Back up the `vouch-data` volume. |

## 3. Put it on the internet safely

The compose file binds the app to `127.0.0.1:8501` on purpose. Put a TLS reverse proxy in front, for example Caddy:

```
vouch.example.com {
    reverse_proxy 127.0.0.1:8501
}
```

Streamlit uses a WebSocket (`/_stcore/stream`); Caddy and most proxies forward it automatically (for nginx add the
`Upgrade`/`Connection` headers).

## 4. Hardening already in place

- Container runs as a non-root user; application code is root-owned and read-only; only `/data` is writable.
- `no-new-privileges`, all Linux capabilities dropped, model server not exposed.
- Health check on `/_stcore/health` (`docker ps` shows `healthy`).
- `.streamlit/config.toml`: XSRF protection on, no usage stats, developer menu hidden, no stack traces to users.
- Passwords: salted scrypt; lockout after 5 failures; generic login errors; idle timeout; roles enforced server side.

## 5. Demo setup

```bash
# in .env: VOUCH_DEMO_MODE=true and VOUCH_DEMO_PASSWORD=<12+ chars>
docker compose exec vouch python -m vouch.accounts seed-demo
```

Accounts: `sophie` (consultant), `anna` and `pieter` (experts), `lotte` (admin). `seed-demo` is idempotent: run it
again to reset their passwords and roles. **Reset demo** (admin, demo mode only) clears requests and the gap log.

## 6. Operations

- **Backups:** copy `/data/vouch.db` (SQLite; safe to copy with `sqlite3 vouch.db ".backup backup.db"`).
- **Update knowledge:** add documents to `data/corpus/`, run `python -m vouch.extract`, rebuild the image.
- **Users:** `docker compose exec vouch python -m vouch.accounts list`.
