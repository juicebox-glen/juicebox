// The shape of the /lately tiles document, and the rules for it.
//
// Pure JS with no Node imports, so the browser code can import the same
// limits the server enforces.

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_POSTER_BYTES = 2 * 1024 * 1024;

export const MAX_TILES = 300;
export const MAX_PROJECTS = 30;
export const MAX_INTRO = 800;
export const MAX_TITLE = 120;
export const MAX_LINE = 240;
export const MAX_LINK = 500;
export const MAX_PROJECT_NAME = 40;

export const MEDIA_PREFIX = "lately/media/";
export const DOC_PATH = "lately/tiles.json";

export const DEFAULT_DOC = Object.freeze({
  version: 1,
  intro: "Hello. A rolling look at what I’m making at the moment.",
  projects: ["WiiF", "WiiFendo", "Patch", "Nudge"],
  tiles: [],
});

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const BLOB_HOST_RE = /^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/;

export function isBlobUrl(value) {
  if (typeof value !== "string" || value.length > 600) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    BLOB_HOST_RE.test(url.hostname) &&
    url.pathname.startsWith(`/${MEDIA_PREFIX}`)
  );
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanText(value, max, { required = false, label }) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") return { error: `${label} must be text` };
  const text = value.trim();
  if (required && text.length === 0) return { error: `${label} is required` };
  if (text.length > max) return { error: `${label} is too long (max ${max})` };
  return { value: text };
}

function cleanDimension(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 20000) return { error: `${label} is invalid` };
  return { value: Math.round(n) };
}

// Returns { ok: true, doc } with a freshly built, sanitised document, or
// { ok: false, error }. Unknown properties are dropped.
export function validateDoc(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Document must be an object" };
  }

  const intro = cleanText(input.intro, MAX_INTRO, { label: "Intro" });
  if (intro.error) return { ok: false, error: intro.error };

  if (!Array.isArray(input.projects) || input.projects.length > MAX_PROJECTS) {
    return { ok: false, error: "Projects must be a short list" };
  }
  const projects = [];
  const seenProjects = new Set();
  for (const raw of input.projects) {
    const name = cleanText(raw, MAX_PROJECT_NAME, { required: true, label: "Project name" });
    if (name.error) return { ok: false, error: name.error };
    const key = name.value.toLowerCase();
    if (seenProjects.has(key)) return { ok: false, error: "Duplicate project name" };
    seenProjects.add(key);
    projects.push(name.value);
  }

  if (!Array.isArray(input.tiles) || input.tiles.length > MAX_TILES) {
    return { ok: false, error: `At most ${MAX_TILES} tiles` };
  }
  const tiles = [];
  const seenIds = new Set();
  for (const raw of input.tiles) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "Bad tile" };

    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      return { ok: false, error: "Bad tile id" };
    }
    if (seenIds.has(raw.id)) return { ok: false, error: "Duplicate tile id" };
    seenIds.add(raw.id);

    if (raw.type !== "image" && raw.type !== "video") {
      return { ok: false, error: "Tile type must be image or video" };
    }
    if (!isBlobUrl(raw.url)) return { ok: false, error: "Tile media must be in the Blob store" };

    let poster = "";
    if (raw.type === "video") {
      if (!isBlobUrl(raw.poster)) return { ok: false, error: "Videos need a poster frame" };
      poster = raw.poster;
    } else if (raw.poster) {
      return { ok: false, error: "Only videos have a poster" };
    }

    const width = cleanDimension(raw.width, "Width");
    if (width.error) return { ok: false, error: width.error };
    const height = cleanDimension(raw.height, "Height");
    if (height.error) return { ok: false, error: height.error };

    const title = cleanText(raw.title, MAX_TITLE, { required: true, label: "Title" });
    if (title.error) return { ok: false, error: title.error };
    const line = cleanText(raw.line, MAX_LINE, { label: "Description" });
    if (line.error) return { ok: false, error: line.error };

    const link = cleanText(raw.link, MAX_LINK, { label: "Link" });
    if (link.error) return { ok: false, error: link.error };
    if (link.value && !isHttpUrl(link.value)) {
      return { ok: false, error: "Link must start with http:// or https://" };
    }

    const project = cleanText(raw.project, MAX_PROJECT_NAME, { label: "Project" });
    if (project.error) return { ok: false, error: project.error };
    if (project.value && !seenProjects.has(project.value.toLowerCase())) {
      return { ok: false, error: `Unknown project "${project.value}"` };
    }
    // Store the canonical spelling from the projects list.
    const canonical = project.value
      ? projects.find((p) => p.toLowerCase() === project.value.toLowerCase())
      : "";

    tiles.push({
      id: raw.id,
      type: raw.type,
      url: raw.url,
      ...(poster ? { poster } : {}),
      width: width.value,
      height: height.value,
      title: title.value,
      line: line.value,
      link: link.value,
      project: canonical,
    });
  }

  return { ok: true, doc: { version: 1, intro: intro.value, projects, tiles } };
}

// Tolerant read used when loading what is already stored: if the stored
// file is somehow damaged the page falls back to the default rather than
// breaking.
export function normalizeStoredDoc(raw) {
  const result = validateDoc(raw);
  return result.ok ? result.doc : structuredClone(DEFAULT_DOC);
}

// Every Blob URL a document points at (media and posters).
export function docUrls(doc) {
  const urls = new Set();
  for (const tile of doc.tiles) {
    urls.add(tile.url);
    if (tile.poster) urls.add(tile.poster);
  }
  return urls;
}

// Rules for what the browser is allowed to upload, decided by the server
// before it hands out an upload token. `kind` comes from the client but
// every limit is looked up here.
const UPLOAD_RULES = {
  image: {
    pathname: new RegExp(`^${MEDIA_PREFIX}[A-Za-z0-9-]{8,64}\\.webp$`),
    types: ["image/webp"],
    max: MAX_IMAGE_BYTES,
  },
  poster: {
    pathname: new RegExp(`^${MEDIA_PREFIX}[A-Za-z0-9-]{8,64}\\.webp$`),
    types: ["image/webp"],
    max: MAX_POSTER_BYTES,
  },
  video: {
    pathname: new RegExp(`^${MEDIA_PREFIX}[A-Za-z0-9-]{8,64}\\.(mp4|webm|mov)$`),
    types: ["video/mp4", "video/webm", "video/quicktime"],
    max: MAX_VIDEO_BYTES,
  },
};

export function uploadRule(pathname, clientPayload) {
  let kind;
  try {
    kind = JSON.parse(clientPayload || "{}").kind;
  } catch {
    return null;
  }
  const rule = Object.hasOwn(UPLOAD_RULES, kind) ? UPLOAD_RULES[kind] : null;
  if (!rule || typeof pathname !== "string" || !rule.pathname.test(pathname)) return null;
  return { allowedContentTypes: rule.types, maximumSizeInBytes: rule.max };
}
