import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm";
import { parseGallery, POST_API, POST_URL } from "./lib/gallery.js";
import { buildModel } from "./lib/model.js";

const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json";
const ANTARCTICA_ID = "010";
const LIVE_TIMEOUT_MS = 10000;
const PLAY_STEP_MS = 900;
const SMALL_POLYGON_PX2 = 40;
const MAX_ZOOM = 24;
const PLACE_ZOOM_LIMIT = 12;
const PHONE_WIDTH = 760;

const fullDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthYear = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const byId = (id) => document.getElementById(id);
const els = {
  stage: byId("stage"),
  masthead: byId("masthead"),
  timeline: byId("timeline"),
  svg: byId("map"),
  message: byId("map-message"),
  tooltip: byId("tooltip"),
  stats: byId("stats"),
  listToggle: byId("list-toggle"),
  panel: byId("panel"),
  panelEyebrow: byId("panel-eyebrow"),
  panelTitle: byId("panel-title"),
  panelMeta: byId("panel-meta"),
  panelBody: byId("panel-body"),
  panelClose: byId("panel-close"),
  play: byId("play"),
  allYears: byId("all-years"),
  years: byId("years"),
  timelineStatus: byId("timeline-status"),
  source: byId("source"),
  lightbox: byId("lightbox"),
  lightboxImage: byId("lightbox-image"),
  lightboxCaption: byId("lightbox-caption"),
  lightboxPrev: byId("lightbox-prev"),
  lightboxNext: byId("lightbox-next"),
  lightboxClose: byId("lightbox-close"),
  zoomIn: byId("zoom-in"),
  zoomOut: byId("zoom-out"),
  zoomReset: byId("zoom-reset"),
};

const state = {
  model: null,
  features: [],
  featureByIso: new Map(),
  ownerByIso: new Map(),
  spots: [],
  spotPlaces: new Set(),
  years: [],
  year: null,
  selected: null,
  panelMode: null,
  playTimer: null,
  lightbox: null,
  size: { width: 0, height: 0 },
  chrome: { top: 0, bottom: 0 },
  k: 1,
};

const map = {};

main().catch((error) => {
  console.error(error);
  els.message.textContent = "The map could not be loaded. The study itself is on janhoffmann.live.";
});

async function main() {
  const [world, config, overrides, feed] = await Promise.all([
    fetchJson(WORLD_URL),
    fetchJson("data/places.json"),
    fetchJson("data/overrides.json"),
    loadPhotos(),
  ]);

  state.features = topojson
    .feature(world, world.objects.countries)
    .features.filter((feature) => feature.id !== ANTARCTICA_ID);
  state.featureByIso = new Map(state.features.filter((f) => f.id).map((f) => [f.id, f]));
  state.model = buildModel({ photos: feed.photos, config, overrides, locate: makeLocator(state.features) });
  state.ownerByIso = new Map(state.model.places.filter((p) => p.iso && !p.bbox).map((p) => [p.iso, p]));
  state.spots = buildSpots(state.model.sessions);
  state.spotPlaces = new Set(state.spots.map((spot) => spot.place));
  window.haircutMap = { model: state.model, source: feed.source };

  renderStats();
  renderSource(feed);
  renderTimeline();
  setupMap();
  bindControls();
  els.message.hidden = true;
  openFromHash();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function loadPhotos() {
  try {
    const post = await fetchJson(POST_API, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    const photos = parseGallery(post.content ?? "");
    if (!photos.length) throw new Error("The live post has no gallery photos");
    return { source: "live", modified: post.modified, photos };
  } catch (error) {
    console.warn("Live feed unavailable, using the snapshot.", error);
    const snapshot = await fetchJson("data/snapshot.json");
    return { source: "snapshot", modified: snapshot.modified, photos: snapshot.photos };
  }
}

function makeLocator(features) {
  const indexed = features.map((feature) => ({ feature, bounds: d3.geoBounds(feature) }));
  const containing = (lon, lat) => {
    for (const { feature, bounds } of indexed) {
      const [[west, south], [east, north]] = bounds;
      if (lat < south || lat > north) continue;
      const inLongitude = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
      if (inLongitude && d3.geoContains(feature, [lon, lat])) return feature;
    }
    return null;
  };
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  // Photos taken on a beach or a boat fall just outside the coastline, so search outwards a little.
  return (lon, lat) => {
    let feature = containing(lon, lat);
    for (const step of [0.05, 0.1, 0.2, 0.4]) {
      if (feature) break;
      for (const [dx, dy] of directions) {
        feature = containing(lon + dx * step, lat + dy * step);
        if (feature) break;
      }
    }
    return feature ? { iso: feature.id ?? null, name: feature.properties.name } : null;
  };
}

function buildSpots(sessions) {
  const spots = new Map();
  for (const session of sessions) {
    const key = `${session.place.name}|${session.lat.toFixed(1)}|${session.lon.toFixed(1)}`;
    if (!spots.has(key)) {
      spots.set(key, { key, place: session.place, lat: session.lat, lon: session.lon, sessions: [] });
    }
    spots.get(key).sessions.push(session);
  }
  // Larger spots first so smaller ones are drawn on top.
  return [...spots.values()].sort((a, b) => b.sessions.length - a.sessions.length);
}

/* ---------- Helpers ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function plural(count, word, pluralWord = `${word}s`) {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

const yearOf = (ts) => new Date(ts * 1000).getUTCFullYear();
const dateText = (ts) => (ts ? fullDate.format(ts * 1000) : "Date unknown");
const thumbUrl = (photo) => `${photo.url}?w=240&h=240&crop=1&strip=info`;
const largeUrl = (photo) => `${photo.url}?w=1600&strip=info`;

function sessionLabel(session) {
  return session.city ? `${session.city}, ${session.place.name}` : session.place.name;
}

function spotLabel(spot) {
  const city = spot.sessions.find((session) => session.city)?.city;
  return city ? `${city}, ${spot.place.name}` : spot.place.name;
}

function describePlace(place) {
  if (!place.sessions.length) return "On the list · no photos linked yet";
  return `${plural(place.sessions.length, "hair cut")} · ${plural(place.photoCount, "photo")}`;
}

function isVisible(place) {
  if (state.year === null) return true;
  return place.firstTs !== null && yearOf(place.firstTs) <= state.year;
}

function spotVisible(spot) {
  if (state.year === null) return true;
  return spot.sessions.some((session) => session.start && yearOf(session.start) <= state.year);
}

/* ---------- Masthead & footer ---------- */

function renderStats() {
  const { stats } = state.model;
  const items = [
    [stats.places, "countries & territories"],
    [stats.sessions, "hair cuts mapped"],
    [stats.photos, "photos"],
    [`${stats.firstYear}–${stats.lastYear}`, "period"],
  ];
  els.stats.replaceChildren(
    ...items.map(([value, label]) => el("div", {}, el("dt", { text: label }), el("dd", { text: String(value) }))),
  );
}

function renderSource(feed) {
  const updated = feed.modified ? fullDate.format(new Date(feed.modified)) : "unknown date";
  const link = el("a", { href: POST_URL, target: "_blank", rel: "noopener", text: "janhoffmann.live" });
  const lead = feed.source === "live" ? "Photos and captions read live from " : "Live feed unavailable — showing a saved copy of ";
  const parts = [lead, link, ` (post updated ${updated}).`];
  const { unplacedPhotos } = state.model.stats;
  if (unplacedPhotos) {
    parts.push(" ", el("button", { type: "button", text: `${unplacedPhotos} photos not yet placed`, onclick: () => openList(true) }));
  }
  els.source.replaceChildren(...parts);
}

/* ---------- Map ---------- */

function setupMap() {
  map.svg = d3.select(els.svg);
  map.root = map.svg.append("g");
  map.projection = d3.geoEqualEarth();
  map.path = d3.geoPath(map.projection);

  map.sphere = map.root
    .append("path")
    .attr("class", "sphere")
    .datum({ type: "Sphere" })
    .on("click", () => closePanel());
  map.graticule = map.root.append("path").attr("class", "graticule").datum(d3.geoGraticule10());

  map.countries = map.root
    .append("g")
    .selectAll("path")
    .data(state.features)
    .join("path")
    .attr("class", "country")
    .on("pointermove", showCountryTooltip)
    .on("pointerleave", hideTooltip)
    .on("click", (event, feature) => {
      const place = state.ownerByIso.get(feature.id);
      if (place && isVisible(place)) openPlace(place);
      else closePanel();
    });

  map.rings = map.root.append("g");
  map.spots = map.root.append("g");

  map.zoom = d3.zoom().scaleExtent([1, MAX_ZOOM]).on("zoom", onZoom);
  map.svg.call(map.zoom);

  new ResizeObserver(layout).observe(els.stage);
  layout();
}

// The masthead and timeline float over the map; the map is fitted into the gap between them.
function measureChrome() {
  const stageBox = els.stage.getBoundingClientRect();
  const top = Math.max(0, els.masthead.getBoundingClientRect().bottom - stageBox.top);
  const bottom = Math.max(0, stageBox.bottom - els.timeline.getBoundingClientRect().top);
  state.chrome = { top, bottom };
  document.documentElement.style.setProperty("--chrome-top", `${top}px`);
  document.documentElement.style.setProperty("--chrome-bottom", `${bottom}px`);
}

function layout() {
  const { width, height } = els.stage.getBoundingClientRect();
  if (!width || !height || (width === state.size.width && height === state.size.height)) return;
  state.size = { width, height };
  measureChrome();

  const padding = Math.min(24, width * 0.03);
  map.svg.attr("viewBox", `0 0 ${width} ${height}`);
  map.projection.fitExtent(
    [[padding, state.chrome.top + padding], [width - padding, height - state.chrome.bottom - padding]],
    { type: "FeatureCollection", features: state.features },
  );
  map.sphere.attr("d", map.path);
  map.graticule.attr("d", map.path);
  map.countries.attr("d", map.path);
  map.zoom
    .extent([[0, 0], [width, height]])
    .translateExtent([[-width * 0.25, -height * 0.25], [width * 1.25, height * 1.25]]);

  drawMarkers();
  applyFilter();
  if (state.selected) zoomToPlace(state.selected, false);
  else map.svg.call(map.zoom.transform, d3.zoomIdentity);
}

function drawMarkers() {
  const at = (d) => `translate(${map.projection([d.lon, d.lat])})`;

  map.spots
    .selectAll("g.spot")
    .data(state.spots, (spot) => spot.key)
    .join((enter) => {
      const group = enter.append("g").attr("class", "spot");
      group.append("circle").attr("class", "spot-hit");
      group.append("circle").attr("class", "spot-mark");
      return group
        .on("pointermove", showSpotTooltip)
        .on("pointerleave", hideTooltip)
        .on("click", (event, spot) => {
          event.stopPropagation();
          openPlace(spot.place, spot.sessions[0].id);
        });
    })
    .attr("transform", at);

  // Places on the list with no photos, too small to see or click at world scale.
  const ringPlaces = state.model.places.filter((place) => {
    if (state.spotPlaces.has(place)) return false;
    const feature = state.featureByIso.get(place.iso);
    return place.bbox || !feature || map.path.area(feature) < SMALL_POLYGON_PX2;
  });
  map.rings
    .selectAll("g.ring-group")
    .data(ringPlaces, (place) => place.name)
    .join((enter) => {
      const group = enter.append("g").attr("class", "ring-group");
      group.append("circle").attr("class", "ring-hit");
      group.append("circle").attr("class", "ring");
      return group
        .on("pointermove", (event, place) => showTooltip(event, place.name, describePlace(place)))
        .on("pointerleave", hideTooltip)
        .on("click", (event, place) => {
          event.stopPropagation();
          openPlace(place);
        });
    })
    .attr("transform", at);

  sizeMarkers();
}

function spotRadius(spot) {
  return 3.5 + Math.min(4.5, Math.sqrt(spot.sessions.length) * 1.3);
}

function sizeMarkers() {
  // Spots shrink on phones, where the whole world is only a few hundred pixels wide.
  const k = state.size.width < PHONE_WIDTH ? state.k / 0.7 : state.k;
  map.spots.selectAll(".spot-mark").attr("r", (spot) => spotRadius(spot) / k);
  map.spots.selectAll(".spot-hit").attr("r", (spot) => Math.max(12, spotRadius(spot) + 6) / k);
  map.rings.selectAll(".ring").attr("r", 6 / k);
  map.rings.selectAll(".ring-hit").attr("r", 12 / k);
}

function onZoom({ transform }) {
  map.root.attr("transform", transform);
  state.k = transform.k;
  sizeMarkers();
  hideTooltip();
}

function applyFilter() {
  map.countries.attr("class", (feature) => {
    const place = state.ownerByIso.get(feature.id);
    let name = "country";
    if (place && isVisible(place)) name += " is-visited";
    if (place && place === state.selected) name += " is-selected";
    return name;
  });
  map.spots
    .selectAll("g.spot")
    .attr("display", (spot) => (spotVisible(spot) ? null : "none"))
    .classed("is-selected", (spot) => spot.place === state.selected)
    .classed(
      "is-past",
      (spot) => state.year !== null && !spot.sessions.some((s) => s.start && yearOf(s.start) === state.year),
    );
  map.rings.selectAll("g.ring-group").attr("display", (place) => (isVisible(place) ? null : "none"));
}

function mainPart(feature, place) {
  if (feature.geometry.type !== "MultiPolygon") return feature;
  const parts = feature.geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
  const anchor = [place.lon, place.lat];
  return parts.find((part) => d3.geoContains(part, anchor)) ?? parts.reduce((a, b) => (d3.geoArea(a) > d3.geoArea(b) ? a : b));
}

function zoomToPlace(place, animate = true) {
  const { width, height } = state.size;
  const view = { left: 0, top: state.chrome.top, right: width, bottom: height - state.chrome.bottom };
  if (!els.panel.hidden) {
    const stageBox = els.stage.getBoundingClientRect();
    const panelBox = els.panel.getBoundingClientRect();
    if (width < PHONE_WIDTH) view.bottom = panelBox.top - stageBox.top;
    else view.right = panelBox.left - stageBox.left;
  }

  const points = [[place.lon, place.lat], ...place.sessions.map((s) => [s.lon, s.lat])].map((p) => map.projection(p));
  let [x0, y0, x1, y1] = [d3.min(points, (p) => p[0]), d3.min(points, (p) => p[1]), d3.max(points, (p) => p[0]), d3.max(points, (p) => p[1])];
  const feature = state.featureByIso.get(place.iso);
  if (feature && !place.bbox) {
    const [[fx0, fy0], [fx1, fy1]] = map.path.bounds(mainPart(feature, place));
    [x0, y0, x1, y1] = [Math.min(x0, fx0), Math.min(y0, fy0), Math.max(x1, fx1), Math.max(y1, fy1)];
  }

  const viewWidth = view.right - view.left;
  const viewHeight = view.bottom - view.top;
  const fit = 0.7 / Math.max((x1 - x0 || 1) / viewWidth, (y1 - y0 || 1) / viewHeight);
  const k = Math.max(1, Math.min(PLACE_ZOOM_LIMIT, fit));
  const transform = d3.zoomIdentity
    .translate(view.left + viewWidth / 2, view.top + viewHeight / 2)
    .scale(k)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);

  const target = animate && !reduceMotion.matches ? map.svg.transition().duration(750) : map.svg;
  target.call(map.zoom.transform, transform);
}

function resetZoom() {
  const target = reduceMotion.matches ? map.svg : map.svg.transition().duration(600);
  target.call(map.zoom.transform, d3.zoomIdentity);
}

/* ---------- Tooltip ---------- */

function showTooltip(event, title, detail) {
  els.tooltip.replaceChildren(el("strong", { text: title }), el("span", { text: detail }));
  els.tooltip.hidden = false;
  const stageBox = els.stage.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = els.tooltip;
  let x = event.clientX - stageBox.left + 14;
  let y = event.clientY - stageBox.top + 14;
  if (x + width > stageBox.width - 8) x -= width + 28;
  if (y + height > stageBox.height - 8) y -= height + 28;
  els.tooltip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
}

function hideTooltip() {
  els.tooltip.hidden = true;
}

function showCountryTooltip(event, feature) {
  const place = state.ownerByIso.get(feature.id);
  if (place && isVisible(place)) {
    showTooltip(event, place.name, describePlace(place));
  } else {
    const detail = state.year === null ? "No hair cut on record" : `No dated hair cut by ${state.year}`;
    showTooltip(event, feature.properties.name, detail);
  }
}

function showSpotTooltip(event, spot) {
  const photos = d3.sum(spot.sessions, (session) => session.photos.length);
  let detail;
  if (spot.sessions.length === 1) {
    detail = `${dateText(spot.sessions[0].start)} · ${plural(photos, "photo")}`;
  } else {
    const years = spot.sessions.filter((s) => s.start).map((s) => yearOf(s.start));
    const span = years.length ? ` · ${d3.min(years)}–${d3.max(years)}` : "";
    detail = `${plural(spot.sessions.length, "hair cut")}${span}`;
  }
  showTooltip(event, spotLabel(spot), detail);
}

/* ---------- Panel ---------- */

function showPanel() {
  els.panel.hidden = false;
  els.panelBody.scrollTop = 0;
  els.listToggle.setAttribute("aria-expanded", String(state.panelMode === "list"));
}

function closePanel() {
  if (els.panel.hidden) return;
  els.panel.hidden = true;
  state.selected = null;
  state.panelMode = null;
  els.listToggle.setAttribute("aria-expanded", "false");
  applyFilter();
  setHash(null);
}

function setPanelHeader(eyebrow, title, meta) {
  els.panelEyebrow.textContent = eyebrow;
  els.panelTitle.textContent = title;
  els.panelMeta.textContent = meta;
}

function photoGrid(group, title) {
  const count = group.photos.length;
  return el(
    "div",
    { class: "thumbs" },
    ...group.photos.map((photo, index) =>
      el(
        "button",
        {
          class: "thumb",
          type: "button",
          "aria-label": `Open photo ${index + 1} of ${count}: ${title}`,
          onclick: () => openLightbox(group, index, title),
        },
        el("img", { src: thumbUrl(photo), alt: "", loading: "lazy", decoding: "async", width: 240, height: 240 }),
      ),
    ),
  );
}

function openPlace(place, focusSessionId = null) {
  stopPlaying();
  hideTooltip();
  state.selected = place;
  state.panelMode = "place";

  const eyebrow = place.inList ? "Country or territory" : "From the photos · not on the published list";
  const first = place.firstTs ? ` · first ${monthYear.format(place.firstTs * 1000)}` : "";
  setPanelHeader(eyebrow, place.name, place.sessions.length ? `${describePlace(place)}${first}` : describePlace(place));

  if (place.sessions.length) {
    els.panelBody.replaceChildren(
      ...place.sessions.map((session) => {
        const focused = session.id === focusSessionId && place.sessions.length > 1;
        return el(
          "section",
          { class: focused ? "session is-focused" : "session", id: `session-${session.id}` },
          el("h3", {}, el("span", { text: session.city ?? place.name }), el("span", { text: dateText(session.start) })),
          session.source ? el("p", { class: "session-source", text: session.source }) : null,
          photoGrid(session, sessionLabel(session)),
        );
      }),
    );
  } else {
    els.panelBody.replaceChildren(
      el("p", { class: "note", text: "Listed in the study. No photo in the gallery is linked to it yet." }),
    );
  }

  showPanel();
  applyFilter();
  zoomToPlace(place);
  setHash(place.name);
  if (focusSessionId && place.sessions.length > 1) {
    byId(`session-${focusSessionId}`)?.scrollIntoView({ block: "start" });
  }
}

function openList(scrollToUnplaced = false) {
  stopPlaying();
  state.selected = null;
  state.panelMode = "list";
  const { stats, places, unplaced } = state.model;
  setPanelHeader("The evidence, A–Z", "All places", `${stats.places} countries & territories · ${stats.withPhotos} with photos`);

  const placeList = el(
    "ul",
    { class: "place-list" },
    ...places.map((place) =>
      el(
        "li",
        {},
        el(
          "button",
          { type: "button", onclick: () => openPlace(place) },
          el("span", { text: place.name }),
          el("span", {
            class: place.sessions.length ? "count" : "count is-empty",
            text: place.sessions.length ? plural(place.sessions.length, "cut") : "no photos",
          }),
        ),
      ),
    ),
  );

  const children = [placeList];
  if (unplaced.length) {
    children.push(
      el("h3", { class: "list-heading", id: "unplaced-heading", text: "Not yet placed" }),
      el("p", {
        class: "note",
        text: "These photos carry no caption, GPS or date that ties them to a place. A town or country written in the caption of any one of them on janhoffmann.live places the whole group.",
      }),
      el(
        "ul",
        { class: "place-list" },
        ...unplaced.map((group) =>
          el(
            "li",
            {},
            el(
              "button",
              { type: "button", onclick: () => openUnplaced(group) },
              el("span", { text: unplacedLabel(group) }),
              el("span", { class: "count", text: plural(group.photos.length, "photo") }),
            ),
          ),
        ),
      ),
    );
  }
  els.panelBody.replaceChildren(...children);
  showPanel();
  applyFilter();
  setHash(null);
  if (scrollToUnplaced) byId("unplaced-heading")?.scrollIntoView({ block: "start" });
}

// Undated groups are named by their files: the WordPress folder month is not when they were taken.
function unplacedLabel(group) {
  if (group.start) return `Taken ${dateText(group.start)}`;
  const names = group.photos.map((photo) => photo.title.replace(/_singular_display_fullPicture$/i, ""));
  const more = names.length > 2 ? ` + ${names.length - 2} more` : "";
  return `Undated · ${names.slice(0, 2).join(", ")}${more}`;
}

function openUnplaced(group) {
  state.panelMode = "unplaced";
  const label = unplacedLabel(group);
  setPanelHeader("Not yet placed", label, plural(group.photos.length, "photo"));
  els.panelBody.replaceChildren(
    el("button", { class: "back-button", type: "button", text: "‹ All places", onclick: () => openList(true) }),
    el("section", { class: "session" }, photoGrid(group, `${label}, not yet placed`)),
  );
  showPanel();
}

/* ---------- Lightbox ---------- */

function openLightbox(group, index, title) {
  state.lightbox = { group, index, title, opener: document.activeElement };
  els.lightbox.hidden = false;
  document.body.style.overflow = "hidden";
  showLightboxPhoto();
  els.lightboxClose.focus();
}

function showLightboxPhoto() {
  const { group, index, title } = state.lightbox;
  const photo = group.photos[index];
  const count = group.photos.length;
  els.lightboxImage.src = largeUrl(photo);
  els.lightboxImage.alt = `Hair cut photo ${index + 1} of ${count}: ${title}`;
  const date = group.start !== undefined && group.place ? ` · ${dateText(group.start)}` : "";
  els.lightboxCaption.replaceChildren(
    `${title}${date} · ${index + 1} / ${count}`,
    el("a", { href: photo.permalink ?? POST_URL, target: "_blank", rel: "noopener", text: "View on janhoffmann.live" }),
  );
  els.lightboxPrev.hidden = count < 2;
  els.lightboxNext.hidden = count < 2;
  if (count > 1) new Image().src = largeUrl(group.photos[(index + 1) % count]);
}

function stepLightbox(delta) {
  const { group } = state.lightbox;
  state.lightbox.index = (state.lightbox.index + delta + group.photos.length) % group.photos.length;
  showLightboxPhoto();
}

function closeLightbox() {
  els.lightbox.hidden = true;
  document.body.style.overflow = "";
  els.lightboxImage.removeAttribute("src");
  state.lightbox.opener?.focus();
  state.lightbox = null;
}

function trapLightboxFocus(event) {
  const focusable = [...els.lightbox.querySelectorAll("button:not([hidden]), a[href]")];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ---------- Timeline ---------- */

function renderTimeline() {
  const { firstYear, lastYear } = state.model.stats;
  const dated = state.model.sessions.filter((session) => session.start);
  const counts = d3.rollup(dated, (sessions) => sessions.length, (session) => yearOf(session.start));
  const max = d3.max(counts.values()) ?? 1;
  state.years = d3.range(firstYear, lastYear + 1);

  els.years.replaceChildren(
    ...state.years.map((year) => {
      const count = counts.get(year) ?? 0;
      const labelled = year === firstYear || year === lastYear || year % 5 === 0;
      const description = `${year}: ${plural(count, "hair cut")}`;
      return el(
        "button",
        {
          class: "year",
          type: "button",
          "data-year": year,
          "aria-pressed": "false",
          "aria-label": description,
          title: description,
          onclick: () => {
            stopPlaying();
            selectYear(state.year === year ? null : year);
          },
        },
        el("span", { class: "year-bar", style: `height: ${count ? Math.max(8, (count / max) * 100) : 0}%` }),
        labelled ? el("span", { class: "year-label", text: String(year) }) : null,
      );
    }),
  );
  updateTimeline();
}

function selectYear(year) {
  state.year = year;
  updateTimeline();
  applyFilter();
  if (state.selected && !isVisible(state.selected)) closePanel();
}

function updateTimeline() {
  const year = state.year;
  els.years.classList.toggle("is-filtered", year !== null);
  for (const button of els.years.children) {
    const buttonYear = Number(button.dataset.year);
    button.setAttribute("aria-pressed", String(buttonYear === year));
    button.classList.toggle("is-future", year !== null && buttonYear > year);
  }
  els.allYears.setAttribute("aria-pressed", String(year === null));

  const { stats, places, sessions } = state.model;
  if (year === null) {
    els.timelineStatus.textContent = `${stats.places} countries & territories · ${stats.sessions} hair cuts mapped`;
  } else {
    const reached = places.filter(isVisible).length;
    const thisYear = sessions.filter((s) => s.start && yearOf(s.start) === year).length;
    els.timelineStatus.textContent = `${year}: ${plural(thisYear, "hair cut")} · ${reached} countries & territories by year end`;
  }
  measureChrome();
}

function startPlaying() {
  const years = state.years;
  let index = state.year === null || state.year === years.at(-1) ? 0 : years.indexOf(state.year) + 1;
  closePanel();
  resetZoom();
  const step = () => {
    if (index >= years.length) {
      stopPlaying();
      selectYear(null);
      return;
    }
    selectYear(years[index]);
    index += 1;
  };
  step();
  state.playTimer = setInterval(step, PLAY_STEP_MS);
  els.play.setAttribute("aria-label", "Pause");
  els.play.setAttribute("aria-pressed", "true");
}

function stopPlaying() {
  if (!state.playTimer) return;
  clearInterval(state.playTimer);
  state.playTimer = null;
  els.play.setAttribute("aria-label", "Play the years");
  els.play.setAttribute("aria-pressed", "false");
}

/* ---------- Wiring ---------- */

function setHash(name) {
  const url = name ? `#${encodeURIComponent(name)}` : `${location.pathname}${location.search}`;
  history.replaceState(null, "", url);
}

function openFromHash() {
  const name = decodeURIComponent(location.hash.slice(1)).toLowerCase();
  if (!name) return;
  const place = state.model.places.find((p) => p.name.toLowerCase() === name);
  if (place) openPlace(place);
}

function bindControls() {
  els.panelClose.addEventListener("click", closePanel);
  els.listToggle.addEventListener("click", () => (state.panelMode === "list" ? closePanel() : openList()));
  els.play.addEventListener("click", () => (state.playTimer ? stopPlaying() : startPlaying()));
  els.allYears.addEventListener("click", () => {
    stopPlaying();
    selectYear(null);
  });
  els.zoomIn.addEventListener("click", () => map.svg.transition().duration(300).call(map.zoom.scaleBy, 1.6));
  els.zoomOut.addEventListener("click", () => map.svg.transition().duration(300).call(map.zoom.scaleBy, 1 / 1.6));
  els.zoomReset.addEventListener("click", resetZoom);

  els.lightboxClose.addEventListener("click", closeLightbox);
  els.lightboxPrev.addEventListener("click", () => stepLightbox(-1));
  els.lightboxNext.addEventListener("click", () => stepLightbox(1));
  els.lightbox.addEventListener("click", (event) => {
    if (event.target === els.lightbox || event.target.tagName === "FIGURE") closeLightbox();
  });

  document.addEventListener("keydown", (event) => {
    if (state.lightbox) {
      if (event.key === "Escape") closeLightbox();
      else if (event.key === "ArrowLeft") stepLightbox(-1);
      else if (event.key === "ArrowRight") stepLightbox(1);
      else if (event.key === "Tab") trapLightboxFocus(event);
    } else if (event.key === "Escape") {
      closePanel();
    }
  });
  window.addEventListener("hashchange", openFromHash);
}
