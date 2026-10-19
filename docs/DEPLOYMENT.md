# Deployment runbook

Production shape (decided in
[features/live-deployment.md](features/live-deployment.md)): Fly.io hosts the
API (one machine, volume for SQLite + local uploads), Cloudflare Pages hosts
the viewer, and Cloudflare R2 serves media once `STORAGE_DRIVER=s3`.

Nothing here requires a dashboard-only step that an agent cannot reproduce
from the CLI. Secrets are never committed; only variable names live in the
repo.

## 0. Accounts and CLIs (one-time, operator)

1. Create a [Fly.io](https://fly.io) account (a card is required) and a
   [Cloudflare](https://dash.cloudflare.com) account.
2. Install Fly CLI: `brew install flyctl`, then `fly auth login`.
   Wrangler is a project-local devDependency of `apps/viewer-web`
   (Cloudflare's recommended install, kept at `@latest`); run it through
   pnpm and log in once: `pnpm --filter @holoim/web exec wrangler login`.

## 1. API on Fly

From the workspace root (the Docker build context is the monorepo root):

```sh
fly apps create holoim-api            # skip if it already exists
fly volumes create holoim_data --size 3 --region iad -a holoim-api
fly secrets set -a holoim-api \
  WEB_ORIGIN="https://holoim-viewer.pages.dev" \
  WEB_ORIGINS="https://holoim-viewer.pages.dev,https://*.holoim-viewer.pages.dev"
fly deploy -c fly.toml
fly open -a holoim-api                # opens https://holoim-api.fly.dev/healthz path manually
curl https://holoim-api.fly.dev/healthz   # {"status":"ok"}
```

Rules that keep this topology correct:

- **One machine.** `fly.toml` pins `min_machines_running = 1` with
  auto-stop off. Do not `fly scale count 2`: each machine gets its own
  volume and its own SQLite file.
- The embedded USDZ worker runs in the same process (SQLite phase). The
  machine is sized `shared-cpu-2x` / 2 GB for the Python converter.
- Volumes are billed at $0.15/GB-month with no free allowance on new
  Fly organisations, so start small: 3 GB (~$0.45/month) holds roughly
  800 median GLBs, or ~30 GLB+USDZ demo pairs at ~90 MB per USDZ. Grow
  it any time with `fly volumes extend`. With Quick Look opt-in and a
  handful of demo holograms, the volume is not a near-term constraint.
- Volume snapshots are the backup story for the SQLite index:
  `fly volumes snapshots list <volume-id>`. R2 media without a database
  row is unreachable, so snapshot before risky operations.

## 2. Viewer on Cloudflare Pages

```sh
VITE_API_ORIGIN="https://holoim-api.fly.dev" pnpm --filter @holoim/web build
pnpm --filter @holoim/web exec wrangler pages deploy dist --project-name holoim-viewer
```

Or connect the GitHub repo in the Pages dashboard with build command
`pnpm --filter @holoim/web build`, output `apps/viewer-web/dist`, and
`VITE_API_ORIGIN` set in the project environment. Preview deployments get
`https://<branch>.holoim-viewer.pages.dev` URLs, which the API allows via
the `WEB_ORIGINS` wildcard above.

## 3. Media on R2 (Phase 2)

The code already supports R2; this section is a configuration flip, not
a project. Stay on the Fly volume while all of these hold: a handful of
demo holograms, Quick Look opt-in, one machine, low download traffic.
Move when any trigger hits:

- Volume passes ~70% full, or opted-in USDZ pairs grow past ~50.
- Download traffic becomes public/shared (Fly egress is $0.02/GB and
  competes with the API machine; R2 egress is free and CDN-cached).
- A second machine or region is needed (volumes are per-machine).
- Media must survive losing the Fly volume/machine.

1. Create the bucket: `wrangler r2 bucket create holoim-media`.
2. Attach a public custom domain (e.g. `media.<your-domain>`) in the R2
   dashboard — the `r2.dev` URL is rate-limited and not for production.
3. Create an R2 API token (Object Read & Write, this bucket) and set:

```sh
fly secrets set -a holoim-api \
  STORAGE_DRIVER="s3" \
  S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  S3_REGION="auto" \
  S3_BUCKET="holoim-media" \
  S3_ACCESS_KEY_ID="<token id>" \
  S3_SECRET_ACCESS_KEY="<token secret>" \
  PUBLIC_MEDIA_BASE_URL="https://media.<your-domain>"
fly deploy -c fly.toml
```

4. Bucket CORS (R2 dashboard → bucket → Settings → CORS policy). Browsers
   PUT to presigned URLs and fetch GLB bytes cross-origin, so the bucket —
   not just the API — needs CORS:

```json
[
  {
    "AllowedOrigins": [
      "https://holoim-viewer.pages.dev",
      "https://*.holoim-viewer.pages.dev",
      "https://localhost:3174"
    ],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

With `STORAGE_DRIVER=s3`, uploads go browser → R2 directly (presigned
POST, 25 MB cap enforced by policy + completion checks), and the DTO
serves media from `PUBLIC_MEDIA_BASE_URL` with immutable caching. Local
development keeps `STORAGE_DRIVER=local` and needs no credentials.

**Orphan cleanup.** Abandoned direct uploads leave objects under
`incoming/`. List and remove stale ones (nothing references that prefix
after completion):

```sh
wrangler r2 object list holoim-media --prefix incoming/   # inspect first
```

Delete only after confirming the keys are older than the 10-minute intent
expiry and unreferenced.

## 4. Post-deploy checks (operator, physical devices)

Automated checks do not prove these; record results in the feature brief:

- Open the Pages URL on a Quest headset: feed loads, a hologram renders,
  WebXR session enters (the URL is a non-localhost secure origin).
- On an iPhone: upload a hologram, wait for "View in AR" to replace
  "Preparing preview…", tap it, confirm Quick Look plays the animation.
- Upload from the capture app against the live API and view it in the feed.

## 5. Later exits (already decided, not yet built)

- Postgres (Neon/Supabase URL + Prisma provider swap) when accounts/auth
  land; that unlocks scaling beyond one machine and a separate converter
  app. Until then, converter separation is impossible on a Fly volume —
  see the brief, B1.
- Fly Managed Postgres was rejected on price (~$38/mo) versus Neon.
