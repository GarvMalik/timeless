# Timeless — Brand Assets

Primary mark: **Presence** (outlined infinity with emerald dot at center).

## Files

- `svg/` — source vector files (scale infinitely, edit in any vector tool)
  - `mark-light.svg`, `mark-dark.svg` — mark with emerald dot
  - `mark-mono-black.svg`, `mark-mono-white.svg` — single-color
  - `app-icon-{light,dark,emerald}.svg` — 1024×1024 rounded-square icon
  - `wordmark-{light,dark,mono-black,mono-white}.svg`
  - `favicon.svg` — the recommended favicon (used by the site)

- `png/`
  - `app-icon/{light,dark,emerald}/icon-{1024,512,256,192,180,152,120}.png`
    - 1024: App Store / Play Store master
    - 512, 192: PWA / Android
    - 180: iOS home screen (apple-touch-icon)
    - 152, 120: iPad / older iOS
  - `favicon/favicon-{16,32,48,64,96,128,180,256,512}.png`
  - `mark/{light,dark,mono-black,mono-white}/mark-*.png` — mark only, transparent PNG for mono
  - `wordmark/{light,dark,mono-black,mono-white}/wordmark-*.png` — full lockup

## Color tokens
- Ink `#141712`
- Paper `#fbf9f2`
- Emerald `#0f9d58`

## Recommended HTML

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png" />
<link rel="manifest" href="/site.webmanifest" />
```
