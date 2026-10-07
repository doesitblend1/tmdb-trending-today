# TMDB Top Today (Stremio addon)

Drop-in refactor of the single-file addon. Same manifest id, same install-URL config format, same image/pattern URLs,
same dependencies (`express`, `sharp`, `stremio-addon-sdk`). Needs Node 18+.

## Run

```
TMDB_API_KEY=... ADDON_URL=https://your.host node server.js
```

| Variable | Default | |
|---|---|---|
| `TMDB_API_KEY` | required | startup fails with a clear message if missing |
| `ADDON_URL` | required | public base URL, e.g. `https://addon.example.com` (trailing slash is stripped) |
| `PORT` | `7000` | |
| `CACHE_DIR` | `./image-cache` | point at a volume to keep generated images across deploys |
| `RENDER_CONCURRENCY` | `4` | images composited at once (CPU/RAM bound) |
| `IMAGE_FORMAT` | `jpg` | format of the artwork URLs handed out by the catalog and configure page (`jpg` or `png`) |

## Test

```
node --test test/*.test.js
```

The route tests use a small Express stand-in (`test/helpers/miniExpress.js`) and a fake TMDB (`test/helpers/fakeTmdb.js`),
so they run offline with no API key.

## Layout

```
server.js               entry point
src/env.js              env validation
src/tmdb.js             TMDB client: timeouts, retry/backoff, de-dupe, TTL cache + stale-if-error, frozen results
src/tags.js             badge rules (movie + series) as pure functions; tunable windows in WINDOW
src/media.js            release dates, shared trending list + rank lookup, genres, tag resolution
src/userConfig.js       install-URL settings: one schema, legacy aliases, validation
src/catalog.js          manifest + catalog handler
src/artwork.js          poster/backdrop renderer (one pipeline, layout table for the differences)
src/imageStore.js       memory (byte-capped) + disk cache, atomic writes, sweeper
src/http.js             request validation + Express helpers
src/routes/             addon routes, image routes
public/configure.html   the configure page (was a string inside server.js)
```

## Behaviour changes worth knowing

- **Artwork is JPEG by default.** The extension in the URL picks the format: `/poster/123.jpg` is a JPEG (quality 90, full
  chroma), `/poster/123.png` is a PNG exactly as before. Catalog URLs and the configure page now use `.jpg`; on real photos
  the files are ~7-9x smaller and encode ~40% faster. Existing installs and saved AIOMetadata patterns that use `.png` keep
  working unchanged; paste the new `.jpg` pattern URLs from the configure page to get the smaller files there too.
  Set `IMAGE_FORMAT=png` to keep handing out `.png` URLs.

- In landscape mode the background now follows the backdrop settings (tags, ranks, logos, language), just like portrait.
  It used to be TMDB's plain textless image. For the old look, set Backdrop language to Textless and turn backdrop tags off.
- The optional **Curated** setting is available independently for posters and backgrounds. It uses textless artwork
  and adds the title logo with a subtle radial halo only when sampled logo-to-artwork contrast is below 3:1. If a
  textless image has no usable title logo, the title is rendered as text instead. Portrait posters fall back to a
  centered, cropped textless background when no textless poster is available.
- `/image/...` and `/landscape/...` (AIOMetadata patterns) now use exactly the same tag rules as the catalog. Before, the
  series rules had drifted between the two.
- A movie with no digital date is no longer "Coming Soon" if it is already on disc, or its first cinema release was more
  than a year ago (`WINDOW.staleTheatrical`).
- Query parameters are validated: numeric ids (else 400), only known tags, numeric ranks, language codes. Anything else
  falls back to the default instead of reaching TMDB or being drawn onto an image.
- Redirects to TMDB are 302 (were 301) and the backdrop passthrough uses `w1280` (was `original`).
- Missing artwork gives a locally generated placeholder instead of a redirect to via.placeholder.com.
- Catalog responses carry cache headers (15 min); TMDB outages serve the last good copy for up to 6 h.
- TMDB failures return 502 (were 500); unknown catalog ids return 404.
- Manifest version is 2.1.0.
- Old files in `image-cache/` use a different key format; the sweeper deletes them once they are 24 h old (it only touches
  `.png`, `.jpg` and `.tmp` files).
