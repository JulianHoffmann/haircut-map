// Saves data/posts.json: Jan's blog posts with the days their photos were taken, so each hair cut
// on the map can link to the posts from the same trip. Run with: npm run posts
import { writeFile } from "node:fs/promises";
import { decodeEntities, parseGallery } from "../lib/gallery.js";

const POSTS_API = "https://public-api.wordpress.com/rest/v1.1/sites/janhoffmann.live/posts";
const HAIR_CUTS_POST_ID = 12352;
// Posts whose photos span more than this are collections ("The port crane collection"), not trips.
const COLLECTION_SPAN_DAYS = 45;
const PAGE_SIZE = 100;

const isoDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const posts = [];

for (let page = 1; ; page += 1) {
  const url = `${POSTS_API}?number=${PAGE_SIZE}&page=${page}&fields=ID,date,title,URL,content`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`WordPress API answered ${response.status} for page ${page}`);
  const { posts: batch } = await response.json();

  for (const post of batch) {
    if (post.ID === HAIR_CUTS_POST_ID) continue;
    const times = parseGallery(post.content ?? "")
      .map((photo) => photo.ts)
      .filter((ts) => ts > 0 && ts < 4e9);
    const spanDays = times.length ? (Math.max(...times) - Math.min(...times)) / 86400 : 0;
    const collection = spanDays > COLLECTION_SPAN_DAYS;
    posts.push({
      title: decodeEntities(post.title).trim(),
      url: post.URL.replace(/^http:/, "https:"),
      published: post.date.slice(0, 10),
      days: collection ? [] : [...new Set(times.map(isoDay))].sort(),
    });
  }
  if (batch.length < PAGE_SIZE) break;
}

posts.sort((a, b) => a.published.localeCompare(b.published));
await writeFile(new URL("../data/posts.json", import.meta.url), `${JSON.stringify(posts)}\n`);
console.log(`Saved ${posts.length} posts, ${posts.filter((p) => p.days.length).length} with dated photos.`);
