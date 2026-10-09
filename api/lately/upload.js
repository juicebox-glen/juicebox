// POST /api/lately/upload   editor only
//
// Videos can be up to 20 MB, which is too big to send through a Vercel
// function, so the browser uploads straight to Blob. This route only hands
// out a short-lived, single-file upload permission, and only to a signed-in
// editor.
//
// It uses Blob's presigned-URL flow, which works with the store's built-in
// Vercel identity (BLOB_STORE_ID). The older client-token flow needs a
// BLOB_READ_WRITE_TOKEN, which stores created today don't have.
//
// No upload-completed callback is configured, so Blob never calls this
// route back: every request to it needs the editor cookie.

import { handleUploadPresigned } from "@vercel/blob/client";
import { issueSignedToken } from "@vercel/blob";
import { isAuthed } from "../_lib/lately-auth.js";
import { json, isJsonRequest, isSameOrigin } from "../_lib/lately-http.js";
import { uploadRule } from "../_lib/lately-schema.js";

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

export function createHandler({ upload = handleUploadPresigned, issue = issueSignedToken } = {}) {
  // What the browser is allowed to upload is decided here, from our rules.
  // The same limits go on both the signed token and the presigned URL.
  async function getSignedToken(pathname, clientPayload) {
    const rule = uploadRule(pathname, clientPayload);
    if (!rule) throw new Error("That file isn’t allowed");

    const limits = {
      allowedContentTypes: rule.allowedContentTypes,
      maximumSizeInBytes: rule.maximumSizeInBytes,
      validUntil: Date.now() + TOKEN_LIFETIME_MS,
    };
    // The permission is for this one file name, for upload only. The name
    // already contains a UUID from the browser, so no random suffix is
    // asked for (the stored name is exactly the one signed for), and
    // overwriting is off, so an existing file can never be replaced.
    const token = await issue({ pathname, operations: ["put"], ...limits });
    return { token, urlOptions: { ...limits } };
  }

  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }
    if (!isAuthed(req)) return json(res, 401, { error: "Not signed in" });
    if (!isJsonRequest(req)) return json(res, 415, { error: "Expected JSON" });
    if (!isSameOrigin(req)) return json(res, 403, { error: "Wrong origin" });

    try {
      const result = await upload({ body: req.body, request: req, getSignedToken });
      return json(res, 200, result);
    } catch (error) {
      console.error("lately/upload error:", error);
      return json(res, 400, { error: error instanceof Error ? error.message : "Upload failed" });
    }
  };
}

export default createHandler();
