const songList = document.querySelector('#songList'), albumGrid = document.querySelector('#albumGrid');
const playlistGrid = document.querySelector('#playlistGrid'), plSongList = document.querySelector('#plSongList');
const selectBar = document.querySelector('#selectBar'), selectCount = document.querySelector('#selectCount'), selectToggle = document.querySelector('#selectToggle');
const playlistPicker = document.querySelector('#playlistPicker'), ppList = document.querySelector('#ppList'), ppNewName = document.querySelector('#ppNewName'), ppEmpty = document.querySelector('#ppEmpty');
const cdAlbumGrid = document.querySelector('#cdAlbumGrid'), cdTrackList = document.querySelector('#cdTrackList');
const cdMediaPath = document.querySelector('#cdMediaPath'), cdScanButton = document.querySelector('#cdScanButton'), cdScanStatus = document.querySelector('#cdScanStatus');
const transcodeToggle = document.querySelector('#transcodeToggle'), transcodeOptions = document.querySelector('#transcodeOptions'), transcodeFormat = document.querySelector('#transcodeFormat'), transcodeBitrate = document.querySelector('#transcodeBitrate');
const transcodeCacheDir = document.querySelector('#transcodeCacheDir'), transcodeCacheSize = document.querySelector('#transcodeCacheSize'), transcodeCacheInfo = document.querySelector('#transcodeCacheInfo'), transcodeCacheClear = document.querySelector('#transcodeCacheClear');
const cdDetailCover = document.querySelector('#cdDetailCover'), cdDetailTitle = document.querySelector('#cdDetailTitle'), cdDetailArtist = document.querySelector('#cdDetailArtist'), cdDetailTags = document.querySelector('#cdDetailTags'), cdDetailDesc = document.querySelector('#cdDetailDesc');
const songCount = document.querySelector('#songCount'), albumCount = document.querySelector('#albumCount');
const mediaPath = document.querySelector('#mediaPath'), scanButton = document.querySelector('#scanButton'), scanStatus = document.querySelector('#scanStatus');
const audio = new Audio();
let library = {tracks: [], albums: []}, favoriteIds = [], activeSection = 'library', activeTracks = [];
// 播放队列与视图列表解耦：视图切换不再影响正在播放的上一首/下一首
let playQueue = [], playIndex = -1;
let playlists = [], activePlaylist = null, selectMode = false, selectedIds = new Set();
let cdLibrary = {albums: []}, activeCdAlbum = null;
let transcodeConfig = {enabled: false, format: 'aac', bitrate: 128, cacheDir: '', cacheSizeGB: 2};
// 转码设置未保存的暂存改动（OpenWrt 风格：点"保存并应用"才生效，关闭面板即放弃）
let pendingTranscode = null;
let shuffleOn = false, lyricUserScroll = 0, lyricAutoScroll = false, lyricItems = [], activeLyricIndex = -1;
let activeAlbum = null, nowPlayingTrack = null;
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const ICON_PREV = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
const ICON_SHUFFLE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>';

function duration(seconds = 0) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function isFavorite(track) { return favoriteIds.includes(track.id); }
function art(track, className) { return track?.hasCover ? `<div class="${className} cover-art" data-cover="${encodeURIComponent(track.path)}"></div>` : `<div class="${className} empty-cover">♫</div>`; }
let coverObserver = null;
function initCoverObserver() {
  if (coverObserver) return;
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.cover-art[data-cover]').forEach(loadCover);
    coverObserver = {};
    return;
  }
  coverObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) { loadCover(entry.target); coverObserver.unobserve(entry.target); }
    });
  }, {rootMargin: '300px'});
}
function loadCover(el) {
  const id = el.dataset.cover;
  if (!id || el.style.backgroundImage) return;
  // data-cover 可能是完整 /api/ 路径（如 CD 封面），也可能是媒体库曲目路径
  el.style.backgroundImage = id.startsWith('/api/') ? `url('${id}')` : `url('/api/cover?id=${id}')`;
  delete el.dataset.cover;
}
function observeCovers(container) {
  initCoverObserver();
  if (!coverObserver || !coverObserver.observe) return;
  container.querySelectorAll('.cover-art[data-cover]').forEach(el => coverObserver.observe(el));
}
function columnLabelsHtml() { return '<div class="column-labels"><span>歌曲</span><span>专辑</span><span>时长</span></div>'; }
function isPlayingTrack(track) { return !!nowPlayingTrack && !!track && track.id === nowPlayingTrack.id; }
function rowTemplate(track, index, opts = {}) { const check = opts.selectable ? `<div class="select-cell"><input type="checkbox" class="row-check" ${selectedIds.has(track.id) ? 'checked' : ''} aria-label="选择"></div>` : ''; const remove = opts.removable ? `<button class="pl-remove" data-remove-id="${encodeURIComponent(track.id)}" type="button" title="从歌单移除" aria-label="从歌单移除">×</button>` : ''; const addBtn = opts.removable ? '' : `<button class="add-button" data-add-id="${encodeURIComponent(track.id)}" type="button" title="加入歌单" aria-label="加入歌单">＋</button>`; return `<article class="song-row ${isPlayingTrack(track) ? 'selected' : ''} ${opts.selectable ? 'selectable' : ''}" data-index="${index}">${check}<div class="song-main">${art(track, 'cover')}<div><div class="song-name">${escapeHtml(track.title)}</div><div class="artist">${escapeHtml(track.artist)}</div></div></div><div class="album-name">${escapeHtml(track.album)}</div><div class="duration-cell"><span>${duration(track.duration)}</span>${remove}${addBtn}<button class="favorite-button ${isFavorite(track) ? 'is-favorite' : ''}" data-favorite-id="${encodeURIComponent(track.id)}" type="button" aria-label="${isFavorite(track) ? '取消收藏' : '收藏'}">${isFavorite(track) ? '♥' : '♡'}</button></div></article>`; }
function emptyLibraryHtml() { return `<div class="empty-library"><div><strong>${activeSection === 'favorites' ? '暂无收藏' : '暂无歌曲'}</strong><span>${activeSection === 'favorites' ? '点击歌曲右侧的爱心，即可将它收藏到这里' : '填写媒体库路径并开始扫描后，歌曲将在这里显示'}</span></div></div>`; }
// ---- 虚拟滚动：只渲染可视窗口内的行，spacer 撑起总高度 ----
let virtualRowHeight = 0, virtualCount = 0, virtualRaf = 0;
const VIRTUAL_BUFFER = 6;
function measureVirtual() {
  const row = songList.querySelector('.song-row');
  virtualRowHeight = row ? row.offsetHeight : 84;
  virtualCount = activeTracks.length;
}
function rowOpts() { return { selectable: selectMode }; }
function updateVirtual() {
  if (!virtualCount) return;
  const scrolled = Math.max(0, -songList.getBoundingClientRect().top);
  const viewH = window.innerHeight;
  const from = Math.max(0, Math.floor(scrolled / virtualRowHeight) - VIRTUAL_BUFFER);
  const to = Math.min(virtualCount, Math.ceil((scrolled + viewH) / virtualRowHeight) + VIRTUAL_BUFFER);
  const slice = activeTracks.slice(from, to).map((track, i) => rowTemplate(track, from + i, rowOpts())).join('');
  songList.innerHTML = columnLabelsHtml() + `<div class="v-spacer" style="height:${virtualCount * virtualRowHeight}px;position:relative"><div class="v-window" style="position:absolute;top:${from * virtualRowHeight}px;left:0;right:0">${slice}</div></div>`;
  observeCovers(songList);
}
function displayedTracks() {
  const base = activeSection === 'favorites' ? favoriteIds.map(id => library.tracks.find(track => track.id === id)).filter(Boolean) : library.tracks;
  return activeAlbum ? base.filter(track => track.album === activeAlbum) : base;
}
function renderLibrary() {
  const base = activeSection === 'favorites' ? favoriteIds.map(id => library.tracks.find(track => track.id === id)).filter(Boolean) : library.tracks;
  activeTracks = activeAlbum ? base.filter(track => track.album === activeAlbum) : base;
  if (selectToggle) selectToggle.style.display = (activeTracks.length && (activeSection === 'library' || activeSection === 'favorites')) ? '' : 'none';
  const albums = activeSection === 'favorites' ? library.albums.filter(album => base.some(track => track.album === album.title)) : library.albums;
  songCount.textContent = activeAlbum ? `共 ${activeTracks.length} 首歌曲` : activeSection === 'favorites' ? `共 ${activeTracks.length} 首收藏歌曲` : `共 ${activeTracks.length} 首歌曲`;
  albumCount.textContent = `共 ${albums.length} 张专辑`;
  mediaPath.value = library.path || mediaPath.value;
  const songsTitle = document.querySelector('#songsTitle');
  if (songsTitle) songsTitle.textContent = activeAlbum || '全部歌曲';
  const backBtn = document.querySelector('#backToAll');
  if (backBtn) backBtn.style.display = activeAlbum ? '' : 'none';
  if (activeTracks.length) { measureVirtual(); updateVirtual(); } else { songList.innerHTML = emptyLibraryHtml(); }
  albumGrid.innerHTML = albums.length ? albums.map(album => { const track = base.find(item => item.album === album.title); return `<article class="album-card" data-album="${encodeURIComponent(album.title)}">${art(track, 'album-art')}<h3>${escapeHtml(album.title)}</h3><p>${escapeHtml(album.artist)} · ${album.tracks} 首歌曲</p></article>`; }).join('') : '<div class="empty-library"><div><strong>暂无专辑</strong><span>扫描到歌曲后将自动整理专辑</span></div></div>';
  observeCovers(albumGrid);
}
function updatePlayer(track) {
  document.querySelector('#nowTitle').textContent = track.title; document.querySelector('#nowArtist').textContent = track.artist;
  const button = document.querySelector('#currentFavorite'); button.textContent = isFavorite(track) ? '♥' : '♡'; button.classList.toggle('is-favorite', isFavorite(track));
  document.querySelectorAll('.song-row').forEach(row => row.classList.toggle('selected', activeTracks[Number(row.dataset.index)]?.id === track.id));
  document.querySelectorAll('.cd-track-row').forEach(row => row.classList.toggle('selected', activeTracks[Number(row.dataset.index)]?.id === track.id));
  renderLyrics(track);
  updateMediaSession(track);
  updateLvBackButton();
  if (document.querySelector('#lvQueueOverlay').classList.contains('open')) renderQueuePanel();
}
async function playTrack(index) { if (!activeTracks[index]) return; playQueue = activeTracks.slice(); playIndex = index; const track = activeTracks[index]; nowPlayingTrack = track; audio.src = streamUrl(track); updatePlayer(track); preloadNextTrack(); try { await audio.play(); } catch {} }
function setPlayIcon(playing) {
  const bottom = document.querySelector('#playToggle');
  if (bottom) { bottom.textContent = playing ? 'Ⅱ' : '▶'; bottom.setAttribute('aria-label', playing ? '暂停' : '播放'); }
  const lyric = document.querySelector('#lvPlay');
  if (lyric) { lyric.innerHTML = playing ? ICON_PAUSE : ICON_PLAY; lyric.setAttribute('aria-label', playing ? '暂停' : '播放'); }
}
// ---- 媒体会话：安卓通知栏显示歌名/封面 + 上一曲/下一曲 ----
function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', prevTrack);
  ms.setActionHandler('nexttrack', nextTrack);
  ms.setActionHandler('seekto', details => { if (details.seekTime != null) seekTo(details.seekTime); });
  ms.setActionHandler('seekbackward', () => { seekTo(audio.currentTime - 15); });
  ms.setActionHandler('seekforward', () => { seekTo(Math.min(playbackTotal(), audio.currentTime + 15)); });
}
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  const base = (typeof location !== 'undefined' && location.origin) || '';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: track.hasCover ? [{ src: `${base}/api/cover?id=${encodeURIComponent(track.path)}`, sizes: '512x512' }] : []
  });
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}
function parseLyrics(raw) {
  const timed = [], plain = [];
  String(raw || '').split(/\r?\n/).forEach(line => {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = line.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
    if (!text) return;
    if (matches.length) matches.forEach(match => timed.push({time: Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || 0}`), text}));
    else plain.push({time: null, text});
  });
  return timed.length ? timed.sort((a, b) => a.time - b.time) : plain;
}
function renderLyrics(track) {
  const coverImg = document.querySelector('#lvCoverImg');
  const lyricsView = document.querySelector('#lyricsView');
  if (track?.hasCover) {
    const coverUrl = `/api/cover?id=${encodeURIComponent(track.path)}`;
    coverImg.src = coverUrl;
    lyricsView.style.setProperty('--lv-bg-image', `url('${coverUrl}')`);
  } else {
    coverImg.removeAttribute('src');
    lyricsView.style.removeProperty('--lv-bg-image');
  }
  document.querySelector('#lvTitle').textContent = track?.title || '未选择歌曲';
  document.querySelector('#lvArtist').textContent = track?.artist || '—';
  document.querySelector('#lvAlbum').textContent = track?.album || '—';
  document.querySelector('#lvProgCur').textContent = '0:00';
  document.querySelector('#lvProgDur').textContent = duration(track?.duration || 0);
  document.querySelector('#lvProgFill').style.width = '0%';
  document.querySelector('#lvProgKnob').style.left = '0%';
  lyricItems = parseLyrics(track?.lyrics);
  activeLyricIndex = -1;
  lyricUserScroll = 0;
  document.querySelector('#lvLines').innerHTML = lyricItems.length ? lyricItems.map((item, index) => `<div class="lv-line" data-lyric-index="${index}">${escapeHtml(item.text)}</div>`).join('') : '<p class="no-lyrics">这首歌曲暂无歌词</p>';
  updateLyricsProgress();
}
function updateLyricsProgress() {
  const total = playbackTotal();
  const cur = audio.currentTime || 0;
  const fill = document.querySelector('#lvProgFill');
  if (fill) {
    const pct = total ? (cur / total) * 100 : 0;
    fill.style.width = pct + '%';
    const knob = document.querySelector('#lvProgKnob');
    if (knob) knob.style.left = pct + '%';
  }
  document.querySelector('#lvProgCur').textContent = duration(cur);
  document.querySelector('#lvProgDur').textContent = duration(total);
  if (!lyricItems.some(item => item.time !== null)) return;
  let nextIndex = -1;
  lyricItems.forEach((item, index) => { if (item.time <= cur) nextIndex = index; });
  if (nextIndex === activeLyricIndex) return;
  document.querySelectorAll('.lv-line').forEach(line => line.classList.toggle('active', Number(line.dataset.lyricIndex) === nextIndex));
  const activeLine = document.querySelector(`.lv-line[data-lyric-index="${nextIndex}"]`);
  if (activeLine && Date.now() - lyricUserScroll > 4000) {
    lyricAutoScroll = true;
    const sc = document.querySelector('#lvScroll');
    sc.scrollTo({top: activeLine.offsetTop - 2 * activeLine.offsetHeight, behavior: 'smooth'});
    setTimeout(() => { lyricAutoScroll = false; }, 900);
  }
  activeLyricIndex = nextIndex;
}
function fitLyrics() {
  const body = document.querySelector('.lv-body');
  const cover = document.querySelector('.lv-cover');
  const img = document.querySelector('#lvCoverImg');
  const view = document.querySelector('#lyricsView');
  if (!body || !img || !view.classList.contains('open')) return;
  if (window.innerWidth < 700) { img.style.width = ''; img.style.height = ''; return; }
  const compact = window.innerHeight <= 520 && window.innerWidth >= 700;
  const bs = getComputedStyle(body);
  const padTop = parseFloat(bs.paddingTop) || 0;
  const padBottom = parseFloat(bs.paddingBottom) || 0;
  let extra = 0;
  if (!compact) {
    cover.querySelectorAll('.lv-info').forEach(el => { extra += el.offsetHeight; });
  }
  const availH = window.innerHeight - padTop - padBottom - extra;
  const maxW = Math.min(340, window.innerWidth * 0.3);
  const size = Math.max(88, Math.min(maxW, availH));
  img.style.width = size + 'px';
  img.style.height = size + 'px';
}
function openLyrics() { if (!nowPlayingTrack) return; document.querySelector('#lyricsView').classList.add('open'); document.querySelector('#lyricsView').setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; renderLyrics(nowPlayingTrack); fitLyrics(); updateLvBackButton(); }
function closeLyrics() { document.querySelector('#lyricsView').classList.remove('open'); document.querySelector('#lyricsView').setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }
// ---- 歌词页：返回专辑列表（仅 CD 库曲目显示）----
function currentCdAlbum() { return nowPlayingTrack ? (cdLibrary.albums.find(album => album.tracks.some(track => track.id === nowPlayingTrack.id)) || null) : null; }
function updateLvBackButton() { const btn = document.querySelector('#lvBackToAlbum'); if (btn) btn.style.display = currentCdAlbum() ? '' : 'none'; }
// ---- 歌词页：播放列表小窗 ----
function renderQueuePanel() {
  const list = document.querySelector('#lvQueueList');
  if (!list) return;
  if (!playQueue.length) { list.innerHTML = '<p class="lv-queue-empty">播放队列为空</p>'; return; }
  list.innerHTML = playQueue.map((track, i) => `<div class="lv-queue-item${i === playIndex ? ' current' : ''}" data-qi="${i}" role="button" tabindex="0"><span class="lv-queue-dot"></span><span class="lv-queue-title">${escapeHtml(track.title)}</span><span class="lv-queue-artist">${escapeHtml(track.artist)}</span></div>`).join('');
}
function openQueuePanel() {
  const overlay = document.querySelector('#lvQueueOverlay');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  renderQueuePanel();
  positionQueuePanel();
  focusQueueCurrent();
  // woff2 字体异步加载会使面板尺寸变化，字体就绪后重新定位
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (overlay.classList.contains('open')) positionQueuePanel(); });
}
function closeQueuePanel() { const overlay = document.querySelector('#lvQueueOverlay'); overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); }
// popover 定位：小窗出现在「播放列表」按钮旁边，空间不足时翻转到按钮下方；箭头始终对准按钮
function positionQueuePanel() {
  const btn = document.querySelector('#lvQueue');
  const panel = document.querySelector('.lv-queue-panel');
  if (!btn || !panel) return;
  const br = btn.getBoundingClientRect();
  // 用 offsetWidth/offsetHeight 而非 getBoundingClientRect：入场动画 scale() 会污染测量值
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  let left = br.left + br.width / 2 - pw / 2;
  let top = br.top - ph - 14;
  const below = top < 14;
  if (below) top = br.bottom + 14;
  left = Math.max(10, Math.min(left, window.innerWidth - pw - 10));
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  panel.classList.toggle('below', below);
  // 箭头对准按钮中心（面板被边界 clamp 后仍指向按钮）
  const arrowX = br.left + br.width / 2 - left;
  panel.style.setProperty('--arrow-x', Math.max(18, Math.min(arrowX, pw - 18)) + 'px');
}
// 播放列表小窗滚动到当前播放的歌曲（打开时与点"聚焦"按钮时调用）
function focusQueueCurrent() {
  const list = document.querySelector('#lvQueueList');
  const item = list && list.querySelector('.lv-queue-item.current');
  if (!list || !item) return;
  requestAnimationFrame(() => { list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2; });
}
// 专辑详情页滚动到正在播放的曲目行（CD 曲目列表非虚拟滚动，可整表滚动）
function scrollToPlayingCdRow() {
  const row = document.querySelector('#cdTrackList .cd-track-row.selected');
  if (row) requestAnimationFrame(() => row.scrollIntoView({behavior: 'smooth', block: 'center'}));
}
// 数据到达后按用户当前所在视图重绘（修复：加载期间切到 CD/歌单 视图不会空白）
function renderCurrentSection() {
  if (activeSection === 'cdlib') renderCdLibrary();
  else if (activeSection === 'cdalbum' && activeCdAlbum) renderCdAlbumDetail();
  else if (activeSection === 'playlists') renderPlaylists();
  else if (activeSection === 'playlist' && activePlaylist) renderPlaylistDetail();
  else renderLibrary();
}
async function loadData() { try { const [libraryResult, favoritesResult, playlistsResult, cdlibResult, transcodeResult] = await Promise.all([fetch('/api/library'), fetch('/api/favorites'), fetch('/api/playlists'), fetch('/api/cdlib'), fetch('/api/transcode-config')]); library = await libraryResult.json(); favoriteIds = (await favoritesResult.json()).ids || []; playlists = (await playlistsResult.json()).playlists || []; cdLibrary = await cdlibResult.json(); transcodeConfig = await transcodeResult.json(); renderTranscodeSettings(); const h = location.hash; if (h && h.length > 1) applyHash(h); else renderCurrentSection(); } catch { renderLibrary(); } }
async function setFavorite(id, favorite) { const response = await fetch('/api/favorites', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, favorite})}); if (!response.ok) return; favoriteIds = (await response.json()).ids || []; renderLibrary(); if (activeSection === 'cdalbum' && activeCdAlbum) renderCdAlbumDetail(); if (nowPlayingTrack) updatePlayer(nowPlayingTrack); }
function showView(viewId) { ['songs', 'albums', 'playlists', 'playlistDetail', 'cdlib', 'cdAlbumDetail'].forEach(id => document.getElementById(id).classList.toggle('active-view', id === viewId)); }
function updateTabsVisibility() { document.querySelector('.tabs').style.display = (activeSection === 'library' || activeSection === 'favorites') ? '' : 'none'; }
function setSection(section) {
  activeSection = section; activeAlbum = null; exitSelectMode();
  const titles = { library: ['音乐库', 'Mooloco媒体服务器'], favorites: ['收藏', '心动音乐'], playlists: ['歌单', '收藏空间'], playlist: [activePlaylist?.name || '歌单', '歌单详情'], cdlib: ['CD 库', '专属唱片与CD光盘'], cdalbum: [activeCdAlbum?.title || '专辑', '专辑详情'] };
  document.querySelector('#pageTitle').textContent = titles[section][0];
  document.querySelector('#pageEyebrow').textContent = titles[section][1];
  document.querySelector('#libraryNav').classList.toggle('active', section === 'library');
  document.querySelector('#favoritesNav').classList.toggle('active', section === 'favorites');
  document.querySelector('#playlistsNav').classList.toggle('active', section === 'playlists' || section === 'playlist');
  document.querySelector('#cdNav').classList.toggle('active', section === 'cdlib' || section === 'cdalbum');
  document.querySelector('.topbar').classList.toggle('compact', section === 'cdalbum');
  updateTabsVisibility();
  if (section === 'playlists') { showView('playlists'); renderPlaylists(); syncHash(); return; }
  if (section === 'playlist') { showView('playlistDetail'); renderPlaylistDetail(); syncHash(); return; }
  if (section === 'cdlib') { showView('cdlib'); renderCdLibrary(); syncHash(); return; }
  if (section === 'cdalbum') { showView('cdAlbumDetail'); renderCdAlbumDetail(); syncHash(); return; }
  showView(document.querySelector('.tab.active')?.dataset.view === 'albums' ? 'albums' : 'songs');
  renderLibrary();
  syncHash();
}
// ---- hash 路由：视图切换写进 URL（#library/#cdlib/#playlist=id/#cdalbum=dir），支持浏览器前进后退与刷新恢复 ----
function syncHash(target) {
  let h = target || activeSection;
  if (!target && activeSection === 'playlist' && activePlaylist) h = `playlist=${encodeURIComponent(activePlaylist.id)}`;
  else if (!target && activeSection === 'cdalbum' && activeCdAlbum) h = `cdalbum=${encodeURIComponent(activeCdAlbum.dir)}`;
  const t = h.startsWith('#') ? h : `#${h}`;
  if (location.hash !== t) history.pushState(null, '', t);
}
function closeTopOverlay() {
  for (const [sel, close] of [['#lvQueueOverlay.open', closeQueuePanel], ['#lyricsView.open', closeLyrics], ['#settingsOverlay.open', closeSettingsOverlay], ['#searchOverlay.open', closeSearch], ['#playlistPicker.open', closePlaylistPicker]]) {
    if (document.querySelector(sel)) { close(); return true; }
  }
  return false;
}
function applyHash(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (h.startsWith('playlist=')) {
    const pl = playlists.find(p => p.id === decodeURIComponent(h.slice(9)));
    if (pl) openPlaylistDetail(pl); else setSection('playlists');
  } else if (h.startsWith('cdalbum=')) {
    const dir = decodeURIComponent(h.slice(8));
    const album = cdLibrary.albums.find(a => a.dir === dir);
    if (album) openCdAlbum(album); else setSection('cdlib');
  } else if (h === 'favorites') setSection('favorites');
  else if (h === 'playlists') setSection('playlists');
  else if (h === 'cdlib') setSection('cdlib');
  else if (h === 'settings') { if (!settingsOverlay.classList.contains('open')) openSettingsRoute(); }
  else setSection('library');
}
window.addEventListener('popstate', () => { if (closeTopOverlay()) return; applyHash(location.hash); });
document.querySelector('#libraryNav').addEventListener('click', () => setSection('library')); document.querySelector('#favoritesNav').addEventListener('click', () => setSection('favorites'));
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { if (activeSection !== 'library' && activeSection !== 'favorites') return; exitSelectMode(); document.querySelectorAll('.tab').forEach(item => { const selected = item === tab; item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected)); }); showView(tab.dataset.view); if (tab.dataset.view === 'albums' && activeAlbum) { activeAlbum = null; renderLibrary(); } }));
const settingsOverlay = document.querySelector('#settingsOverlay');
let prevSettingsHash = '#library';
function openSettingsRoute() {
  if (!settingsOverlay.classList.contains('open')) prevSettingsHash = location.hash && location.hash !== '#settings' ? location.hash : '#library';
  renderTranscodeSettings(); refreshTranscodeCacheInfo();
  settingsOverlay.classList.add('open'); settingsOverlay.setAttribute('aria-hidden', 'false');
  if (window.matchMedia('(max-width:820px)').matches) syncHash('#settings');
}
function closeSettingsOverlay() {
  if (pendingTranscode) { pendingTranscode = null; renderTranscodeSettings(); }
  settingsOverlay.classList.remove('open'); settingsOverlay.setAttribute('aria-hidden', 'true');
}
document.querySelector('#settingsButton').addEventListener('click', openSettingsRoute); document.querySelector('#closeSettings').addEventListener('click', () => { closeSettingsOverlay(); if (window.matchMedia('(max-width:820px)').matches) syncHash(prevSettingsHash || '#library'); }); settingsOverlay.addEventListener('click', event => { if (event.target === settingsOverlay && !window.matchMedia('(max-width:820px)').matches) document.querySelector('#closeSettings').click(); });
scanButton.addEventListener('click', async () => { const path = mediaPath.value.trim(); if (!path) { scanStatus.textContent = '请先填写媒体库路径。'; scanStatus.className = 'scan-status error'; return; } scanButton.disabled = true; scanButton.innerHTML = '<span>◌</span> 正在扫描…'; scanStatus.textContent = '正在读取音频内嵌元数据与歌词…'; scanStatus.className = 'scan-status'; try { const response = await fetch('/api/library/scan', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path})}); const result = await response.json(); if (!response.ok) throw new Error(result.error || '扫描失败'); library = result; activeAlbum = null; renderLibrary(); scanStatus.textContent = `扫描完成：已发现 ${result.tracks.length} 首歌曲。`; scanStatus.className = 'scan-status success'; } catch (error) { scanStatus.textContent = error.message || '扫描失败，请检查路径。'; scanStatus.className = 'scan-status error'; } finally { scanButton.disabled = false; scanButton.innerHTML = '<span>⌕</span> 开始扫描'; } });
songList.addEventListener('click', event => { if (selectMode) { const selRow = event.target.closest('.song-row'); if (selRow) { const selTrack = activeTracks[Number(selRow.dataset.index)]; if (selTrack) toggleSelected(selTrack.id); updateVirtual(); } return; } const addBtn = event.target.closest('.add-button'); if (addBtn) { openPlaylistPicker(decodeURIComponent(addBtn.dataset.addId)); return; } const favorite = event.target.closest('.favorite-button'); if (favorite) { setFavorite(decodeURIComponent(favorite.dataset.favoriteId), !favorite.classList.contains('is-favorite')); return; } const row = event.target.closest('.song-row'); if (row) playTrack(Number(row.dataset.index)); });
albumGrid.addEventListener('click', event => { const card = event.target.closest('.album-card'); if (!card || !card.dataset.album) return; exitSelectMode(); activeAlbum = decodeURIComponent(card.dataset.album); document.querySelectorAll('.tab').forEach(item => { const selected = item.dataset.view === 'songs'; item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected)); }); showView('songs'); renderLibrary(); });
document.querySelector('#backToAll').addEventListener('click', () => { activeAlbum = null; exitSelectMode(); renderLibrary(); });
document.querySelector('#currentFavorite').addEventListener('click', () => { if (nowPlayingTrack) setFavorite(nowPlayingTrack.id, !isFavorite(nowPlayingTrack)); });
document.querySelector('#playAll').addEventListener('click', () => playTrack(0)); document.querySelector('#shuffle').addEventListener('click', () => playTrack(Math.floor(Math.random() * activeTracks.length)));
function playFromQueue(index) { const track = playQueue[index]; if (!track) return; playIndex = index; nowPlayingTrack = track; audio.src = streamUrl(track); updatePlayer(track); preloadNextTrack(); audio.play().catch(() => {}); }
function nextTrack() { if (!playQueue.length || playIndex < 0) return; let n; if (shuffleOn && playQueue.length > 1) { do { n = Math.floor(Math.random() * playQueue.length); } while (n === playIndex); } else n = (playIndex + 1) % playQueue.length; playFromQueue(n); }
function prevTrack() { if (!playQueue.length || playIndex < 0) return; playFromQueue((playIndex - 1 + playQueue.length) % playQueue.length); }
document.querySelector('#playToggle').addEventListener('click', () => { if (audio.src) audio.paused ? audio.play() : audio.pause(); else playTrack(0); });
document.querySelector('#previousButton').addEventListener('click', prevTrack);
document.querySelector('#nextButton').addEventListener('click', nextTrack);
document.querySelector('.player').addEventListener('click', event => {
  if (event.target.closest('button')) return;
  if (window.innerWidth >= 1024) openLyrics();
  else if (event.target.closest('.now-playing')) openLyrics();
});
document.querySelector('#lvClose').addEventListener('click', closeLyrics);
document.querySelector('#lvBackToAlbum').addEventListener('click', () => { const album = currentCdAlbum(); if (!album) return; closeLyrics(); openCdAlbum(album); scrollToPlayingCdRow(); });
document.querySelector('#lvQueue').addEventListener('click', openQueuePanel);
document.querySelector('#lvQueueFocus').addEventListener('click', focusQueueCurrent);
document.querySelector('#lvQueueClose').addEventListener('click', closeQueuePanel);
document.querySelector('#lvQueueOverlay').addEventListener('click', event => { if (event.target === document.querySelector('#lvQueueOverlay')) closeQueuePanel(); });
document.querySelector('#lvQueueList').addEventListener('click', event => { const item = event.target.closest('.lv-queue-item'); if (item && Number(item.dataset.qi) >= 0) playFromQueue(Number(item.dataset.qi)); });
document.querySelector('#lvPrev').addEventListener('click', prevTrack);
document.querySelector('#lvNext').addEventListener('click', nextTrack);
document.querySelector('#lvPlay').addEventListener('click', () => document.querySelector('#playToggle').click());
const lvProgBar = document.querySelector('#lvProgBar');
// 转码管道流（audio.duration 为 Infinity）：总长用曲目元数据；seek 用 &seek= 参数让服务端从目标秒重新管道
function playbackTotal() { const d = audio.duration; return (Number.isFinite(d) && d > 0) ? d : (nowPlayingTrack?.duration || 0); }
function seekTo(seconds) {
  const target = Math.max(0, seconds);
  if (Number.isFinite(audio.duration) && audio.duration > 0) { audio.currentTime = target; return; }
  const track = nowPlayingTrack;
  if (!track || !track.path) return;
  audio.src = `${streamUrl(track)}&seek=${Math.floor(target)}`;
  audio.play().catch(() => {});
}
let progDragging = false, progDragTarget = -1;
const seekFromEvent = event => {
  if (!audio.src) return;
  const r = lvProgBar.getBoundingClientRect();
  const total = playbackTotal();
  const target = total > 0 ? Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) * total : 0;
  progDragTarget = target;
  if (progDragging) {
    // 拖动中：只预览位置，释放时才真正 seek（转码管道流不能被连续重载）
    const pct = total > 0 ? (target / total) * 100 : 0;
    document.querySelector('#lvProgFill').style.width = pct + '%';
    const knob = document.querySelector('#lvProgKnob');
    if (knob) knob.style.left = pct + '%';
    document.querySelector('#lvProgCur').textContent = duration(target);
  }
};
lvProgBar.addEventListener('pointerdown', event => { progDragging = true; progDragTarget = -1; seekFromEvent(event); lvProgBar.setPointerCapture(event.pointerId); });
lvProgBar.addEventListener('pointermove', event => { if (progDragging) seekFromEvent(event); });
lvProgBar.addEventListener('pointerup', () => { progDragging = false; if (progDragTarget >= 0) { seekTo(progDragTarget); lyricUserScroll = 0; activeLyricIndex = -1; updateLyricsProgress(); } });
audio.addEventListener('play', () => { setPlayIcon(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; }); audio.addEventListener('pause', () => { setPlayIcon(false); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; }); audio.addEventListener('ended', nextTrack); audio.addEventListener('timeupdate', updateLyricsProgress); audio.addEventListener('loadedmetadata', updateLyricsProgress);
document.querySelector('#lvShuffle').addEventListener('click', () => { shuffleOn = !shuffleOn; document.querySelector('#lvShuffle').classList.toggle('shuffle-on', shuffleOn); });
document.querySelector('#lvLines').addEventListener('click', event => {
  const line = event.target.closest('.lv-line');
  if (!line || !lyricItems.length || lyricItems[0].time === null) return;
  const i = Number(line.dataset.lyricIndex);
  if (!(i >= 0)) return;
  audio.currentTime = lyricItems[i].time;
  if (audio.paused) audio.play();
  lyricUserScroll = 0; activeLyricIndex = -1; updateLyricsProgress();
});
const lyricsScrollEl = document.querySelector('#lvScroll');
lyricsScrollEl.addEventListener('scroll', () => { if (!lyricAutoScroll) lyricUserScroll = Date.now(); });
lyricsScrollEl.addEventListener('scrollend', () => { lyricAutoScroll = false; });
window.addEventListener('scroll', () => {
  if (virtualRaf) return;
  virtualRaf = requestAnimationFrame(() => { virtualRaf = 0; updateVirtual(); });
}, {passive: true});
window.addEventListener('resize', () => {
  if (document.querySelector('#lyricsView').classList.contains('open')) fitLyrics();
  measureVirtual();
  updateVirtual();
});
const searchOverlay = document.querySelector('#searchOverlay'), searchInput = document.querySelector('#searchInput'), searchResults = document.querySelector('#searchResults'), searchMeta = document.querySelector('#searchMeta');
let searchResultList = [];
function openSearch() {
  searchOverlay.classList.add('open'); searchOverlay.setAttribute('aria-hidden', 'false');
  searchInput.value = ''; searchResults.innerHTML = ''; searchMeta.textContent = '输入歌名开始搜索';
  searchInput.focus();
}
function closeSearch() {
  if (!searchOverlay.classList.contains('open')) return;
  searchOverlay.classList.remove('open'); searchOverlay.setAttribute('aria-hidden', 'true');
  searchResultList = []; renderLibrary();
}
// ---- 搜索栏「正在播放」：跳到当前播放歌曲在主页的位置（主媒体库/CD库均生效）----
function forceSongsTab() { document.querySelectorAll('.tab').forEach(item => { const selected = item.dataset.view === 'songs'; item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected)); }); showView('songs'); }
function scrollToPlayingSongRow() {
  const idx = activeTracks.findIndex(track => track.id === nowPlayingTrack.id);
  if (idx < 0) return;
  measureVirtual();
  const rowTop = songList.getBoundingClientRect().top + window.scrollY + idx * virtualRowHeight;
  window.scrollTo({top: Math.max(0, rowTop - window.innerHeight / 2 + virtualRowHeight / 2), behavior: 'smooth'});
}
function jumpToNowPlaying() {
  if (!nowPlayingTrack) return;
  closeSearch();
  const album = currentCdAlbum();
  if (album) {
    if (!(activeSection === 'cdalbum' && activeCdAlbum && activeCdAlbum.dir === album.dir)) openCdAlbum(album);
    else renderCdAlbumDetail();
    scrollToPlayingCdRow();
  } else {
    forceSongsTab();
    if (activeSection !== 'library') { activeAlbum = null; setSection('library'); }
    else if (activeAlbum) { activeAlbum = null; renderLibrary(); }
    scrollToPlayingSongRow();
  }
}
document.querySelector('#nowPlayingButton').addEventListener('click', jumpToNowPlaying);
// 播放栏 ⌁ 按钮：软连到「正在播放」跳转
document.querySelector('#playerJumpToNow').addEventListener('click', jumpToNowPlaying);
document.querySelector('#searchButton').addEventListener('click', openSearch);
searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) { searchResults.innerHTML = ''; searchMeta.textContent = '输入歌名开始搜索'; searchResultList = []; return; }
  searchResultList = library.tracks.filter(track => track.title.toLowerCase().includes(query));
  searchMeta.textContent = `找到 ${searchResultList.length} 首歌曲`;
  searchResults.innerHTML = searchResultList.length ? searchResultList.map((track, index) => rowTemplate(track, index)).join('') : '<div class="empty-search">未找到相关歌曲</div>';
  observeCovers(searchResults);
});
searchResults.addEventListener('click', event => {
  const addBtn = event.target.closest('.add-button');
  if (addBtn) { openPlaylistPicker(decodeURIComponent(addBtn.dataset.addId)); return; }
  const favorite = event.target.closest('.favorite-button');
  if (favorite) {
    setFavorite(decodeURIComponent(favorite.dataset.favoriteId), !favorite.classList.contains('is-favorite')).then(() => {
      if (searchOverlay.classList.contains('open') && searchResultList.length) activeTracks = searchResultList;
    });
    return;
  }
  const row = event.target.closest('.song-row');
  if (row) { activeTracks = searchResultList; playTrack(Number(row.dataset.index)); }
});
document.querySelector('#searchClear').addEventListener('click', () => { searchInput.value = ''; searchInput.focus(); searchResults.innerHTML = ''; searchMeta.textContent = '输入歌名开始搜索'; searchResultList = []; });
searchOverlay.addEventListener('click', event => { if (event.target === searchOverlay) closeSearch(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.querySelector('#lvQueueOverlay').classList.contains('open')) { closeQueuePanel(); return; } if (event.key === 'Escape' && playlistPicker.classList.contains('open')) { closePlaylistPicker(); return; } if (event.key === 'Escape' && searchOverlay.classList.contains('open')) closeSearch(); });
// ============ 歌单 ============
function playlistTracks() { const byId = new Map(library.tracks.map(track => [track.id, track])); return (activePlaylist?.tracks || []).map(item => byId.get(item.id)).filter(Boolean); }
function renderPlaylists() {
  document.querySelector('#playlistCount').textContent = `共 ${playlists.length} 个歌单`;
  if (!playlists.length) { playlistGrid.innerHTML = '<div class="empty-library"><div><strong>暂无歌单</strong><span>点击右上角「新建歌单」，然后在歌曲列表勾选歌曲批量加入</span></div></div>'; return; }
  playlistGrid.innerHTML = playlists.map(playlist => { const first = playlist.tracks[0]; const track = first && library.tracks.find(item => item.id === first.id); return `<article class="playlist-card" data-pl-id="${playlist.id}">${track?.hasCover ? `<div class="playlist-art cover-art" data-cover="${encodeURIComponent(track.path)}"></div>` : '<div class="playlist-art">♬</div>'}<h3>${escapeHtml(playlist.name)}</h3><p>${playlist.tracks.length} 首歌曲</p></article>`; }).join('');
  observeCovers(playlistGrid);
}
function renderPlaylistDetail() {
  if (!activePlaylist) return;
  document.querySelector('#plDetailTitle').textContent = activePlaylist.name;
  document.querySelector('#plDetailCount').textContent = `共 ${activePlaylist.tracks.length} 首歌曲`;
  const tracks = playlistTracks();
  plSongList.innerHTML = tracks.length ? columnLabelsHtml() + tracks.map((track, i) => rowTemplate(track, i, { removable: true })).join('') : '<div class="empty-library"><div><strong>歌单还是空的</strong><span>在歌曲列表中勾选歌曲，点击「加入歌单」</span></div></div>';
  observeCovers(plSongList);
}
function openPlaylistDetail(playlist) { activePlaylist = playlist; activeTracks = playlistTracks(); setSection('playlist'); }
function syncPlaylistFromServer(playlistId, tracks) { const pl = playlists.find(item => item.id === playlistId); if (pl) pl.tracks = tracks; if (activePlaylist && activePlaylist.id === playlistId) { activePlaylist.tracks = tracks; activeTracks = playlistTracks(); } }
async function createPlaylist(name) { const response = await fetch('/api/playlists', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name})}); const result = await response.json(); if (!response.ok) throw new Error(result.error || '创建失败'); playlists.unshift(result); return result; }
async function addToPlaylist(playlistId, trackIds) { const response = await fetch('/api/playlists/add', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({playlistId, trackIds})}); const result = await response.json(); if (!response.ok) throw new Error(result.error || '加入失败'); syncPlaylistFromServer(playlistId, result.playlist.tracks); return result; }
async function removeFromPlaylist(trackId) { if (!activePlaylist) return; const response = await fetch('/api/playlists/remove', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({playlistId: activePlaylist.id, trackId})}); const result = await response.json(); if (!response.ok) { showToast(result.error || '移除失败'); return; } syncPlaylistFromServer(activePlaylist.id, result.playlist.tracks); renderPlaylistDetail(); }
async function deletePlaylist(playlistId) { await fetch(`/api/playlists?id=${encodeURIComponent(playlistId)}`, {method: 'DELETE'}); playlists = playlists.filter(item => item.id !== playlistId); showToast('歌单已删除'); setSection('playlists'); }
// ---- 批量选择 ----
function updateSelectCount() { selectCount.textContent = `已选 ${selectedIds.size} 首`; }
function toggleSelected(trackId) { if (selectedIds.has(trackId)) selectedIds.delete(trackId); else selectedIds.add(trackId); updateSelectCount(); }
function exitSelectMode() { if (!selectMode) return; selectMode = false; selectedIds.clear(); selectBar.style.display = 'none'; if (selectToggle) selectToggle.textContent = '☑ 选择'; }
function toggleSelectMode() { selectMode = !selectMode; selectedIds.clear(); selectToggle.textContent = selectMode ? '☑ 取消选择' : '☑ 选择'; selectBar.style.display = selectMode ? 'flex' : 'none'; updateSelectCount(); renderLibrary(); }
// ---- 加入歌单面板 ----
let pickerTrackIds = [], pickerSingle = false;
function renderPickerList() { ppList.innerHTML = playlists.map(playlist => `<button class="pp-item" data-pick-id="${playlist.id}" type="button"><span>▤</span>${escapeHtml(playlist.name)}<span class="pp-count">${playlist.tracks.length} 首</span></button>`).join(''); ppEmpty.style.display = playlists.length ? 'none' : ''; }
function openPlaylistPicker(singleTrackId) { pickerSingle = !!singleTrackId; pickerTrackIds = pickerSingle ? [singleTrackId] : [...selectedIds]; if (!pickerTrackIds.length) return; playlistPicker.classList.add('open'); playlistPicker.setAttribute('aria-hidden', 'false'); ppNewName.value = ''; renderPickerList(); }
function closePlaylistPicker() { playlistPicker.classList.remove('open'); playlistPicker.setAttribute('aria-hidden', 'true'); }
async function pickPlaylist(playlistId) { if (!pickerTrackIds.length) return; const trackIds = pickerTrackIds; try { const data = await addToPlaylist(playlistId, trackIds); const playlist = playlists.find(item => item.id === playlistId); showToast(data.added === 1 && playlist ? `已加入「${playlist.name}」` : `已加入 ${data.added} 首歌曲`); } catch (error) { showToast(error.message); return; } closePlaylistPicker(); if (!pickerSingle) { exitSelectMode(); renderLibrary(); if (activePlaylist && activePlaylist.id === playlistId) renderPlaylistDetail(); } }
async function createAndAdd(name) { const trimmed = name.trim(); if (!trimmed) return; try { const playlist = await createPlaylist(trimmed); await pickPlaylist(playlist.id); } catch (error) { showToast(error.message); } }
// ---- 轻提示 ----
let toastTimer = 0;
function showToast(message) { let el = document.querySelector('#appToast'); if (!el) { el = document.createElement('div'); el.id = 'appToast'; el.className = 'app-toast'; document.body.appendChild(el); } el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200); }
// ---- 事件绑定 ----
document.querySelector('#playlistsNav').addEventListener('click', () => setSection('playlists'));
const inlineCreate = document.querySelector('#inlineCreate');
document.querySelector('#newPlaylistBtn').addEventListener('click', () => { inlineCreate.style.display = 'flex'; document.querySelector('#inlineCreateName').focus(); });
function submitInlineCreate() { const name = document.querySelector('#inlineCreateName').value.trim(); if (!name) return; createPlaylist(name).then(() => { inlineCreate.style.display = 'none'; document.querySelector('#inlineCreateName').value = ''; renderPlaylists(); showToast('歌单已创建'); }).catch(error => showToast(error.message)); }
document.querySelector('#inlineCreateOk').addEventListener('click', submitInlineCreate);
document.querySelector('#inlineCreateCancel').addEventListener('click', () => { inlineCreate.style.display = 'none'; });
document.querySelector('#inlineCreateName').addEventListener('keydown', event => { if (event.key === 'Enter') submitInlineCreate(); });
playlistGrid.addEventListener('click', event => { const card = event.target.closest('.playlist-card'); if (!card || !card.dataset.plId) return; const playlist = playlists.find(item => item.id === card.dataset.plId); if (playlist) openPlaylistDetail(playlist); });
document.querySelector('#plBack').addEventListener('click', () => { activePlaylist = null; setSection('playlists'); });
document.querySelector('#plDelete').addEventListener('click', () => { if (!activePlaylist) return; if (!window.confirm(`确定删除歌单「${activePlaylist.name}」吗？歌单中的歌曲不会被删除。`)) return; deletePlaylist(activePlaylist.id); });
plSongList.addEventListener('click', event => { const remove = event.target.closest('.pl-remove'); if (remove) { removeFromPlaylist(decodeURIComponent(remove.dataset.removeId)); return; } const favorite = event.target.closest('.favorite-button'); if (favorite) { setFavorite(decodeURIComponent(favorite.dataset.favoriteId), !favorite.classList.contains('is-favorite')); return; } const row = event.target.closest('.song-row'); if (row) { activeTracks = playlistTracks(); playTrack(Number(row.dataset.index)); } });
selectToggle.addEventListener('click', toggleSelectMode);
document.querySelector('#selectCancel').addEventListener('click', () => { exitSelectMode(); renderLibrary(); });
document.querySelector('#addToPlaylistBtn').addEventListener('click', openPlaylistPicker);
document.querySelector('#ppClose').addEventListener('click', closePlaylistPicker);
document.querySelector('#ppNewBtn').addEventListener('click', () => createAndAdd(ppNewName.value));
ppNewName.addEventListener('keydown', event => { if (event.key === 'Enter') createAndAdd(ppNewName.value); });
ppList.addEventListener('click', event => { const item = event.target.closest('.pp-item'); if (item && item.dataset.pickId) pickPlaylist(item.dataset.pickId); });
playlistPicker.addEventListener('click', event => { if (event.target === playlistPicker) closePlaylistPicker(); });

// ============ CD 库 ============
function formatMB(size) { return `${(size / 1048576).toFixed(1)} MB`; }
function renderCdLibrary() {
  cdMediaPath.value = cdLibrary.path || cdMediaPath.value;
  document.querySelector('#cdAlbumCount').textContent = `共 ${cdLibrary.albums.length} 张专辑`;
  if (!cdLibrary.albums.length) { cdAlbumGrid.innerHTML = '<div class="empty-library"><div><strong>暂无 CD 专辑</strong><span>在设置中填写 CD 库路径并扫描，第一层子文件夹将作为专辑展示</span></div></div>'; return; }
  cdAlbumGrid.innerHTML = cdLibrary.albums.map(album => `<article class="cd-album-card" data-cd-dir="${encodeURIComponent(album.dir)}">${album.hasCover ? `<div class="cd-album-art cover-art" data-cover="/api/cdlib/cover?album=${encodeURIComponent(album.dir)}"></div>` : '<div class="cd-album-art">💿</div>'}<h3>${escapeHtml(album.info?.title || album.title)}</h3><p>${escapeHtml(album.artist)} · ${album.tracks.length} 首</p></article>`).join('');
  observeCovers(cdAlbumGrid);
}
function cdTrackRow(track, index) { return `<article class="cd-track-row ${isPlayingTrack(track) ? 'selected' : ''}" data-index="${index}"><span class="cd-track-no">${escapeHtml(track.track || String(index + 1))}</span><div class="cd-track-title">${escapeHtml(track.title)}</div><span class="cd-track-size">${formatMB(track.size)}</span><span class="cd-track-dur">${duration(track.duration)}</span><button class="add-button" data-add-id="${encodeURIComponent(track.id)}" type="button" title="加入歌单" aria-label="加入歌单">＋</button><button class="favorite-button ${isFavorite(track) ? 'is-favorite' : ''}" data-favorite-id="${encodeURIComponent(track.id)}" type="button" aria-label="${isFavorite(track) ? '取消收藏' : '收藏'}">${isFavorite(track) ? '♥' : '♡'}</button></article>`; }
function renderCdAlbumDetail() {
  if (!activeCdAlbum) return;
  const info = activeCdAlbum.info || {};
  cdDetailTitle.textContent = info.title || activeCdAlbum.title;
  cdDetailArtist.textContent = info.artist || activeCdAlbum.artist;
  const tags = [];
  if (info.genre) tags.push(`<span class="cd-tag cd-tag-genre">${escapeHtml(info.genre)}</span>`);
  if (info.date) tags.push(`<span class="cd-tag">📅 ${escapeHtml(info.date)}</span>`);
  if (info.label) tags.push(`<span class="cd-tag">🏢 ${escapeHtml(info.label)}</span>`);
  cdDetailTags.innerHTML = tags.join('');
  cdDetailTags.style.display = tags.length ? '' : 'none';
  if (info.desc) { cdDetailDesc.textContent = info.desc; cdDetailDesc.style.display = ''; } else { cdDetailDesc.style.display = 'none'; }
  if (activeCdAlbum.hasCover) {
    cdDetailCover.style.backgroundImage = `url('/api/cdlib/cover?album=${encodeURIComponent(activeCdAlbum.dir)}')`;
    cdDetailCover.classList.remove('no-cover');
  } else {
    cdDetailCover.style.backgroundImage = '';
    cdDetailCover.classList.add('no-cover');
  }
  cdTrackList.innerHTML = `<div class="cd-track-head"><span>#</span><span>歌曲</span><span>大小</span><span>时长</span><span></span><span></span></div>` + activeCdAlbum.tracks.map((track, i) => cdTrackRow(track, i)).join('');
}
function openCdAlbum(album) { activeCdAlbum = album; activeTracks = album.tracks; setSection('cdalbum'); }
document.querySelector('#cdNav').addEventListener('click', () => setSection('cdlib'));
cdAlbumGrid.addEventListener('click', event => { const card = event.target.closest('.cd-album-card'); if (!card || !card.dataset.cdDir) return; const album = cdLibrary.albums.find(item => item.dir === decodeURIComponent(card.dataset.cdDir)); if (album) openCdAlbum(album); });
document.querySelector('#cdBack').addEventListener('click', () => { activeCdAlbum = null; setSection('cdlib'); });
document.querySelector('#cdPlayAll').addEventListener('click', () => { if (activeCdAlbum?.tracks.length) { activeTracks = activeCdAlbum.tracks; playTrack(0); } });
cdTrackList.addEventListener('click', event => { const addBtn = event.target.closest('.add-button'); if (addBtn) { openPlaylistPicker(decodeURIComponent(addBtn.dataset.addId)); return; } const favorite = event.target.closest('.favorite-button'); if (favorite) { setFavorite(decodeURIComponent(favorite.dataset.favoriteId), !favorite.classList.contains('is-favorite')); return; } const row = event.target.closest('.cd-track-row'); if (row) playTrack(Number(row.dataset.index)); });
// 设置页：媒体库 / CD库 切换
document.querySelectorAll('.settings-nav-item[data-settings-tab]').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.settings-nav-item[data-settings-tab]').forEach(item => item.classList.toggle('active', item === btn)); document.querySelectorAll('.setting-card[data-settings-panel]').forEach(card => card.style.display = card.dataset.settingsPanel === btn.dataset.settingsTab ? '' : 'none'); }));
cdScanButton.addEventListener('click', async () => { const path = cdMediaPath.value.trim(); if (!path) { cdScanStatus.textContent = '请先填写CD库路径。'; cdScanStatus.className = 'scan-status error'; return; } cdScanButton.disabled = true; cdScanButton.innerHTML = '<span>◌</span> 正在扫描…'; cdScanStatus.textContent = '正在扫描第一层专辑文件夹…'; cdScanStatus.className = 'scan-status'; try { const response = await fetch('/api/cdlib/scan', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path})}); const result = await response.json(); if (!response.ok) throw new Error(result.error || '扫描失败'); cdLibrary = result; activeCdAlbum = null; renderCdLibrary(); cdScanStatus.textContent = `扫描完成：发现 ${result.albums.length} 张专辑。`; cdScanStatus.className = 'scan-status success'; } catch (error) { cdScanStatus.textContent = error.message || '扫描失败，请检查路径。'; cdScanStatus.className = 'scan-status error'; } finally { cdScanButton.disabled = false; cdScanButton.innerHTML = '<span>⌕</span> 开始扫描'; } });

// ============ 转码设置 ============
function formatBytes(n) { if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`; if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`; if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`; return `${n} B`; }
function renderTranscodeSettings() {
  const cfg = pendingTranscode || transcodeConfig;
  transcodeToggle.checked = !!cfg.enabled;
  transcodeOptions.style.display = cfg.enabled ? '' : 'none';
  [...transcodeFormat.querySelectorAll('.option-btn')].forEach(btn => btn.classList.toggle('active', btn.dataset.value === cfg.format));
  [...transcodeBitrate.querySelectorAll('.option-btn')].forEach(btn => btn.classList.toggle('active', Number(btn.dataset.value) === cfg.bitrate));
  transcodeCacheDir.value = cfg.cacheDir || '';
  transcodeCacheSize.value = String(cfg.cacheSizeGB);
  transcodeDirty.style.display = pendingTranscode ? '' : 'none';
}
const transcodeSave = document.querySelector('#transcodeSave'), transcodeDirty = document.querySelector('#transcodeDirty');
async function refreshTranscodeCacheInfo() { try { const stats = await (await fetch('/api/transcode-cache')).json(); transcodeCacheInfo.textContent = `${formatBytes(stats.sizeBytes)} · ${stats.fileCount} 个文件`; } catch { transcodeCacheInfo.textContent = '—'; } }
function markTranscodeDirty(patch) { pendingTranscode = { ...(pendingTranscode || transcodeConfig), ...patch }; renderTranscodeSettings(); }
async function applyTranscodeConfig() {
  if (!pendingTranscode) return;
  try {
    const response = await fetch('/api/transcode-config', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(pendingTranscode)});
    transcodeConfig = await response.json();
    pendingTranscode = null;
    renderTranscodeSettings();
    refreshTranscodeCacheInfo();
    showToast('转码设置已保存并应用');
  } catch { /* 网络异常忽略 */ }
}
transcodeToggle.addEventListener('change', () => markTranscodeDirty({enabled: transcodeToggle.checked}));
transcodeFormat.addEventListener('click', event => { const btn = event.target.closest('.option-btn'); if (btn && btn.dataset.value !== (pendingTranscode || transcodeConfig).format) markTranscodeDirty({format: btn.dataset.value}); });
transcodeBitrate.addEventListener('click', event => { const btn = event.target.closest('.option-btn'); if (btn && Number(btn.dataset.value) !== (pendingTranscode || transcodeConfig).bitrate) markTranscodeDirty({bitrate: Number(btn.dataset.value)}); });
transcodeCacheDir.addEventListener('change', () => markTranscodeDirty({cacheDir: transcodeCacheDir.value}));
transcodeCacheSize.addEventListener('change', () => markTranscodeDirty({cacheSizeGB: Number(transcodeCacheSize.value)}));
transcodeSave.addEventListener('click', applyTranscodeConfig);
transcodeCacheClear.addEventListener('click', async () => { await fetch('/api/transcode-cache/clear', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}); refreshTranscodeCacheInfo(); });

// ============ 界面主题（亮色/暗色，localStorage 记忆，亮色兜底）============
const themeToggle = document.querySelector('#themeToggle'), themeLabel = document.querySelector('#themeLabel');
function currentTheme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
function applyTheme(theme) {
  const value = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem('theme', value); } catch { /* 隐私模式等场景忽略，刷新回亮色兜底 */ }
  if (themeToggle) themeToggle.checked = value === 'light';
  if (themeLabel) themeLabel.textContent = value === 'light' ? '亮色' : '暗色';
}
themeToggle.addEventListener('change', () => applyTheme(themeToggle.checked ? 'light' : 'dark'));
// 实际主题已由 <head> 内联脚本按 localStorage 提前设置（防闪烁），这里只同步开关状态
applyTheme(currentTheme());

// 播放 URL：转码开启时带 transcode=1（服务端再按源文件码率判定是否真的转码）
function streamUrl(track) { return transcodeConfig.enabled ? `/api/stream?id=${encodeURIComponent(track.path)}&transcode=1` : `/api/stream?id=${encodeURIComponent(track.path)}`; }
// 预转播放列表下一首的开头缓冲（尽力而为）
function preloadNextTrack() {
  if (!transcodeConfig.enabled || !playQueue.length || playIndex < 0) return;
  const next = playQueue[(playIndex + 1) % playQueue.length];
  if (next) fetch('/api/transcode/preload', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: next.path})}).catch(() => {});
}

initMediaSession();
loadData();
// 入口页：展示 3 秒后淡出，给后台音乐库加载留时间
// splash 期间锁定滚动：歌曲列表渲染撑高页面时滚动条不会提前出现
document.body.style.overflow = 'hidden';
setTimeout(() => {
  const splash = document.querySelector('#splash');
  if (splash && !splash.classList.contains('fade')) {
    splash.classList.add('fade');
    setTimeout(() => {
      splash.style.display = 'none';
      // 解锁滚动：滚动条与首页主体同帧出现，不再有"滚动条先行"的错位
      document.body.style.overflow = '';
    }, 600);
  }
}, 3000);
