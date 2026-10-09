// GET    /api/lately/tiles   public: the page content, plus whether this
//                           browser is signed in as the editor
// PUT    /api/lately/tiles   editor only: replace the page content
// DELETE /api/lately/tiles   editor only: discard uploaded files that never
//                           made it into the page
//
// Every route that changes anything checks the signed cookie first.

import { BlobError } from "@vercel/blob";
import { isAuthed } from "../_lib/lately-auth.js";
import { json, isJsonRequest, isSameOrigin } from "../_lib/lately-http.js";
import { validateDoc, docUrls, isBlobUrl } from "../_lib/lately-schema.js";
import { createBlobStore, ConflictError } from "../_lib/lately-store.js";

export function createHandler({ store = createBlobStore() } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method === "GET") {
        const { doc, etag } = await store.readDoc();
        return json(res, 200, { doc, etag, editing: isAuthed(req) });
      }

      if (req.method === "PUT" || req.method === "DELETE") {
        if (!isAuthed(req)) return json(res, 401, { error: "Not signed in" });
        if (!isJsonRequest(req)) return json(res, 415, { error: "Expected JSON" });
        if (!isSameOrigin(req)) return json(res, 403, { error: "Wrong origin" });
        return req.method === "PUT" ? await save(req, res, store) : await discard(req, res, store);
      }

      res.setHeader("Allow", "GET, PUT, DELETE");
      return json(res, 405, { error: "Method not allowed" });
    } catch (error) {
      console.error("lately/tiles error:", error);
      // Storage problems (wrong store type, missing token, ...) carry a
      // readable message from Vercel Blob. Pass it on so it's diagnosable.
      if (error instanceof BlobError) {
        return json(res, 502, { error: `Storage problem: ${String(error.message).slice(0, 240)}` });
      }
      return json(res, 500, { error: "Server error" });
    }
  };
}

async function save(req, res, store) {
  const body = req.body || {};
  const checked = validateDoc(body.doc);
  if (!checked.ok) return json(res, 400, { error: checked.error });

  const sentEtag = typeof body.etag === "string" ? body.etag : null;
  const current = await store.readDoc();
  if (current.etag !== sentEtag) {
    return json(res, 409, { error: "Changed elsewhere", doc: current.doc, etag: current.etag });
  }

  let written;
  try {
    written = await store.writeDoc(checked.doc, sentEtag);
  } catch (error) {
    if (error instanceof ConflictError) {
      const fresh = await store.readDoc();
      return json(res, 409, { error: "Changed elsewhere", doc: fresh.doc, etag: fresh.etag });
    }
    throw error;
  }

  // Files that were in the old page but aren't in the new one are gone
  // for good: remove them from Blob too.
  const keep = docUrls(checked.doc);
  const removed = [...docUrls(current.doc)].filter((url) => !keep.has(url));
  try {
    await store.deleteUrls(removed);
  } catch (error) {
    console.error("lately/tiles: could not delete removed files", error);
  }

  return json(res, 200, { doc: checked.doc, etag: written.etag });
}

async function discard(req, res, store) {
  const urls = req.body && req.body.urls;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 20 || !urls.every(isBlobUrl)) {
    return json(res, 400, { error: "Bad file list" });
  }
  // Never delete anything the page currently uses.
  const { doc } = await store.readDoc();
  const inUse = docUrls(doc);
  const orphans = urls.filter((url) => !inUse.has(url));
  await store.deleteUrls(orphans);
  return json(res, 200, { deleted: orphans.length });
}

export default createHandler();
