// POST /api/lately/upload   editor only
//
// Videos can be up to 20 MB, which is too big to send through a Vercel
// function, so the browser uploads straight to Blob. This route only hands
// out a short-lived upload token, and only to a signed-in editor.
//
// No upload-completed callback is configured, so Blob never calls this
// route back: every request to it needs the editor cookie.

import { handleUpload } from "@vercel/blob/client";
import { isAuthed } from "../_lib/lately-auth.js";
import { json, isJsonRequest, isSameOrigin } from "../_lib/lately-http.js";
import { uploadRule } from "../_lib/lately-schema.js";

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

export function createHandler({ upload = handleUpload } = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }
    if (!isAuthed(req)) return json(res, 401, { error: "Not signed in" });
    if (!isJsonRequest(req)) return json(res, 415, { error: "Expected JSON" });
    if (!isSameOrigin(req)) return json(res, 403, { error: "Wrong origin" });

    try {
      const result = await upload({
        body: req.body,
        request: req,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          const rule = uploadRule(pathname, clientPayload);
          if (!rule) throw new Error("That file isn’t allowed");
          return {
            ...rule,
            addRandomSuffix: true,
            validUntil: Date.now() + TOKEN_LIFETIME_MS,
          };
        },
      });
      return json(res, 200, result);
    } catch (error) {
      console.error("lately/upload error:", error);
      return json(res, 400, { error: error instanceof Error ? error.message : "Upload failed" });
    }
  };
}

export default createHandler();
