// POST /api/lately/login   body: { passcode }
//
// Checks the passcode against the LATELY_PASSCODE environment variable and,
// if it matches, sets the signed session cookie.

import { passcodeMatches, buildSessionCookie, isConfigured } from "../_lib/lately-auth.js";
import { json, isJsonRequest, isSameOrigin, sleep } from "../_lib/lately-http.js";

export function createHandler({ failDelayMs = 800 } = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }
    if (!isConfigured()) return json(res, 503, { error: "Editing isn’t set up yet" });
    if (!isJsonRequest(req)) return json(res, 415, { error: "Expected JSON" });
    if (!isSameOrigin(req)) return json(res, 403, { error: "Wrong origin" });

    const passcode = req.body && req.body.passcode;
    if (!passcodeMatches(passcode)) {
      // Serverless functions share no memory, so there's no real rate
      // limit here. A short delay makes guessing slow.
      await sleep(failDelayMs);
      return json(res, 401, { error: "Wrong passcode" });
    }

    res.setHeader("Set-Cookie", buildSessionCookie());
    return json(res, 200, { ok: true });
  };
}

export default createHandler();
