// POST /api/lately/logout   clears the session cookie on this browser.

import { buildClearedCookie } from "../_lib/lately-auth.js";
import { json, isSameOrigin } from "../_lib/lately-http.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }
  if (!isSameOrigin(req)) return json(res, 403, { error: "Wrong origin" });
  res.setHeader("Set-Cookie", buildClearedCookie());
  return json(res, 200, { ok: true });
}
