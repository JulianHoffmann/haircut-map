// Saves the current gallery as data/snapshot.json, which the map uses when the live feed fails.
// Run with: npm run snapshot
import { writeFile } from "node:fs/promises";
import { parseGallery, POST_API } from "../lib/gallery.js";

const response = await fetch(POST_API);
if (!response.ok) throw new Error(`WordPress API answered ${response.status}`);
const post = await response.json();
const photos = parseGallery(post.content ?? "");
if (!photos.length) throw new Error("No gallery photos found in the post");

const snapshot = { modified: post.modified, captured: new Date().toISOString(), photos };
await writeFile(new URL("../data/snapshot.json", import.meta.url), `${JSON.stringify(snapshot)}\n`);
console.log(`Saved ${photos.length} photos (post last modified ${post.modified}).`);
