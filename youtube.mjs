const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const handlePattern = /^@[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}_.·-]*[\p{L}\p{M}\p{N}])?$/u;
const channelInputError = "Use a YouTube @handle, UC channel ID, or YouTube channel URL.";
const recentVideoLimit = 25;
const uploadsPageLimit = 4;
const concurrentChannels = 4;

function parseChannel(input) {
  if (typeof input !== "string") throw new Error(channelInputError);
  let value = input.trim();
  if (!value.startsWith("@") && !channelIdPattern.test(value)) {
    let url;
    try {
      url = new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      throw new Error(channelInputError);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.port ||
        url.username || url.password || !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      throw new Error(channelInputError);
    }
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new Error(channelInputError);
    }
    const match = /^\/(?:channel\/(UC[A-Za-z0-9_-]{22})|(@[^/]+))(?:\/(?:videos|shorts|streams|featured))?\/?$/.exec(path);
    if (!match) throw new Error(channelInputError);
    value = match[1] || match[2];
  }
  if (channelIdPattern.test(value)) return { id: value };
  if (handlePattern.test(value)) return { forHandle: value.normalize("NFC").toLowerCase() };
  throw new Error(channelInputError);
}

async function list(resource, parameters, apiKey, fetchImpl) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  url.search = new URLSearchParams(parameters);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "x-goog-api-key": apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("Could not reach YouTube. Try again when this computer is online.");
  }
  if (!response.ok) {
    if (resource === "playlistItems" && response.status === 404) return { items: [] };
    if ([400, 401, 403].includes(response.status)) {
      throw new Error(`YouTube rejected the request (HTTP ${response.status}). Check the API key, YouTube Data API v3 access, and quota.`);
    }
    throw new Error(`YouTube returned HTTP ${response.status}. Try again later.`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("YouTube returned an unreadable response.");
  }
  if (!Array.isArray(data?.items)) throw new Error("YouTube returned an incomplete response.");
  return data;
}

function count(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function thumbnail(images) {
  for (const size of ["medium", "high", "default", "standard", "maxres"]) {
    const url = images?.[size]?.url;
    if (typeof url === "string" && url.startsWith("https://")) return url;
  }
  return null;
}

function durationSeconds(value) {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(part => part !== undefined)) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days || 0) * 86400 + Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds || 0);
}

function publicVideo(video, now) {
  const { snippet, status, statistics = {}, contentDetails = {}, liveStreamingDetails } = video;
  const time = Date.parse(snippet?.publishedAt);
  if (!video.id || !snippet?.title || status?.privacyStatus !== "public" ||
      snippet.liveBroadcastContent === "upcoming" || !Number.isFinite(time) || time > now) return null;
  let liveStatus = null;
  if (liveStreamingDetails?.actualEndTime) liveStatus = "completed";
  else if (snippet.liveBroadcastContent === "live") liveStatus = "live";
  else if (snippet.liveBroadcastContent === "none") liveStatus = "none";
  const caption = contentDetails.caption;
  let captions = null;
  if (caption === "true" || caption === true) captions = true;
  if (caption === "false" || caption === false) captions = false;
  return {
    id: video.id, title: snippet.title, publishedAt: snippet.publishedAt,
    views: count(statistics.viewCount), likes: count(statistics.likeCount), comments: count(statistics.commentCount),
    description: snippet.description ?? "", durationSeconds: durationSeconds(contentDetails.duration),
    liveStatus, captions, thumbnail: thumbnail(snippet.thumbnails),
  };
}

async function recentVideos(playlistId, apiKey, fetchImpl) {
  if (!playlistId) return [];
  const found = new Map();
  const now = Date.now();
  let pageToken;
  const seenTokens = new Set();
  for (let pageNumber = 0; pageNumber < uploadsPageLimit; pageNumber++) {
    const params = {
      playlistId, part: "contentDetails", maxResults: "50",
      fields: "nextPageToken,items/contentDetails/videoId",
    };
    if (pageToken) params.pageToken = pageToken;
    const page = await list("playlistItems", params, apiKey, fetchImpl);
    const ids = [...new Set(page.items.map(item => item.contentDetails?.videoId).filter(id => id && !found.has(id)))];
    if (ids.length) {
      const videos = await list("videos", {
        id: ids.join(","), part: "snippet,status,statistics,contentDetails,liveStreamingDetails",
        fields: "items(id,snippet(title,description,publishedAt,liveBroadcastContent,thumbnails),status/privacyStatus,statistics(viewCount,likeCount,commentCount),contentDetails(duration,caption),liveStreamingDetails/actualEndTime)",
      }, apiKey, fetchImpl);
      for (const video of videos.items) {
        const entry = publicVideo(video, now);
        if (entry) found.set(entry.id, entry);
      }
    }
    pageToken = page.nextPageToken;
    if (!pageToken || found.size >= recentVideoLimit) break;
    if (seenTokens.has(pageToken)) throw new Error("YouTube repeated an uploads page.");
    seenTokens.add(pageToken);
  }
  // The playlist uses upload order; a video's public release time can differ.
  return [...found.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, recentVideoLimit);
}

// Wait for the current batch to finish even on error, so a retry never overlaps
// outstanding requests from a rejected setup. Preserve the caller's display order.
async function mapChannels(values, action) {
  const results = [];
  for (let offset = 0; offset < values.length; offset += concurrentChannels) {
    const batch = values.slice(offset, offset + concurrentChannels);
    const settled = await Promise.allSettled(batch.map((value, i) => action(value, offset + i)));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

export async function getChannels(inputs, apiKey, { fetchImpl = fetch } = {}) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("Enter at least one YouTube channel.");
  const filters = inputs.map(parseChannel);
  if (new Set(filters.map(filter => filter.id || filter.forHandle)).size !== filters.length) {
    throw new Error("Enter each YouTube channel only once.");
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Enter a YouTube Data API key.");
  const queries = filters.filter(filter => filter.forHandle);
  const ids = filters.map(filter => filter.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) queries.push({ id: ids.slice(i, i + 50).join(",") });

  const resolved = new Map();
  await mapChannels(queries, async filter => {
    const data = await list("channels", {
      ...filter, maxResults: "50", part: "snippet,statistics,contentDetails",
      fields: "items(id,snippet(title,description,customUrl,publishedAt,country,thumbnails),statistics(subscriberCount,hiddenSubscriberCount,viewCount,videoCount),contentDetails/relatedPlaylists/uploads)",
    }, apiKey.trim(), fetchImpl);
    for (const channel of data.items) {
      if (channel?.id && channel.snippet?.title) resolved.set(filter.forHandle || channel.id, channel);
    }
  });
  const channels = filters.map((filter, index) => {
    const channel = resolved.get(filter.id || filter.forHandle);
    if (!channel) throw new Error(`Could not find YouTube channel ${index + 1}. Check its handle or ID.`);
    return channel;
  });
  if (new Set(channels.map(channel => channel.id)).size !== channels.length) throw new Error("Two entries refer to the same YouTube channel.");
  return mapChannels(channels, async (channel, index) => {
    const { snippet, statistics = {} } = channel;
    const videos = await recentVideos(channel.contentDetails?.relatedPlaylists?.uploads, apiKey.trim(), fetchImpl);
    return {
      id: channel.id, title: snippet.title,
      subscribers: statistics.hiddenSubscriberCount ? null : count(statistics.subscriberCount),
      description: snippet.description ?? "",
      handle: handlePattern.test(snippet.customUrl ?? "") ? snippet.customUrl : filters[index].forHandle ?? null,
      joinedAt: snippet.publishedAt ?? null, country: snippet.country ?? null,
      lifetimeViews: count(statistics.viewCount), publicVideoCount: count(statistics.videoCount),
      thumbnail: thumbnail(snippet.thumbnails), videos, video: videos[0] ?? null,
    };
  });
}
