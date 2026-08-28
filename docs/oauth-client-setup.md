# OAuth2 Client App Setup Cheatsheet

This guide walks you through creating OAuth2 client apps for each premium AI
provider so tenants can sign in with their accounts (Google, ChatGPT, Claude,
etc.) instead of pasting API keys.

## How it works

Each premium provider has an OAuth flow defined in
`src/providers/registry.ts`. The flow is activated only when the corresponding
`*_OAUTH_CLIENT_ID` environment variable is set. When unset, the OAuth button
in the UI is disabled and users fall back to API key paste — the system still
works, just without the sign-in convenience.

## Redirect URI pattern

All providers use the same redirect URI pattern:

```
https://<control-plane-domain>/tenants/<tenant-slug>/agents/oauth/<provider>/callback
```

For local development:

```
http://localhost:8090/tenants/<tenant-slug>/agents/oauth/<provider>/callback
```

The `<provider>` segment is the provider id from the registry: `openai`,
`anthropic`, `google`, `openrouter`, `github-copilot`.

## Environment variables

Set these in `crowdrelay-agents/.env` (local) or the deployment environment
(production). All are optional — unset = OAuth disabled for that provider.

| Provider | Env Var (ID) | Env Var (Secret) | Secret Required? |
|----------|-------------|-----------------|-----------------|
| Google (Gemini) | `GOOGLE_OAUTH_CLIENT_ID` | `GOOGLE_OAUTH_CLIENT_SECRET` | Yes (authorization_code flow) |
| GitHub Copilot | `GITHUB_OAUTH_CLIENT_ID` | `GITHUB_OAUTH_CLIENT_SECRET` | Optional (device_code flow) |
| OpenAI (ChatGPT) | `OPENAI_OAUTH_CLIENT_ID` | `OPENAI_OAUTH_CLIENT_SECRET` | Optional (PKCE flow, usually empty) |
| Anthropic (Claude) | `ANTHROPIC_OAUTH_CLIENT_ID` | `ANTHROPIC_OAUTH_CLIENT_SECRET` | Optional (PKCE flow, usually empty) |
| OpenRouter | `OPENROUTER_OAUTH_CLIENT_ID` | `OPENROUTER_OAUTH_CLIENT_SECRET` | Optional (PKCE flow, usually empty) |

---

## Provider setup guides

### Google (Gemini) — easiest, fully supported

Google has proper OAuth2 with the Generative Language API scope. This is the
most straightforward setup.

**Prerequisites:** A Google account (free or paid). No billing required for
the OAuth app itself.

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or use an existing one).
3. Navigate to **APIs & Services → Credentials**.
4. Click **Create Credentials → OAuth client ID**.
   - If you see "To create an OAuth client ID, you must first configure your
     consent screen", click **Configure Consent Screen** first:
     - Choose **External** (unless you have a Google Workspace and want
       internal).
     - Fill in the app name (e.g. "CrowdRelay"), your email, and developer
       email.
     - Add the scope: `https://www.googleapis.com/auth/generative-language`
     - Add your redirect URI(s) under **Authorized redirect URIs**.
     - Save and publish (you can keep it in "Testing" mode for personal use —
       only your email will be able to sign in until verified).
5. Back on the credentials page:
   - Application type: **Web application**
   - Authorized redirect URIs: add your redirect URI(s)
     - Local: `http://localhost:8090/tenants/<slug>/agents/oauth/google/callback`
     - Production: `https://<domain>/tenants/<slug>/agents/oauth/google/callback`
   - Click **Create**.
6. Copy the **Client ID** and **Client Secret**.
7. Set env vars:
   ```
   GOOGLE_OAUTH_CLIENT_ID=xxxxx.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxxx
   ```

**Scopes used:** `https://www.googleapis.com/auth/generative-language`
**Flow type:** Authorization Code (with client secret)
**Token flavor:** Refresh token (long-lived)

---

### GitHub Copilot — device code flow, no redirect URI needed

GitHub uses the device code flow (the "sign in on another device" pattern).
No redirect URI is needed — the user visits `github.com/login/device` and
enters a code. This is the easiest flow to set up because there's no callback
URL to register.

**Prerequisites:** A GitHub account. The OAuth app needs to be owned by an
organization or user with access to Copilot subscriptions.

1. Go to [GitHub Settings → Developer settings → OAuth Apps](https://github.com/settings/developers).
2. Click **New OAuth App**.
   - Application name: "CrowdRelay Copilot Connector"
   - Homepage URL: your control plane URL
   - Authorization callback URL: `http://localhost:8090` (or your production
     URL — this is not used for device flow, but GitHub requires it)
3. Copy the **Client ID**.
4. Generate a **Client Secret** (optional for device flow, but we support it).
5. Set env vars:
   ```
   GITHUB_OAUTH_CLIENT_ID=Iv1.xxxxx
   GITHUB_OAUTH_CLIENT_SECRET=xxxxx
   ```

**Scopes used:** `read:user`
**Flow type:** Device Code (no redirect URI needed)
**Token flavor:** Short-lived exchange (GitHub user token → Copilot API token
via `api.github.com/copilot_internal/v2/token`)

**Note:** The Copilot token exchange hits an internal GitHub API. This is
inherently fragile — GitHub may change it. The code handles failures
gracefully (marks credential invalid, falls back to other providers).

---

### OpenRouter — official OAuth, PKCE

OpenRouter has proper OAuth2 with PKCE. When the user signs in, OpenRouter
returns an API key tied to their account.

**Prerequisites:** An OpenRouter account (free to create at
[openrouter.ai](https://openrouter.ai)).

1. Go to [OpenRouter Settings → API Keys](https://openrouter.ai/settings).
2. OpenRouter's OAuth flow is built into their web app. To create an OAuth
   client app:
   - Contact OpenRouter support or check their docs at
     [openrouter.ai/docs](https://openrouter.ai/docs) for the latest
     OAuth client setup process.
   - As of 2025, OpenRouter's auth flow at `https://openrouter.ai/auth`
     supports PKCE-based authorization. You may need to register your app
     with them directly.
3. Set env var:
   ```
   OPENROUTER_OAUTH_CLIENT_ID=xxxxx
   ```

**Scopes used:** None (OpenRouter manages scopes internally)
**Flow type:** Authorization Code + PKCE (no client secret needed)
**Token flavor:** API key returned (OpenRouter returns an API key, not a
refresh token — the key is stored as the credential)

**Fallback:** If you can't get an OAuth client ID, users can still paste an
OpenRouter API key directly. Get one at
[openrouter.ai/keys](https://openrouter.ai/keys).

---

### OpenAI (ChatGPT login) — experimental, CLI-mimic

**⚠️ Experimental:** OpenAI does not offer a public OAuth2 API for ChatGPT
plan access. This flow mimics the OAuth flow used by OpenAI's Codex CLI. It
may break at any time if OpenAI changes their auth system.

**Prerequisites:** A ChatGPT Plus/Pro/Team account. No developer portal
registration — the client ID is extracted from the Codex CLI.

1. Install the OpenAI Codex CLI:
   ```
   npm install -g @openai/codex
   ```
2. Run `codex auth login` and complete the sign-in.
3. Find the stored config:
   - macOS: `~/.codex/auth.json`
   - Linux: `~/.codex/auth.json`
4. The config contains the client ID used by the CLI. Extract the
   `client_id` field.
5. Set env var:
   ```
   OPENAI_OAUTH_CLIENT_ID=app_xxxxx
   OPENAI_OAUTH_CLIENT_SECRET=  (usually empty for PKCE)
   ```

**Scopes used:** `openid profile email offline_access`
**Flow type:** Authorization Code + PKCE
**Token flavor:** Refresh token

**Fallback:** If the OAuth flow breaks, users can paste an OpenAI API key
from [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
This uses the standard API, not their ChatGPT plan quota.

---

### Anthropic (Claude login) — experimental, CLI-mimic

**⚠️ Experimental:** Anthropic does not offer a public OAuth2 API for Claude
plan access. This flow mimics the OAuth flow used by Anthropic's Claude Code
CLI. It may break at any time.

**Prerequisites:** A Claude Pro/Max account. No developer portal registration
— the client ID is extracted from the Claude Code CLI.

1. Install the Claude Code CLI:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
2. Run `claude auth login` and complete the sign-in.
3. Find the stored config:
   - macOS: `~/.claude/auth.json`
   - Linux: `~/.claude/auth.json`
4. Extract the `client_id` field.
5. Set env var:
   ```
   ANTHROPIC_OAUTH_CLIENT_ID=app_xxxxx
   ANTHROPIC_OAUTH_CLIENT_SECRET=  (usually empty for PKCE)
   ```

**Scopes used:** `user:inference`
**Flow type:** Authorization Code + PKCE
**Token flavor:** Refresh token

**Fallback:** If the OAuth flow breaks, users can paste an Anthropic API key
from [console.anthropic.com](https://console.anthropic.com/).

---

## Providers without OAuth (API key only)

These providers do not offer OAuth2 — they only support API keys. They appear
in the **Providers** tab (not Premium AI) and are connected via API key paste:

| Provider | Where to get an API key |
|----------|----------------------|
| Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| xAI (Grok) | [console.x.ai](https://console.x.ai) |
| Zhipu (GLM) | [open.bigmodel.cn](https://open.bigmodel.cn) (China) or [z.ai](https://z.ai) (international) |
| Cognition (Devin) | [settings.devin.ai](https://settings.devin.ai) — needs API key + org ID |
| OpenCode Zen | No key needed (free tier, 100 req/day) |

---

## Verifying your setup

After setting the env vars, restart the agent-service:

```bash
# Local
cd crowdrelay-control-plane && just up

# Or manually
docker compose restart agent-service
```

Then check the providers endpoint:

```bash
curl http://localhost:8095/providers | jq '.providers[] | {id, oauthAvailable}'
```

Providers with `oauthAvailable: true` will show an active "Sign in" button in
the Premium AI tab. Those with `false` will show "OAuth not configured" and
users can still paste API keys.

## Security notes

- Client secrets are stored only in environment variables, never in the
  database or code.
- OAuth state rows are single-use and expire after 10 minutes.
- Tokens are encrypted at rest using `AGENT_SERVICE_ENCRYPTION_KEY`.
- The Copilot token exchange uses an internal GitHub API — this is inherently
  fragile and may break without notice.
- The OpenAI and Anthropic OAuth flows mimic their CLI clients' auth. These
  are not officially supported APIs and may break if the CLI auth changes.
