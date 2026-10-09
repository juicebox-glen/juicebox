// Passcode check and signed session cookie for the /lately editor.
//
// The only secret is the LATELY_PASSCODE environment variable. The cookie
// is signed with a key derived from it, so changing the passcode signs
// every device out.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "lately_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 30;

const MAX_PASSCODE_LENGTH = 200;

function configuredPasscode() {
  const value = process.env.LATELY_PASSCODE;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isConfigured() {
  return configuredPasscode() !== null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function signingKey(passcode) {
  return sha256(`lately-session-v1:${passcode}`);
}

function sign(payload, passcode) {
  return createHmac("sha256", signingKey(passcode)).update(payload).digest("hex");
}

function safeEqualStrings(a, b) {
  // Hash first so both buffers are the same length and the comparison
  // time doesn't depend on where the strings differ.
  return timingSafeEqual(sha256(a), sha256(b));
}

export function passcodeMatches(input) {
  const expected = configuredPasscode();
  if (expected === null) return false;
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_PASSCODE_LENGTH) {
    return false;
  }
  return safeEqualStrings(input, expected);
}

export function buildSessionCookie(now = Date.now()) {
  const passcode = configuredPasscode();
  if (passcode === null) throw new Error("LATELY_PASSCODE is not set");
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const payload = String(expires);
  const value = `${payload}.${sign(payload, passcode)}`;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function buildClearedCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function isAuthed(req, now = Date.now()) {
  const passcode = configuredPasscode();
  if (passcode === null) return false;

  const raw = readCookie(req, COOKIE_NAME);
  if (!raw) return false;

  const dot = raw.indexOf(".");
  if (dot === -1) return false;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  if (!/^\d{1,12}$/.test(payload)) return false;
  if (!safeEqualStrings(signature, sign(payload, passcode))) return false;
  return Number(payload) > Math.floor(now / 1000);
}
