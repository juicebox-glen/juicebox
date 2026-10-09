import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BlobError } from "@vercel/blob";

import { buildSessionCookie } from "../api/_lib/lately-auth.js";
import { ConflictError } from "../api/_lib/lately-store.js";
import {
  MAX_VIDEO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_POSTER_BYTES,
  uploadRule,
} from "../api/_lib/lately-schema.js";
import { createHandler as createTiles } from "../api/lately/tiles.js";
import { createHandler as createUpload } from "../api/lately/upload.js";
import { createHandler as createLogin } from "../api/lately/login.js";

const PASSCODE = "correct horse battery staple";
const HOST = "https://abc123def.public.blob.vercel-storage.com/lately/media";
const img = (n) => `${HOST}/image-${n}-aaaa.webp`;
const vid = (n) => `${HOST}/video-${n}-aaaa.mp4`;

beforeEach(() => {
  process.env.LATELY_PASSCODE = PASSCODE;
});

// ---- helpers ---------------------------------------------------------

function fakeStore(initial) {
  let n = 1;
  const state = {
    doc: initial ?? { version: 1, intro: "hi", projects: ["WiiF", "Patch"], tiles: [] },
    etag: `etag-${n}`,
    deleted: [],
    writes: 0,
  };
  return {
    state,
    async readDoc() {
      return { doc: structuredClone(state.doc), etag: state.etag, latest: state.etag };
    },
    async writeDoc(doc, etag) {
      if (etag !== state.etag) throw new ConflictError();
      state.doc = doc;
      state.etag = `etag-${++n}`;
      state.writes += 1;
      return { etag: state.etag };
    },
    async deleteUrls(urls) {
      state.deleted.push(...urls);
    },
  };
}

function req({ method = "PUT", cookie, body, headers = {} } = {}) {
  return {
    method,
    body,
    headers: {
      host: "example.com",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  };
}

function res() {
  const out = { statusCode: null, body: null, headers: {} };
  out.setHeader = (k, v) => void (out.headers[k.toLowerCase()] = v);
  out.status = (code) => ((out.statusCode = code), out);
  out.json = (b) => ((out.body = b), out);
  return out;
}

const sessionCookie = (now) => buildSessionCookie(now).split(";")[0];

const tile = (over = {}) => ({
  id: "tile-0001",
  type: "image",
  url: img(1),
  width: 1200,
  height: 800,
  title: "Splash screen",
  line: "Animated the splash screen",
  link: "",
  project: "WiiF",
  ...over,
});

const docWith = (tiles, over = {}) => ({
  version: 1,
  intro: "hi",
  projects: ["WiiF", "Patch"],
  tiles,
  ...over,
});

// ---- the cookie is required ------------------------------------------

test("tiles PUT refuses without the cookie, and writes nothing", async () => {
  const store = fakeStore();
  const response = res();
  await createTiles({ store })(
    req({ body: { doc: docWith([tile()]), etag: store.state.etag } }),
    response,
  );
  assert.equal(response.statusCode, 401);
  assert.equal(store.state.writes, 0);
});

test("tiles DELETE refuses without the cookie, and deletes nothing", async () => {
  const store = fakeStore();
  const response = res();
  await createTiles({ store })(req({ method: "DELETE", body: { urls: [img(9)] } }), response);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(store.state.deleted, []);
});

test("upload refuses without the cookie, and never asks Blob for a token", async () => {
  let asked = false;
  const handler = createUpload({
    upload: async () => {
      asked = true;
      return {};
    },
  });
  const response = res();
  await handler(
    req({
      method: "POST",
      body: {
        type: "blob.generate-client-token",
        payload: {
          pathname: "lately/media/abcd1234-shot.jpg",
          clientPayload: JSON.stringify({ kind: "image" }),
        },
      },
    }),
    response,
  );
  assert.equal(response.statusCode, 401);
  assert.equal(asked, false);
});

test("forged, expired and wrongly signed cookies are all refused", async () => {
  const store = fakeStore();
  const body = { doc: docWith([tile()]), etag: store.state.etag };

  const wrongKey = (() => {
    process.env.LATELY_PASSCODE = "a different passcode";
    const cookie = sessionCookie();
    process.env.LATELY_PASSCODE = PASSCODE;
    return cookie;
  })();

  const attempts = {
    garbage: "lately_session=abc",
    "bad signature": "lately_session=9999999999.deadbeef",
    "no signature": "lately_session=9999999999",
    expired: sessionCookie(0),
    "signed with another passcode": wrongKey,
  };

  for (const [name, cookie] of Object.entries(attempts)) {
    const response = res();
    await createTiles({ store })(req({ cookie, body }), response);
    assert.equal(response.statusCode, 401, name);
  }
  assert.equal(store.state.writes, 0);
});

test("with no passcode configured, nothing is ever authorised", async () => {
  const cookie = sessionCookie(); // made while the passcode exists
  delete process.env.LATELY_PASSCODE;
  const store = fakeStore();
  const response = res();
  await createTiles({ store })(
    req({ cookie, body: { doc: docWith([tile()]), etag: store.state.etag } }),
    response,
  );
  assert.equal(response.statusCode, 401);
});

test("a cross-site Origin is refused even with a valid cookie", async () => {
  const store = fakeStore();
  const response = res();
  await createTiles({ store })(
    req({
      cookie: sessionCookie(),
      headers: { origin: "https://evil.example" },
      body: { doc: docWith([tile()]), etag: store.state.etag },
    }),
    response,
  );
  assert.equal(response.statusCode, 403);
  assert.equal(store.state.writes, 0);
});

// ---- logging in ------------------------------------------------------

test("login: wrong passcode gets no cookie; right passcode gets a locked-down one", async () => {
  const login = createLogin({ failDelayMs: 0 });

  const wrong = res();
  await login(req({ method: "POST", body: { passcode: "nope" } }), wrong);
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers["set-cookie"], undefined);

  const right = res();
  await login(req({ method: "POST", body: { passcode: PASSCODE } }), right);
  assert.equal(right.statusCode, 200);
  const cookie = right.headers["set-cookie"];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);

  // ...and that cookie really does unlock editing.
  const store = fakeStore();
  const saved = res();
  await createTiles({ store })(
    req({
      cookie: cookie.split(";")[0],
      body: { doc: docWith([tile()]), etag: store.state.etag },
    }),
    saved,
  );
  assert.equal(saved.statusCode, 200);
});

// ---- what the editor can do ------------------------------------------

test("anyone can read the page, and is told whether they can edit", async () => {
  const store = fakeStore();
  const anon = res();
  await createTiles({ store })(req({ method: "GET" }), anon);
  assert.equal(anon.statusCode, 200);
  assert.equal(anon.body.editing, false);

  const editor = res();
  await createTiles({ store })(req({ method: "GET", cookie: sessionCookie() }), editor);
  assert.equal(editor.body.editing, true);
});

test("deleting a tile removes its video and poster from Blob", async () => {
  const withVideo = tile({
    id: "tile-0002",
    type: "video",
    url: vid(2),
    poster: img(2),
    project: "Patch",
  });
  const store = fakeStore(docWith([tile(), withVideo]));
  const response = res();
  await createTiles({ store })(
    req({ cookie: sessionCookie(), body: { doc: docWith([tile()]), etag: store.state.etag } }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(store.state.deleted.sort(), [vid(2), img(2)].sort());
});

test("a stale tab gets a conflict instead of overwriting newer changes", async () => {
  const store = fakeStore();
  const response = res();
  await createTiles({ store })(
    req({ cookie: sessionCookie(), body: { doc: docWith([tile()]), etag: "etag-old" } }),
    response,
  );
  assert.equal(response.statusCode, 409);
  assert.equal(store.state.writes, 0);
});

test("saving right after another save works even while the downloaded copy is stale", async () => {
  // Blob already says the newest version is e2, but the CDN still hands back
  // the old copy (and its old etag e1). The browser, which just saved, holds
  // the newest etag and a full up-to-date document. This must go through:
  // adding several items in a row is the normal way to use the page.
  const store = fakeStore();
  const stale = { version: 1, intro: "old", projects: ["WiiF", "Patch"], tiles: [] };
  store.readDoc = async () => ({ doc: stale, etag: "e1", latest: "e2" });
  const written = [];
  store.writeDoc = async (doc, etag) => (written.push(etag), { etag: "e3" });

  const response = res();
  await createTiles({ store })(
    req({ cookie: sessionCookie(), body: { doc: docWith([tile()]), etag: "e2" } }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(written, ["e2"]); // the write itself is conditional on the newest version
});

test("a browser holding a stale copy is refused instead of overwriting newer tiles", async () => {
  // A reload during the same stale window downloads the old copy WITH its old
  // etag (e1). Saving from it must be refused, or the newest tiles would be dropped.
  const store = fakeStore();
  const stale = { version: 1, intro: "old", projects: ["WiiF", "Patch"], tiles: [] };
  store.readDoc = async () => ({ doc: stale, etag: "e1", latest: "e2" });
  let wrote = false;
  store.writeDoc = async () => ((wrote = true), { etag: "e3" });

  const response = res();
  await createTiles({ store })(
    req({ cookie: sessionCookie(), body: { doc: docWith([tile()]), etag: "e1" } }),
    response,
  );
  assert.equal(response.statusCode, 409);
  assert.equal(wrote, false);
});

test("discarding never deletes a file the page is using", async () => {
  const store = fakeStore(docWith([tile()]));
  const response = res();
  await createTiles({ store })(
    req({ method: "DELETE", cookie: sessionCookie(), body: { urls: [img(1), img(7)] } }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(store.state.deleted, [img(7)]);
});

// ---- the rules for what gets saved -----------------------------------

test("the server rejects content it shouldn't store", async () => {
  const cases = {
    "media outside our Blob store": tile({ url: "https://evil.example/x.webp" }),
    "javascript: link": tile({ link: "javascript:alert(1)" }),
    "video without a poster": tile({ type: "video", url: vid(3) }),
    "unknown project": tile({ project: "Nope" }),
    "empty title": tile({ title: "   " }),
    "title that's far too long": tile({ title: "x".repeat(500) }),
  };
  for (const [name, bad] of Object.entries(cases)) {
    const store = fakeStore();
    const response = res();
    await createTiles({ store })(
      req({ cookie: sessionCookie(), body: { doc: docWith([bad]), etag: store.state.etag } }),
      response,
    );
    assert.equal(response.statusCode, 400, name);
    assert.equal(store.state.writes, 0, name);
  }
});

test("upload rules: 20 MB video cap, WebP or JPEG images tied to their extension, our folder only", () => {
  const video = uploadRule("lately/media/abcd1234-clip.mp4", JSON.stringify({ kind: "video" }));
  assert.equal(video.maximumSizeInBytes, MAX_VIDEO_BYTES);
  assert.equal(MAX_VIDEO_BYTES, 20 * 1024 * 1024);
  assert.ok(video.allowedContentTypes.includes("video/mp4"));

  // WebP is the normal case; JPEG is the fallback for browsers that can't encode WebP.
  const types = (pathname, kind) =>
    uploadRule(pathname, JSON.stringify({ kind }))?.allowedContentTypes;
  assert.deepEqual(types("lately/media/abcd1234-shot.webp", "image"), ["image/webp"]);
  assert.deepEqual(types("lately/media/abcd1234-shot.jpg", "image"), ["image/jpeg"]);
  assert.deepEqual(types("lately/media/abcd1234-frame.webp", "poster"), ["image/webp"]);
  assert.deepEqual(types("lately/media/abcd1234-frame.jpg", "poster"), ["image/jpeg"]);
  assert.equal(
    uploadRule("lately/media/abcd1234-frame.jpg", JSON.stringify({ kind: "poster" })).maximumSizeInBytes,
    MAX_POSTER_BYTES,
  );

  const bad = [
    ["lately/media/abcd1234-shot.png", { kind: "image" }],
    ["lately/media/abcd1234-shot.jpeg", { kind: "image" }],
    ["lately/media/abcd1234-shot.gif", { kind: "image" }],
    ["lately/media/abcd1234-shot.jpg", { kind: "video" }],
    ["lately/media/abcd1234-clip.mp4", { kind: "image" }],
    ["lately/media/abcd1234-clip.exe", { kind: "video" }],
    ["somewhere-else/abcd1234-shot.jpg", { kind: "image" }],
    ["lately/media/../tiles.json", { kind: "image" }],
    ["lately/media/abcd1234-clip.mp4", { kind: "script" }],
  ];
  for (const [pathname, payload] of bad) {
    assert.equal(uploadRule(pathname, JSON.stringify(payload)), null, pathname);
  }
  assert.equal(uploadRule("lately/media/abcd1234-clip.mp4", "not json"), null);
});

test("a signed-in editor is given upload permission for exactly one .jpg file", async () => {
  // Stand-ins for Blob: `issue` records the permission we ask it to mint, and
  // `upload` (Blob's presigned handler) just runs our getSignedToken.
  const issued = [];
  const handler = createUpload({
    issue: async (options) => {
      issued.push(options);
      return { fakeToken: true };
    },
    upload: async ({ body, getSignedToken }) => {
      const { pathname, clientPayload, multipart } = body.payload;
      return { type: body.type, ...(await getSignedToken(pathname, clientPayload, multipart)) };
    },
  });
  const ask = (pathname, kind) => ({
    type: "blob.generate-presigned-url",
    payload: { pathname, clientPayload: JSON.stringify({ kind }), multipart: false },
  });

  const path = "lately/media/abcd1234-shot.jpg";
  const before = Date.now();
  const ok = res();
  await handler(req({ method: "POST", cookie: sessionCookie(), body: ask(path, "image") }), ok);

  assert.equal(ok.statusCode, 200);
  assert.equal(issued.length, 1);
  const [perm] = issued;
  assert.equal(perm.pathname, path); // this one file, not the whole store
  assert.deepEqual(perm.operations, ["put"]); // upload only: no read, no delete
  assert.deepEqual(perm.allowedContentTypes, ["image/jpeg"]);
  assert.equal(perm.maximumSizeInBytes, MAX_IMAGE_BYTES);
  assert.ok(perm.validUntil > before && perm.validUntil <= before + 11 * 60 * 1000, "expires within ~10 minutes");

  // the same limits go on the presigned URL, and an existing file can't be replaced
  const { urlOptions } = ok.body;
  assert.deepEqual(urlOptions.allowedContentTypes, ["image/jpeg"]);
  assert.equal(urlOptions.maximumSizeInBytes, MAX_IMAGE_BYTES);
  assert.notEqual(urlOptions.allowOverwrite, true);
  assert.equal(urlOptions.addRandomSuffix, undefined);

  // a video gets the 20 MB cap
  issued.length = 0;
  await handler(
    req({ method: "POST", cookie: sessionCookie(), body: ask("lately/media/abcd1234-clip.mp4", "video") }),
    res(),
  );
  assert.equal(issued[0].maximumSizeInBytes, MAX_VIDEO_BYTES);

  // a disallowed file is refused and no permission is ever requested for it
  issued.length = 0;
  const refused = res();
  await handler(
    req({ method: "POST", cookie: sessionCookie(), body: ask("lately/media/abcd1234-shot.png", "image") }),
    refused,
  );
  assert.equal(refused.statusCode, 400);
  assert.equal(issued.length, 0);
});

test("a Blob storage problem is reported readably, not as a bare 'Server error'", async () => {
  const store = fakeStore();
  store.writeDoc = async () => {
    throw new BlobError("This store is private, use access: 'private'");
  };
  const response = res();
  await createTiles({ store })(
    req({ cookie: sessionCookie(), body: { doc: docWith([tile()]), etag: store.state.etag } }),
    response,
  );
  assert.equal(response.statusCode, 502);
  assert.match(response.body.error, /^Storage problem: .*private/);
  // ...but it never echoes anything secret: the message is Blob's own text.
  assert.doesNotMatch(JSON.stringify(response.body), /vercel_blob_rw_|LATELY_PASSCODE|correct horse/);
});

test("a tile with a JPEG image saves like any other", async () => {
  const store = fakeStore();
  const jpeg = tile({ url: `${HOST}/image-9-aaaa.jpg` });
  const response = res();
  await createTiles({ store })(
    req({ cookie: sessionCookie(), body: { doc: docWith([jpeg]), etag: store.state.etag } }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(store.state.doc.tiles[0].url, jpeg.url);
});
