const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = 3456;
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('读取配置文件失败:', e.message);
  }
  return {};
}
const CONFIG = loadConfig();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      return {
        unsorted: data.unsorted || { songs: [] },
        playlists: data.playlists || [],
        ktvs: data.ktvs || [],
      };
    }
  } catch (e) {
    console.error('读取数据文件失败:', e.message);
  }
  return { unsorted: { songs: [] }, playlists: [], ktvs: [] };
}

function writeStore(store) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    console.error('写入数据文件失败:', e.message);
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': u.protocol === 'https:' ? 'https://y.qq.com/' : 'https://music.163.com/',
      },
      timeout: 10000,
    };
    const req = mod.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

function httpGetRedirect(fullUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000,
      maxRedirects: 0,
    };
    const req = mod.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const resolved = loc.startsWith('http') ? loc : (u.protocol + '//' + u.hostname + (loc.startsWith('/') ? '' : '/') + loc);
        resolve(resolved);
      } else {
        resolve(fullUrl);
      }
    });
    req.on('error', () => resolve(fullUrl));
    req.on('timeout', () => { req.destroy(); resolve(fullUrl); });
    req.end();
  });
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : text.trim();
}

function normalizeNetEase(songs) {
  return (songs || []).map((s) => ({
    id: 'ne_' + s.id,
    name: s.name || '',
    artist: (s.artists || []).map((a) => a.name).join(' / '),
    album: (s.album && s.album.name) || '',
    durationSec: Math.round((s.duration || 0) / 1000),
    source: 'netease',
  }));
}

function normalizeQQ(songs) {
  return (songs || []).map((s) => {
    let album = s.albumname || s.album || '';
    if (typeof album === 'object') album = album.name || album.title || '';
    return {
    id: 'qq_' + (s.songid || s.songmid || s.id || s.mid),
    name: s.songname || s.name || '',
    artist: (s.singer || []).map((a) => a.name).join(' / '),
    album,
    durationSec: parseInt(s.interval) || 0,
    source: 'qq',
  }});
}

function scoreRelevance(song, rawQuery) {
  const terms = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const name = (song.name || '').toLowerCase();
  const artist = (song.artist || '').toLowerCase();
  const album = (song.album || '').toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (name === t) score += 50;
    else if (name.startsWith(t)) score += 35;
    else if (name.includes(t)) score += 22;
    if (artist === t) score += 30;
    else if (artist.includes(t)) score += 12;
    if (album === t) score += 18;
    else if (album.includes(t)) score += 6;
  }
  const fieldsHit = [name, artist, album].filter(f => terms.some(t => f.includes(t))).length;
  score += fieldsHit * 10;
  return score;
}

function sortByRelevance(songs, rawQuery) {
  return songs
    .map(s => ({ ...s, _score: scoreRelevance(s, rawQuery) }))
    .sort((a, b) => b._score - a._score);
}

app.get('/api/search', async (req, res) => {
  const { q, source } = req.query;
  if (!q || !q.trim()) {
    return res.json({ error: '请输入歌曲名' });
  }
  const rawQuery = q.trim();
  const keyword = encodeURIComponent(rawQuery);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
  try {
    if (source === 'qq') {
      const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${keyword}&format=json&n=${limit}&p=${page}`;
      const data = await httpGet(url);
      const list = (data && data.data && data.data.song && data.data.song.list) || [];
      const total = (data && data.data && data.data.song && data.data.song.totalnum) || 0;
      res.json({
        songs: sortByRelevance(normalizeQQ(list), rawQuery),
        source: 'qq', page, limit, total,
        hasMore: (page * limit) < total
      });
    } else {
      const offset = (page - 1) * limit;
      const url = `https://music.163.com/api/search/get?s=${keyword}&type=1&limit=${limit}&offset=${offset}`;
      const data = await httpGet(url);
      if (data.code !== 200) {
        return res.json({ error: '搜索失败，请重试', songs: [] });
      }
      const list = (data.result && data.result.songs) || [];
      const total = (data.result && data.result.songCount) || 0;
      res.json({
        songs: sortByRelevance(normalizeNetEase(list), rawQuery),
        source: 'netease', page, limit, total,
        hasMore: (page * limit) < total
      });
    }
  } catch (e) {
    res.json({ error: '搜索请求失败: ' + e.message, songs: [] });
  }
});

app.post('/api/search/batch', async (req, res) => {
  const { keywords } = req.body;
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return res.json({ error: '请提供歌曲名列表' });
  }
  const sources = ['netease', 'qq'];
  const results = {};
  for (const kw of keywords.slice(0, 50)) {
    if (!kw || !kw.trim()) continue;
    const name = kw.trim();
    results[name] = { netease: [], qq: [], error: null };
    for (const src of sources) {
      try {
        const keyword = encodeURIComponent(name);
        if (src === 'qq') {
          const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${keyword}&format=json&n=5&p=1`;
          const data = await httpGet(url);
          const list = (data && data.data && data.data.song && data.data.song.list) || [];
           results[name].qq = sortByRelevance(normalizeQQ(list), name);
         } else {
           const url = `https://music.163.com/api/search/get?s=${keyword}&type=1&limit=5`;
           const data = await httpGet(url);
           if (data.code === 200) {
             const list = (data.result && data.result.songs) || [];
             results[name].netease = sortByRelevance(normalizeNetEase(list), name);
          }
        }
      } catch (e) {
        results[name].error = e.message;
      }
    }
  }
  res.json({ results });
});

app.get('/api/playlist/import', async (req, res) => {
  const { url, source } = req.query;
  if (!url || !url.trim()) return res.json({ error: '请输入歌单链接' });
  let rawUrl = extractUrl(url.trim());

  // Resolve short links (163cn.tv etc.)
  const shortDomains = ['163cn.tv', '163cn.cn', 'c6.y.qq.com'];
  try {
    if (shortDomains.some(d => rawUrl.includes(d))) {
      rawUrl = await httpGetRedirect(rawUrl);
    }
    // Follow any additional redirect chain (NetEase might redirect twice)
    if (rawUrl.includes('163cn.tv') || rawUrl.includes('163cn.cn')) {
      rawUrl = await httpGetRedirect(rawUrl);
    }
  } catch (e) {}

  let id = '';
  if (source === 'qq') {
    const m = rawUrl.match(/playlist\/(\d+)/) || rawUrl.match(/[?&]id=(\d+)/) || rawUrl.match(/^(\d+)$/);
    id = m ? m[1] : '';
  } else {
    const m = rawUrl.match(/[?&]id=(\d+)/) || rawUrl.match(/playlist\/(\d+)/) || rawUrl.match(/^(\d+)$/);
    id = m ? m[1] : '';
  }
  if (!id) return res.json({ error: '无法识别歌单链接，可尝试直接粘贴歌单ID' });
  try {
    if (source === 'qq') {
      const apiUrl = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?id=${id}&format=json&type=1&newsong=1`;
      const data = await httpGet(apiUrl);
      if (data.code !== 0) return res.json({ error: '获取QQ歌单失败: ' + (data.msg || '') });
      const cd = (data.data && data.data.cdlist && data.data.cdlist[0]) || {};
      const songs = normalizeQQ(cd.songlist || []);
      res.json({ name: cd.dissname || '', songs, source: 'qq' });
    } else {
      const apiUrl = `https://music.163.com/api/playlist/detail?id=${id}`;
      const data = await httpGet(apiUrl);
      if (data.code !== 200) return res.json({ error: '获取失败，请确认歌单为公开歌单（网易云需在歌单设置中设为公开）' });
      const pl = data.result || {};
      const tracks = (pl.tracks || []).map(t => ({
        id: 'ne_' + t.id,
        name: t.name || '',
        artist: (t.artists || []).map(a => a.name).join(' / '),
        album: (t.album && t.album.name) || '',
        durationSec: Math.round((t.duration || 0) / 1000),
        source: 'netease',
      }));
      res.json({ name: pl.name || '', songs: tracks, source: 'netease' });
    }
  } catch (e) {
    res.json({ error: '导入失败: ' + e.message, songs: [] });
  }
});

app.get('/api/playlists', (req, res) => {
  const store = readStore();
  res.json({ playlists: store.playlists.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, songCount: (p.songs || []).length })) });
});

app.get('/api/playlists/:id', (req, res) => {
  const store = readStore();
  const pl = store.playlists.find((p) => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: '歌单不存在' });
  res.json(pl);
});

app.post('/api/playlists', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.json({ error: '歌单名称不能为空' });
  const store = readStore();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pl = { id, name: name.trim(), createdAt: new Date().toISOString(), songs: [] };
  store.playlists.push(pl);
  writeStore(store);
  res.json(pl);
});

app.put('/api/playlists/:id', (req, res) => {
  const store = readStore();
  const idx = store.playlists.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '歌单不存在' });
  const pl = store.playlists[idx];
  const { name, songs, action, songIds } = req.body;

  if (name !== undefined) pl.name = name.trim();

  if (action === 'add' && Array.isArray(songs)) {
    for (const s of songs) {
      const song = {
        id: s.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        name: s.name,
        artist: s.artist || '',
        album: s.album || '',
        durationSec: parseInt(s.durationSec) || 0,
        source: s.source || 'unknown',
        wantLevel: 1,
        addedAt: new Date().toISOString(),
      };
      const dup = pl.songs.find((x) => x.name === song.name && x.artist === song.artist);
      if (!dup) pl.songs.push(song);
    }
  }

  if (action === 'remove' && Array.isArray(songIds)) {
    pl.songs = pl.songs.filter((s) => !songIds.includes(s.id));
  }

  if (action === 'updateLevel' && req.body.songId && req.body.wantLevel !== undefined) {
    const s = pl.songs.find((x) => x.id === req.body.songId);
    if (s) s.wantLevel = Math.max(1, Math.min(5, parseInt(req.body.wantLevel) || 1));
  }

  if (action === 'sort') {
    const { by } = req.body;
    if (by === 'level') pl.songs.sort((a, b) => (b.wantLevel || 1) - (a.wantLevel || 1));
    if (by === 'name') pl.songs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    if (by === 'duration') pl.songs.sort((a, b) => a.durationSec - b.durationSec);
  }

  if (action === 'reorder' && Array.isArray(req.body.songIds)) {
    const orderMap = {};
    req.body.songIds.forEach((id, i) => { orderMap[id] = i; });
    pl.songs.sort((a, b) => ((orderMap[a.id] ?? 9999) - (orderMap[b.id] ?? 9999)));
  }

  store.playlists[idx] = pl;
  writeStore(store);
  res.json(pl);
});

app.delete('/api/playlists/:id', (req, res) => {
  const store = readStore();
  store.playlists = store.playlists.filter((p) => p.id !== req.params.id);
  writeStore(store);
  res.json({ ok: true });
});

app.get('/api/unsorted', (req, res) => {
  const store = readStore();
  res.json(store.unsorted);
});

app.put('/api/unsorted', (req, res) => {
  const store = readStore();
  const { action, songs, songIds } = req.body;
  if (action === 'set' && Array.isArray(songs)) {
    store.unsorted.songs = songs;
  } else if (action === 'add' && Array.isArray(songs)) {
    for (const s of songs) {
      const dup = store.unsorted.songs.find((x) => x.name === s.name && x.artist === s.artist);
      if (!dup) store.unsorted.songs.push(s);
    }
  } else if (action === 'remove' && Array.isArray(songIds)) {
    store.unsorted.songs = store.unsorted.songs.filter((s) => !songIds.includes(s.id));
  }
  writeStore(store);
  res.json(store.unsorted);
});

app.post('/api/unsorted/add-to-playlist', (req, res) => {
  const store = readStore();
  const { songIds, playlistId } = req.body;
  if (!Array.isArray(songIds) || !playlistId) return res.json({ error: '参数错误' });
  const pl = store.playlists.find((p) => p.id === playlistId);
  if (!pl) return res.status(404).json({ error: '歌单不存在' });
  const added = [];
  const remaining = [];
  for (const sid of songIds) {
    const idx = store.unsorted.songs.findIndex((s) => s.id === sid);
    if (idx === -1) continue;
    const song = store.unsorted.songs[idx];
    const dup = pl.songs.find((x) => x.name === song.name && x.artist === song.artist);
    if (!dup) {
      pl.songs.push({ ...song, wantLevel: song.wantLevel || 1, addedAt: new Date().toISOString() });
    }
    added.push(sid);
  }
  store.unsorted.songs = store.unsorted.songs.filter((s) => !added.includes(s.id));
  writeStore(store);
  res.json({ ok: true, added });
});

app.get('/api/export', (req, res) => {
  const store = readStore();
  const { playlistId, format, ktvId } = req.query;
  let songs = [];

  if (playlistId) {
    const pl = store.playlists.find((p) => p.id === playlistId);
    if (pl) songs = (pl.songs || []).map(s => ({ ...s, _plId: playlistId }));
  } else {
    for (const pl of store.playlists) {
      songs = songs.concat((pl.songs || []).map(s => ({ ...s, _plId: pl.id })));
    }
  }

  const level = parseInt(req.query.level);
  if (level >= 1 && level <= 5) {
    songs = songs.filter((s) => s.wantLevel === level);
  }

  if (ktvId) {
    const ktv = store.ktvs.find((k) => k.id === ktvId);
    if (ktv) {
      songs = songs.filter((s) => {
        const avail = (ktv.availability && ktv.availability[s._plId]) || {};
        return avail[s.id] !== false;
      });
    }
  }

  if (format === 'csv') {
    const header = '歌名,歌手,专辑,时长(秒),时长(格式),平台,想唱等级';
    const rows = songs.map((s) =>
      `"${s.name}","${s.artist}","${s.album || ''}",${s.durationSec},"${fmtDuration(s.durationSec)}",${s.source},${s.wantLevel || 1}`
    );
    const csv = '\uFEFF' + header + '\n' + rows.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=songs.csv');
    return res.send(csv);
  }

  const totalSec = songs.reduce((sum, s) => sum + s.durationSec, 0);
  const lines = songs.map(
    (s, i) => `${i + 1}. ${s.name} - ${s.artist}  ${fmtDuration(s.durationSec)}  [${'★'.repeat(s.wantLevel || 1)}]`
  );
  const text = lines.join('\n') + `\n\n总计: ${songs.length} 首, ${fmtDuration(totalSec)}`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(text);
});

// --- KTV ---
app.get('/api/ktv/search', async (req, res) => {
  const { city, keywords } = req.query;
  const ak = CONFIG.baiduAk;
  if (!ak || ak === 'YOUR_BAIDU_AK_HERE') {
    return res.json({ error: '请先在 config.json 中配置百度地图 AK' });
  }
  if (!keywords || !keywords.trim()) {
    return res.json({ error: '请输入关键词' });
  }
  const query = encodeURIComponent(keywords.trim() + ' KTV');
  const region = encodeURIComponent(city || '全国');
  const page = Math.max(0, parseInt(req.query.page) || 0);
  const pageSize = Math.min(20, Math.max(5, parseInt(req.query.limit) || 20));
  const url = `https://api.map.baidu.com/place/v2/search?query=${query}&region=${region}&output=json&ak=${ak}&page_size=${pageSize}&page_num=${page}&scope=2`;
  try {
    const data = await httpGet(url);
    if (data.status !== 0) {
      return res.json({ error: '搜索失败: ' + (data.message || '未知错误'), ktvs: [] });
    }
    const list = (data.results || []).map(r => ({
      id: 'bd_' + r.uid,
      name: r.name || '',
      address: r.address || '',
      lat: (r.location && r.location.lat) || 0,
      lng: (r.location && r.location.lng) || 0,
      phone: r.telephone || '',
      rating: (r.detail_info && r.detail_info.overall_rating) || '',
      baiduUid: r.uid,
    }));
    const total = data.total || list.length;
    res.json({ ktvs: list, total, page, hasMore: ((page + 1) * pageSize) < total });
  } catch (e) {
    res.json({ error: '搜索请求失败: ' + e.message, ktvs: [] });
  }
});

app.get('/api/ktv', (req, res) => {
  const store = readStore();
  res.json({ ktvs: store.ktvs });
});

app.post('/api/ktv', (req, res) => {
  const { name, address, lat, lng, phone, rating, baiduUid, source } = req.body;
  if (!name || !name.trim()) return res.json({ error: 'KTV 名称不能为空' });
  const store = readStore();
  const id = 'ktv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ktv = {
    id, name: name.trim(), address: address || '', lat: lat || 0, lng: lng || 0,
    phone: phone || '', rating: rating || '', baiduUid: baiduUid || '', source: source || 'manual',
    availability: {}
  };
  const dup = store.ktvs.find(k => k.baiduUid && baiduUid && k.baiduUid === baiduUid);
  if (dup) {
    dup.name = ktv.name;
    dup.address = ktv.address;
    dup.lat = ktv.lat;
    dup.lng = ktv.lng;
    dup.phone = ktv.phone;
    store.ktvs = store.ktvs.map(k => k.id === dup.id ? dup : k);
    writeStore(store);
    return res.json(dup);
  }
  store.ktvs.push(ktv);
  writeStore(store);
  res.json(ktv);
});

app.delete('/api/ktv/:id', (req, res) => {
  const store = readStore();
  store.ktvs = store.ktvs.filter(k => k.id !== req.params.id);
  writeStore(store);
  res.json({ ok: true });
});

app.put('/api/ktv/:id/availability', (req, res) => {
  const store = readStore();
  const ktv = store.ktvs.find(k => k.id === req.params.id);
  if (!ktv) return res.status(404).json({ error: 'KTV 不存在' });
  const { playlistId, songId, available } = req.body;
  if (!playlistId || !songId) return res.json({ error: '参数不完整' });
  if (!ktv.availability) ktv.availability = {};
  if (!ktv.availability[playlistId]) ktv.availability[playlistId] = {};
  if (available === false) {
    ktv.availability[playlistId][songId] = false;
  } else {
    delete ktv.availability[playlistId][songId];
  }
  writeStore(store);
  res.json(ktv);
});

app.put('/api/ktv/:id/sung', (req, res) => {
  const store = readStore();
  const ktv = store.ktvs.find(k => k.id === req.params.id);
  if (!ktv) return res.status(404).json({ error: 'KTV 不存在' });
  const { songId, decrement } = req.body;
  if (!songId) return res.json({ error: '参数不完整' });
  if (!ktv.songHistory) ktv.songHistory = {};

  let entry = ktv.songHistory[songId];
  // Migrate old format { count, lastSung } → { records: [...] }
  if (entry && typeof entry.count !== 'undefined') {
    const old = entry;
    entry = { records: [] };
    for (let i = 0; i < (old.count || 0); i++) {
      entry.records.push(old.lastSung || new Date().toISOString());
    }
  }
  if (!entry || !entry.records) {
    entry = { records: [] };
  }

  if (decrement) {
    if (entry.records.length > 0) entry.records.pop();
  } else {
    entry.records.push(new Date().toISOString());
  }

  ktv.songHistory[songId] = entry;
  writeStore(store);
  res.json(ktv);
});

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

app.post('/api/reset', (req, res) => {
  writeStore({ unsorted: { songs: [] }, playlists: [], ktvs: [] });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
  if (!fs.existsSync(DATA_FILE)) {
    writeStore({ unsorted: { songs: [] }, playlists: [], ktvs: [] });
    console.log('已初始化数据文件');
  }
});
