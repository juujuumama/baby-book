# Baby Book

A cozy, private helper for making a scrapbook-style baby book from phone photos.
Sort photos by the baby's age in months, pick favorites, and (soon) match printed
photos and plan 12×12 pages.

**Everything runs on your device.** Photos are never uploaded. There are no accounts,
servers, or paid services. It's a static web app you can host for free.

## Status

| Step | Feature | State |
| --- | --- | --- |
| 1 | Import, on-device storage, timeline by month of age | ✅ done |
| 2 | Print-matching sort (table photo + one-at-a-time) | ✅ done |
| 3 | Cut-sheet export (12×12 sheets of a month's photos) | planned |
| 4 | Collage pages with soft cutouts and stickers | planned |

### What works now
- **Import** from the camera roll (JPEG, PNG, HEIC). Photos are decoded and resized on the
  device: a 3000 px copy for printing and layouts, plus a small thumbnail. HEIC is read natively
  in Safari. Other browsers download a bundled decoder the first time they need it.
- **No duplicates.** If you pick the same photo again, it's skipped, even when one copy is HEIC
  and the other is the JPEG the phone converted.
- **Timeline by month of age**, worked out from the birth date in Settings and each photo's EXIF
  date. Photos are grouped by day, and US holidays and birthdays are labeled automatically.
- **Needs a date** pile for photos with no date (texted photos, screenshots). It suggests dates
  found in file names and lets you date several photos at once.
- **Favorites**: tap ♡ on any photo. The month chips and headers show how many favorites
  each month has.
- **Backup & restore** of the whole book as `.zip` file(s) you can save to iCloud Drive or Files.
  Very large books are split into parts of 1.5 GB or less.
- **Sort prints** (Sort prints tab):
  - *A whole batch:* lay up to 30–40 prints on a table or floor and take one photo. Each print is
    found, straightened, matched to its photo, and numbered in date order on your picture, with its
    age and date. A list below gives "4 mo · Aug 6 · #4 of 12" for each print. Anything uncertain
    is marked "?" and you pick from the closest matches.
  - *One at a time:* hold a print up to the camera to see "5 mo · Jun 12 · #14 of 38".
  - Matched photos are marked "printed" in the timeline.
- **Works offline** and installs to the Home Screen (PWA). It also asks the browser for
  persistent storage.

## Using it on iPhone
1. Open the site in Safari.
2. Tap **Share → Add to Home Screen**, then open Baby Book from the Home Screen.
   (iOS can delete website data for sites that aren't on the Home Screen.)
3. Enter the birth date, then add photos. You can add a month at a time or everything at once.
4. After each big batch, go to **Settings → Back up everything** and save the file to iCloud Drive.

## Development
```bash
npm install
npm run dev       # local dev server (also reachable from your phone on the same Wi-Fi)
npm test          # unit tests
npm run build     # production build in dist/
npm run icons     # re-render PNG icons from public/icon.svg (needs Playwright)
```

Stack: Vite + Preact + TypeScript, IndexedDB (`idb`), `exifr` for EXIF, `heic-to` (libheif)
for HEIC, `vite-plugin-pwa` for offline support.

### Code map
- `src/lib/dates.ts`: local-date math, month-of-age calculation, formatting
- `src/lib/holidays.ts`: US holidays (incl. Easter and floating holidays) and birthdays
- `src/lib/importer.ts`, `image.ts`, `exif.ts`: on-device import pipeline
- `src/lib/db.ts`: IndexedDB storage (photo metadata and image blobs)
- `src/lib/backup.ts`, `zip.ts`: backup/restore as stored ZIP files
- `src/lib/timeline.ts`: groups photos into months and days
- `src/lib/vision/`: print detection (`detect.ts`), perspective straightening (`warp.ts`),
  fingerprint matching (`match.ts`) and the batch pipeline (`pipeline.ts`). Pure TypeScript with
  no dependencies, tested on synthetic table photos in `tests/vision.test.ts`.
- `src/components/`: UI

## Deploying (free)
**GitHub Pages:** the workflow in `.github/workflows/deploy.yml` builds and publishes on every
push to `main`. One-time setup: repository **Settings → Pages → Source: GitHub Actions**.

**Netlify:** build command `npm run build`, publish directory `dist`.

All asset paths are relative, so the app works from any sub-path.
