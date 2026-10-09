# studio-juicebox.com

The Studio Juicebox site: an [Astro](https://astro.build) static site, deployed on Vercel from the `main` branch. Every branch and pull request gets a Vercel preview deployment.

```bash
npm install
npm run dev      # local site at http://localhost:4321
npm run build    # static build into dist/
npm test         # unit tests for the /lately API
```

## How it's put together

| Path | What it is |
| --- | --- |
| `src/pages/` | One file per page. All pages are pre-built HTML. |
| `src/components/`, `src/layouts/` | Shared nav, footer and page shell. |
| `public/` | Images, fonts, the Webflow-exported CSS, and the standalone questionnaire at `public/forms/`. |
| `api/` | Vercel serverless functions. They sit next to the static site, so the Astro build is unchanged and there is no adapter. Files starting with `_` (such as `api/_lib/`) are helpers, not routes. |
| `vercel.json` | Only adds a no-index header to `/lately`. |
| `test/` | Tests, run with Node's built-in test runner. |

`astro dev` does not run `api/`. To try the API-backed pages locally use the mock described under [Lately](#lately-the-unlisted-page-at-lately), or test on a Vercel preview.

## Environment variables

Set these in Vercel (Project → Settings → Environment Variables). Never commit values; `.env` is git-ignored.

| Variable | Used by | Notes |
| --- | --- | --- |
| `LATELY_PASSCODE` | `/lately` editing | The passcode you type to unlock editing. Use a long one. Changing it signs every device out. Mark it Sensitive. |
| `BLOB_READ_WRITE_TOKEN` | `/lately` storage | Added automatically when you connect a Blob store to the project. |
| `RESEND_API_KEY` | questionnaire | See below. |

Enable each variable for **Production and Preview** (and Development if you use `vercel env pull`). A preview deployment without them can't load or edit `/lately`.

## The questionnaire

`public/forms/project-questionnaire.html` is a single-file form. Duplicate it per project and edit the `CONFIG` object at the top of its script. Submissions post to `api/submit-questionnaire.js`, which emails them with [Resend](https://resend.com).

Until `studio-juicebox.com` is a verified sending domain in Resend, mail goes out from Resend's shared sandbox address and can only be delivered to the Resend account's own email, so recipients are set to `glen@studio-juicebox.com` and mail may land in spam. Once the domain is verified, change `FROM_ADDRESS` and `TO_ADDRESS` in the function.

## Lately: the unlisted page at `/lately`

A masonry grid of what's being made at the moment (images and short videos with a title, a line, an optional link and a project tag), filterable by project. It is for sending to studios, so it is **unlisted**: not linked from anywhere, `noindex` (meta tag and `X-Robots-Tag` header), and there is no sitemap. There is deliberately no `robots.txt` entry for it, since that would publish the URL. Anyone with the link can view it.

`?p=Patch` opens the page filtered to one project.

### Editing

Open `/lately#edit`, enter the passcode, and an **Upload** button appears at the top left. Nothing about editing is visible to visitors.

- **Add:** pick, drop or paste images and videos, then fill in the title, line, link and project. New tiles go to the top. A new project name can be typed straight into the project field.
- **Images** are re-encoded in the browser to WebP, or, for browsers that can't encode WebP (Safari, including on iPhone), to JPEG at quality 0.85. Either way the longest side is at most 2000px and all metadata is stripped. JPEG has no transparency, so anything see-through gets a white background. GIFs are refused, because they'd be flattened to a still: convert to MP4 and upload that as a video.
- **Videos** are uploaded as they are, up to **20 MB** (MP4/H.264 plays everywhere; MOV from an iPhone may not play in every browser). A poster frame is captured in the browser and stored in Blob next to the video. Videos are shown with that poster and `preload="none"`, so nothing downloads until someone presses play.
- **Lazy loading:** images and video posters below the first screen load as they come near the viewport.
- **Edit, reorder, delete** each tile with the buttons under it. Reorder by dragging (mouse) or with Earlier / Later (works on a phone). Deleting a tile removes its file, and poster, from Blob too.
- The hello text at the top is editable in place. It saves when you click away.
- **Lock** signs this browser out.

### Storage

[Vercel Blob](https://vercel.com/docs/vercel-blob), no database. Media lives under `lately/media/`, and the page content is one JSON file, `lately/tiles.json`, in the same store. The JSON is written with an ETag check, so a stale tab can't overwrite newer changes: it reloads and retries instead.

> **Preview and production share one Blob store.** A preview deployment reads and writes the same files as production, so anything uploaded, edited or deleted on a preview is live straight away.

#### One-time setup in Vercel

1. Project → **Storage** → create a **Blob** store, with public access, and connect it to this project for Production, Preview and Development. This adds `BLOB_READ_WRITE_TOKEN`.
2. Project → Settings → Environment Variables: add `LATELY_PASSCODE` for Production and Preview, marked Sensitive.
3. Redeploy so the new variables apply.

### API

| Route | Who | What |
| --- | --- | --- |
| `GET /api/lately/tiles` | anyone | The page content, and whether this browser can edit. |
| `PUT /api/lately/tiles` | editor | Replace the page content (validated server-side). Files no longer referenced are deleted from Blob. |
| `DELETE /api/lately/tiles` | editor | Discard uploaded files that never made it onto the page. Never touches files in use. |
| `POST /api/lately/upload` | editor | Hands the browser a short-lived token to upload straight to Blob (a function can't take a 20 MB body). The server decides the allowed types, size limit and folder. |
| `POST /api/lately/login` | anyone | Checks the passcode, sets the session cookie. |
| `POST /api/lately/logout` | anyone | Clears the cookie. |

### Security

- The passcode is only ever read from `LATELY_PASSCODE` on the server. It is compared in constant time (both sides hashed first, then `timingSafeEqual`).
- A correct passcode sets a signed (HMAC-SHA-256), `HttpOnly`, `Secure`, `SameSite=Strict` cookie that lasts 30 days. The signing key is derived from the passcode.
- Every route that changes anything, or issues an upload token, refuses without a valid cookie. Writes also require a JSON request and a same-origin `Origin`.
- The server validates everything it stores: media URLs must be in the Blob store's `lately/media/` folder, links must be `http(s)`, and text lengths are capped.
- Serverless functions share no memory, so there is no real rate limiting on login. Wrong guesses just get a slow response. Use a long passcode.
- Run `npm test` after touching anything in `api/`. The tests prove that missing, forged, expired and wrongly signed cookies are refused on every upload and edit route.

### Trying it locally

`npm run dev`, then open **`/lately?mock`** to see the page as a visitor, or **`/lately?mock&edit`** to start unlocked (the mock passcode is `mock`). This runs the page against an in-memory fake of the API with sample tiles. Nothing is saved, and the mock code is stripped from production builds (it sits behind `import.meta.env.DEV`).

Real uploads and the real passcode can only be tried on a Vercel deployment, where `api/` and Blob exist.

## Secrets

No secrets, tokens or passcodes belong in the repo. Before pushing, scan the commits with [gitleaks](https://github.com/gitleaks/gitleaks):

```bash
gitleaks git --redact --no-banner .
```

## Known limitations

- A video's poster frame is captured by the browser itself, so the browser has to be able to play the clip. If it can't, the page says so; export as MP4 (H.264), which plays everywhere.
- `astro dev` doesn't run `api/`; use the mock locally.
- Vercel Blob's free allowance is small. Many 20 MB videos will use it up, so check usage in the Vercel dashboard.
- `npm audit` reports issues in Astro's own dependencies (devalue, sharp, smol-toml and others). They predate the Lately work and are not in `@vercel/blob`.
