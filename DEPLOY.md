# Deploy AgentForge (public MVP)

One of these gets you a public URL so your agent can call the API.

---

## Option A: Render (one Blueprint)

1. Push this repo to GitHub.
2. [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint**.
3. Connect the repo; Render uses `render.yaml` at the root.
4. Click **Deploy Blueprint**. When prompted:
   - **REDIS_PASSWORD**: leave blank (or set if your Key Value instance uses auth).
   - **ROOT_URL**: leave blank for now.
5. After the first deploy, open your web service → **Environment** → set **ROOT_URL** to your service URL (e.g. `https://agentforge.onrender.com`) → **Save** (redeploys).
6. Open `https://<your-service>.onrender.com` → create the first user (admin) → copy that user’s **security token**.
7. Agent auth:  
   `POST https://<your-service>.onrender.com/api/v1/auth/anonymous`  
   Body: `{ "accessToken": "<security_token>" }`  
   Use the returned `authToken` as `Authorization: Bearer <authToken>` on API requests.

---

## Option B: Railway

1. Push this repo to GitHub.
2. [Railway](https://railway.app) → **New Project** → **Deploy from GitHub** → select this repo (Railway uses the root `Dockerfile` and `railway.toml`).
3. In the same project: **+ New** → **Database** → **PostgreSQL**; then **+ New** → **Database** → **Redis**.
4. Open your **app service** → **Variables** → add:
   - **DATABASE_URL** (from Postgres service).
   - **REDIS_HOST**, **REDIS_PORT**, **REDIS_PASSWORD** (from Redis service).
   - **JWT_SECRET_KEY**, **ACCESS_TOKEN_SALT** (any long random strings).
   - **ROOT_URL** = your public URL (e.g. `https://<your-app>.up.railway.app`) — set after **Generate Domain** in **Settings** → **Networking**.
5. Deploy; then create the first user and use the security token for the agent as in Option A (replace the base URL with your Railway URL).

---

## Env reference

| Variable            | Required | Notes                                           |
| ------------------- | -------- | ----------------------------------------------- |
| `DATABASE_URL`      | Yes      | Postgres URL from the host.                     |
| `REDIS_HOST`        | Yes      | Redis host.                                     |
| `REDIS_PORT`        | Yes      | Usually `6379`.                                 |
| `REDIS_PASSWORD`    | No\*     | Leave empty if Redis has no auth.               |
| `JWT_SECRET_KEY`    | Yes      | Long random string.                             |
| `ACCESS_TOKEN_SALT` | Yes      | Long random string.                             |
| `ROOT_URL`          | Yes      | Your app’s public URL (set after first deploy). |

\* App allows empty; required if your Redis has a password.
