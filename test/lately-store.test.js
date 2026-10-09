import { test } from "node:test";
import assert from "node:assert/strict";
import { BlobNotFoundError } from "@vercel/blob";

import { createBlobStore } from "../api/_lib/lately-store.js";

const URL_ = "https://abc123def.public.blob.vercel-storage.com/lately/tiles.json";
const docWithIntro = (intro) => ({ version: 1, intro, projects: ["WiiF"], tiles: [] });

// A downloaded copy of the file: what the CDN hands back, with its etag header.
const copy = (intro, etag) => ({
  ok: true,
  status: 200,
  headers: { get: (name) => (name.toLowerCase() === "etag" && etag ? etag : null) },
  json: async () => docWithIntro(intro),
});

function storeWith({ headEtag, copies }) {
  const calls = { head: 0, fetched: [], paused: 0 };
  const store = createBlobStore({
    blob: {
      head: async () => (calls.head++, { url: URL_, etag: headEtag }),
      put: async () => ({}),
      del: async () => {},
    },
    fetchFile: async (url) => (calls.fetched.push(url), copies.shift()),
    pause: async () => void calls.paused++,
  });
  return { store, calls };
}

test("a fresh copy is returned with its etag", async () => {
  const { store, calls } = storeWith({ headEtag: '"e2"', copies: [copy("new", '"e2"')] });
  const result = await store.readDoc();
  assert.equal(result.doc.intro, "new");
  assert.equal(result.etag, '"e2"');
  assert.equal(result.latest, '"e2"');
  assert.equal(calls.fetched.length, 1);
});

test("a stale copy is retried, and the fresh one is used once it arrives", async () => {
  const { store, calls } = storeWith({
    headEtag: '"e2"',
    copies: [copy("old", '"e1"'), copy("new", '"e2"')],
  });
  const result = await store.readDoc();
  assert.equal(result.doc.intro, "new");
  assert.equal(result.etag, '"e2"');
  assert.equal(calls.fetched.length, 2);
  assert.equal(calls.paused, 1);
});

test("a copy that stays stale is never given the newer etag", async () => {
  // The bug seen live: Blob said e2, the downloaded content was still e1's.
  // Pairing that old content with e2 would let a save based on it pass the
  // freshness check and drop the newest tiles.
  const { store, calls } = storeWith({
    headEtag: '"e2"',
    copies: [copy("old", '"e1"'), copy("old", '"e1"'), copy("old", '"e1"')],
  });
  const result = await store.readDoc();
  assert.equal(result.doc.intro, "old");
  assert.equal(result.etag, '"e1"'); // the old content's own etag, not e2
  assert.equal(result.latest, '"e2"'); // ...while the newest version is still reported
  assert.equal(calls.fetched.length, 3); // gave up after three tries
});

test("each attempt asks for a differently-addressed copy, to dodge caches", async () => {
  const { store, calls } = storeWith({
    headEtag: '"e2"',
    copies: [copy("old", '"e1"'), copy("old", '"e1"'), copy("old", '"e1"')],
  });
  await store.readDoc();
  assert.equal(new Set(calls.fetched).size, 3);
});

test("a copy with no etag header is treated as current", async () => {
  const { store } = storeWith({ headEtag: '"e2"', copies: [copy("new", null)] });
  const result = await store.readDoc();
  assert.equal(result.etag, '"e2"');
});

test("no file yet reads as the default page with no etag", async () => {
  const store = createBlobStore({
    blob: {
      head: async () => {
        throw new BlobNotFoundError();
      },
      put: async () => ({}),
      del: async () => {},
    },
    fetchFile: async () => assert.fail("should not download anything"),
  });
  const result = await store.readDoc();
  assert.equal(result.etag, null);
  assert.equal(result.latest, null);
  assert.deepEqual(result.doc.tiles, []);
});
