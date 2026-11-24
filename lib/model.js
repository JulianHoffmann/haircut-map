// Turns gallery photos into hair-cut sessions and places.
//
// A session is one visit to a barber: photos taken within SESSION_GAP_S of each other.
// Its place comes from, in order of trust:
//   1. an override in data/overrides.json,
//   2. a caption, alt text, description or descriptive title naming a city or country,
//   3. the GPS position stored in the photo.
// Captions beat GPS because camera GPS is sometimes stale; when two captions disagree,
// the one that agrees with the GPS wins.

const SESSION_GAP_S = 3 * 3600;
// A second camera on the same day often has its clock in another time zone.
const CAMERA_MERGE_WINDOW_S = 12 * 3600;
// Nobody has two hair cuts in the same place within a day.
const SAME_PLACE_WINDOW_S = 24 * 3600;
const FILENAME_LIKE_TITLE = /^(jh[gn]_|dsc|img|imag|p\d|photo|od_photo|screenshot|video|olympus|\d)/i;
// The study's results table is an image in the same gallery.
const NOT_A_HAIRCUT_TITLE = /^screenshot/i;
const MARKER_DECIMALS = 1;

export function normalise(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildGazetteer(places, cities, placeByName) {
  const entries = [];
  const add = (name, place, city, lat, lon) => entries.push({ key: normalise(name), place, city, lat, lon });

  for (const place of places) {
    add(place.name, place, null, place.lat, place.lon);
    for (const alias of place.aliases ?? []) add(alias, place, null, place.lat, place.lon);
    if (place.city) add(place.city, place, place.city, place.lat, place.lon);
  }
  for (const [city, entry] of Object.entries(cities)) {
    const place = placeByName.get(entry.place);
    if (!place) throw new Error(`City ${city} refers to unknown place ${entry.place}`);
    add(city, place, city, entry.lat, entry.lon);
    for (const alias of entry.aliases ?? []) add(alias, place, city, entry.lat, entry.lon);
  }
  // Longest first, so "Santiago de Chile" wins over "Chile".
  return entries.filter((entry) => entry.key).sort((a, b) => b.key.length - a.key.length);
}

function matchText(text, gazetteer) {
  const padded = ` ${normalise(text)} `;
  if (!padded.trim()) return null;
  return gazetteer.find((entry) => padded.includes(` ${entry.key} `)) ?? null;
}

function insideBox([west, south, east, north], lon, lat) {
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundCoordinate(value) {
  const factor = 10 ** MARKER_DECIMALS;
  return Math.round(value * factor) / factor;
}

function uploadMonth(path) {
  const match = path.match(/\/uploads\/(\d{4})\/(\d{2})\//);
  return match ? `${match[1]}-${match[2]}` : null;
}

export function buildModel({ photos, config, overrides = {}, locate }) {
  const places = config.places.map((place) => ({ ...place, inList: !place.addedFromPhotos, sessions: [] }));
  const placeByName = new Map(places.map((place) => [place.name, place]));
  const gazetteer = buildGazetteer(places, config.cities ?? {}, placeByName);
  const excluded = new Set((overrides.exclude ?? []).map(String));
  const forcedText = overrides.photos ?? {};

  function placeFromGps(lat, lon) {
    const territory = places.find((place) => place.bbox && insideBox(place.bbox, lon, lat));
    if (territory) return territory;
    const country = locate(lon, lat);
    if (!country) return null;
    const listed = places.find((place) => !place.bbox && place.iso && place.iso === country.iso);
    if (listed) return listed;
    if (!placeByName.has(country.name)) {
      const extra = { name: country.name, iso: country.iso, lat, lon, inList: false, sessions: [] };
      places.push(extra);
      placeByName.set(extra.name, extra);
    }
    return placeByName.get(country.name);
  }

  function matchPhoto(photo) {
    const forced = forcedText[photo.id];
    if (forced) {
      const text = typeof forced === "string" ? forced : forced.place;
      const match = matchText(text, gazetteer);
      if (!match) throw new Error(`Override for photo ${photo.id} names an unknown place: ${text}`);
      return { ...match, forced: true, source: typeof forced === "string" ? null : forced.source ?? null };
    }
    const texts = [photo.caption, photo.alt, photo.description];
    if (!FILENAME_LIKE_TITLE.test(photo.title)) texts.push(photo.title);
    for (const text of texts) {
      const match = text && matchText(text, gazetteer);
      if (match) return { ...match, forced: false };
    }
    return null;
  }

  const usable = photos.filter((photo) => !excluded.has(String(photo.id)) && !NOT_A_HAIRCUT_TITLE.test(photo.title));
  for (const photo of usable) {
    photo.match = matchPhoto(photo);
    photo.gpsPlace = photo.lat === null ? null : placeFromGps(photo.lat, photo.lon);
  }

  function resolve(session) {
    const matches = session.photos.map((photo) => photo.match).filter(Boolean);
    const gpsPlace = mostCommon(session.photos.map((photo) => photo.gpsPlace).filter(Boolean));
    const cityFirst = [...matches].sort((a, b) => Number(Boolean(b.city)) - Number(Boolean(a.city)));
    const match =
      matches.find((m) => m.forced) ?? cityFirst.find((m) => m.place === gpsPlace) ?? cityFirst[0] ?? null;

    if (match) {
      session.place = match.place;
      session.city = match.city;
      session.evidence = match.forced ? "override" : "caption";
      session.source = match.source ?? null;
      const gpsAgrees = !match.city && gpsPlace === match.place;
      Object.assign(session, gpsAgrees ? gpsCentre(session, gpsPlace) : { lat: match.lat, lon: match.lon });
    } else if (gpsPlace) {
      session.place = gpsPlace;
      session.city = null;
      session.evidence = "gps";
      Object.assign(session, gpsCentre(session, gpsPlace));
    }
  }

  function gpsCentre(session, place) {
    const located = session.photos.filter((photo) => photo.gpsPlace === place);
    return {
      lat: roundCoordinate(median(located.map((photo) => photo.lat))),
      lon: roundCoordinate(median(located.map((photo) => photo.lon))),
    };
  }

  // 1. Dated photos: split the timeline wherever the gap exceeds SESSION_GAP_S.
  const dated = usable.filter((photo) => photo.ts).sort((a, b) => a.ts - b.ts);
  const timeline = [];
  for (const photo of dated) {
    const current = timeline.at(-1);
    if (current && photo.ts - current.end <= SESSION_GAP_S) {
      current.photos.push(photo);
      current.end = photo.ts;
    } else {
      timeline.push({ photos: [photo], start: photo.ts, end: photo.ts, place: null });
    }
  }
  timeline.forEach(resolve);

  // 2. A placeless group taken within hours of a placed one is the same visit seen by another camera.
  const placed = timeline.filter((session) => session.place);
  for (const session of timeline.filter((s) => !s.place)) {
    let nearest = null;
    let nearestGap = Infinity;
    for (const candidate of placed) {
      const gap = Math.max(0, Math.max(candidate.start, session.start) - Math.min(candidate.end, session.end));
      if (gap < nearestGap) {
        nearest = candidate;
        nearestGap = gap;
      }
    }
    if (nearest && nearestGap <= CAMERA_MERGE_WINDOW_S) {
      nearest.photos.push(...session.photos);
      nearest.start = Math.min(nearest.start, session.start);
      nearest.end = Math.max(nearest.end, session.end);
      session.mergedInto = nearest;
    }
  }
  // 2b. Placed groups at the same place within a day are one visit (e.g. evening and next morning).
  const datedSessions = [];
  for (const session of timeline.filter((s) => !s.mergedInto)) {
    const previous = datedSessions.findLast((s) => s.place && s.place === session.place);
    if (previous && session.place && session.start - previous.end <= SAME_PLACE_WINDOW_S) {
      previous.photos.push(...session.photos);
      previous.end = Math.max(previous.end, session.end);
      previous.city ??= session.city;
      previous.source ??= session.source;
    } else {
      datedSessions.push(session);
    }
  }

  // 3. Undated photos that name or carry a place: one "date unknown" session per place.
  const undatedByPlace = new Map();
  const undatedLeftovers = [];
  for (const photo of usable.filter((p) => !p.ts)) {
    // An override can attach an undated photo to the visit of a named photo: { "join": "<id>" }.
    const joinId = forcedText[photo.id]?.join;
    const joined = joinId && datedSessions.find((s) => s.photos.some((p) => String(p.id) === String(joinId)));
    if (joined) {
      joined.photos.push(photo);
      continue;
    }
    const place = photo.match?.place ?? photo.gpsPlace;
    if (!place) {
      undatedLeftovers.push(photo);
      continue;
    }
    if (!undatedByPlace.has(place)) undatedByPlace.set(place, { photos: [], start: null, end: null, place: null });
    undatedByPlace.get(place).photos.push(photo);
  }
  // An undated photo joins the dated visit to the same place when there is only one candidate.
  const undatedSessions = [];
  for (const session of undatedByPlace.values()) {
    resolve(session);
    const samePlace = datedSessions.filter((s) => s.place === session.place);
    const sameCity = samePlace.filter((s) => session.city && s.city === session.city);
    const home = samePlace.length === 1 ? samePlace[0] : sameCity.length === 1 ? sameCity[0] : null;
    if (home) home.photos.push(...session.photos);
    else undatedSessions.push(session);
  }

  // 4. A bare undated photo sitting between two photos of the same place belongs there.
  const sessionOfPhoto = new Map();
  for (const session of [...datedSessions, ...undatedSessions]) {
    if (!session.place) continue;
    for (const photo of session.photos) sessionOfPhoto.set(photo, session);
  }
  const galleryOrder = [...usable].sort((a, b) => a.order - b.order);
  const positionOf = new Map(galleryOrder.map((photo, index) => [photo, index]));
  const adoptions = [];
  for (const photo of undatedLeftovers) {
    const index = positionOf.get(photo);
    const before = sessionOfPhoto.get(galleryOrder[index - 1]);
    const after = sessionOfPhoto.get(galleryOrder[index + 1]);
    if (before && after && before.place === after.place) adoptions.push([photo, before]);
  }
  for (const [photo, session] of adoptions) session.photos.push(photo);
  const adopted = new Set(adoptions.map(([photo]) => photo));

  // 5. Collect placed sessions per place; everything else is "not yet placed".
  const sessions = [...datedSessions, ...undatedSessions]
    .filter((session) => session.place)
    .map((session) => ({
      id: String(session.photos.reduce((a, b) => (a.order < b.order ? a : b)).id),
      place: session.place,
      city: session.city,
      lat: session.lat,
      lon: session.lon,
      start: session.start,
      end: session.end,
      evidence: session.evidence,
      source: session.source ?? null,
      photos: [...session.photos].sort((a, b) => a.order - b.order),
    }));
  for (const session of sessions) session.place.sessions.push(session);

  for (const place of places) {
    place.sessions.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
    place.photoCount = place.sessions.reduce((sum, session) => sum + session.photos.length, 0);
    const starts = place.sessions.map((session) => session.start).filter(Boolean);
    place.firstTs = starts.length ? Math.min(...starts) : null;
  }

  const unplaced = [];
  for (const session of datedSessions.filter((s) => !s.place)) {
    unplaced.push({ id: String(session.photos[0].id), start: session.start, uploadMonth: null, photos: session.photos });
  }
  const byUploadMonth = new Map();
  for (const photo of undatedLeftovers.filter((p) => !adopted.has(p))) {
    const month = uploadMonth(photo.path);
    if (!byUploadMonth.has(month)) byUploadMonth.set(month, []);
    byUploadMonth.get(month).push(photo);
  }
  for (const [month, group] of byUploadMonth) {
    unplaced.push({ id: String(group[0].id), start: null, uploadMonth: month, photos: group });
  }

  const visiblePlaces = places.filter((place) => place.inList || place.sessions.length);
  const years = sessions.filter((s) => s.start).map((s) => new Date(s.start * 1000).getUTCFullYear());

  return {
    places: visiblePlaces.sort((a, b) => a.name.localeCompare(b.name, "en")),
    sessions: sessions.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity)),
    unplaced,
    stats: {
      places: visiblePlaces.length,
      listed: visiblePlaces.filter((place) => place.inList).length,
      withPhotos: visiblePlaces.filter((place) => place.sessions.length).length,
      sessions: sessions.length,
      photos: sessions.reduce((sum, session) => sum + session.photos.length, 0),
      unplacedPhotos: unplaced.reduce((sum, group) => sum + group.photos.length, 0),
      firstYear: years.length ? Math.min(...years) : null,
      lastYear: years.length ? Math.max(...years) : null,
    },
  };
}
