import { Innertube, Log } from 'youtubei.js';

// Disable youtubei.js warnings (none important)
Log.setLevel(Log.Level.NONE);

// ==================== CONFIGURATION ====================

const CONFIG = {
  SEARCH_CACHE_TTL: 5 * 60 * 1000,
  VIDEO_CACHE_TTL: 30 * 60 * 1000,
  COMMENT_CACHE_TTL: 10 * 60 * 1000,
  MAX_RESULTS_PER_SEARCH: 500,
  MAX_COMMENTS: 200,
  BACKGROUND_FETCH_DELAY: 50,
  ENABLE_LOGGING: true,
};

const log = CONFIG.ENABLE_LOGGING 
  ? (...args) => console.log(...args)
  : () => {};


// YOUTUBE INSTANCE
let youtubeInstance = null;
let instancePromise = null;
let instanceCreatedAt = 0;
const INSTANCE_TTL = 30 * 60 * 1000;

function generateVisitorData() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = 'Cgt';
  for (let i = 0; i < 22; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function getYouTube(forceNew = false) {
  if (youtubeInstance && !forceNew && (Date.now() - instanceCreatedAt < INSTANCE_TTL)) {
    return youtubeInstance;
  }

  if (instancePromise && !forceNew) {
    return instancePromise;
  }

  instancePromise = (async () => {
    try {
      youtubeInstance = await Innertube.create({
        retrieve_player: false,
        generate_session_locally: true,
        enable_session_cache: false,
        lang: 'en',
        location: 'US',
        visitor_data: generateVisitorData()
      });
      instanceCreatedAt = Date.now();
      log('✅ YouTube instance ready');
      return youtubeInstance;
    } catch (error) {
      console.error('YouTube init failed:', error.message);
      instancePromise = null;
      throw error;
    }
  })();

  return instancePromise;
}

getYouTube().catch(() => {});

// FAST CACHE

class FastCache {
  constructor(ttl) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  key(...parts) {
    return parts.map(p => String(p || '').toLowerCase().trim()).join('|');
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key, data) {
    this.cache.set(key, { data, ts: Date.now() });
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const searchCache = new FastCache(CONFIG.SEARCH_CACHE_TTL);
const videoCache = new FastCache(CONFIG.VIDEO_CACHE_TTL);
const commentCache = new FastCache(CONFIG.COMMENT_CACHE_TTL);

const activeFetches = new Set();


// UTILITY FUNCTIONS

function extractText(field) {
  if (!field) return null;
  if (typeof field === 'string') return field;
  if (field.text) return field.text;
  if (field.runs) {
    return field.runs.map(r => r.text || '').join('');
  }
  if (field.simpleText) return field.simpleText;
  if (field.content) return extractText(field.content);
  // Handle toString for special objects
  if (typeof field.toString === 'function') {
    const str = field.toString();
    if (str !== '[object Object]') return str;
  }
  return null;
}

function safeGet(obj, path, defaultVal = null) {
  try {
    const keys = path.split('.');
    let result = obj;
    for (const key of keys) {
      if (result === null || result === undefined) return defaultVal;
      result = result[key];
    }
    return result ?? defaultVal;
  } catch {
    return defaultVal;
  }
}

function parseViewCount(input) {
  if (!input) return 0;
  if (typeof input === 'number') return input;

  const str = String(typeof input === 'object' ? (input.text || input.simpleText || input) : input).toLowerCase();

  const match = str.match(/([\d,.]+)\s*([kmb])?/i);
  if (match) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    const mult = { k: 1000, m: 1000000, b: 1000000000 }[match[2]?.toLowerCase()] || 1;
    return Math.round(num * mult);
  }
  return 0;
}

function parseDuration(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;

  const str = String(val);

  const iso = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (iso) return (+(iso[1]||0))*3600 + (+(iso[2]||0))*60 + +(iso[3]||0);

  if (str.includes(':')) {
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
    if (parts.length === 2) return parts[0]*60 + parts[1];
  }

  return parseInt(str) || 0;
}

function formatDuration(s) {
  if (!s) return '0:00';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h > 0 
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

function formatViews(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}

function isValidTag(v) {
  if (!v || typeof v !== 'string') return false;
  const t = v.trim();
  return t.length >= 2 && 
         !t.includes('http') && 
         !/^\d+$/.test(t) && 
         !['N/A','null','undefined'].includes(t);
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter(isValidTag).map(t => t.trim()))];
}

function extractHashtags(text) {
  if (!text) return [];
  const matches = text.match(/#[\w\u0080-\uFFFF]+/g) || [];
  return [...new Set(matches)];
}


// VIDEO FORMATTERS

function extractBadges(item) {
  const badges = [];
  if (item.badges) {
    for (const b of item.badges) {
      const label = extractText(b.label) || extractText(b.text) || b.style;
      if (label) badges.push(label);
    }
  }
  if (item.is_live) badges.push('LIVE');
  if (item.is_upcoming) badges.push('UPCOMING');
  return [...new Set(badges)];
}

function formatVideo(item) {
  const id = item.id || item.video_id;
  if (!id) return null;

  const title = extractText(item.title) || 'Unknown';
  const thumbnail = item.thumbnails?.slice(-1)[0]?.url || 
                    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  let duration = 'N/A';
  if (item.duration) {
    if (typeof item.duration === 'string') duration = item.duration;
    else if (item.duration.text) duration = item.duration.text;
    else if (item.duration.seconds) duration = formatDuration(item.duration.seconds);
  }

  const views = item.view_count?.text || item.short_view_count?.text || 
                (typeof item.view_count === 'number' ? item.view_count.toLocaleString() : 'N/A');

  const published = extractText(item.published) || 'N/A';
  const author = item.author || {};

  return {
    type: 'video',
    id,
    title,
    thumbnail,
    duration,
    views,
    published,
    url: `https://www.youtube.com/watch?v=${id}`,
    description: extractText(item.description_snippet) || extractText(item.description) || '',
    channel: {
      name: author.name || 'Unknown',
      id: author.id || null,
      url: author.url || null,
      thumbnail: author.thumbnails?.[0]?.url || null,
      isVerified: author.is_verified || false,
      isArtist: author.is_verified_artist || false
    },
    metadata: {
      isLive: item.is_live || false,
      isShort: (item.duration?.seconds && item.duration.seconds <= 60) || false,
      badges: extractBadges(item)
    }
  };
}

function formatChannel(item) {
  const id = item.author?.id || item.id;
  if (!id) return null;

  return {
    type: 'channel',
    id,
    name: item.author?.name || extractText(item.title) || 'Unknown',
    thumbnail: item.author?.thumbnails?.slice(-1)[0]?.url || item.thumbnails?.slice(-1)[0]?.url,
    subscriberCount: extractText(item.subscriber_count) || 'N/A',
    videoCount: extractText(item.video_count) || 'N/A',
    url: item.author?.url || `https://www.youtube.com/channel/${id}`,
    metadata: {
      isVerified: item.author?.is_verified || item.is_verified || false
    }
  };
}

function formatPlaylist(item) {
  const id = item.id || item.playlist_id;
  if (!id) return null;

  return {
    type: 'playlist',
    id,
    title: extractText(item.title) || 'Unknown',
    thumbnail: item.thumbnails?.slice(-1)[0]?.url,
    videoCount: extractText(item.video_count) || String(item.video_count || 'N/A'),
    url: `https://www.youtube.com/playlist?list=${id}`,
    channel: {
      name: item.author?.name || 'Unknown',
      id: item.author?.id || null
    }
  };
}

function formatResult(item) {
  if (!item) return null;

  const type = item.type;
  if (type === 'Video' || type === 'Movie' || item.duration || item.view_count) {
    return formatVideo(item);
  }
  if (type === 'Channel' || item.subscriber_count) {
    return formatChannel(item);
  }
  if (type === 'Playlist' || (item.video_count && !item.duration)) {
    return formatPlaylist(item);
  }
  return null;
}


// SEARCH

function extractSearchResults(data, seenIds) {
  const results = [];
  const items = data?.results || data?.contents || [];

  for (const item of items) {
    const id = item.id || item.author?.id || item.playlist_id;
    if (id && !seenIds.has(id)) {
      const formatted = formatResult(item);
      if (formatted) {
        seenIds.add(id);
        results.push(formatted);
      }
    }
  }
  return results;
}

async function search(query, options = {}) {
  const {
    type = 'all',
    sort = 'relevance',
    duration = null,
    uploadDate = null,
    start = 1,
    end = 20,
  } = options;

  const cacheKey = searchCache.key('s', query, type, sort, duration, uploadDate);

  let cached = searchCache.get(cacheKey);

  if (cached && cached.results.length >= end) {
    log(`📦 Cache hit: ${query} (${cached.results.length} results)`);
    return buildSearchResponse(query, options, cached, start, end);
  }

  log(`🔍 Searching: "${query}"`);

  const yt = await getYouTube();

  const filters = {};
  if (type !== 'all') filters.type = type.charAt(0).toUpperCase() + type.slice(1);

  const sortMap = { 
    relevance: 'relevance', 
    date: 'upload_date', 
    upload_date: 'upload_date', 
    views: 'view_count', 
    view_count: 'view_count' 
  };
  if (sortMap[sort]) filters.sort_by = sortMap[sort];
  if (duration) filters.duration = duration;
  if (uploadDate) filters.upload_date = uploadDate;

  try {
    if (!cached) {
      const searchData = await yt.search(query, filters);
      const seenIds = new Set();
      const results = extractSearchResults(searchData, seenIds);

      cached = {
        results,
        seenIds,
        searchData,
        isComplete: !searchData?.has_continuation
      };
      searchCache.set(cacheKey, cached);
    }

    let pages = 0;
    while (cached.results.length < end && cached.searchData?.has_continuation && pages < 3) {
      try {
        cached.searchData = await cached.searchData.getContinuation();
        const more = extractSearchResults(cached.searchData, cached.seenIds);
        if (more.length === 0) break;
        cached.results.push(...more);
        pages++;
      } catch (e) {
        log(`⚠️ Continuation failed: ${e.message}`);
        break;
      }
    }

    cached.isComplete = !cached.searchData?.has_continuation;
    searchCache.set(cacheKey, cached);

    if (!cached.isComplete && !activeFetches.has(cacheKey)) {
      activeFetches.add(cacheKey);
      backgroundFetchSearch(cacheKey, cached)
        .finally(() => activeFetches.delete(cacheKey));
    }

    log(`✅ Search complete: ${cached.results.length} results`);
    return buildSearchResponse(query, options, cached, start, end);

  } catch (error) {
    log(`❌ Search error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function backgroundFetchSearch(cacheKey, cached) {
  let pages = 0;
  const maxPages = 20;

  while (
    cached.results.length < CONFIG.MAX_RESULTS_PER_SEARCH && 
    cached.searchData?.has_continuation && 
    pages < maxPages
  ) {
    try {
      cached.searchData = await cached.searchData.getContinuation();
      const more = extractSearchResults(cached.searchData, cached.seenIds);
      if (more.length === 0) break;

      cached.results.push(...more);
      searchCache.set(cacheKey, cached);
      pages++;

      if (pages % 5 === 0) {
        await new Promise(r => setTimeout(r, CONFIG.BACKGROUND_FETCH_DELAY));
      }
    } catch {
      break;
    }
  }

  cached.isComplete = true;
  searchCache.set(cacheKey, cached);
  log(`📦 Background fetch complete: ${cached.results.length} total results`);
}

function buildSearchResponse(query, options, cached, start, end) {
  const { type = 'all', sort = 'relevance', duration, uploadDate } = options;

  const startIdx = Math.max(0, start - 1);
  const endIdx = Math.min(cached.results.length, end);
  const results = cached.results.slice(startIdx, endIdx);

  return {
    success: true,
    query,
    filters: { type, sort, duration, uploadDate },
    range: { start, end: startIdx + results.length },
    totalResults: results.length,
    totalCached: cached.results.length,
    isComplete: cached.isComplete,
    hasMore: !cached.isComplete || cached.results.length > end,
    results,
    videos: results.filter(r => r.type === 'video'),
    channels: results.filter(r => r.type === 'channel'),
    playlists: results.filter(r => r.type === 'playlist')
  };
}

// VIDEO INFO

function extractVideoInfo(info, videoId) {
  // Helper to try multiple paths
  const tryPaths = (paths, defaultVal = null) => {
    for (const path of paths) {
      const value = safeGet(info, path);
      if (value !== null && value !== undefined && value !== '') {
        const extracted = extractText(value);
        if (extracted) return extracted;
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return value;
      }
    }
    return defaultVal;
  };

  // DESCRIPTION - Try multiple sources
  let description = '';

  // Try basic_info.short_description first (most common)
  description = safeGet(info, 'basic_info.short_description');

  // If not found, trying other paths
  if (!description) {
    description = safeGet(info, 'basic_info.description');
  }

  // Try secondary_info.description (has runs format)
  if (!description) {
    const secDesc = safeGet(info, 'secondary_info.description');
    if (secDesc) {
      description = extractText(secDesc);
    }
  }

  // Try microformat
  if (!description) {
    description = safeGet(info, 'microformat.playerMicroformatRenderer.description.simpleText');
  }

  // Try video_details
  if (!description) {
    description = safeGet(info, 'video_details.short_description');
  }

  // Ensure description is a string
  if (typeof description !== 'string') {
    description = extractText(description) || '';
  }

  // TITLE
  const title = tryPaths([
    'basic_info.title',
    'primary_info.title',
    'video_details.title',
    'microformat.playerMicroformatRenderer.title.simpleText'
  ], '');

  // DURATION
  let duration = safeGet(info, 'basic_info.duration', 0);
  if (!duration) {
    const formats = safeGet(info, 'streaming_data.formats') || 
                   safeGet(info, 'streaming_data.adaptive_formats') || [];
    for (const f of formats) {
      if (f.approxDurationMs) {
        duration = Math.floor(parseInt(f.approxDurationMs) / 1000);
        break;
      }
    }
  }
  if (!duration) {
    duration = parseDuration(safeGet(info, 'video_details.length_seconds'));
  }
  if (!duration) {
    duration = parseDuration(safeGet(info, 'microformat.playerMicroformatRenderer.lengthSeconds'));
  }

  // VIEWS
  let views = safeGet(info, 'basic_info.view_count', 0);
  if (!views) {
    const viewCountObj = safeGet(info, 'primary_info.view_count');
    if (viewCountObj) {
      views = parseViewCount(safeGet(viewCountObj, 'view_count.text')) ||
              parseViewCount(safeGet(viewCountObj, 'short_view_count.text')) ||
              parseViewCount(viewCountObj.original_view_count) ||
              parseViewCount(viewCountObj);
    }
  }
  if (!views) {
    views = parseViewCount(safeGet(info, 'video_details.view_count'));
  }

  // CHANNEL INFO
  const channelName = tryPaths([
    'basic_info.author',
    'basic_info.channel.name',
    'secondary_info.owner.author.name',
    'video_details.author'
  ], 'Unknown');

  const channelId = tryPaths([
    'basic_info.channel_id',
    'basic_info.channel.id',
    'secondary_info.owner.author.id',
    'secondary_info.owner.author.endpoint.payload.browseId',
    'video_details.channel_id'
  ], null);

  // Channel thumbnail
  let channelThumbnail = null;
  const channelThumbSources = [
    safeGet(info, 'secondary_info.owner.author.thumbnails'),
    safeGet(info, 'basic_info.channel.thumbnails'),
    safeGet(info, 'channel.thumbnails')
  ];
  for (const thumbs of channelThumbSources) {
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
      if (sorted[0]?.url) {
        channelThumbnail = sorted[0].url;
        break;
      }
    }
  }

  // Channel handle
  let channelHandle = null;
  const canonicalUrl = safeGet(info, 'secondary_info.owner.author.endpoint.payload.canonicalBaseUrl');
  if (canonicalUrl) {
    channelHandle = canonicalUrl.startsWith('/') ? canonicalUrl.substring(1) : canonicalUrl;
  }
  if (!channelHandle) {
    const authorUrl = safeGet(info, 'secondary_info.owner.author.url') || 
                     safeGet(info, 'basic_info.channel.url');
    if (authorUrl) {
      const handleMatch = authorUrl.match(/@[\w.-]+/);
      if (handleMatch) channelHandle = handleMatch[0];
    }
  }

  // THUMBNAIL
  let thumbnail = null;
  const thumbSources = [
    safeGet(info, 'basic_info.thumbnail'),
    safeGet(info, 'video_details.thumbnail.thumbnails'),
    safeGet(info, 'microformat.playerMicroformatRenderer.thumbnail.thumbnails')
  ];
  for (const thumbs of thumbSources) {
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
      if (sorted[0]?.url) {
        thumbnail = sorted[0].url;
        break;
      }
    }
  }
  if (!thumbnail) {
    thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  }

  // OTHER FIELDS
  const publishDate = tryPaths([
    'basic_info.publish_date',
    'primary_info.published',
    'primary_info.relative_date',
    'microformat.playerMicroformatRenderer.publishDate'
  ], null);

  const uploadDate = tryPaths([
    'basic_info.upload_date',
    'microformat.playerMicroformatRenderer.uploadDate'
  ], null);

  const category = tryPaths([
    'basic_info.category',
    'microformat.playerMicroformatRenderer.category'
  ], null);

  const tags = safeGet(info, 'basic_info.tags') || 
               safeGet(info, 'video_details.keywords') || [];

  const keywords = safeGet(info, 'basic_info.keywords') || [];

  const subscriberCount = extractText(safeGet(info, 'secondary_info.owner.subscriber_count')) ||
                         extractText(safeGet(info, 'basic_info.channel.subscriber_count'));

  return {
    title: typeof title === 'string' ? title : extractText(title) || '',
    description,
    channelName: typeof channelName === 'string' ? channelName : extractText(channelName) || 'Unknown',
    channelId,
    channelThumbnail,
    channelHandle,
    channelUrl: safeGet(info, 'secondary_info.owner.author.url') || 
                safeGet(info, 'basic_info.channel.url'),
    duration,
    viewCount: views,
    likeCount: safeGet(info, 'basic_info.like_count', 0),
    thumbnail,
    publishDate: typeof publishDate === 'string' ? publishDate : extractText(publishDate),
    uploadDate,
    category,
    tags: Array.isArray(tags) ? tags : [],
    keywords: Array.isArray(keywords) ? keywords : [],
    isLive: safeGet(info, 'basic_info.is_live', false),
    isPrivate: safeGet(info, 'basic_info.is_private', false),
    isFamilySafe: safeGet(info, 'basic_info.is_family_safe', true),
    isVerified: safeGet(info, 'secondary_info.owner.author.is_verified', false),
    isVerifiedArtist: safeGet(info, 'secondary_info.owner.author.is_verified_artist', false),
    subscriberCount
  };
}

function extractCredits(description) {
  const credits = {};
  if (!description || typeof description !== 'string') return credits;

  const patterns = {
    song: /SONG\s*[:\-]\s*([^\n]+)/i,
    singer: /(?:SINGER|VOCALS?|ARTIST)\s*[:\-]\s*([^\n]+)/i,
    music: /(?:MUSIC|COMPOSED)\s*(?:BY)?\s*[:\-]\s*([^\n]+)/i,
    lyrics: /(?:LYRICS|WRITTEN)\s*(?:BY)?\s*[:\-]\s*([^\n]+)/i,
    director: /(?:DIRECTED|DIRECTOR)\s*(?:BY)?\s*[:\-]\s*([^\n]+)/i,
    label: /(?:MUSIC\s+LABEL|LABEL)\s*[:\-]\s*([^\n]+)/i
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = description.match(pattern);
    if (match && isValidTag(match[1])) {
      credits[key] = match[1].trim();
    }
  }

  return credits;
}

function extractArtists(title) {
  const artists = [];
  if (!title || typeof title !== 'string') return artists;

  const featMatch = title.match(/(?:feat\.?|ft\.?|featuring)\s+([^|(\[\]]+)/i);
  if (featMatch) artists.push(featMatch[1].trim());

  const pipeParts = title.split('|').map(p => p.trim()).filter(p => p.length > 2 && p.length < 30);
  if (pipeParts.length > 1) artists.push(...pipeParts.slice(1, 3));

  return [...new Set(artists.filter(a => a.length > 2 && a.length < 40 && isValidTag(a)))];
}

async function getVideoInfo(videoId, options = {}) {
  const {
    includeComments = true,
    commentStart = 1,
    commentEnd = 20,
    maxComments = 100,
    commentSort = 'top'
  } = options;

  const cacheKey = videoCache.key('v', videoId);
  const cached = videoCache.get(cacheKey);

  if (cached && !includeComments) {
    log(`📦 Video cache hit: ${videoId}`);
    return { success: true, video: cached, fromCache: true };
  }

  log(`📹 Getting video info: ${videoId}`);

  const yt = await getYouTube();

  let info;
  try {
    info = await yt.getInfo(videoId);
  } catch (e) {
    log(`❌ getInfo failed: ${e.message}`);
    return { success: false, error: e.message };
  }

  if (!info) {
    return { success: false, error: 'No info returned' };
  }

  const extracted = extractVideoInfo(info, videoId);

  const title = extracted.title;
  const description = extracted.description;

  // Log for debugging
  log(`📝 Title: ${title.substring(0, 50)}...`);
  log(`📝 Description length: ${description.length} chars`);

  // Extract metadata
  const hashtags = [
    ...extractHashtags(title),
    ...extractHashtags(description)
  ];

  const credits = extractCredits(description);
  const artists = extractArtists(title);

  if (credits.singer && !artists.includes(credits.singer)) {
    artists.unshift(credits.singer);
  }

  const tags = cleanTags(extracted.tags);
  const keywords = cleanTags(extracted.keywords);

  const allTags = cleanTags([
    ...tags,
    ...keywords,
    ...hashtags,
    ...artists
  ]);

  const video = {
    id: videoId,
    title,
    description,
    thumbnail: extracted.thumbnail,
    duration: extracted.duration,
    durationFormatted: formatDuration(extracted.duration),
    views: extracted.viewCount,
    viewsFormatted: formatViews(extracted.viewCount),
    likes: extracted.likeCount,
    likesFormatted: formatViews(extracted.likeCount),
    published: extracted.publishDate,
    uploadDate: extracted.uploadDate,

    channel: {
      name: extracted.channelName,
      id: extracted.channelId,
      handle: extracted.channelHandle,
      url: extracted.channelHandle || extracted.channelUrl,
      fullUrl: extracted.channelUrl,
      thumbnail: extracted.channelThumbnail,
      subscriberCount: extracted.subscriberCount,
      isVerified: extracted.isVerified,
      isVerifiedArtist: extracted.isVerifiedArtist
    },

    credits,

    metadata: {
      tags,
      keywords,
      hashtags: [...new Set(hashtags)],
      artists: [...new Set(artists)],
      category: extracted.category,
      isLive: extracted.isLive,
      isPrivate: extracted.isPrivate,
      isFamilySafe: extracted.isFamilySafe,
      allTags,
      searchTags: {
        primary: hashtags.slice(0, 3),
        artists: artists.slice(0, 3),
        category: extracted.category ? [extracted.category] : []
      }
    }
  };

  // Cache video (without comments)
  videoCache.set(cacheKey, video);

  // Get comments if requested
  let commentsData = {
    count: 0,
    fetched: 0,
    isComplete: true,
    hasMore: false,
    sortBy: commentSort,
    items: []
  };

  if (includeComments) {
    const commentsResult = await getVideoComments(videoId, {
      start: commentStart,
      end: commentEnd,
      maxComments,
      sortBy: commentSort
    });

    if (commentsResult.success) {
      commentsData = {
        count: commentsResult.totalFetched,
        fetched: commentsResult.comments.length,
        isComplete: commentsResult.isComplete,
        hasMore: commentsResult.hasMore,
        sortBy: commentSort,
        items: commentsResult.comments
      };
    }
  }

  log(`✅ Video info complete: ${videoId}`);

  return {
    success: true,
    video: {
      ...video,
      comments: commentsData
    }
  };
}

// ============================================================================
// COMMENTS
// ============================================================================

function parseCommentItem(item) {
  // Handle different comment structures from youtubei.js
  let c = item;

  // Try to extract the actual comment object
  if (item.comment) c = item.comment;
  else if (item.commentRenderer) c = item.commentRenderer;
  else if (item.commentThreadRenderer?.comment?.commentRenderer) {
    c = item.commentThreadRenderer.comment.commentRenderer;
  }

  if (!c) return null;

  // Extract comment ID
  const id = c.comment_id || c.commentId || c.id || null;

  // Extract text - try multiple approaches
  let text = null;

  if (c.content) {
    text = extractText(c.content);
  }
  if (!text && c.content_text) {
    text = extractText(c.content_text);
  }
  if (!text && c.contentText) {
    text = extractText(c.contentText);
  }
  if (!text && c.text) {
    text = extractText(c.text);
  }

  if (!text) return null;

  // AUTHOR INFO
  const author = c.author || {};
  const authorName = author.name || 
                     extractText(c.author_text) || 
                     extractText(c.authorText) ||
                     'Unknown';

  const authorId = author.id || 
                   safeGet(c, 'authorEndpoint.browseEndpoint.browseId') ||
                   safeGet(author, 'endpoint.payload.browseId') ||
                   null;

  const authorThumbnail = author.thumbnails?.[0]?.url ||
                          safeGet(c, 'authorThumbnail.thumbnails.0.url') ||
                          author.best_thumbnail?.url ||
                          null;

  // LIKES - Multiple extraction methods
  let likesText = '0';
  let likesCount = 0;

  // Method 1: vote_count object
  if (c.vote_count) {
    if (typeof c.vote_count === 'object') {
      likesText = extractText(c.vote_count) || 
                  c.vote_count.text ||
                  c.vote_count.simpleText ||
                  '0';
    } else {
      likesText = String(c.vote_count);
    }
  }

  // Method 2: voteCount
  if (likesText === '0' && c.voteCount) {
    if (typeof c.voteCount === 'object') {
      likesText = extractText(c.voteCount) || 
                  c.voteCount.simpleText ||
                  '0';
    } else {
      likesText = String(c.voteCount);
    }
  }

  // Method 3: like_count
  if (likesText === '0' && c.like_count !== undefined) {
    likesText = String(c.like_count);
  }

  // Method 4: likeCount
  if (likesText === '0' && c.likeCount !== undefined) {
    likesText = String(c.likeCount);
  }

  // Method 5: Check for accessibility label (contains like count)
  if (likesText === '0') {
    const accessibilityLabel = safeGet(c, 'voteCount.accessibility.accessibilityData.label') ||
                               safeGet(c, 'actionButtons.commentActionButtonsRenderer.likeButton.toggleButtonRenderer.accessibilityData.accessibilityData.label');
    if (accessibilityLabel) {
      const match = accessibilityLabel.match(/(\d[\d,]*)/);
      if (match) {
        likesText = match[1];
      }
    }
  }

  // Parse likes count
  likesCount = parseViewCount(likesText);

  // PUBLISHED TIME
  let published = '';

  // Method 1: published object
  if (c.published) {
    if (typeof c.published === 'object') {
      published = extractText(c.published) || c.published.text || '';
    } else {
      published = String(c.published);
    }
  }

  // Method 2: published_time_text
  if (!published && c.published_time_text) {
    published = extractText(c.published_time_text) || '';
  }

  // Method 3: publishedTimeText (camelCase)
  if (!published && c.publishedTimeText) {
    if (typeof c.publishedTimeText === 'object') {
      published = c.publishedTimeText.text ||
                  extractText(c.publishedTimeText) ||
                  safeGet(c, 'publishedTimeText.runs.0.text') ||
                  '';
    } else {
      published = String(c.publishedTimeText);
    }
  }

  // REPLY COUNT
  let replyCount = 0;

  if (c.reply_count !== undefined) {
    replyCount = typeof c.reply_count === 'number' ? c.reply_count : parseInt(c.reply_count) || 0;
  } else if (c.replyCount !== undefined) {
    replyCount = typeof c.replyCount === 'number' ? c.replyCount : parseInt(c.replyCount) || 0;
  }

  // Check for reply text like "View 5 replies"
  const replyText = extractText(c.replies?.view_replies?.text) || 
                    extractText(c.replies?.viewReplies?.text) ||
                    safeGet(c, 'replies.commentRepliesRenderer.moreText.simpleText');
  if (replyText && replyCount === 0) {
    const match = replyText.match(/(\d+)/);
    if (match) replyCount = parseInt(match[1]);
  }

  // HEARTED & PINNED
  const isHearted = c.is_hearted || 
                    !!c.creator_heart || 
                    !!c.creatorHeart ||
                    !!safeGet(c, 'actionButtons.commentActionButtonsRenderer.creatorHeart') ||
                    false;

  const isPinned = c.is_pinned || 
                   !!c.pinned_comment_badge || 
                   !!c.pinnedCommentBadge ||
                   !!safeGet(c, 'pinnedCommentBadge.pinnedCommentBadgeRenderer') ||
                   false;

  // IS VERIFIED / CHANNEL OWNER
  const isVerified = author.is_verified || 
                     !!safeGet(c, 'authorCommentBadge.authorCommentBadgeRenderer') ||
                     false;

  const isChannelOwner = c.is_channel_owner || 
                         c.author_is_channel_owner || 
                         c.authorIsChannelOwner ||
                         author.is_channel_owner ||
                         false;

  return {
    id,
    text: text.trim(),
    author: {
      name: authorName,
      id: authorId,
      thumbnail: authorThumbnail,
      isVerified,
      isChannelOwner
    },
    likes: likesText,
    likesCount,
    published,
    replyCount,
    isHearted,
    isPinned,
    isReply: c.is_reply || false
  };
}

function parseCommentsFromThread(thread, comments, seenIds) {
  if (!thread) return;

  // Try multiple ways to get comments array
  let items = [];

  if (thread.contents && Array.isArray(thread.contents)) {
    items = thread.contents;
  } else if (thread.comments && Array.isArray(thread.comments)) {
    items = thread.comments;
  } else if (thread[Symbol.iterator]) {
    try {
      items = [...thread];
    } catch (e) {
      // Not iterable
    }
  }


  for (const item of items) {
    try {
      const parsed = parseCommentItem(item);
      if (parsed && parsed.text) {
        if (parsed.id && seenIds.has(parsed.id)) continue;
        if (parsed.id) seenIds.add(parsed.id);

        const textKey = `txt_${parsed.text.substring(0, 50)}`;
        if (seenIds.has(textKey)) continue;
        seenIds.add(textKey);

        comments.push(parsed);
      }
    } catch (e) {
      if (CONFIG.ENABLE_LOGGING) {
        console.log('Failed to parse comment:', e.message);
      }
    }
  }
}

async function getVideoComments(videoId, options = {}) {
  const {
    start = 1,
    end = 20,
    maxComments = CONFIG.MAX_COMMENTS,
    sortBy = 'top',
    forceRefresh = false
  } = typeof options === 'number' ? { end: options } : options;

  const cacheKey = commentCache.key('c', videoId, sortBy);

  if (!forceRefresh) {
    const cached = commentCache.get(cacheKey);
    if (cached && (cached.comments.length >= end || cached.isComplete)) {
      log(`📦 Comment cache hit: ${videoId} (${cached.comments.length} comments)`);

      const startIdx = Math.max(0, start - 1);
      const endIdx = Math.min(cached.comments.length, end);

      return {
        success: true,
        videoId,
        sortBy,
        range: { start, end },
        comments: cached.comments.slice(startIdx, endIdx),
        totalFetched: cached.comments.length,
        isComplete: cached.isComplete,
        hasMore: !cached.isComplete || cached.comments.length > end
      };
    }
  }

  log(`💬 Fetching comments: ${videoId}`);

  const yt = await getYouTube();

  let cacheEntry = commentCache.get(cacheKey);

  if (!cacheEntry) {
    cacheEntry = {
      comments: [],
      seenIds: new Set(),
      thread: null,
      isComplete: false
    };

    try {
      const sortOpt = sortBy === 'newest' ? 'NEWEST_FIRST' : 'TOP_COMMENTS';
      cacheEntry.thread = await yt.getComments(videoId, sortOpt);

      if (!cacheEntry.thread) {
        log(`ℹ️ No comments available for ${videoId}`);
        return {
          success: true,
          videoId,
          sortBy,
          range: { start, end },
          comments: [],
          totalFetched: 0,
          isComplete: true,
          hasMore: false,
          message: 'Comments disabled or unavailable'
        };
      }

      parseCommentsFromThread(cacheEntry.thread, cacheEntry.comments, cacheEntry.seenIds);
      cacheEntry.isComplete = !cacheEntry.thread.has_continuation;

    } catch (e) {
      log(`⚠️ Comment fetch failed: ${e.message}`);
      return {
        success: true,
        videoId,
        sortBy,
        range: { start, end },
        comments: [],
        totalFetched: 0,
        isComplete: true,
        hasMore: false,
        message: 'Could not fetch comments'
      };
    }
  }

  let pages = 0;
  while (cacheEntry.comments.length < end && cacheEntry.thread?.has_continuation && pages < 5) {
    try {
      cacheEntry.thread = await cacheEntry.thread.getContinuation();
      const beforeCount = cacheEntry.comments.length;
      parseCommentsFromThread(cacheEntry.thread, cacheEntry.comments, cacheEntry.seenIds);

      if (cacheEntry.comments.length === beforeCount) break;
      pages++;
    } catch (e) {
      log(`⚠️ Comment continuation failed: ${e.message}`);
      break;
    }
  }

  cacheEntry.isComplete = !cacheEntry.thread?.has_continuation;
  commentCache.set(cacheKey, cacheEntry);

  if (!cacheEntry.isComplete && cacheEntry.comments.length < maxComments) {
    const bgKey = `bg_${cacheKey}`;
    if (!activeFetches.has(bgKey)) {
      activeFetches.add(bgKey);
      backgroundFetchComments(cacheKey, cacheEntry, maxComments)
        .finally(() => activeFetches.delete(bgKey));
    }
  }

  const startIdx = Math.max(0, start - 1);
  const endIdx = Math.min(cacheEntry.comments.length, end);

  log(`✅ Comments fetched: ${cacheEntry.comments.length} for ${videoId}`);

  return {
    success: true,
    videoId,
    sortBy,
    range: { start, end },
    comments: cacheEntry.comments.slice(startIdx, endIdx),
    totalFetched: cacheEntry.comments.length,
    isComplete: cacheEntry.isComplete,
    hasMore: !cacheEntry.isComplete || cacheEntry.comments.length > end
  };
}

async function backgroundFetchComments(cacheKey, cacheEntry, maxComments) {
  let pages = 0;
  const maxPages = 30;

  while (
    cacheEntry.comments.length < maxComments &&
    cacheEntry.thread?.has_continuation &&
    pages < maxPages
  ) {
    try {
      cacheEntry.thread = await cacheEntry.thread.getContinuation();
      const beforeCount = cacheEntry.comments.length;
      parseCommentsFromThread(cacheEntry.thread, cacheEntry.comments, cacheEntry.seenIds);

      if (cacheEntry.comments.length === beforeCount) break;

      commentCache.set(cacheKey, cacheEntry);
      pages++;

      if (pages % 5 === 0) {
        await new Promise(r => setTimeout(r, CONFIG.BACKGROUND_FETCH_DELAY));
      }
    } catch {
      break;
    }
  }

  cacheEntry.isComplete = true;
  commentCache.set(cacheKey, cacheEntry);
  log(`📦 Background comments complete: ${cacheEntry.comments.length} total`);
}


// RELATED VIDEOS

async function findRelatedByTags(videoId, options = {}) {
  const { 
    start = 1, 
    end = 20, 
    maxQueries = 3,
    includeWatchNext = true 
  } = options;

  const limit = end - start + 1;

  log(`🔗 Finding related videos for ${videoId}`);

  const yt = await getYouTube();

  let watchNextVideos = [];
  let videoInfo = null;

  try {
    const info = await yt.getInfo(videoId);

    if (includeWatchNext && info.watch_next_feed) {
      for (const item of info.watch_next_feed) {
        if (item.id && item.id !== videoId) {
          const formatted = formatVideo(item);
          if (formatted) {
            formatted.relatedVia = { type: 'youtube_related', weight: 15 };
            watchNextVideos.push(formatted);
          }
        }
      }
      log(`📺 Found ${watchNextVideos.length} from watch_next_feed`);
    }

    videoInfo = extractVideoInfo(info, videoId);
  } catch (e) {
    log(`⚠️ Could not get video info: ${e.message}`);
  }

  if (watchNextVideos.length >= end) {
    const s = Math.max(0, start - 1);
    const paginated = watchNextVideos.slice(s, s + limit);

    return {
      success: true,
      originalVideo: { id: videoId, title: videoInfo?.title, channel: videoInfo?.channelName },
      source: 'watch_next_feed',
      range: { start, end },
      totalResults: paginated.length,
      totalFound: watchNextVideos.length,
      hasMore: watchNextVideos.length > end,
      results: paginated,
      videos: paginated
    };
  }

  const queries = [];
  if (videoInfo) {
    const { title, channelName, description } = videoInfo;

    const credits = extractCredits(description || '');
    if (credits.singer) {
      queries.push({ query: `${credits.singer} songs`, type: 'singer', weight: 12 });
    }

    const artists = extractArtists(title);
    if (artists.length > 0) {
      queries.push({ query: `${artists[0]} songs`, type: 'artist', weight: 10 });
    }

    if (channelName && channelName !== 'Unknown') {
      queries.push({ query: `${channelName} latest`, type: 'channel', weight: 8 });
    }

    if (title) {
      const words = title.replace(/[|:\-\[\]()]/g, ' ').split(' ').filter(w => w.length > 3).slice(0, 3).join(' ');
      if (words.length > 5) {
        queries.push({ query: words, type: 'title', weight: 9 });
      }
    }

    const hashtags = extractHashtags(title);
    if (hashtags.length > 0) {
      queries.push({ query: hashtags[0].replace('#', ''), type: 'hashtag', weight: 7 });
    }
  }

  queries.sort((a, b) => b.weight - a.weight);
  const queriesToRun = queries.slice(0, maxQueries);

  const seenIds = new Set([videoId, ...watchNextVideos.map(v => v.id)]);
  const searchResults = [];

  if (queriesToRun.length > 0) {
    log(`🔍 Running ${queriesToRun.length} search queries`);

    const searchPromises = queriesToRun.map(async ({ query, type, weight }) => {
      try {
        const result = await search(query, { type: 'video', start: 1, end: 25 });
        return { videos: result.success ? result.videos : [], type, weight };
      } catch {
        return { videos: [], type, weight };
      }
    });

    const results = await Promise.all(searchPromises);

    for (const { videos, type, weight } of results) {
      for (const video of videos) {
        if (!seenIds.has(video.id)) {
          seenIds.add(video.id);
          video.relatedVia = { type, weight };
          searchResults.push(video);
        }
      }
    }
  }

  const combined = [...watchNextVideos, ...searchResults];
  combined.sort((a, b) => {
    const weightDiff = (b.relatedVia?.weight || 0) - (a.relatedVia?.weight || 0);
    if (weightDiff !== 0) return weightDiff;

    if (b.channel?.isVerified && !a.channel?.isVerified) return 1;
    if (a.channel?.isVerified && !b.channel?.isVerified) return -1;

    return 0;
  });

  const s = Math.max(0, start - 1);
  const paginated = combined.slice(s, s + limit);

  log(`✅ Found ${combined.length} related videos`);

  return {
    success: true,
    originalVideo: { id: videoId, title: videoInfo?.title, channel: videoInfo?.channelName },
    searchQueries: queriesToRun.map(q => q.query),
    range: { start, end },
    totalResults: paginated.length,
    totalFound: combined.length,
    hasMore: combined.length > end,
    results: paginated,
    videos: paginated
  };
}


// ADDITIONAL FUNCTIONS

async function searchVideos(query, options = {}) {
  return search(query, { ...options, type: 'video' });
}

async function searchChannels(query, options = {}) {
  return search(query, { ...options, type: 'channel' });
}

async function searchPlaylists(query, options = {}) {
  return search(query, { ...options, type: 'playlist' });
}

async function getSearchSuggestions(query) {
  try {
    const yt = await getYouTube();
    const suggestions = await yt.getSearchSuggestions(query);
    return { success: true, query, suggestions: suggestions || [] };
  } catch (e) {
    return { success: false, error: e.message, suggestions: [] };
  }
}

async function getTrending(options = {}) {
  try {
    const yt = await getYouTube();
    const trending = await yt.getTrending();

    const results = [];
    const seenIds = new Set();

    const sections = [trending.videos, trending.now, trending.music, trending.gaming, trending.movies];

    for (const section of sections) {
      if (!section) continue;
      for (const item of section) {
        if (item.id && !seenIds.has(item.id)) {
          const formatted = formatVideo(item);
          if (formatted) {
            seenIds.add(item.id);
            results.push(formatted);
          }
        }
      }
    }

    return { success: true, totalResults: results.length, results };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getVideoTags(videoId) {
  const cacheKey = videoCache.key('tags', videoId);
  const cached = videoCache.get(cacheKey);
  if (cached) return cached;

  try {
    const yt = await getYouTube();
    const info = await yt.getInfo(videoId);

    const result = {
      tags: cleanTags(safeGet(info, 'basic_info.tags') || []),
      keywords: cleanTags(safeGet(info, 'basic_info.keywords') || []),
      category: safeGet(info, 'basic_info.category')
    };

    videoCache.set(cacheKey, result);
    return result;
  } catch {
    return { tags: [], keywords: [], category: null };
  }
}

async function batchGetVideoTags(videoIds) {
  const results = {};
  await Promise.all(videoIds.map(async id => {
    results[id] = await getVideoTags(id);
  }));
  return results;
}

async function searchByTag(tag, options = {}) {
  return search(tag.replace(/^#/, ''), { ...options, type: 'video' });
}

async function prefetchSearch(query, options = {}) {
  search(query, { ...options, start: 1, end: 20 }).catch(() => {});
  return true;
}


// CACHE MANAGEMENT

function getSearchCacheStatus(query, options = {}) {
  const { type = 'all', sort = 'relevance', duration, uploadDate } = options;
  const cacheKey = searchCache.key('s', query, type, sort, duration, uploadDate);
  const cached = searchCache.get(cacheKey);

  return cached 
    ? { exists: true, resultCount: cached.results.length, isComplete: cached.isComplete }
    : { exists: false };
}

function clearSearchCache(query = null) {
  if (query) {
    for (const key of searchCache.cache.keys()) {
      if (key.includes(query.toLowerCase())) {
        searchCache.delete(key);
      }
    }
  } else {
    searchCache.clear();
  }
}

function getCommentCacheStatus(videoId, sortBy = 'top') {
  const cacheKey = commentCache.key('c', videoId, sortBy);
  const cached = commentCache.get(cacheKey);

  return cached
    ? { exists: true, commentCount: cached.comments.length, isComplete: cached.isComplete }
    : { exists: false };
}

function clearCommentCache(videoId = null) {
  if (videoId) {
    for (const key of commentCache.cache.keys()) {
      if (key.includes(videoId)) {
        commentCache.delete(key);
      }
    }
  } else {
    commentCache.clear();
  }
}

function getSystemStatus() {
  return {
    youtube: { ready: !!youtubeInstance },
    instanceAge: youtubeInstance ? Date.now() - instanceCreatedAt : 0,
    activeFetches: activeFetches.size,
    caches: {
      search: searchCache.size(),
      video: videoCache.size(),
      comment: commentCache.size()
    }
  };
}


export {
  search,
  searchVideos,
  searchChannels,
  searchPlaylists,
  getSearchSuggestions,
  getTrending,
  getVideoInfo,
  getVideoTags,
  batchGetVideoTags,
  getVideoComments,
  findRelatedByTags,
  searchByTag,
  getSearchCacheStatus,
  clearSearchCache,
  prefetchSearch,
  clearCommentCache,
  getCommentCacheStatus,
  getSystemStatus
};
