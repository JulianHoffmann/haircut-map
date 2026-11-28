"""Adds hair-cut photos that are not in Jan's blog gallery (e.g. Lightroom exports) to the map.

Usage:
    python scripts/add_extra_photos.py "<folder with .jpg files>" "<town or country>" ["<note shown on the map>"]

Each photo is resized (1600 px for viewing, 480 px thumbnail) with its metadata removed, saved
under photos/, listed in data/extra-photos.json and placed via data/overrides.json. Running it
again for the same files replaces them. If Jan later uploads the same files to his post, the map
shows the gallery copy and skips these.
"""

import datetime as dt
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
EXTRAS_FILE = ROOT / "data" / "extra-photos.json"
OVERRIDES_FILE = ROOT / "data" / "overrides.json"
LARGE_PX = 1600
THUMB_PX = 480
DEFAULT_NOTE = "From Jan's photo archive (not in the blog gallery)"
EXIF_IFD = 0x8769
DATE_TIME_ORIGINAL = 36867
MODEL = 272


def capture_time(image):
    """Camera time as seconds, stored as if it were UTC, like the map does for EXIF."""
    exif = image.getexif()
    raw = exif.get_ifd(EXIF_IFD).get(DATE_TIME_ORIGINAL)
    if not raw:
        return None
    taken = dt.datetime.strptime(raw, "%Y:%m:%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    return int(taken.timestamp())


def compact(value):
    return "{ " + ", ".join(f"{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in value.items()) + " }"


def write_overrides(overrides):
    entries = ",\n".join(f"    {json.dumps(key)}: {compact(value)}" for key, value in overrides["photos"].items())
    text = (
        "{\n"
        f'  "about": {json.dumps(overrides["about"], ensure_ascii=False)},\n'
        '  "photos": {\n'
        f"{entries}\n"
        "  },\n"
        f'  "exclude": {json.dumps(overrides.get("exclude", []))}\n'
        "}\n"
    )
    OVERRIDES_FILE.write_text(text, encoding="utf-8")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    folder, place = Path(sys.argv[1]), sys.argv[2]
    note = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_NOTE
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in (".jpg", ".jpeg"))
    if not files:
        sys.exit(f"No .jpg files in {folder}")

    slug = re.sub(r"[^a-z0-9]+", "-", place.lower()).strip("-")
    extras = json.loads(EXTRAS_FILE.read_text(encoding="utf-8")) if EXTRAS_FILE.exists() else []
    overrides = json.loads(OVERRIDES_FILE.read_text(encoding="utf-8"))
    by_id = {photo["id"]: photo for photo in extras}

    for source in files:
        with Image.open(source) as original:
            ts = capture_time(original)
            camera = original.getexif().get(MODEL)
            image = ImageOps.exif_transpose(original).convert("RGB")
        year = dt.datetime.fromtimestamp(ts, dt.timezone.utc).year if ts else "undated"
        stem = source.stem.lower()
        folder_rel = f"photos/{slug}-{year}"
        (ROOT / folder_rel).mkdir(parents=True, exist_ok=True)

        large = image.copy()
        large.thumbnail((LARGE_PX, LARGE_PX))
        large.save(ROOT / folder_rel / f"{stem}.jpg", quality=82, optimize=True, progressive=True)
        thumb = image.copy()
        thumb.thumbnail((THUMB_PX, THUMB_PX))
        thumb.save(ROOT / folder_rel / f"{stem}-thumb.jpg", quality=80, optimize=True)

        photo_id = f"extra-{slug}-{stem}"
        by_id[photo_id] = {
            "id": photo_id,
            "url": f"{folder_rel}/{stem}.jpg",
            "thumb": f"{folder_rel}/{stem}-thumb.jpg",
            "path": f"/{folder_rel}/{stem}.jpg",
            "title": source.stem,
            "caption": "",
            "description": "",
            "alt": "",
            "ts": ts,
            "lat": None,
            "lon": None,
            "camera": camera,
            "width": large.width,
            "height": large.height,
            "extra": True,
        }
        overrides["photos"][photo_id] = {"place": place, "source": note}
        print(f"{source.name}: {dt.datetime.fromtimestamp(ts, dt.timezone.utc):%Y-%m-%d %H:%M} -> {folder_rel}" if ts else f"{source.name}: undated -> {folder_rel}")

    extras = sorted(by_id.values(), key=lambda photo: (photo["ts"] or 0, photo["id"]))
    EXTRAS_FILE.write_text(json.dumps(extras, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    write_overrides(overrides)
    print(f"{len(files)} photos added for {place}. Check the map, then commit photos/ and data/.")


if __name__ == "__main__":
    main()
