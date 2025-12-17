import { Innertube, Log } from 'youtubei.js';
import { resolveChannelId } from './channelallvideosHandlers.js';

// Disable youtubei.js warnings
Log.setLevel(Log.Level.NONE);

// ==================== CONFIGURATION ====================
const CONFIG = {
  // Pool settings
  POOL_SIZE: 5,                    // Number of YouTube instances in pool
  MAX_CONCURRENT_REQUESTS: 20,     // Max parallel requests across all instances
  MAX_REQUESTS_PER_INSTANCE: 4,    // Max concurrent requests per instance

  // Timeouts
  INSTANCE_TIMEOUT: 30000,         // 30 seconds
  REQUEST_TIMEOUT: 25000,          // 25 seconds

  // Instance refresh
  INSTANCE_MAX_REQUESTS: 100,      // Refresh instance after N requests
  INSTANCE_MAX_AGE: 1000 * 60 * 15, // Refresh instance after 15 minutes

  // Retry settings
  MAX_RETRIES: 2,
  RETRY_DELAY: 500,

  // Cache settings
  CACHE_EXPIRY: 1000 * 60 * 30,    // 30 minutes
};

// ==================== INSTANCE POOL ====================
class YouTubeInstancePool {
  constructor() {
    this.instances = [];
    this.instanceStats = new Map();
    this.initPromise = null;
    this.isInitializing = false;
  }

  // Generate random visitor data for fresh session
  generateVisitorData() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let result = 'Cgt';
    for (let i = 0; i < 22; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Create a single YouTube instance
  async createInstance() {
    const instance = await Innertube.create({
      retrieve_player: false,
      generate_session_locally: true,
      enable_session_cache: false,
      lang: 'en',
      location: 'US',
      visitor_data: this.generateVisitorData()
    });

    const instanceId = `yt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.instanceStats.set(instanceId, {
      createdAt: Date.now(),
      requestCount: 0,
      activeRequests: 0,
      errors: 0,
      lastUsed: Date.now()
    });

    return { id: instanceId, instance };
  }

  // Initialize the pool
  async initialize() {
    if (this.initPromise) return this.initPromise;
    if (this.instances.length >= CONFIG.POOL_SIZE) return;

    this.isInitializing = true;
    this.initPromise = (async () => {
      console.log(`🔧 Initializing YouTube instance pool (size: ${CONFIG.POOL_SIZE})...`);

      const createPromises = [];
      for (let i = 0; i < CONFIG.POOL_SIZE; i++) {
        createPromises.push(
          this.createInstance()
            .then(inst => {
              this.instances.push(inst);
              console.log(`   ✅ Instance ${i + 1}/${CONFIG.POOL_SIZE} created`);
            })
            .catch(err => {
              console.error(`   ❌ Failed to create instance ${i + 1}: ${err.message}`);
            })
        );
      }

      await Promise.allSettled(createPromises);
      console.log(`🎉 Pool initialized with ${this.instances.length} instances`);
      this.isInitializing = false;
    })();

    return this.initPromise;
  }

  // best available instance
  async getInstance() {
    await this.initialize();

    if (this.instances.length === 0) {
      throw new Error('No YouTube instances available');
    }

    
    let bestInstance = null;
    let lowestLoad = Infinity;

    for (const inst of this.instances) {
      const stats = this.instanceStats.get(inst.id);
      if (!stats) continue;

      // Skiping if at capacity
      if (stats.activeRequests >= CONFIG.MAX_REQUESTS_PER_INSTANCE) continue;

      // Checking if instance needs refresh
      const needsRefresh = 
        stats.requestCount >= CONFIG.INSTANCE_MAX_REQUESTS ||
        Date.now() - stats.createdAt >= CONFIG.INSTANCE_MAX_AGE;

      if (needsRefresh && stats.activeRequests === 0) {
        // Refreshing this instance in background
        this.refreshInstance(inst.id);
        continue;
      }

      // Calculate load score (active requests + error penalty)
      const loadScore = stats.activeRequests + (stats.errors * 0.5);

      if (loadScore < lowestLoad) {
        lowestLoad = loadScore;
        bestInstance = inst;
      }
    }

    // If all instances are busy, wait and retry
    if (!bestInstance) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.getInstance();
    }

    return bestInstance;
  }

  // Acquiring an instance for a request
  async acquire() {
    const inst = await this.getInstance();
    const stats = this.instanceStats.get(inst.id);

    if (stats) {
      stats.activeRequests++;
      stats.lastUsed = Date.now();
    }

    return inst;
  }

  // Releaseing an instance after request completes
  release(instanceId, hadError = false) {
    const stats = this.instanceStats.get(instanceId);
    if (stats) {
      stats.activeRequests = Math.max(0, stats.activeRequests - 1);
      stats.requestCount++;
      if (hadError) stats.errors++;
    }
  }

  // Refreshing a specific instance
  async refreshInstance(instanceId) {
    const index = this.instances.findIndex(i => i.id === instanceId);
    if (index === -1) return;

    try {
      console.log(`🔄 Refreshing instance ${instanceId.slice(-8)}...`);
      const newInst = await this.createInstance();

      // Removeing old stats
      this.instanceStats.delete(instanceId);

      // Replaceing instance
      this.instances[index] = newInst;

      console.log(`✅ Instance refreshed: ${newInst.id.slice(-8)}`);
    } catch (err) {
      console.error(`❌ Failed to refresh instance: ${err.message}`);
    }
  }

  // Get pool statistics
  getStats() {
    const stats = {
      totalInstances: this.instances.length,
      instances: []
    };

    for (const inst of this.instances) {
      const instStats = this.instanceStats.get(inst.id);
      if (instStats) {
        stats.instances.push({
          id: inst.id.slice(-8),
          activeRequests: instStats.activeRequests,
          totalRequests: instStats.requestCount,
          errors: instStats.errors,
          age: Math.round((Date.now() - instStats.createdAt) / 1000) + 's'
        });
      }
    }

    return stats;
  }
}

// ==================== REQUEST QUEUE / SEMAPHORE ====================
class RequestSemaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.currentCount = 0;
    this.waitingQueue = [];
  }

  async acquire() {
    if (this.currentCount < this.maxConcurrent) {
      this.currentCount++;
      return;
    }

    // Wait in queue
    return new Promise(resolve => {
      this.waitingQueue.push(resolve);
    });
  }

  release() {
    if (this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift();
      next();
    } else {
      this.currentCount = Math.max(0, this.currentCount - 1);
    }
  }

  getStats() {
    return {
      active: this.currentCount,
      waiting: this.waitingQueue.length,
      max: this.maxConcurrent
    };
  }
}

// ==================== GLOBAL INSTANCES ====================
const instancePool = new YouTubeInstancePool();
const requestSemaphore = new RequestSemaphore(CONFIG.MAX_CONCURRENT_REQUESTS);
const playlistCache = new Map();

// ==================== HELPER: Execute with instance ====================
async function executeWithInstance(operation, options = {}) {
  const { 
    retries = CONFIG.MAX_RETRIES,
    timeout = CONFIG.REQUEST_TIMEOUT 
  } = options;

  // Acquire semaphore slot
  await requestSemaphore.acquire();

  let lastError;
  let attempts = 0;

  try {
    while (attempts <= retries) {
      const inst = await instancePool.acquire();

      try {
        // Execute with timeout
        const result = await Promise.race([
          operation(inst.instance),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout')), timeout)
          )
        ]);

        instancePool.release(inst.id, false);
        return result;

      } catch (error) {
        lastError = error;
        instancePool.release(inst.id, true);

        attempts++;

        if (attempts <= retries) {
          console.log(`⚠️ Retry ${attempts}/${retries} after error: ${error.message}`);
          await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY * attempts));
        }
      }
    }

    throw lastError;

  } finally {
    requestSemaphore.release();
  }
}

// ==================== HELPER: Extract Playlist IDs ====================
function extractPlaylistIds(data, isContinuation = false) {
  const ids = [];

  try {
    let items = [];

    if (isContinuation) {
      items = data.contents?.contents || data.contents || [];

      const findPlaylists = (obj, depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > 10) return;

        if (obj.content_id && obj.content_type === 'PLAYLIST') {
          if (!ids.includes(obj.content_id)) {
            ids.push(obj.content_id);
          }
        }

        if (obj.id && typeof obj.id === 'string' && obj.id.startsWith('PL')) {
          if (!ids.includes(obj.id)) {
            ids.push(obj.id);
          }
        }

        if (obj.playlist_id && typeof obj.playlist_id === 'string') {
          if (!ids.includes(obj.playlist_id)) {
            ids.push(obj.playlist_id);
          }
        }

        if (Array.isArray(obj)) {
          obj.forEach(item => findPlaylists(item, depth + 1));
        } else {
          Object.keys(obj).forEach(key => {
            if (!key.startsWith('_') && typeof obj[key] === 'object') {
              findPlaylists(obj[key], depth + 1);
            }
          });
        }
      };

      findPlaylists(data);

    } else {
      const tabContents = data.current_tab?.content?.contents || [];

      for (const section of tabContents) {
        if (section.contents) {
          for (const gridContainer of section.contents) {
            if (gridContainer.type === 'Grid' && gridContainer.items) {
              items.push(...gridContainer.items);
            }
            if (gridContainer.items) {
              items.push(...gridContainer.items);
            }
          }
        }

        if (section.type === 'Grid' && section.items) {
          items.push(...section.items);
        }

        if (section.items) {
          items.push(...section.items);
        }
      }

      for (const item of items) {
        if (item.content_id && item.content_type === 'PLAYLIST') {
          if (!ids.includes(item.content_id)) {
            ids.push(item.content_id);
          }
        }

        if (item.id && typeof item.id === 'string' && item.id.startsWith('PL')) {
          if (!ids.includes(item.id)) {
            ids.push(item.id);
          }
        }
      }

      const findPlaylists = (obj, depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > 10) return;

        if (obj.content_id && obj.content_type === 'PLAYLIST') {
          if (!ids.includes(obj.content_id)) {
            ids.push(obj.content_id);
          }
        }

        if (obj.id && typeof obj.id === 'string' && obj.id.startsWith('PL')) {
          if (!ids.includes(obj.id)) {
            ids.push(obj.id);
          }
        }

        if (Array.isArray(obj)) {
          obj.forEach(item => findPlaylists(item, depth + 1));
        } else {
          Object.keys(obj).forEach(key => {
            if (!key.startsWith('_') && typeof obj[key] === 'object') {
              findPlaylists(obj[key], depth + 1);
            }
          });
        }
      };

      findPlaylists(data);
    }
  } catch (e) {
    console.log(`   Warning: Error extracting playlists: ${e.message}`);
  }

  return ids;
}

// ==================== HELPER: Get Playlists Via Browse ====================
async function getPlaylistsViaBrowse(youtube, channelId) {
  const playlistIds = [];

  try {
    let browseData = await youtube.actions.execute('/browse', {
      browseId: channelId,
      params: 'EglwbGF5bGlzdHPyBgQKAkIA'
    });

    if (!browseData?.data) {
      return playlistIds;
    }

    const findContinuationToken = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 15) return null;

      if (obj.token && typeof obj.token === 'string' && obj.token.length > 20) {
        return obj.token;
      }
      if (obj.continuation && typeof obj.continuation === 'string' && obj.continuation.length > 20) {
        return obj.continuation;
      }

      if (Array.isArray(obj)) {
        for (const item of obj) {
          const token = findContinuationToken(item, depth + 1);
          if (token) return token;
        }
      } else {
        for (const key of Object.keys(obj)) {
          if (key.startsWith('_')) continue;
          const token = findContinuationToken(obj[key], depth + 1);
          if (token) return token;
        }
      }
      return null;
    };

    const findPlaylistIds = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 15) return;

      if (obj.playlistId && typeof obj.playlistId === 'string') {
        if (!playlistIds.includes(obj.playlistId)) {
          playlistIds.push(obj.playlistId);
        }
      }

      if (obj.id && typeof obj.id === 'string' && obj.id.startsWith('PL')) {
        if (!playlistIds.includes(obj.id)) {
          playlistIds.push(obj.id);
        }
      }

      if (obj.content_id && obj.content_type === 'PLAYLIST') {
        if (!playlistIds.includes(obj.content_id)) {
          playlistIds.push(obj.content_id);
        }
      }

      if (Array.isArray(obj)) {
        obj.forEach(item => findPlaylistIds(item, depth + 1));
      } else {
        Object.keys(obj).forEach(key => {
          if (!key.startsWith('_') && typeof obj[key] === 'object') {
            findPlaylistIds(obj[key], depth + 1);
          }
        });
      }
    };

    findPlaylistIds(browseData.data);

    let pageCount = 1;
    let continuationToken = findContinuationToken(browseData.data);

    while (continuationToken && pageCount < 50) {
      try {
        const contData = await youtube.actions.execute('/browse', {
          continuation: continuationToken
        });

        pageCount++;
        findPlaylistIds(contData?.data);
        continuationToken = findContinuationToken(contData?.data);

        if (pageCount % 10 === 0) {
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (e) {
        break;
      }
    }

  } catch (e) {
    console.log(`   Browse endpoint error: ${e.message}`);
  }

  return playlistIds;
}

// ==================== MAIN FUNCTIONS ====================

async function getChannelInfo(channelIdentifier) {
  return executeWithInstance(async (youtube) => {
    let channelId = channelIdentifier;

    // Convert handle/URL to channel ID
    if (channelIdentifier.startsWith('@') || channelIdentifier.includes('youtube.com')) {
      if (channelIdentifier.includes('youtube.com')) {
        const handleMatch = channelIdentifier.match(/@([\w-]+)/);
        const channelMatch = channelIdentifier.match(/channel\/([\w-]+)/);
        channelIdentifier = handleMatch ? '@' + handleMatch[1] : (channelMatch ? channelMatch[1] : channelIdentifier);
      }

      if (channelIdentifier.startsWith('@')) {
        const search = await youtube.search(channelIdentifier.substring(1), { type: 'channel' });
        const channelResult = search.results.find(result => result.type === 'Channel');
        if (!channelResult?.author?.id) return { success: false, error: 'Channel not found' };
        channelId = channelResult.author.id;
      }
    }

    const channel = await youtube.getChannel(channelId);
    if (!channel) return { success: false, error: 'Channel not found' };

    const about = await channel.getAbout();

    // Parse subscriber count
    let subscriberCount = 'N/A';
    if (about.metadata?.subscriber_count) {
      const match = about.metadata.subscriber_count.match(/([\d.]+)\s*([KMB]?)/);
      if (match) {
        let count = parseFloat(match[1]);
        if (match[2] === 'K') count *= 1000;
        else if (match[2] === 'M') count *= 1000000;
        else if (match[2] === 'B') count *= 1000000000;
        subscriberCount = Math.round(count);
      }
    }

    // Parse video count
    let videoCount = 0;
    if (about.metadata?.video_count) {
      const match = about.metadata.video_count.match(/([\d,]+)/);
      if (match) videoCount = parseInt(match[1].replace(/,/g, ''));
    }

    // Extract channel thumbnail
    const thumbnails = channel.metadata?.thumbnail || 
                       channel.metadata?.avatar?.thumbnails || 
                       about.metadata?.avatar?.thumbnails || 
                       [];

    const thumbnail = thumbnails.length > 0 
      ? thumbnails[thumbnails.length - 1]?.url || thumbnails[thumbnails.length - 1] 
      : null;

    // Extract channel banner
    const bannerThumbnails = channel.metadata?.banner?.thumbnails || 
                              channel.header?.banner?.thumbnails ||
                              about.metadata?.banner?.thumbnails || 
                              [];

    const banner = bannerThumbnails.length > 0 
      ? bannerThumbnails[bannerThumbnails.length - 1]?.url || bannerThumbnails[bannerThumbnails.length - 1]
      : null;

    const mobileBannerThumbnails = channel.header?.mobile_banner?.thumbnails || [];
    const mobileBanner = mobileBannerThumbnails.length > 0
      ? mobileBannerThumbnails[mobileBannerThumbnails.length - 1]?.url
      : null;

    const tvBannerThumbnails = channel.header?.tv_banner?.thumbnails || [];
    const tvBanner = tvBannerThumbnails.length > 0
      ? tvBannerThumbnails[tvBannerThumbnails.length - 1]?.url
      : null;

    return {
      success: true,
      channel: {
        name: channel.metadata?.title || 'N/A',
        id: about.metadata?.channel_id || channel.metadata?.external_id || channelId,
        url: about.metadata?.canonical_channel_url || channel.metadata?.vanity_channel_url || `https://www.youtube.com/channel/${channelId}`,
        videoCount,
        subscriber_count: subscriberCount,
        description: about.metadata?.description || channel.metadata?.description || 'N/A',
        thumbnail: thumbnail || 'N/A',
        thumbnailAll: thumbnails.map(t => t?.url || t).filter(Boolean),
        banner: banner || 'N/A',
        bannerAll: bannerThumbnails.map(t => t?.url || t).filter(Boolean),
        mobileBanner: mobileBanner || 'N/A',
        tvBanner: tvBanner || 'N/A'
      }
    };
  });
}

async function getAllPlaylists(channelIdentifier) {
  return executeWithInstance(async (youtube) => {
    let channelId = channelIdentifier;

    if (channelIdentifier.startsWith('@') || channelIdentifier.includes('youtube.com')) {
      if (channelIdentifier.includes('youtube.com')) {
        const handleMatch = channelIdentifier.match(/@([\w-]+)/);
        const channelMatch = channelIdentifier.match(/channel\/([\w-]+)/);
        channelIdentifier = handleMatch ? '@' + handleMatch[1] : (channelMatch ? channelMatch[1] : channelIdentifier);
      }

      if (channelIdentifier.startsWith('@')) {
        const search = await youtube.search(channelIdentifier.substring(1), { type: 'channel' });
        const channelResult = search.results.find(result => result.type === 'Channel');
        if (!channelResult?.author?.id) return { success: false, error: 'Channel not found' };
        channelId = channelResult.author.id;
      }
    }

    const channel = await youtube.getChannel(channelId);
    if (!channel) return { success: false, error: 'Channel not found' };

    let playlistsData = await channel.getPlaylists();
    let playlistIds = [];

    const extractPlaylistIdsLocal = (data, isContinuation = false) => {
      const ids = [];
      let items;

      if (isContinuation) {
        items = data.contents?.contents || [];
      } else {
        const tabContents = data.current_tab?.content?.contents || [];
        items = [];

        for (const section of tabContents) {
          if (section.contents) {
            for (const gridContainer of section.contents) {
              if (gridContainer.type === 'Grid' && gridContainer.items) {
                items.push(...gridContainer.items);
              }
            }
          }
        }
      }

      for (const item of items) {
        if (item.content_id && item.content_type === 'PLAYLIST') {
          ids.push(item.content_id);
        }
      }

      return ids;
    };

    playlistIds = extractPlaylistIdsLocal(playlistsData, false);

    let pageCount = 1;
    while (playlistsData.has_continuation) {
      try {
        playlistsData = await playlistsData.getContinuation();
        const moreIds = extractPlaylistIdsLocal(playlistsData, true);

        if (moreIds.length > 0) {
          playlistIds.push(...moreIds);
        }

        pageCount++;

        if (pageCount > 100) {
          break;
        }
      } catch (e) {
        break;
      }
    }

    return {
      success: true,
      totalPlaylists: playlistIds.length,
      playlistIds: playlistIds
    };
  });
}

async function getChannelWithPlaylists(channelIdentifier) {
  return executeWithInstance(async (youtube) => {
    // Normalize identifier
    let normalizedIdentifier = channelIdentifier.trim();
    if (!normalizedIdentifier.startsWith('@') && 
        !normalizedIdentifier.includes('youtube.com') && 
        !normalizedIdentifier.startsWith('UC')) {
      normalizedIdentifier = '@' + normalizedIdentifier;
    }

    console.log(`🔍 Resolving channel: ${normalizedIdentifier}`);

    // Resolve channel ID
    const channelId = await resolveChannelId(youtube, normalizedIdentifier);
    if (!channelId) {
      return { success: false, error: 'Channel not found' };
    }

    console.log(`✅ Found channel ID: ${channelId}`);

    // Get channel
    const channel = await youtube.getChannel(channelId);
    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    // Get about info
    let about = null;
    try {
      about = await channel.getAbout();
    } catch (e) {
      console.log(`⚠️ Could not get about info: ${e.message}`);
    }

    // Extract channel thumbnail
    let thumbnail = null;
    if (channel.metadata?.thumbnail) {
      if (Array.isArray(channel.metadata.thumbnail)) {
        thumbnail = channel.metadata.thumbnail[channel.metadata.thumbnail.length - 1]?.url;
      } else if (channel.metadata.thumbnail.url) {
        thumbnail = channel.metadata.thumbnail.url;
      }
    } else if (channel.header?.author?.thumbnails) {
      const thumbnails = channel.header.author.thumbnails;
      thumbnail = thumbnails[thumbnails.length - 1]?.url;
    } else if (about?.metadata?.avatar) {
      if (Array.isArray(about.metadata.avatar)) {
        thumbnail = about.metadata.avatar[about.metadata.avatar.length - 1]?.url;
      } else if (about.metadata.avatar.url) {
        thumbnail = about.metadata.avatar.url;
      }
    }

    // Parse subscriber count
    let subscriberCount = 'N/A';
    if (about?.metadata?.subscriber_count) {
      const match = about.metadata.subscriber_count.match(/([\d.]+)\s*([KMB]?)/i);
      if (match) {
        let count = parseFloat(match[1]);
        const suffix = match[2].toUpperCase();
        if (suffix === 'K') count *= 1000;
        else if (suffix === 'M') count *= 1000000;
        else if (suffix === 'B') count *= 1000000000;
        subscriberCount = Math.round(count);
      }
    } else if (channel.metadata?.subscriber_count) {
      subscriberCount = channel.metadata.subscriber_count;
    }

    // Parse video count
    let videoCount = 0;
    if (about?.metadata?.video_count) {
      const match = about.metadata.video_count.match(/([\d,]+)/);
      if (match) videoCount = parseInt(match[1].replace(/,/g, ''));
    }

    // Get playlists
    let playlistIds = [];
    let playlistError = null;

    console.log(`\n📁 Fetching playlists...`);

    // Method 1: Try getPlaylists()
    try {
      let playlistsData = await channel.getPlaylists();
      playlistIds = extractPlaylistIds(playlistsData, false);
      console.log(`   Method 1 (getPlaylists): Found ${playlistIds.length} playlists`);

      let pageCount = 1;
      while (playlistsData.has_continuation && pageCount < 100) {
        try {
          playlistsData = await playlistsData.getContinuation();
          const moreIds = extractPlaylistIds(playlistsData, true);

          for (const id of moreIds) {
            if (!playlistIds.includes(id)) {
              playlistIds.push(id);
            }
          }

          pageCount++;

          if (pageCount % 10 === 0) {
            await new Promise(r => setTimeout(r, 200));
          }
        } catch (e) {
          break;
        }
      }

    } catch (e) {
      playlistError = e.message;
      console.log(`   Method 1 failed: ${e.message}`);
    }

    // Method 2: Try browse endpoint
    if (playlistIds.length < 5) {
      console.log(`   Trying browse endpoint...`);
      try {
        const browsePlaylistIds = await getPlaylistsViaBrowse(youtube, channelId);

        for (const id of browsePlaylistIds) {
          if (!playlistIds.includes(id)) {
            playlistIds.push(id);
          }
        }

        console.log(`   Method 2 (browse): Total ${playlistIds.length} playlists`);
      } catch (e) {
        console.log(`   Method 2 failed: ${e.message}`);
      }
    }

    console.log(`\n📊 Total playlists found: ${playlistIds.length}`);

    const channelName = channel.metadata?.title || 'N/A';
    const channelUrl = about?.metadata?.canonical_channel_url || 
                       channel.metadata?.vanity_channel_url || 
                       `https://www.youtube.com/channel/${channelId}`;
    const description = about?.metadata?.description || 
                        channel.metadata?.description || 
                        'N/A';

    return {
      success: true,
      channel: {
        name: channelName,
        id: about?.metadata?.channel_id || channel.metadata?.external_id || channelId,
        url: channelUrl,
        thumbnail: thumbnail || 'N/A',
        videoCount,
        subscriber_count: subscriberCount,
        description: description,
        totalPlaylists: playlistIds.length,
        playlistIds: playlistIds,
        playlistNote: playlistIds.length === 0 && playlistError 
          ? 'Could not fetch playlists - channel may have none or they may be private' 
          : null
      }
    };
  });
}

async function getPlaylist(playlistId) {
  // Check cache
  const cached = playlistCache.get(playlistId);
  if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_EXPIRY) {
    console.log(`✅ Cache hit: ${playlistId}`);
    return cached.data;
  }

  return executeWithInstance(async (youtube) => {
    console.log(`🔄 Fetching: ${playlistId}`);
    let playlist = await youtube.getPlaylist(playlistId);

    const allVideos = [];

    if (playlist.videos && playlist.videos.length > 0) {
      allVideos.push(...playlist.videos);
    }

    let pageCount = 1;
    while (playlist.has_continuation && pageCount < 200) {
      try {
        playlist = await playlist.getContinuation();
        if (playlist.videos && playlist.videos.length > 0) {
          allVideos.push(...playlist.videos);
        }
        pageCount++;
      } catch (error) {
        console.error(`Error on page ${pageCount + 1}:`, error.message);
        break;
      }
    }

    const videoData = {
      id: playlistId,
      title: playlist.info?.title || 'Playlist',
      description: playlist.info?.description || '',
      videoCount: allVideos.length,
      author: playlist.info?.author?.name || 'Unknown',
      videos: allVideos.map(v => ({
        id: v.id,
        title: v.title?.text || 'Unknown',
        img: v.thumbnails?.[0]?.url || '',
        duration: v.duration?.text || 'N/A',
        author: v.author?.name || 'Unknown'
      }))
    };

    // Cache the result
    playlistCache.set(playlistId, {
      data: videoData,
      timestamp: Date.now()
    });

    console.log(`✅ Cached ${videoData.videos.length} videos for "${videoData.title}"`);
    return videoData;
  });
}

async function getChannelHomePage(channelIdentifier) {
  return executeWithInstance(async (youtube) => {
    const channelId = await resolveChannelId(youtube, channelIdentifier);
    if (!channelId) return { success: false, error: 'Channel not found' };

    const channel = await youtube.getChannel(channelId);
    if (!channel) return { success: false, error: 'Channel not found' };

    let channelInfo = {
      name: channel.metadata?.title || 'N/A',
      id: channelId,
      url: channel.metadata?.vanity_channel_url || `https://www.youtube.com/channel/${channelId}`,
      thumbnail: null
    };

    if (channel.header?.author?.thumbnails) {
      const thumbnails = channel.header.author.thumbnails;
      channelInfo.thumbnail = thumbnails[thumbnails.length - 1]?.url;
    } else if (channel.metadata?.thumbnail) {
      if (Array.isArray(channel.metadata.thumbnail)) {
        channelInfo.thumbnail = channel.metadata.thumbnail[channel.metadata.thumbnail.length - 1]?.url;
      }
    }

    const sections = [];
    let contentSource = channel.current_tab?.content;

    const contents = contentSource?.contents || 
                    contentSource?.section_list?.contents ||
                    contentSource?.rich_grid?.contents ||
                    [];

    // Helper functions
    function getThumbnailUrl(item) {
      if (item.thumbnails && Array.isArray(item.thumbnails) && item.thumbnails.length > 0) {
        return item.thumbnails[item.thumbnails.length - 1]?.url || item.thumbnails[0]?.url;
      }
      if (item.thumbnail) {
        if (Array.isArray(item.thumbnail) && item.thumbnail.length > 0) {
          return item.thumbnail[item.thumbnail.length - 1]?.url || item.thumbnail[0]?.url;
        }
        if (item.thumbnail.url) {
          return item.thumbnail.url;
        }
        if (item.thumbnail.thumbnails && Array.isArray(item.thumbnail.thumbnails)) {
          return item.thumbnail.thumbnails[item.thumbnail.thumbnails.length - 1]?.url;
        }
      }
      if (item.author?.thumbnails && Array.isArray(item.author.thumbnails)) {
        return item.author.thumbnails[item.author.thumbnails.length - 1]?.url;
      }
      return null;
    }

    function getText(field) {
      if (!field) return null;
      if (typeof field === 'string') return field;
      if (field.text) return field.text;
      if (field.simpleText) return field.simpleText;
      if (field.runs && Array.isArray(field.runs)) {
        return field.runs.map(r => r.text).join('');
      }
      if (typeof field === 'object' && field.toString) {
        const str = field.toString();
        if (str !== '[object Object]') return str;
      }
      return null;
    }

    function processPostItem(item) {
      const type = item.type;

      if (type === 'BackstagePost' || type === 'Post' || type === 'SharedPost') {
        const postId = item.id || item.post_id;
        let content = getText(item.content) || getText(item.content_text) || null;
        let attachment = null;

        if (item.backstage_image || item.image) {
          const imgSource = item.backstage_image || item.image;
          attachment = {
            type: 'image',
            url: getThumbnailUrl(imgSource) || imgSource?.url
          };
        }

        if (item.video || item.backstage_attachment?.type === 'Video') {
          const video = item.video || item.backstage_attachment;
          attachment = {
            type: 'video',
            id: video.id,
            title: getText(video.title),
            thumbnail: getThumbnailUrl(video),
            url: `https://www.youtube.com/watch?v=${video.id}`
          };
        }

        if (item.poll || item.backstage_attachment?.type === 'Poll') {
          const poll = item.poll || item.backstage_attachment;
          attachment = {
            type: 'poll',
            choices: poll.choices?.map(c => getText(c.text) || getText(c)) || []
          };
        }

        if (item.backstage_image_gallery || item.image_gallery) {
          const gallery = item.backstage_image_gallery || item.image_gallery;
          attachment = {
            type: 'image_gallery',
            images: gallery.images?.map(img => getThumbnailUrl(img) || img?.url) || []
          };
        }

        return {
          type: 'post',
          id: postId,
          content: content,
          publishedTime: getText(item.published) || getText(item.published_time_text) || null,
          voteCount: getText(item.vote_count) || getText(item.likes) || null,
          commentCount: getText(item.comment_count) || getText(item.reply_count) || null,
          attachment: attachment,
          authorThumbnail: getThumbnailUrl(item.author) || item.author?.thumbnails?.[0]?.url || null,
          url: postId ? `https://www.youtube.com/post/${postId}` : null
        };
      }

      return null;
    }

    function processMediaItem(item) {
      let actualItem = item;
      if (item.type === 'RichItem' && item.content) {
        actualItem = item.content;
      }

      const type = actualItem.type;
      const thumbUrl = getThumbnailUrl(actualItem);

      if (type === 'BackstagePost' || type === 'Post' || type === 'SharedPost') {
        return processPostItem(actualItem);
      }

      if (type === 'Video' || type === 'GridVideo' || type === 'CompactVideo') {
        return {
          type: 'video',
          id: actualItem.id,
          title: getText(actualItem.title) || 'N/A',
          thumbnail: thumbUrl,
          duration: getText(actualItem.duration) || null,
          views: getText(actualItem.view_count) || getText(actualItem.short_view_count) || null,
          published: getText(actualItem.published) || null,
          url: `https://www.youtube.com/watch?v=${actualItem.id}`
        };
      } else if (type === 'Playlist' || type === 'GridPlaylist' || type === 'CompactPlaylist' || type === 'LockupView') {
        return {
          type: 'playlist',
          id: actualItem.id,
          title: getText(actualItem.title) || 'N/A',
          thumbnail: thumbUrl,
          videoCount: getText(actualItem.video_count) || actualItem.video_count || null,
          url: `https://www.youtube.com/playlist?list=${actualItem.id}`
        };
      } else if (type === 'ReelItem' || type === 'ShortsLockupView' || type === 'ShortsLockupViewModel') {
        const videoId = actualItem.id || actualItem.video_id || actualItem.entity_id;
        return {
          type: 'short',
          id: videoId,
          title: getText(actualItem.title) || actualItem.accessibility_text || 'N/A',
          thumbnail: thumbUrl,
          views: getText(actualItem.views) || null,
          url: `https://www.youtube.com/shorts/${videoId}`
        };
      } else if (type === 'Channel' || type === 'GridChannel' || type === 'ChannelCard') {
        const chId = actualItem.id || actualItem.channel_id || actualItem.endpoint?.browseEndpoint?.browseId;
        return {
          type: 'channel',
          id: chId,
          title: getText(actualItem.title) || getText(actualItem.author?.name) || actualItem.author?.name || 'N/A',
          thumbnail: thumbUrl,
          subscriberCount: getText(actualItem.subscriber_count) || getText(actualItem.subscribers) || getText(actualItem.video_count_text) || null,
          url: `https://www.youtube.com/channel/${chId}`
        };
      }

      return null;
    }

    function processChannelItem(item) {
      const type = item.type;

      if (type === 'Channel' || type === 'GridChannel' || type === 'ChannelCard' || type === 'CompactChannel') {
        const chId = item.id || item.channel_id || item.endpoint?.browseEndpoint?.browseId;
        const thumbUrl = getThumbnailUrl(item);

        return {
          type: 'channel',
          id: chId,
          title: getText(item.title) || getText(item.author?.name) || item.author?.name || 'N/A',
          thumbnail: thumbUrl,
          subscriberCount: getText(item.subscriber_count) || getText(item.subscribers) || getText(item.video_count_text) || null,
          description: getText(item.description_snippet) || getText(item.description) || null,
          url: `https://www.youtube.com/channel/${chId}`
        };
      }

      if (item.author || item.channel_id) {
        const chId = item.channel_id || item.id || item.author?.id;
        return {
          type: 'channel',
          id: chId,
          title: getText(item.title) || item.author?.name || 'N/A',
          thumbnail: getThumbnailUrl(item) || item.author?.thumbnails?.[0]?.url,
          subscriberCount: getText(item.subscriber_count) || null,
          url: `https://www.youtube.com/channel/${chId}`
        };
      }

      return null;
    }

    function extractShelfItems(shelf, shelfType = 'default') {
      const items = [];
      const sources = [
        shelf.content?.items,
        shelf.content?.contents,
        shelf.items,
        shelf.contents,
        shelf.content?.horizontal_list?.items,
        shelf.content?.expanded_shelf?.items,
        shelf.content?.post_thread?.post ? [shelf.content.post_thread.post] : null,
        shelf.posts
      ];

      const itemList = sources.find(s => Array.isArray(s) && s.length > 0) || [];

      for (const item of itemList) {
        let processed = null;

        if (shelfType === 'channel') {
          processed = processChannelItem(item) || processMediaItem(item);
        } else if (shelfType === 'post') {
          processed = processPostItem(item) || processMediaItem(item);
        } else {
          processed = processMediaItem(item);
        }

        if (processed && (processed.id || processed.content)) {
          items.push(processed);
        }
      }

      return items;
    }

    function getShelfType(title) {
      const lowerTitle = title.toLowerCase();
      if (lowerTitle.includes('channel') || lowerTitle.includes('subscribe')) {
        return 'channel';
      }
      if (lowerTitle.includes('post') || lowerTitle.includes('community')) {
        return 'post';
      }
      return 'default';
    }

    // Process sections
    for (const section of contents) {
      if (section.type === 'ItemSection') {
        const innerContents = section.contents || [];

        for (const innerItem of innerContents) {
          const innerType = innerItem.type;
          const shelfTitle = getText(innerItem.title) || '';
          const shelfType = getShelfType(shelfTitle);

          if (innerType === 'ChannelVideoPlayer') {
            sections.push({
              type: 'FeaturedVideo',
              title: 'Featured Video',
              items: [{
                type: 'featured_video',
                id: innerItem.id,
                title: getText(innerItem.title) || 'Featured Video',
                description: getText(innerItem.description) || null,
                url: `https://www.youtube.com/watch?v=${innerItem.id}`
              }]
            });
          } else if (innerType === 'Shelf') {
            const shelfData = {
              type: 'Shelf',
              title: shelfTitle,
              items: extractShelfItems(innerItem, shelfType)
            };
            if (shelfData.items.length > 0 || shelfData.title) {
              sections.push(shelfData);
            }
          } else if (innerType === 'ReelShelf') {
            const reelItems = innerItem.items || [];
            const shelfData = {
              type: 'ShortsShelf',
              title: getText(innerItem.title) || 'Shorts',
              items: []
            };

            for (const reel of reelItems) {
              const videoId = reel.id || reel.video_id || reel.entity_id;
              if (videoId) {
                shelfData.items.push({
                  type: 'short',
                  id: videoId,
                  title: getText(reel.title) || reel.accessibility_text || 'N/A',
                  thumbnail: getThumbnailUrl(reel),
                  views: getText(reel.views) || null,
                  url: `https://www.youtube.com/shorts/${videoId}`
                });
              }
            }

            if (shelfData.items.length > 0) {
              sections.push(shelfData);
            }
          } else if (innerType === 'VerticalList') {
            const listData = {
              type: 'VerticalList',
              title: getText(innerItem.header?.title) || '',
              items: []
            };

            const listItems = innerItem.items || innerItem.contents || [];
            for (const item of listItems) {
              const processed = processMediaItem(item);
              if (processed && processed.id) {
                listData.items.push(processed);
              }
            }

            if (listData.items.length > 0) {
              sections.push(listData);
            }
          } else if (innerType === 'HorizontalCardList') {
            const cardData = {
              type: 'HorizontalCardList',
              title: getText(innerItem.header?.title) || '',
              items: []
            };

            const cards = innerItem.cards || innerItem.items || [];
            for (const card of cards) {
              const processed = processChannelItem(card) || processMediaItem(card);
              if (processed && processed.id) {
                cardData.items.push(processed);
              }
            }

            if (cardData.items.length > 0) {
              sections.push(cardData);
            }
          } else if (innerType === 'RecognitionShelf') {
            sections.push({
              type: 'Recognition',
              title: getText(innerItem.title) || 'About',
              subtitle: getText(innerItem.subtitle) || null,
              items: []
            });
          } else if (innerType === 'ChannelFeaturedContent') {
            const featuredData = {
              type: 'FeaturedContent',
              title: getText(innerItem.title) || 'Featured',
              items: extractShelfItems(innerItem)
            };
            if (featuredData.items.length > 0) {
              sections.push(featuredData);
            }
          } else if (innerType === 'BackstagePost' || innerType === 'Post') {
            const post = processPostItem(innerItem);
            if (post) {
              let postsSection = sections.find(s => s.type === 'PostsShelf');
              if (!postsSection) {
                postsSection = {
                  type: 'PostsShelf',
                  title: 'Posts',
                  items: []
                };
                sections.push(postsSection);
              }
              postsSection.items.push(post);
            }
          } else {
            const postItems = [];
            const unknownItems = [];

            const itemSources = [
              innerItem.content?.items,
              innerItem.content?.contents,
              innerItem.items,
              innerItem.contents
            ];

            const itemList = itemSources.find(s => Array.isArray(s) && s.length > 0) || [];

            for (const subItem of itemList) {
              const postProcessed = processPostItem(subItem);
              if (postProcessed) {
                postItems.push(postProcessed);
              } else {
                const mediaProcessed = processMediaItem(subItem);
                if (mediaProcessed && mediaProcessed.id) {
                  unknownItems.push(mediaProcessed);
                }
              }
            }

            if (postItems.length > 0) {
              sections.push({
                type: 'PostsShelf',
                title: shelfTitle || 'Posts',
                items: postItems
              });
            } else if (unknownItems.length > 0) {
              sections.push({
                type: innerType || 'Unknown',
                title: shelfTitle || getText(innerItem.header?.title) || '',
                items: unknownItems
              });
            }
          }
        }
      } else if (section.type === 'RichSection') {
        const richContent = section.content;
        if (richContent?.type === 'RichShelf') {
          const shelfData = {
            type: 'RichShelf',
            title: getText(richContent.title) || '',
            items: []
          };

          const richItems = richContent.contents || [];
          for (const item of richItems) {
            const processed = processMediaItem(item);
            if (processed && processed.id) {
              shelfData.items.push(processed);
            }
          }

          if (shelfData.items.length > 0) {
            sections.push(shelfData);
          }
        }
      }
    }

    // Fallback RichGrid
    if (sections.length === 0 && contentSource?.type === 'RichGrid') {
      const richGridSection = {
        type: 'RichGrid',
        title: 'Videos',
        items: []
      };

      for (const item of (contentSource.contents || [])) {
        const processed = processMediaItem(item);
        if (processed && processed.id) {
          richGridSection.items.push(processed);
        }
      }

      if (richGridSection.items.length > 0) {
        sections.push(richGridSection);
      }
    }

    return {
      success: true,
      channel: channelInfo,
      featuredContent: {
        totalSections: sections.length,
        sections: sections
      }
    };
  });
}

// ==================== UTILITY FUNCTIONS ====================

// Get pool statistics (useful for monitoring)
function getPoolStats() {
  return {
    pool: instancePool.getStats(),
    semaphore: requestSemaphore.getStats(),
    cache: {
      playlists: playlistCache.size
    }
  };
}

// Pre-warm the pool (call on server startup)
async function warmupPool() {
  console.log('🚀 Warming up instance pool...');
  await instancePool.initialize();
  console.log('✅ Pool warmed up and ready');
  return getPoolStats();
}

// Clear playlist cache
function clearCache() {
  playlistCache.clear();
  console.log('🗑️ Cache cleared');
}


export { 
  getChannelWithPlaylists, 
  getPlaylist, 
  getChannelHomePage
};
