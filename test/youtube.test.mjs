import assert from "node:assert/strict";
import { test } from "node:test";
import { getChannels } from "../youtube.mjs";

const ids = ["A", "B", "C"].map(letter => "UC" + letter.repeat(22));
const key = "test-key-for-public-data";
const inputs = ["youtube.com/@%E6%B5%B7%E9%A2%A8/videos?si=test", `https://m.youtube.com/channel/${ids[1]}/`, ids[2]];
const json = (body, status = 200) => Response.json(body, { status });

function channel(id, uploads) {
  return {
    id, snippet: { title: "Channel " + id[2] },
    statistics: { subscriberCount: "12300", hiddenSubscriberCount: id === ids[2] },
    contentDetails: { relatedPlaylists: { uploads } },
  };
}

function video(id, date, privacy = "public", broadcast = "none") {
  return {
    id, snippet: { title: id, publishedAt: date, liveBroadcastContent: broadcast },
    status: { privacyStatus: privacy }, statistics: { viewCount: "101", likeCount: "0" },
  };
}

test("reads three channels in order and selects each latest public, published video", async () => {
  const date = "2024-10-01T12:00:00Z";
  const latest = video("newest", date);
  const catalog = [video("older", "2024-01-01"), video("private", "2024-12-01", "private"), latest,
    video("premiere", "2024-12-01", "public", "upcoming"), video("future", "2099-01-01")];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers["x-goog-api-key"], key);
    assert.equal(url.href.includes(key), false);
    const params = url.searchParams;
    switch (url.pathname.split("/").at(-1)) {
      case "channels": {
        const requested = params.get("forHandle") === "@海風" ? [ids[0]] : params.get("id").split(",");
        return json({ items: requested.reverse().map(id => channel(id, "uploads-" + id[2])) });
      }
      case "playlistItems": {
        const playlist = params.get("playlistId");
        if (playlist === "uploads-C") return json({ items: [] });
        if (playlist === "uploads-B" && !params.has("pageToken")) {
          return json({ items: [{ contentDetails: { videoId: "not-available" } }], nextPageToken: "next" });
        }
        const items = (playlist === "uploads-B" ? [latest] : catalog)
          .map(({ id }) => ({ contentDetails: { videoId: id } }));
        return json({ items });
      }
      case "videos":
        return json({ items: catalog.filter(v => params.get("id").split(",").includes(v.id)) });
      default:
        throw new Error("Unexpected resource");
    }
  };
  const rows = await getChannels(inputs, key, { fetchImpl });
  const expectedVideo = {
    id: "newest", title: "newest", publishedAt: date, views: 101, likes: 0, comments: null,
    description: "", durationSeconds: null, liveStatus: "none", captions: null, thumbnail: null,
  };
  assert.deepEqual(rows.map(({ id, title, subscribers, video }) => ({ id, title, subscribers, video })), [
    { id: ids[0], title: "Channel A", subscribers: 12300, video: expectedVideo },
    { id: ids[1], title: "Channel B", subscribers: 12300, video: expectedVideo },
    { id: ids[2], title: "Channel C", subscribers: null, video: null },
  ]);
  assert.equal(rows[0].handle, "@海風");
  assert.deepEqual(rows.map(channel => channel.videos.map(v => v.id)), [["newest", "older"], ["newest"], []]);
  assert.equal(rows[2].joinedAt, null);
  assert.equal(rows[2].lifetimeViews, null);
  assert.equal(rows[2].publicVideoCount, null);
});

test("rejects invalid or duplicate inputs before sending a request", async () => {
  let requests = 0;
  const options = { fetchImpl: async () => { requests++; } };
  const invalid = [[], ["@one", "@two", "https://example.com/@three"],
    ["@one", "@two", "youtube.com/watch?v=q"], ["@one", "@two", "UCbad"],
    ["@one", "@two", "https://youtube.com.evil.test/@three"], ["@one", "@two", "https://youtube.com/@bad%2Fhandle"],
    ["@one", "www.youtube.com/@ONE", "@two"]];
  for (const values of invalid) await assert.rejects(getChannels(values, key, options), /YouTube/);
  await assert.rejects(getChannels(inputs, "", options), /API key/);
  assert.equal(requests, 0);
});

test("detects duplicate channel identities after resolving different input formats", async () => {
  const fetchImpl = async () => json({ items: [channel(ids[0], "same")] });
  await assert.rejects(getChannels(["@first", ids[0]], key, { fetchImpl }), /same YouTube channel/);
});

test("handles a new channel with an unavailable uploads playlist", async () => {
  const fetchImpl = async url => url.pathname.endsWith("/channels")
    ? json({ items: url.searchParams.get("id").split(",").map(id => channel(id, "empty")) })
    : json({ error: "playlistNotFound" }, 404);
  const rows = await getChannels(ids, key, { fetchImpl });
  assert.deepEqual(rows.map(row => row.video), [null, null, null]);
});

test("preserves useful failure messages without echoing credentials or request URLs", async () => {
  await assert.rejects(getChannels(ids, key, { fetchImpl: async () => json({ items: [] }) }), /Could not find YouTube channel/);
  for (const fetchImpl of [
    async () => { throw new Error("https://internal.test/?key=" + key); },
    async () => json({ error: key }, 403),
    async () => new Response(key),
  ]) {
    await assert.rejects(getChannels(ids, key, { fetchImpl }), error => {
      assert.match(error.message, /YouTube/);
      assert.doesNotMatch(error.message, /test-key-for-public-data|https:/);
      return true;
    });
  }
});

test("includes public channel metadata and caps a deduplicated, publication-date-ordered video history at 25", async () => {
  const live = video("live", "2024-06-30", "public", "live");
  live.snippet.description = "On stage";
  live.snippet.thumbnails = { medium: { url: "https://i.ytimg.com/vi/live/mqdefault.jpg" } };
  live.contentDetails = { duration: "P1DT2H3M4S", caption: "true" };
  const archive = video("archived-live", "2024-06-28");
  archive.liveStreamingDetails = { actualEndTime: "2024-06-28T03:15:00Z" };
  archive.contentDetails = { duration: "PT17S", caption: "false" };
  const privateEntry = video("hidden", "2024-07-01", "private");
  const normal = Array.from({ length: 28 }, (_, i) => video(String(i + 1), "2024-05-" + String(i + 1).padStart(2, "0")));
  const pages = [[...normal.slice(0, 3), privateEntry], [live, archive, normal[0], ...normal.slice(3)]];
  const calls = [];
  const fetchImpl = async url => {
    const resource = url.pathname.split("/").at(-1);
    const params = url.searchParams;
    calls.push(resource);
    if (resource === "channels") {
      const items = params.get("id").split(",").map(id => {
        const data = channel(id, id === ids[0] ? "main" : null);
        data.snippet = {
          ...data.snippet, description: "Channel description", country: "TH", customUrl: "@MyChannel",
          publishedAt: "2019-04-01T12:00:00Z", thumbnails: { default: { url: "https://yt3.ggpht.com/avatar" } },
        };
        Object.assign(data.statistics, { viewCount: "4567890", videoCount: "200" });
        return data;
      });
      return json({ items });
    }
    if (resource === "playlistItems") {
      const page = params.has("pageToken") ? 1 : 0;
      return json({ items: pages[page].map(v => ({ contentDetails: { videoId: v.id } })), nextPageToken: String(page + 1) });
    }
    assert.equal(resource, "videos");
    const requested = params.get("id").split(",");
    assert.ok(params.get("part").includes("liveStreamingDetails"));
    return json({ items: [...normal, live, archive, privateEntry].filter(v => requested.includes(v.id)) });
  };
  const [data] = await getChannels(ids, key, { fetchImpl });
  assert.equal(calls.filter(r => r === "playlistItems").length, 2);
  assert.equal(calls.filter(r => r === "videos").length, 2);
  assert.deepEqual(data.video, {
    id: "live", title: "live", description: "On stage", publishedAt: "2024-06-30",
    views: 101, likes: 0, comments: null, durationSeconds: 93784, liveStatus: "live",
    captions: true, thumbnail: "https://i.ytimg.com/vi/live/mqdefault.jpg",
  });
  assert.equal(data.videos[1].id, archive.id);
  assert.equal(data.videos[1].liveStatus, "completed");
  assert.equal(data.videos[1].captions, false);
  assert.equal(data.videos[1].durationSeconds, 17);
  assert.equal(data.videos.length, 25);
  assert.equal(new Set(data.videos.map(v => v.id)).size, 25);
  assert.equal(data.videos.at(-1).id, "6");
  assert.equal(data.description, "Channel description");
  assert.equal(data.handle, "@MyChannel");
  assert.equal(data.country, "TH");
  assert.equal(data.joinedAt, "2019-04-01T12:00:00Z");
  assert.equal(data.lifetimeViews, 4567890);
  assert.equal(data.publicVideoCount, 200);
  assert.equal(data.thumbnail, "https://yt3.ggpht.com/avatar");
});

test("bounds paging through unavailable uploads", async () => {
  let pages = 0;
  const fetchImpl = async url => {
    if (url.pathname.endsWith("/channels")) {
      const requested = url.searchParams.get("id").split(",");
      return json({ items: requested.map(id => channel(id, id === ids[0] ? "main" : null)) });
    }
    if (url.pathname.endsWith("/videos")) return json({ items: [] });
    pages++;
    assert.ok(pages <= 4);
    return json({ items: [{ contentDetails: { videoId: "missing" + pages } }], nextPageToken: String(pages) });
  };
  const [data] = await getChannels(ids, key, { fetchImpl });
  assert.equal(pages, 4);
  assert.deepEqual(data.videos, []);
  assert.equal(data.video, null);
});

test("accepts one or many channels, batches IDs, bounds concurrent calls and preserves order", async () => {
  const many = Array.from({ length: 106 }, (_, n) => "UC" + String(n).padStart(22, "0"));
  const handles = ["@one", "@two", "@three", "@four", "@five"];
  const byHandle = new Map(handles.map((name, i) => [name, "UC" + String(i + 106).padStart(22, "0")]));
  const mixed = [...many.slice(0, 40), ...handles, ...many.slice(40)].reverse();
  const batchSizes = [];
  let active = 0, peak = 0;
  const fetchImpl = async url => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (!url.pathname.endsWith("/channels")) return json({ items: [] });
    const handle = url.searchParams.get("forHandle");
    const requested = handle ? [byHandle.get(handle)] : url.searchParams.get("id").split(",");
    if (!handle) batchSizes.push(requested.length);
    return json({ items: requested.reverse().map(id => channel(id, "uploads-" + id)) });
  };
  const rows = await getChannels(mixed, key, { fetchImpl });
  assert.deepEqual(rows.map(row => row.id), mixed.map(ref => byHandle.get(ref) || ref));
  assert.deepEqual(batchSizes.sort((a, b) => b - a), [50, 50, 6]);
  assert.equal(peak, 4);
  assert.equal((await getChannels([many[0]], key, { fetchImpl }))[0].id, many[0]);
});
