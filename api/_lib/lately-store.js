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

export function createBlobStore() {
  return {
    // -> { doc, etag }  (etag is null until the file exists)
    async readDoc() {
      let meta;
      try {
        meta = await head(DOC_PATH);
      } catch (error) {
        if (error instanceof BlobNotFoundError) {
          return { doc: structuredClone(DEFAULT_DOC), etag: null };
        }
        throw error;
      }
      // The query string skips any cached copy at the CDN.
      const response = await fetch(`${meta.url}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not read tiles (${response.status})`);
      return { doc: normalizeStoredDoc(await response.json()), etag: meta.etag };
    },

    // -> { etag }. Throws ConflictError if `etag` no longer matches.
    async writeDoc(doc, etag) {
      try {
        const result = await put(DOC_PATH, JSON.stringify(doc), {
          access: "public",
          contentType: "application/json",
          addRandomSuffix: false,
          cacheControlMaxAge: 60,
          ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
        });
        return { etag: result.etag ?? (await head(DOC_PATH)).etag };
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
      if (urls.length > 0) await del(urls);
    },
  };
}
