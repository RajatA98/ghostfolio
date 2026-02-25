# Deploy AgentForge (public MVP) — Railway

Use Railway to get a public URL so your agent can call the API.

---

## Railway steps

1. **Push this repo to GitHub** (if not already).

2. **Create project**  
   [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub** → select this repo.  
   Railway uses the root `Dockerfile` and `railway.toml`.

3. **Add Postgres**  
   In the same project: **+ New** → **Database** → **PostgreSQL**.  
   Open the Postgres service → **Variables** (or **Connect**) → copy **`DATABASE_URL`** (or the connection URL).

4. **Add Redis**  
   **+ New** → **Database** → **Redis**.  
   Open the Redis service → **Variables** → note **Host**, **Port**, **Password** (or the connection URL).

5. **Generate public URL**  
   Open your **app service** (the one from the repo) → **Settings** → **Networking** → **Generate Domain**.  
   Copy the URL (e.g. `https://agentforge-production.up.railway.app`).

6. **Set app env vars**  
   App service → **Variables** → **Add variable** (or **RAW Editor**). Add:

   | Variable            | Where to get it                                                           |
   | ------------------- | ------------------------------------------------------------------------- |
   | `DATABASE_URL`      | Postgres service → Variables / Connect                                    |
   | `REDIS_HOST`        | Redis service → Variables (host)                                          |
   | `REDIS_PORT`        | Redis service → Variables (port, e.g. 6379)                               |
   | `REDIS_PASSWORD`    | Redis service → Variables (password; can leave empty if none)             |
   | `JWT_SECRET_KEY`    | Any long random string (e.g. `openssl rand -hex 32`)                      |
   | `ACCESS_TOKEN_SALT` | Another long random string                                                |
   | `ROOT_URL`          | The URL from step 5 (e.g. `https://agentforge-production.up.railway.app`) |

   **Tip:** For Postgres/Redis, Railway can “Reference” variables from the other services so you don’t copy-paste secrets.

7. **Deploy**  
   Save variables; Railway redeploys. Wait for the deploy to finish.

8. **Create first user**  
   Open **ROOT_URL** in a browser → **Get started** → create an account (this user is admin).

9. **Get token for the agent**  
   In the app: open that user’s **Account** / **Settings** → copy the **security token**.

10. **Agent auth**
    - `POST <ROOT_URL>/api/v1/auth/anonymous`
    - Body: `{ "accessToken": "<security_token>" }`
    - Use the returned **authToken** as `Authorization: Bearer <authToken>` on all API requests.

---

## Alternative: Render

1. Push to GitHub.
2. [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint** → connect repo (uses `render.yaml`).
3. **Deploy Blueprint**; when prompted, leave **REDIS_PASSWORD** and **ROOT_URL** blank for now.
4. After deploy: set **ROOT_URL** in the web service env to your Render URL → Save.
5. Open the URL → create first user → copy security token → use `POST .../api/v1/auth/anonymous` and Bearer token as above.

---

## Env reference

| Variable            | Required | Notes                                           |
| ------------------- | -------- | ----------------------------------------------- |
| `DATABASE_URL`      | Yes      | Postgres connection URL.                        |
| `REDIS_HOST`        | Yes      | Redis host.                                     |
| `REDIS_PORT`        | Yes      | Usually `6379`.                                 |
| `REDIS_PASSWORD`    | No\*     | Leave empty if Redis has no auth.               |
| `JWT_SECRET_KEY`    | Yes      | Long random string.                             |
| `ACCESS_TOKEN_SALT` | Yes      | Long random string.                             |
| `ROOT_URL`          | Yes      | Your app’s public URL (set after first deploy). |

\* App allows empty; required only if your Redis has a password.
