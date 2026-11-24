# Hair Cuts around the World — map

Interactive map of Jan Hoffmann's study [Hair Cuts around the World](https://janhoffmann.live/2026/04/28/hair-cuts/).
Static site, no build step: `index.html`, `styles.css`, `app.js`, `lib/`, `data/`.

## How it stays up to date

On every page load the map reads the post's gallery live from the WordPress.com public API
(captions, photo dates, GPS). If that fails it falls back to `data/snapshot.json`.

Each set of photos taken within three hours counts as one hair cut. Its place comes from, in order:

1. `data/overrides.json` (manual fixes by attachment id; `{ "place", "source" }` shows the evidence on the map),
2. a caption, alt text or description naming a city or country in `data/places.json`,
3. the photo's GPS position.

Photos without EXIF get their date from the file name where it has one (`2013-06-25+16.24.54`,
`20191204_175125`). Undated photos join the dated visit to the same place when there is only one.

**Adding a hair cut (Jan):** upload the photos to the post as usual and write the town or
country as the caption of one of them. Nothing else to do. If the town is not yet known to the
map, write `Town, Country` and the country is enough.

**Adding a country to the list:** add an entry to `places` in `data/places.json`
(`iso` = ISO 3166-1 numeric code; `lat`/`lon` = where its marker sits).

## Run locally

```powershell
python -m http.server 8130
```

Then open http://localhost:8130. Refresh the offline copy with `npm run snapshot` (Node 18+).

Each hair cut links to Jan's blog posts with photos from the same days, from `data/posts.json`.
Refresh that index after he publishes new trips with `npm run posts`.

## Privacy

GPS positions are rounded to three decimals when read and to one decimal (about 10 km) for
markers. Thumbnails are requested with `strip=info`, which removes EXIF data.
