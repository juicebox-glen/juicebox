// Small helpers shared by the /api/lately/* functions.

export function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

export function isJsonRequest(req) {
  const type = (req.headers && req.headers["content-type"]) || "";
  return type.toLowerCase().startsWith("application/json");
}

// Browsers always send Origin on cross-site writes. If it is present it
// must match this deployment's host. (Combined with SameSite=Strict on
// the cookie, this is belt and braces against cross-site requests.)
export function isSameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
