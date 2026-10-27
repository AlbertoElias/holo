# Deployment runbook

Production shape (decided in
[features/live-deployment.md](features/live-deployment.md)): Fly.io hosts the
API (one machine, volume for SQLite), Cloudflare Pages hosts
the viewer, and Cloudflare R2 serves media from `media.holostud.io`.

Nothing here requires a dashboard-only step that an agent cannot reproduce
from the CLI. Secrets are never committed; only variable names live in the
repo.

## Automated deploys (CI-gated)

`.github/workflows/deploy.yml` deploys all three surfaces automatically
whenever the CI workflow completes successfully for a push to `main`:
Fly API, Pages viewer, Pages capture. Each job health-checks its URL
afterwards. Required repository secrets: `FLY_API_TOKEN` (a Fly deploy
token scoped to `holoim-api`), `CLOUDFLARE_API_TOKEN` (scoped token with
Cloudflare Pages edit permission), and `CLOUDFLARE_ACCOUNT_ID`. Manual
redeploys: Actions → Deploy → Run workflow. The manual steps below remain
the fallback and the way the accounts/projects were first created.

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

- **One machine, scaled to zero.** HoloIM is a sandbox/demo app, so
  `fly.toml` sets `auto_stop_machines = "stop"` and
  `min_machines_running = 0`: Fly stops the machine when idle and starts it
  on the next request (a few seconds cold start). You pay for running
  seconds plus the volume, roughly $1–3/month at demo usage versus ~$12
  always-on. Do not `fly scale count 2`: each machine gets its own volume
  and its own SQLite file.
- A stop can interrupt a USDZ conversion; the worker reclaims it after
  `USDZ_STALE_CLAIM_MS` once the machine runs again.
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

The Pages Function `apps/viewer-web/functions/index.ts` serves `/` with
the feed's first page inlined, plus a preload for the newest GLB, so a
first visit does not wait for the API's cold start. It reads
`feed/latest.json` from R2 through the `MEDIA` binding in
`apps/viewer-web/wrangler.toml`. The API rewrites that object after every
upload and delete, and at boot. Without the object or the binding, the
page is served unchanged and the feed loads from the API as before.

## 2b. Capture on Cloudflare Pages

The capture app is a static Vite build with no API wiring, so it deploys
like the viewer. Pages provides the non-localhost HTTPS origin WebXR
requires on the Quest browser. Run the deploy from `apps/capture`, not
through `pnpm --filter @holoim/web exec`: wrangler bundles the `functions/`
directory of the folder it runs in, and from `apps/viewer-web` that ships the
viewer's feed function onto capture.

```sh
pnpm --filter @holoim/capture... run build
pnpm --filter @holoim/web exec wrangler pages project create holoim-capture --production-branch main   # once
cd apps/capture && ../viewer-web/node_modules/.bin/wrangler pages deploy dist --project-name holoim-capture --branch main
```

Live at https://holoim-capture.pages.dev. Limits of the static deploy: the
dev-only input-recording sink (`/__holoim/input-recordings`, served by the
local Vite server) does not exist there, so recording headset input as a
replay fixture still happens against the local dev server. Capture calls
only the API's object-search routes (`/api/objects/*`: search, GLBs and
voice transcription), built with `VITE_API_ORIGIN=https://holoim-api.fly.dev`.
Poly Pizza's API terms forbid offering its models to third parties, so those
routes answer only the web origins, localhost and `CAPTURE_ORIGINS`
(default `https://holoim-capture.pages.dev` and its
`https://*.holoim-capture.pages.dev` previews); capture's origin stays out of
`WEB_ORIGINS`, which also governs the authenticated routes.

Object search secrets on `holoim-api` (each optional; the feature it enables
is off without it):

```sh
fly secrets set -a holoim-api POLYPIZZA_API_KEY="<key from poly.pizza/settings/api>"
# A Cloudflare API token with Workers AI read and run permission.
fly secrets set -a holoim-api WORKERS_AI_ACCOUNT_ID="<account id>" WORKERS_AI_API_TOKEN="<token>"
```

Without the Poly Pizza key, search shows Poly Haven alone. Without the
Workers AI pair, or once the account's free daily allowance (10,000 neurons,
about 200 audio minutes) is used up, `POST /api/objects/transcribe` answers
503 and capture falls back to typing; each client may transcribe 10
recordings a minute.

## 3. Media on R2 (Phase 2)

**Live since 2026-10-25.** Bucket `holoim-media`, served from
`https://media.holostud.io` (zone `holostud.io`, registered at Hover with
Cloudflare nameservers). `fly.toml` sets `STORAGE_DRIVER = "s3"`; the
`S3_*` values and `PUBLIC_MEDIA_BASE_URL` are Fly secrets. The steps below
are kept for rebuilding the setup from scratch.

The move was triggered by load time: the feed fetched four ~5 MB GLBs
uncompressed from one Fly region behind a scale-to-zero machine (6–20 s
each). R2 behind the zone serves them from the edge, brotli-compressed
(5.3 MB → 1.5 MB).

The original guidance: stay on the Fly volume while all of these hold: a
handful of demo holograms, Quick Look opt-in, one machine, low download
traffic. Move when any trigger hits:

- Volume passes ~70% full, or opted-in USDZ pairs grow past ~50.
- Download traffic becomes public/shared (Fly egress is $0.02/GB and
  competes with the API machine; R2 egress is free and CDN-cached).
- A second machine or region is needed (volumes are per-machine).
- Media must survive losing the Fly volume/machine.

1. Create the bucket: `wrangler r2 bucket create holoim-media`.
2. Attach a public custom domain (e.g. `media.<your-domain>`) in the R2
   dashboard — the `r2.dev` URL is rate-limited and not for production.
3. Create an R2 API token (Object Read & Write, this bucket) and set the
   secrets (`STORAGE_DRIVER = "s3"` itself lives in `fly.toml`):

```sh
fly secrets set -a holoim-api \
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

5. Zone rules for the media host. Cloudflare neither caches the `.glb`
   extension nor compresses `model/gltf-binary` by default, so without
   these the files pass through uncached (`cf-cache-status: DYNAMIC`) and
   uncompressed. USDZ is already a zip, so only GLB is compressed.

```sh
cf rulesets entrypoint update http_request_cache_settings -z holostud.io --rules \
  '[{"expression":"(http.host eq \"media.holostud.io\")","action":"set_cache_settings",
     "action_parameters":{"cache":true,"edge_ttl":{"mode":"respect_origin"},"browser_ttl":{"mode":"respect_origin"}}}]'
cf rulesets entrypoint update http_response_compression -z holostud.io --rules \
  '[{"expression":"(http.host eq \"media.holostud.io\" and ends_with(http.request.uri.path, \".glb\"))",
     "action":"compress_response","action_parameters":{"algorithms":[{"name":"brotli"},{"name":"gzip"}]}}]'
```

   Check: a second `curl -H 'Accept-Encoding: br' -I` of a GLB shows
   `content-encoding: br` and `cf-cache-status: HIT`.

6. Copy existing media from the volume before switching the driver
   (`fly ssh console -a holoim-api -C "ls /data/uploads"`, then
   `wrangler r2 object put holoim-media/<file> --remote` with
   `--content-type model/gltf-binary` or `model/vnd.usdz+zip`
   `--content-disposition inline`, and
   `--cache-control "public, max-age=31536000, immutable"`). The DTO
   builds URLs from storage keys, so no database rewrite is needed.

With `STORAGE_DRIVER=s3`, the DTO serves media from
`PUBLIC_MEDIA_BASE_URL` with immutable caching. Uploads to R2 go through
the API (`initiate` answers `multipart`, and the API writes the object):
R2 answers presigned POST with `501 NotImplemented`, so the direct
browser → bucket path (presigned POST, 25 MB cap enforced by policy +
completion checks) only runs against S3 proper. Local
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
