// /lately — the page's browser code.
//
// Loads the tiles from /api/lately/tiles, draws the masonry grid and filter
// chips, and (once unlocked with the passcode) lets the owner upload, edit,
// reorder and delete tiles. Nothing built from stored data goes through
// innerHTML: text is always set with textContent.

import { uploadPresigned } from "@vercel/blob/client";
import {
  MAX_VIDEO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_POSTER_BYTES,
  MAX_INTRO,
  MAX_TITLE,
  MAX_LINE,
  MAX_LINK,
  MAX_PROJECT_NAME,
} from "../../api/_lib/lately-schema.js";

const IMAGE_MAX_EDGE = 2000;
const POSTER_MAX_EDGE = 1280;
const JPEG_QUALITY = 0.85;
const VIDEO_TYPES = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
const NEW_PROJECT = "__new__";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const dom = {
  toolbar: $("latelyToolbar"),
  add: $("latelyAdd"),
  lock: $("latelyLock"),
  status: $("latelyStatus"),
  hello: $("latelyHello"),
  chips: $("latelyChips"),
  grid: $("latelyGrid"),
  empty: $("latelyEmpty"),
  unlock: $("latelyUnlock"),
  unlockForm: $("latelyUnlockForm"),
  passcode: $("latelyPasscode"),
  unlockError: $("latelyUnlockError"),
  unlockGo: $("latelyUnlockGo"),
  unlockCancel: $("latelyUnlockCancel"),
  upload: $("latelyUpload"),
  drop: $("latelyDrop"),
  file: $("latelyFile"),
  drafts: $("latelyDrafts"),
  uploadError: $("latelyUploadError"),
  uploadGo: $("latelyUploadGo"),
  uploadCancel: $("latelyUploadCancel"),
  edit: $("latelyEdit"),
  editForm: $("latelyEditForm"),
  editFields: $("latelyEditFields"),
  editError: $("latelyEditError"),
  editCancel: $("latelyEditCancel"),
};

const state = {
  doc: null,
  etag: null,
  editing: false,
  filter: "All",
  dragId: null,
  uploading: false,
  lastProject: "",
};

// How a file gets to Blob. Replaced by a fake in the dev-only mock mode.
//
// Uses Blob's presigned-URL flow, which works with the store's built-in
// Vercel identity (no read-write token needed).
//
// If our server refuses to give upload permission, the Blob library only
// says "Failed to retrieve the presigned URL" and drops our reason. In that
// case ask the route again to find out what it actually said.
async function realUpload(pathname, body, options) {
  try {
    return await uploadPresigned(pathname, body, options);
  } catch (error) {
    if (!/(presigned|client token)/i.test(String(error && error.message))) throw error;
    const res = await api("/api/lately/upload", {
      method: "POST",
      body: {
        type: "blob.generate-presigned-url",
        payload: { pathname, clientPayload: options.clientPayload, multipart: false },
      },
    });
    if (res.status === 401) throw new Error("you’re signed out, so unlock editing again");
    throw new Error(
      (res.data && res.data.error) || `the server refused the upload (status ${res.status || "no response"})`,
    );
  }
}
let uploadImpl = realUpload;

const reasonOf = (error) => String((error && error.message) || "unknown error").replace(/\.$/, "");

/* ------------------------------------------------------------------ */
/* talking to the server                                               */
/* ------------------------------------------------------------------ */

async function api(path, { method = "GET", body } = {}) {
  try {
    const response = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* not JSON */
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

let statusTimer;
function setStatus(text, ms = 0, kind = "") {
  dom.status.textContent = text;
  dom.status.dataset.kind = kind;
  clearTimeout(statusTimer);
  if (ms) {
    statusTimer = setTimeout(() => {
      dom.status.textContent = "";
      dom.status.dataset.kind = "";
    }, ms);
  }
}

// Apply a change to the latest copy of the page and save it. If the page
// changed somewhere else in the meantime, take the newer copy and apply the
// change to that instead. `change` mutates the draft and may return false
// to say "the thing I was changing is gone".
async function mutate(change, { label = "Saving…" } = {}) {
  setStatus(label);
  for (let attempt = 0; attempt < 3; attempt++) {
    const draft = structuredClone(state.doc);
    if (change(draft) === false) {
      setStatus("");
      return { ok: false, reason: "gone" };
    }
    const res = await api("/api/lately/tiles", {
      method: "PUT",
      body: { doc: draft, etag: state.etag },
    });
    if (res.ok) {
      state.doc = res.data.doc;
      state.etag = res.data.etag;
      render();
      setStatus("Saved", 2000);
      return { ok: true };
    }
    if (res.status === 409 && res.data && res.data.doc) {
      state.doc = res.data.doc;
      state.etag = res.data.etag;
      continue;
    }
    if (res.status === 401) {
      state.editing = false;
      applyEditing();
      render();
      setStatus("Signed out — unlock again to save", 6000, "error");
      return { ok: false, reason: "auth" };
    }
    const message = (res.data && res.data.error) || "Couldn’t save. Check your connection.";
    setStatus(message, 6000, "error");
    return { ok: false, reason: "error", message };
  }
  setStatus("This keeps changing elsewhere. Try again.", 6000, "error");
  return { ok: false, reason: "conflict" };
}

/* ------------------------------------------------------------------ */
/* the page                                                            */
/* ------------------------------------------------------------------ */

const tileEls = new Map(); // id -> { el, sig }
let lastColumns = 0;

function render() {
  renderHello();
  renderChips();
  syncTiles();
  layoutGrid();
}

function renderHello() {
  if (document.activeElement !== dom.hello) dom.hello.textContent = state.doc.intro;
}

function visibleTiles() {
  return state.doc.tiles.filter((t) => state.filter === "All" || t.project === state.filter);
}

function renderChips() {
  const counts = new Map();
  for (const tile of state.doc.tiles) counts.set(tile.project, (counts.get(tile.project) || 0) + 1);
  // Visitors only see projects that have something in them.
  const names = state.doc.projects.filter((name) => state.editing || counts.get(name));
  if (state.filter !== "All" && !names.includes(state.filter)) state.filter = "All";

  dom.chips.hidden = names.length === 0;
  dom.chips.replaceChildren(
    ...["All", ...names].map((name) => {
      const chip = el("button", "lately-chip", name);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(name === state.filter));
      chip.addEventListener("click", () => {
        state.filter = name;
        const url = new URL(location.href);
        if (name === "All") url.searchParams.delete("p");
        else url.searchParams.set("p", name);
        history.replaceState(null, "", url);
        render();
      });
      return chip;
    }),
  );
}

function syncTiles() {
  const seen = new Set();
  for (const tile of state.doc.tiles) {
    seen.add(tile.id);
    const sig = JSON.stringify(tile);
    const known = tileEls.get(tile.id);
    if (!known || known.sig !== sig) tileEls.set(tile.id, { el: buildTile(tile), sig });
  }
  for (const id of [...tileEls.keys()]) if (!seen.has(id)) tileEls.delete(id);
}

function buildTile(tile) {
  const root = el("article", "tile");
  root.dataset.id = tile.id;
  root.draggable = state.editing;

  const media = el("div", "tile-media");
  media.style.aspectRatio = `${tile.width} / ${tile.height}`;

  if (tile.type === "image") {
    const img = el("img");
    img.src = tile.url;
    img.width = tile.width;
    img.height = tile.height;
    img.alt = tile.title;
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    media.append(img);
  } else {
    // Nothing downloads until someone presses play: preload is "none" and
    // the poster is only fetched once the tile is close to the screen.
    const video = el("video");
    video.preload = "none";
    video.playsInline = true;
    video.draggable = false;
    video.setAttribute("aria-label", tile.title);
    video.dataset.poster = tile.poster;
    video.src = tile.url;
    posterObserver.observe(video);

    const play = el("button", "tile-play");
    play.type = "button";
    play.setAttribute("aria-label", `Play video: ${tile.title}`);
    play.addEventListener("click", () => {
      play.remove();
      video.controls = true;
      video.play().catch(() => {});
    });
    media.append(video, play);
  }

  const meta = el("div", "tile-meta");
  const head = el("div", "tile-head");
  head.append(el("h3", "tile-title", tile.title));
  if (tile.project) head.append(el("span", "tile-tag", tile.project));
  meta.append(head);
  if (tile.line) meta.append(el("p", "tile-line", tile.line));
  if (tile.link) {
    const link = el("a", "tile-link", "View ↗");
    link.href = tile.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    meta.append(link);
  }

  const tools = el("div", "tile-tools");
  for (const [action, label] of [
    ["earlier", "← Earlier"],
    ["later", "Later →"],
    ["edit", "Edit"],
    ["delete", "Delete"],
  ]) {
    const button = el("button", "", label);
    button.type = "button";
    button.dataset.action = action;
    button.setAttribute("aria-label", `${label.replace(/[←→] /g, "")}: ${tile.title}`);
    tools.append(button);
  }

  root.append(media, meta, tools);
  return root;
}

// Video posters below the first screen wait until they're near the viewport.
const posterObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const video = entry.target;
      if (video.dataset.poster) video.poster = video.dataset.poster;
      posterObserver.unobserve(video);
    }
  },
  { rootMargin: "300px 0px" },
);

function columnCount() {
  const width = dom.grid.clientWidth || window.innerWidth;
  if (width < 540) return 1;
  if (width < 900) return 2;
  if (width < 1500) return 3;
  return 4;
}

// Masonry: each tile, in order, goes into whichever column is shortest.
// Media boxes have their final shape from the stored width/height, so
// heights are right before anything loads.
function layoutGrid() {
  const visible = visibleTiles();
  lastColumns = columnCount();

  dom.grid.replaceChildren();
  const columns = Array.from({ length: lastColumns }, () => dom.grid.appendChild(el("div", "lately-col")));
  for (const tile of visible) {
    const node = tileEls.get(tile.id).el;
    const shortest = columns.reduce((a, b) => (a.offsetHeight <= b.offsetHeight ? a : b));
    shortest.append(node);
  }

  // Images on the first screen load straight away; the rest stay lazy.
  const screenBottom = window.innerHeight;
  visible.forEach((tile, index) => {
    const node = tileEls.get(tile.id).el;
    const img = node.querySelector("img");
    if (img && img.loading === "lazy" && node.getBoundingClientRect().top < screenBottom) {
      img.loading = "eager";
    }
    node.querySelector('[data-action="earlier"]').disabled = index === 0;
    node.querySelector('[data-action="later"]').disabled = index === visible.length - 1;
  });

  dom.empty.hidden = visible.length > 0;
  if (visible.length === 0) {
    dom.empty.textContent = state.editing
      ? "Nothing here yet. Use Upload, or drop or paste images and videos."
      : "Nothing here yet.";
  }
}

new ResizeObserver(() => {
  if (state.doc && columnCount() !== lastColumns) layoutGrid();
}).observe(dom.grid);
document.fonts.ready.then(() => state.doc && layoutGrid());

/* ------------------------------------------------------------------ */
/* editing mode                                                        */
/* ------------------------------------------------------------------ */

function applyEditing() {
  document.body.classList.toggle("is-editing", state.editing);
  dom.toolbar.hidden = !state.editing;
  dom.hello.contentEditable = state.editing ? "plaintext-only" : "false";
  if (state.editing && dom.hello.contentEditable !== "plaintext-only") {
    dom.hello.contentEditable = "true";
  }
  for (const { el: node } of tileEls.values()) node.draggable = state.editing;
}

dom.hello.addEventListener("paste", (event) => {
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData("text");
  document.execCommand("insertText", false, text);
});

dom.hello.addEventListener("blur", () => {
  if (!state.editing || !state.doc) return;
  const text = dom.hello.innerText.replace(/ /g, " ").trim().slice(0, MAX_INTRO);
  if (text !== state.doc.intro) mutate((d) => void (d.intro = text));
});

dom.lock.addEventListener("click", async () => {
  await api("/api/lately/logout", { method: "POST" });
  state.editing = false;
  applyEditing();
  render();
  setStatus("");
});

/* unlock ----------------------------------------------------------- */

function clearEditHash() {
  if (location.hash === "#edit") history.replaceState(null, "", location.pathname + location.search);
}

function checkHash() {
  if (location.hash !== "#edit") return;
  if (state.editing) clearEditHash();
  else openUnlock();
}

function openUnlock() {
  dom.unlockError.textContent = "";
  dom.passcode.value = "";
  if (!dom.unlock.open) dom.unlock.showModal();
  dom.passcode.focus();
}

dom.unlockCancel.addEventListener("click", () => dom.unlock.close());
dom.unlock.addEventListener("close", clearEditHash);
window.addEventListener("hashchange", checkHash);

dom.unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  dom.unlockError.textContent = "";
  dom.unlockGo.disabled = true;
  const res = await api("/api/lately/login", { method: "POST", body: { passcode: dom.passcode.value } });
  dom.unlockGo.disabled = false;
  if (res.ok) {
    dom.passcode.value = "";
    dom.unlock.close();
    state.editing = true;
    applyEditing();
    render();
    setStatus("Editing unlocked", 2500);
  } else {
    dom.unlockError.textContent =
      res.status === 401
        ? "That passcode isn’t right."
        : (res.data && res.data.error) || "Couldn’t unlock. Try again.";
    dom.passcode.select();
  }
});

/* ------------------------------------------------------------------ */
/* tile actions: edit, delete, move                                    */
/* ------------------------------------------------------------------ */

const tileIndex = (d, id) => d.tiles.findIndex((t) => t.id === id);

function ensureProject(d, name) {
  const existing = d.projects.find((p) => p.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  d.projects.push(name);
  return name;
}

dom.grid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.editing) return;
  const id = button.closest(".tile").dataset.id;
  const tile = state.doc.tiles.find((t) => t.id === id);
  if (!tile) return;

  switch (button.dataset.action) {
    case "edit":
      return openEdit(tile);
    case "delete":
      if (!confirm(`Delete “${tile.title}”? This also removes its file.`)) return;
      return void mutate((d) => {
        const i = tileIndex(d, id);
        if (i < 0) return false;
        d.tiles.splice(i, 1);
      });
    case "earlier":
    case "later": {
      const visible = visibleTiles();
      const at = visible.findIndex((t) => t.id === id);
      const other = visible[at + (button.dataset.action === "earlier" ? -1 : 1)];
      if (!other) return;
      return void mutate((d) => {
        const a = tileIndex(d, id);
        const b = tileIndex(d, other.id);
        if (a < 0 || b < 0) return false;
        [d.tiles[a], d.tiles[b]] = [d.tiles[b], d.tiles[a]];
      });
    }
  }
});

// drag to reorder (mouse; on a phone use the Earlier / Later buttons)
dom.grid.addEventListener("dragstart", (event) => {
  const tile = event.target.closest && event.target.closest('.tile[draggable="true"]');
  if (!tile) return;
  state.dragId = tile.dataset.id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.dragId);
  tile.classList.add("is-dragging");
});

dom.grid.addEventListener("dragover", (event) => {
  if (state.dragId && event.target.closest(".tile")) event.preventDefault();
});

dom.grid.addEventListener("drop", (event) => {
  const target = event.target.closest(".tile");
  const dragged = state.dragId;
  if (!dragged || !target || target.dataset.id === dragged) return;
  event.preventDefault();
  const beforeId = target.dataset.id;
  mutate((d) => {
    const from = tileIndex(d, dragged);
    if (from < 0 || tileIndex(d, beforeId) < 0) return false;
    const [moved] = d.tiles.splice(from, 1);
    d.tiles.splice(tileIndex(d, beforeId), 0, moved);
  });
});

dom.grid.addEventListener("dragend", () => {
  state.dragId = null;
  for (const { el: node } of tileEls.values()) node.classList.remove("is-dragging");
});

/* ------------------------------------------------------------------ */
/* the title / line / link / project fields (used by upload and edit)   */
/* ------------------------------------------------------------------ */

function normalizeLink(value) {
  const text = value.trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return /^[^\s/]+\.[^\s/]+/.test(text) ? `https://${text}` : null;
}

function buildFields(values) {
  const root = el("div", "lately-fields");
  const control = (label, input) => {
    const wrap = el("label", "lately-field");
    wrap.append(el("span", "", label), input);
    root.append(wrap);
    return wrap;
  };
  const text = (value, max, type = "text") => {
    const input = el("input");
    input.type = type;
    input.maxLength = max;
    input.value = value || "";
    return input;
  };

  const title = text(values.title, MAX_TITLE);
  title.required = true;
  const line = text(values.line, MAX_LINE);
  line.placeholder = "What it is, and what I did";
  const link = text(values.link, MAX_LINK);
  link.placeholder = "Optional — https://…";

  const project = el("select");
  const options = [["", "No project"], ...state.doc.projects.map((p) => [p, p]), [NEW_PROJECT, "+ New project…"]];
  for (const [value, label] of options) {
    const option = el("option", "", label);
    option.value = value;
    project.append(option);
  }
  project.value = state.doc.projects.includes(values.project) ? values.project : "";
  const newProject = text("", MAX_PROJECT_NAME);
  newProject.placeholder = "Project name";

  control("Title", title);
  control("Description", line);
  control("Link", link);
  control("Project", project);
  const newWrap = control("New project name", newProject);
  newWrap.hidden = true;
  project.addEventListener("change", () => {
    newWrap.hidden = project.value !== NEW_PROJECT;
    if (!newWrap.hidden) newProject.focus();
  });

  return {
    root,
    focus: () => title.focus(),
    // -> { error } or { value }
    read() {
      if (!title.value.trim()) return { error: "Give it a title." };
      const href = normalizeLink(link.value);
      if (href === null) return { error: "That link doesn’t look right." };
      let chosen = project.value;
      if (chosen === NEW_PROJECT) {
        chosen = newProject.value.trim();
        if (!chosen) return { error: "Name the new project, or pick another." };
      }
      return {
        value: { title: title.value.trim(), line: line.value.trim(), link: href, project: chosen },
      };
    },
  };
}

/* edit one tile ------------------------------------------------------ */

let editing = null; // { id, fields }

function openEdit(tile) {
  const fields = buildFields(tile);
  editing = { id: tile.id, fields };
  dom.editFields.replaceChildren(fields.root);
  dom.editError.textContent = "";
  dom.edit.showModal();
  fields.focus();
}

dom.editCancel.addEventListener("click", () => dom.edit.close());

dom.editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const read = editing.fields.read();
  if (read.error) {
    dom.editError.textContent = read.error;
    return;
  }
  const { id } = editing;
  const result = await mutate((d) => {
    const i = tileIndex(d, id);
    if (i < 0) return false;
    const { project, ...rest } = read.value;
    Object.assign(d.tiles[i], rest, { project: project ? ensureProject(d, project) : "" });
  });
  if (result.ok) dom.edit.close();
  else dom.editError.textContent = result.message || "Couldn’t save that.";
});

/* ------------------------------------------------------------------ */
/* uploading                                                           */
/* ------------------------------------------------------------------ */

const drafts = [];

const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const extensionOf = (name) => (name.split(".").pop() || "").toLowerCase();

function openUpload(files = []) {
  dom.uploadError.textContent = "";
  if (!dom.upload.open) dom.upload.showModal();
  if (files.length) addFiles(files);
}

dom.add.addEventListener("click", () => openUpload());
dom.file.addEventListener("change", () => {
  addFiles([...dom.file.files]);
  dom.file.value = "";
});

function updateUploadButton() {
  const ready = drafts.length > 0 && drafts.every((d) => d.status === "ready") && !state.uploading;
  dom.uploadGo.disabled = !ready;
  dom.uploadGo.textContent = drafts.length > 1 ? `Add ${drafts.length} tiles` : "Add";
}

function addFiles(files) {
  for (const file of files) {
    const draft = { id: crypto.randomUUID(), file, status: "processing", uploaded: null, saved: false };
    const base = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, MAX_TITLE);
    draft.fields = buildFields({
      title: base,
      project: state.filter !== "All" ? state.filter : state.lastProject,
    });

    const row = el("div", "draft");
    draft.thumb = el("img", "draft-thumb");
    draft.thumb.alt = "";
    draft.note = el("p", "draft-note", "Reading…");
    const side = el("div");
    draft.remove = el("button", "lately-btn draft-remove", "Remove");
    draft.remove.type = "button";
    draft.remove.addEventListener("click", () => removeDraft(draft));
    side.append(draft.note, draft.fields.root, draft.remove);
    row.append(draft.thumb, side);
    draft.row = row;

    drafts.push(draft);
    dom.drafts.append(row);
    processFile(draft);
  }
  updateUploadButton();
}

function removeDraft(draft) {
  if (state.uploading) return;
  drafts.splice(drafts.indexOf(draft), 1);
  draft.row.remove();
  if (draft.preview) URL.revokeObjectURL(draft.preview);
  if (draft.uploaded && !draft.saved) discard(draftUrls(draft));
  updateUploadButton();
}

function setNote(draft, text, kind = "") {
  draft.note.textContent = text;
  draft.note.dataset.kind = kind;
}

async function processFile(draft) {
  const { file } = draft;
  const ext = extensionOf(file.name);
  const isVideo = file.type.startsWith("video/") || Object.hasOwn(VIDEO_TYPES, ext);
  try {
    if (isVideo) await processVideo(draft, ext);
    else await processImage(draft);
    draft.status = "ready";
    draft.thumb.src = draft.preview;
    setNote(draft, draft.summary);
  } catch (error) {
    draft.status = "error";
    setNote(draft, error.message || "Couldn’t read this file.", "error");
  }
  updateUploadButton();
}

const encode = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// Draw to a canvas and re-encode: WebP where the browser can, otherwise JPEG
// (Safari can't encode WebP and quietly hands back a PNG instead). Going
// through a canvas also drops all metadata (location, camera, etc.).
async function toImageBlob(source, width, height, maxEdge, webpQuality) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0, w, h);

  let blob = await encode(canvas, "image/webp", webpQuality);
  if (blob && blob.type === "image/webp") {
    return { blob, width: w, height: h, format: "webp", ext: "webp" };
  }

  // JPEG has no transparency, so put white behind anything see-through
  // (otherwise a transparent PNG would come out black).
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#fff";
  context.fillRect(0, 0, w, h);
  blob = await encode(canvas, "image/jpeg", JPEG_QUALITY);
  if (!blob || blob.type !== "image/jpeg") {
    throw new Error("This browser couldn’t convert the image. Try Chrome, Edge or Firefox.");
  }
  return { blob, width: w, height: h, format: "jpeg", ext: "jpg" };
}

// Decode an image file, preferring the path that keeps phone-photo rotation
// right. Older Safari can be fussy about createImageBitmap options, so fall
// back step by step to a plain <img>. Call release() when finished drawing.
async function decodeImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    /* try the next way */
  }
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    /* try the next way */
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Couldn’t read this image in your browser.");
  }
}

async function processImage(draft) {
  const { file } = draft;
  if (file.type === "image/gif") {
    throw new Error("A GIF would lose its animation as a still image. Convert it to MP4 and upload that instead.");
  }
  if (file.type === "image/svg+xml") throw new Error("SVGs aren’t supported. Export a PNG or JPG.");

  const decoded = await decodeImage(file);
  let result;
  try {
    result = await toImageBlob(decoded.source, decoded.width, decoded.height, IMAGE_MAX_EDGE, 0.85);
  } finally {
    decoded.release();
  }
  if (result.blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`This image is still ${formatBytes(result.blob.size)} after converting. Try a smaller one.`);
  }

  draft.kind = "image";
  draft.blob = result.blob;
  draft.ext = result.ext;
  draft.width = result.width;
  draft.height = result.height;
  draft.preview = URL.createObjectURL(result.blob);
  const format = result.format === "webp" ? "WebP" : "JPEG";
  draft.summary = `Image · ${format} ${result.width}×${result.height} · ${formatBytes(result.blob.size)}`;
  if (result.format === "jpeg") draft.summary += " · this browser can’t make WebP, so JPEG";
}

function capturePoster(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(value);
    };
    const fail = () =>
      finish(new Error("Couldn’t read this video in your browser. Export it as MP4 (H.264) and try again."));
    const timer = setTimeout(fail, 15000);

    video.addEventListener("error", fail);
    video.addEventListener("loadedmetadata", () => {
      if (!video.videoWidth || !video.videoHeight) return fail();
      const at = Number.isFinite(video.duration) ? Math.min(1, video.duration * 0.25) : 0;
      video.currentTime = Math.max(0.05, at);
    });
    video.addEventListener("seeked", async () => {
      try {
        const poster = await toImageBlob(video, video.videoWidth, video.videoHeight, POSTER_MAX_EDGE, 0.8);
        finish(null, { poster, width: video.videoWidth, height: video.videoHeight });
      } catch (error) {
        finish(error);
      }
    });
    video.src = url;
  });
}

async function processVideo(draft, ext) {
  const { file } = draft;
  const type = file.type || VIDEO_TYPES[ext];
  if (!Object.values(VIDEO_TYPES).includes(type)) throw new Error("Use an MP4, WebM or MOV video.");
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error(`This video is ${formatBytes(file.size)}. The limit is 20 MB, so compress it and try again.`);
  }
  const { poster, width, height } = await capturePoster(file);
  if (poster.blob.size > MAX_POSTER_BYTES) throw new Error("The poster frame came out too large. Try another clip.");

  draft.kind = "video";
  draft.contentType = type;
  draft.ext = Object.hasOwn(VIDEO_TYPES, ext) ? ext : "mp4";
  draft.poster = poster.blob;
  draft.posterExt = poster.ext;
  draft.width = width;
  draft.height = height;
  draft.preview = URL.createObjectURL(poster.blob);
  draft.summary = `Video · ${width}×${height} · ${formatBytes(file.size)} · poster frame captured`;
  if (ext === "mov") draft.summary += " · MOV may not play in every browser";
}

async function uploadBlob(blob, kind, ext, contentType, onProgress) {
  const result = await uploadImpl(`lately/media/${crypto.randomUUID()}.${ext}`, blob, {
    access: "public",
    handleUploadUrl: "/api/lately/upload",
    clientPayload: JSON.stringify({ kind }),
    contentType,
    onUploadProgress: onProgress,
  });
  return result.url;
}

const draftUrls = (draft) => [draft.uploaded.url, draft.uploaded.poster].filter(Boolean);

async function discard(urls) {
  if (urls.length) await api("/api/lately/tiles", { method: "DELETE", body: { urls } });
}

dom.uploadCancel.addEventListener("click", () => dom.upload.close());
dom.upload.addEventListener("cancel", (event) => {
  if (state.uploading) event.preventDefault();
});

// Closing the dialog throws away anything that was uploaded but never made
// it onto the page.
dom.upload.addEventListener("close", () => {
  const orphans = drafts.filter((d) => d.uploaded && !d.saved).flatMap(draftUrls);
  for (const d of drafts) if (d.preview) URL.revokeObjectURL(d.preview);
  drafts.length = 0;
  dom.drafts.replaceChildren();
  dom.uploadError.textContent = "";
  updateUploadButton();
  discard(orphans);
});

dom.uploadGo.addEventListener("click", async () => {
  dom.uploadError.textContent = "";

  const read = drafts.map((d) => d.fields.read());
  const bad = read.findIndex((r) => r.error);
  if (bad !== -1) {
    dom.uploadError.textContent = read[bad].error;
    drafts[bad].row.scrollIntoView({ block: "nearest" });
    return;
  }

  state.uploading = true;
  dom.uploadCancel.disabled = true;
  updateUploadButton();

  let failed = null;
  for (const draft of drafts) {
    if (draft.uploaded) continue;
    try {
      setNote(draft, "Uploading…");
      const progress = (p) => setNote(draft, `Uploading ${Math.round(p.percentage)}%`);
      if (draft.kind === "image") {
        draft.uploaded = {
          url: await uploadBlob(draft.blob, "image", draft.ext, draft.blob.type, progress),
        };
      } else {
        const poster = await uploadBlob(draft.poster, "poster", draft.posterExt, draft.poster.type);
        const url = await uploadBlob(draft.file, "video", draft.ext, draft.contentType, progress);
        draft.uploaded = { url, poster };
      }
      setNote(draft, "Uploaded");
    } catch (error) {
      failed = error;
      setNote(draft, `Upload failed: ${reasonOf(error)}`, "error");
      break;
    }
  }

  if (failed) {
    dom.uploadError.textContent = `Couldn’t upload everything: ${reasonOf(failed)}. Press Add to try again.`;
  } else {
    const tiles = drafts.map((draft, i) => ({
      id: draft.id,
      type: draft.kind,
      url: draft.uploaded.url,
      ...(draft.uploaded.poster ? { poster: draft.uploaded.poster } : {}),
      width: draft.width,
      height: draft.height,
      ...read[i].value,
    }));
    const result = await mutate(
      (d) => {
        for (const tile of tiles) {
          tile.project = tile.project ? ensureProject(d, tile.project) : "";
        }
        d.tiles.unshift(...tiles);
      },
      { label: "Adding…" },
    );
    if (result.ok) {
      for (const draft of drafts) draft.saved = true;
      state.lastProject = tiles[0].project;
      if (state.filter !== "All" && !tiles.some((t) => t.project === state.filter)) {
        state.filter = "All";
        render();
      }
      dom.upload.close();
      setStatus(tiles.length > 1 ? `Added ${tiles.length} tiles` : "Added", 3000);
    } else {
      dom.uploadError.textContent = result.message || "Couldn’t save. Press Add to try again.";
    }
  }

  state.uploading = false;
  dom.uploadCancel.disabled = false;
  updateUploadButton();
});

/* pick, drop or paste -------------------------------------------------- */

const hasFiles = (event) => [...((event.dataTransfer && event.dataTransfer.types) || [])].includes("Files");

window.addEventListener("dragover", (event) => {
  if (state.editing && hasFiles(event)) {
    event.preventDefault();
    dom.drop.classList.add("is-over");
  }
});
window.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) dom.drop.classList.remove("is-over");
});
window.addEventListener("drop", (event) => {
  dom.drop.classList.remove("is-over");
  if (!state.editing || !hasFiles(event)) return;
  event.preventDefault();
  openUpload([...event.dataTransfer.files]);
});

document.addEventListener("paste", (event) => {
  if (!state.editing) return;
  const files = [...((event.clipboardData && event.clipboardData.files) || [])];
  if (!files.length) return;
  if (document.querySelector("dialog[open]:not(#latelyUpload)")) return;
  event.preventDefault();
  openUpload(files);
});

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

async function init() {
  // Dev-only: `npm run dev` then /lately?mock (add &edit to start unlocked)
  // runs the page against an in-memory fake server. This whole branch is
  // removed from the production build.
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.has("mock")) {
    const mock = await import("./lately-dev-mock.js");
    // &realupload keeps the real upload code, with the fake server refusing
    // the token, to see how a failed upload is reported.
    if (!params.has("realupload")) uploadImpl = mock.fakeUpload;
    mock.install({ editing: params.has("edit") });
  }

  const res = await api("/api/lately/tiles");
  if (!res.ok) {
    dom.hello.textContent = "Couldn’t load this right now. Please refresh in a moment.";
    return;
  }
  state.doc = res.data.doc;
  state.etag = res.data.etag;
  state.editing = Boolean(res.data.editing);
  const wanted = new URLSearchParams(location.search).get("p");
  if (wanted) state.filter = wanted;

  applyEditing();
  render();
  checkHash();
}

init();
