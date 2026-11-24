// Reads the photo gallery out of the "Hair Cuts around the World" post on janhoffmann.live.
// Shared by the browser (live feed) and scripts/snapshot.mjs (offline fallback), so it uses
// plain string parsing rather than the DOM.

export const SITE = "https://janhoffmann.live";
export const POST_URL = `${SITE}/2026/04/28/hair-cuts/`;
export const POST_API =
  "https://public-api.wordpress.com/rest/v1.1/sites/janhoffmann.live/posts/slug:hair-cuts?fields=modified,content";

const GALLERY_IMAGE = /<img\b[^>]*\bdata-attachment-id="[^"]*"[^>]*>/g;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const NAMED_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
// About 100 m. Enough to tell countries apart without republishing exact positions.
const GPS_DECIMALS = 3;

export function decodeEntities(text) {
  let current = text;
  // WordPress double-encodes some titles (N&amp;#8217;Djamena), so decode until stable.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current.replace(ENTITY, (match, code) => {
      if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? match;
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

function plainText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function coordinate(value) {
  const number = parseFloat(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** GPS_DECIMALS;
  return Math.round(number * factor) / factor;
}

function readMeta(json) {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
}

export function parseGallery(html) {
  const photos = [];
  const seenPaths = new Set();

  for (const tag of html.match(GALLERY_IMAGE) ?? []) {
    const attributes = {};
    for (const [, name, value] of tag.matchAll(ATTRIBUTE)) attributes[name] = decodeEntities(value);

    const source = (attributes["data-orig-file"] || attributes.src || "").split("?")[0];
    const path = source.replace(/^https?:\/\/[^/]+/, "");
    if (!path || seenPaths.has(path)) continue;
    seenPaths.add(path);

    const meta = readMeta(attributes["data-image-meta"]);
    const lat = coordinate(meta.latitude);
    const lon = coordinate(meta.longitude);
    const hasGps = lat !== null && lon !== null && !(lat === 0 && lon === 0);
    const [width, height] = (attributes["data-orig-size"] || "").split(",").map(Number);

    photos.push({
      id: attributes["data-attachment-id"],
      url: SITE + path,
      path,
      permalink: (attributes["data-permalink"] || "").replace(/^http:/, "https:") || null,
      title: plainText(attributes["data-image-title"] || ""),
      caption: plainText(attributes["data-image-caption"] || ""),
      description: plainText(attributes["data-image-description"] || ""),
      alt: plainText(attributes.alt || ""),
      ts: Number(meta.created_timestamp) || null,
      lat: hasGps ? lat : null,
      lon: hasGps ? lon : null,
      camera: meta.camera || null,
      width: width || null,
      height: height || null,
      order: photos.length,
    });
  }
  return photos;
}
