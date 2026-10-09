// DEV ONLY. An in-memory stand-in for /api/lately/* so the page can be tried
// with `npm run dev`, which doesn't run Vercel functions.
//
//   /lately?mock          the page, as a visitor sees it
//   /lately?mock&edit     the page, already unlocked
//   passcode in this mode: "mock"
//
// Nothing here is saved anywhere and none of it ships: the only import of
// this file sits behind `import.meta.env.DEV` in lately-client.js.

const SAMPLE_VIDEO = "https://pub-6e9c9d0558e94619893e3ae1137eeec8.r2.dev/videos/outwrite-rewrite.mp4";

const sample = (id, type, file, width, height, title, line, project, extra = {}) => ({
  id: `mock-${id}`,
  type,
  url: file,
  width,
  height,
  title,
  line,
  link: "",
  project,
  ...extra,
});

let doc = {
  version: 1,
  intro: "Hello. A rolling look at what I’m making at the moment. (Sample content.)",
  projects: ["WiiF", "WiiFendo", "Patch", "Nudge"],
  tiles: [
    sample("01", "image", "/images/work-1.webp", 1440, 1800, "Sample: splash screen", "A sample tile, tall image.", "WiiF"),
    sample("02", "image", "/images/superheroic.webp", 3000, 1708, "Sample: title card", "A sample tile, wide image.", "WiiFendo"),
    sample("03", "image", "/images/work-2.webp", 1440, 1440, "Sample: icon set", "A sample tile, square image.", "Patch", {
      link: "https://studio-juicebox.com",
    }),
    sample("04", "video", SAMPLE_VIDEO, 1440, 1440, "Sample: motion test", "A sample video. Press play.", "Nudge", {
      poster: "/images/work-2.webp",
    }),
    sample("05", "image", "/images/station.jpg", 3000, 1708, "Sample: wide frame", "Another sample, no link.", "Nudge"),
    sample("06", "image", "/images/shapes.jpg", 1440, 1800, "Sample: shapes", "A second tall sample.", "Patch"),
    sample("07", "image", "/images/image-4.webp", 1440, 1708, "Sample: layout", "Mixed heights make the masonry.", "WiiF"),
    sample("08", "image", "/images/people.jpg", 3000, 1708, "Sample: another wide one", "Last sample.", "WiiFendo"),
  ],
};
let version = 1;
let signedIn = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reply = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function install({ editing }) {
  signedIn = editing;
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/lately/")) return realFetch(input, init);

    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    await delay(120);

    if (url === "/api/lately/tiles" && method === "GET") {
      return reply(200, { doc, etag: `v${version}`, editing: signedIn });
    }
    if (url === "/api/lately/login") {
      if (body.passcode === "mock") {
        signedIn = true;
        return reply(200, { ok: true });
      }
      return reply(401, { error: "Wrong passcode" });
    }
    if (url === "/api/lately/logout") {
      signedIn = false;
      return reply(200, { ok: true });
    }
    if (!signedIn) return reply(401, { error: "Not signed in" });

    if (url === "/api/lately/tiles" && method === "PUT") {
      if (body.etag !== `v${version}`) return reply(409, { error: "Changed elsewhere", doc, etag: `v${version}` });
      doc = body.doc;
      version += 1;
      return reply(200, { doc, etag: `v${version}` });
    }
    if (url === "/api/lately/tiles" && method === "DELETE") {
      return reply(200, { deleted: (body.urls || []).length });
    }
    return reply(404, { error: "Not found" });
  };
}

// Stands in for the browser-to-Blob upload: hands back a local blob: URL.
export async function fakeUpload(pathname, body, options) {
  for (const percentage of [20, 60, 100]) {
    options.onUploadProgress?.({ loaded: percentage, total: 100, percentage });
    await delay(120);
  }
  return { url: URL.createObjectURL(body), pathname };
}
