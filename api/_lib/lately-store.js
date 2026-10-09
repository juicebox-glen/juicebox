// The only module that talks to Vercel Blob. Handlers receive a store
// object, so tests can swap in an in-memory one.
//
// The tiles document is one JSON file in Blob. Writes use the file's ETag
// (`ifMatch`), so a stale tab can't silently overwrite newer changes.

import {
  put,
  head,
  del,
  BlobNotFoundError,
  BlobPreconditionFailedError,
} from "@vercel/blob";
import { DEFAULT_DOC, DOC_PATH, normalizeStoredDoc } from "./lately-schema.js";

export class ConflictError extends Error {
  constructor() {
    super("The page changed somewhere else");
    this.name = "ConflictError";
  }
}

const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 400;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBlobStore({
  blob = { put, head, del },
  fetchFile = (url, init) => fetch(url, init),
  pause = wait,
} = {}) {
  return {
    // -> { doc, etag, latest }  (etag and latest are null until the file exists)
    //   etag    describes the downloaded `doc` exactly (see below)
    //   latest  is the newest version according to Blob itself
    //
    // After a change, the CDN can keep serving the previous copy of the file
    // for a few minutes even though `head` already reports the new version.
    // So the ETag handed back is the one the downloaded copy actually came
    // with, never the one `head` reported: a stale copy is then paired with
    // its own old ETag, and saving from it is refused as a conflict instead
    // of silently overwriting newer tiles. A few quick retries usually get
    // the fresh copy before that matters.
    async readDoc() {
      let meta;
      try {
        meta = await blob.head(DOC_PATH);
      } catch (error) {
        if (error instanceof BlobNotFoundError) {
          return { doc: structuredClone(DEFAULT_DOC), etag: null, latest: null };
        }
        throw error;
      }

      let latest;
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
        // The query string varies the request so it isn't answered from a cache.
        const response = await fetchFile(`${meta.url}?t=${Date.now()}-${attempt}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Could not read tiles (${response.status})`);

        const etag = response.headers.get("etag") || meta.etag;
        latest = { doc: normalizeStoredDoc(await response.json()), etag, latest: meta.etag };
        if (etag === meta.etag) return latest;
        if (attempt < READ_ATTEMPTS - 1) await pause(READ_RETRY_MS);
      }
      return latest;
    },

    // -> { etag }. Throws ConflictError if `etag` no longer matches.
    async writeDoc(doc, etag) {
      try {
        const result = await blob.put(DOC_PATH, JSON.stringify(doc), {
          access: "public",
          contentType: "application/json",
          addRandomSuffix: false,
          cacheControlMaxAge: 60,
          ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
        });
        return { etag: result.etag ?? (await blob.head(DOC_PATH)).etag };
      } catch (error) {
        if (
          error instanceof BlobPreconditionFailedError ||
          /already exists/i.test(String(error && error.message))
        ) {
          throw new ConflictError();
        }
        throw error;
      }
    },

    async deleteUrls(urls) {
      if (urls.length > 0) await blob.del(urls);
    },
  };
}
