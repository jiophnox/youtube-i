async function resolveChannelId(youtube, channelIdentifier) {
  let channelId = channelIdentifier;

  if (channelIdentifier.startsWith('@') || channelIdentifier.includes('youtube.com')) {
    if (channelIdentifier.includes('youtube.com')) {
      const handleMatch = channelIdentifier.match(/@([\w-]+)/);
      const channelMatch = channelIdentifier.match(/channel\/([\w-]+)/);
      channelIdentifier = handleMatch ? '@' + handleMatch[1] : (channelMatch ? channelMatch[1] : channelIdentifier);
    }

    if (channelIdentifier.startsWith('@')) {
      // Try resolveURL first
      try {
        const resolved = await youtube.resolveURL(`https://www.youtube.com/${channelIdentifier}`);
        if (resolved?.payload?.browseId) {
          return resolved.payload.browseId;
        }
      } catch (e) {
        // Fall back to search
      }

      const search = await youtube.search(channelIdentifier.substring(1), { type: 'channel' });
      const channelResult = search.results.find(result => result.type === 'Channel');
      if (!channelResult?.author?.id) return null;
      channelId = channelResult.author.id;
    }
  }

  return channelId;
}

export  { resolveChannelId };
