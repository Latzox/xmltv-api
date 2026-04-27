const express = require('express');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = process.env.PORT || 3001;
const EPG_URL = process.env.EPG_URL || 'http://epg:3000/guide.xml';
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS || '3600000'); // 1 hour default

let guideData = null;
let lastFetched = null;

// --- XML Parsing ---

async function fetchAndParseGuide() {
  console.log(`[${new Date().toISOString()}] Fetching guide from ${EPG_URL}...`);
  const response = await axios.get(EPG_URL, { timeout: 30000, responseType: 'text' });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '_',
    isArray: (name) => ['channel', 'programme'].includes(name),
    processEntities: false,
  });

  const parsed = parser.parse(response.data);
  const tv = parsed.tv;

  const channels = (tv.channel || []).map((ch) => ({
    id: ch._id,
    name: Array.isArray(ch['display-name'])
      ? ch['display-name'][0]?.['#text'] || ch['display-name'][0]
      : ch['display-name']?.['#text'] || ch['display-name'] || ch._id,
    icon: ch.icon?._src || null,
  }));

  const programmes = (tv.programme || []).map((p) => ({
    channelId: p._channel,
    start: parseXmltvDate(p._start),
    stop: parseXmltvDate(p._stop),
    title: p.title?.['#text'] || p.title || '',
    description: p.desc?.['#text'] || p.desc || null,
    category: p.category?.['#text'] || p.category || null,
    episode: p['episode-num']?.['#text'] || null,
    rating: p.rating?.value || null,
  }));

  guideData = { channels, programmes };
  lastFetched = new Date();
  console.log(`[${lastFetched.toISOString()}] Loaded ${channels.length} channels, ${programmes.length} programmes.`);
}

function parseXmltvDate(str) {
  // Format: 20250427183000 +0200
  if (!str) return null;
  const match = str.toString().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!match) return null;
  const [, year, month, day, hour, min, sec, tz] = match;
  const tzStr = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : '+00:00';
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}${tzStr}`);
}

function ensureLoaded(res) {
  if (!guideData) {
    res.status(503).json({ error: 'Guide not loaded yet. Try again in a moment.' });
    return false;
  }
  return true;
}

// --- Routes ---

// Health check + status
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    lastFetched: lastFetched?.toISOString() || null,
    channels: guideData?.channels.length || 0,
    programmes: guideData?.programmes.length || 0,
  });
});

// List all channels
app.get('/channels', (req, res) => {
  if (!ensureLoaded(res)) return;
  const { q } = req.query;
  let channels = guideData.channels;
  if (q) {
    const query = q.toLowerCase();
    channels = channels.filter((c) => c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query));
  }
  res.json({ count: channels.length, channels });
});

// What's on right now across all channels (or filtered)
app.get('/now', (req, res) => {
  if (!ensureLoaded(res)) return;
  const now = new Date();
  const { channel } = req.query;

  const channelMap = Object.fromEntries(guideData.channels.map((c) => [c.id, c.name]));

  let current = guideData.programmes.filter(
    (p) => p.start <= now && p.stop > now
  );

  if (channel) {
    const query = channel.toLowerCase();
    const matchingIds = guideData.channels
      .filter((c) => c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query))
      .map((c) => c.id);
    current = current.filter((p) => matchingIds.includes(p.channelId));
  }

  const result = current.map((p) => ({
    channel: channelMap[p.channelId] || p.channelId,
    channelId: p.channelId,
    title: p.title,
    description: p.description,
    category: p.category,
    start: p.start,
    stop: p.stop,
    minutesRemaining: Math.round((p.stop - now) / 60000),
  }));

  res.json({ time: now.toISOString(), count: result.length, programmes: result });
});

// What's on next (upcoming within N hours)
app.get('/next', (req, res) => {
  if (!ensureLoaded(res)) return;
  const now = new Date();
  const hours = Math.min(parseInt(req.query.hours || '2'), 24);
  const cutoff = new Date(now.getTime() + hours * 3600000);
  const { channel } = req.query;

  const channelMap = Object.fromEntries(guideData.channels.map((c) => [c.id, c.name]));

  let upcoming = guideData.programmes.filter(
    (p) => p.start > now && p.start <= cutoff
  );

  if (channel) {
    const query = channel.toLowerCase();
    const matchingIds = guideData.channels
      .filter((c) => c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query))
      .map((c) => c.id);
    upcoming = upcoming.filter((p) => matchingIds.includes(p.channelId));
  }

  const result = upcoming
    .sort((a, b) => a.start - b.start)
    .map((p) => ({
      channel: channelMap[p.channelId] || p.channelId,
      channelId: p.channelId,
      title: p.title,
      description: p.description,
      category: p.category,
      start: p.start,
      stop: p.stop,
      startsInMinutes: Math.round((p.start - now) / 60000),
    }));

  res.json({ time: now.toISOString(), hours, count: result.length, programmes: result });
});

// Schedule for a specific channel (today or by date)
app.get('/channel/:id', (req, res) => {
  if (!ensureLoaded(res)) return;
  const channelId = req.params.id;
  const dateParam = req.query.date; // YYYY-MM-DD or 'today'

  const channel = guideData.channels.find(
    (c) => c.id === channelId || c.name.toLowerCase() === channelId.toLowerCase()
  );

  if (!channel) {
    return res.status(404).json({ error: `Channel '${channelId}' not found.` });
  }

  let startOfDay, endOfDay;
  if (dateParam && dateParam !== 'today') {
    startOfDay = new Date(`${dateParam}T00:00:00`);
    endOfDay = new Date(`${dateParam}T23:59:59`);
  } else {
    const now = new Date();
    startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  }

  const programmes = guideData.programmes
    .filter((p) => p.channelId === channel.id && p.start >= startOfDay && p.start <= endOfDay)
    .sort((a, b) => a.start - b.start)
    .map((p) => ({
      title: p.title,
      description: p.description,
      category: p.category,
      start: p.start,
      stop: p.stop,
      episode: p.episode,
      rating: p.rating,
    }));

  res.json({
    channel: channel.name,
    channelId: channel.id,
    date: startOfDay.toISOString().split('T')[0],
    count: programmes.length,
    programmes,
  });
});

// Search programmes by title or description
app.get('/search', (req, res) => {
  if (!ensureLoaded(res)) return;
  const { q, category, date } = req.query;

  if (!q && !category) {
    return res.status(400).json({ error: 'Provide at least ?q= or ?category=' });
  }

  const channelMap = Object.fromEntries(guideData.channels.map((c) => [c.id, c.name]));
  const now = new Date();

  let results = guideData.programmes.filter((p) => p.start > now); // only future/current

  if (q) {
    const query = q.toLowerCase();
    results = results.filter(
      (p) =>
        p.title.toLowerCase().includes(query) ||
        (p.description && p.description.toLowerCase().includes(query))
    );
  }

  if (category) {
    const cat = category.toLowerCase();
    results = results.filter((p) => p.category && p.category.toLowerCase().includes(cat));
  }

  if (date) {
    const startOfDay = new Date(`${date}T00:00:00`);
    const endOfDay = new Date(`${date}T23:59:59`);
    results = results.filter((p) => p.start >= startOfDay && p.start <= endOfDay);
  }

  const mapped = results
    .sort((a, b) => a.start - b.start)
    .slice(0, 100) // cap at 100 results
    .map((p) => ({
      channel: channelMap[p.channelId] || p.channelId,
      channelId: p.channelId,
      title: p.title,
      description: p.description,
      category: p.category,
      start: p.start,
      stop: p.stop,
    }));

  res.json({ query: q || null, category: category || null, count: mapped.length, programmes: mapped });
});

// Force refresh
app.post('/refresh', async (req, res) => {
  try {
    await fetchAndParseGuide();
    res.json({ status: 'ok', lastFetched: lastFetched.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Startup ---

async function start() {
  try {
    await fetchAndParseGuide();
  } catch (err) {
    console.error('Initial fetch failed:', err.message, '— will retry in 60s');
    setTimeout(async () => {
      try { await fetchAndParseGuide(); } catch (e) { console.error('Retry failed:', e.message); }
    }, 60000);
  }

  // Refresh on interval
  setInterval(async () => {
    try { await fetchAndParseGuide(); } catch (err) { console.error('Refresh failed:', err.message); }
  }, REFRESH_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`EPG API running on port ${PORT}`);
    console.log(`Endpoints: /health /channels /now /next /channel/:id /search`);
  });
}

start();