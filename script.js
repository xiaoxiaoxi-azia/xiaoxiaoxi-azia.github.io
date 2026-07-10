(function () {
  const state = {
    songs: [],
    videos: [],
    query: '',
    category: '全部',
    sort: 'default',
    page: 1,
    pageSize: 30,
  };

  const els = {
    songCount: document.querySelector('#songCount'),
    randomSongs: document.querySelectorAll('[data-random-song]'),
    resultSummary: document.querySelector('#resultSummary'),
    searchInput: document.querySelector('#searchInput'),
    categoryFilters: document.querySelector('#categoryFilters'),
    categorySelect: document.querySelector('#categorySelect'),
    sortButtons: document.querySelectorAll('[data-sort]'),
    sortSelect: document.querySelector('#sortSelect'),
    statusMessage: document.querySelector('#statusMessage'),
    songGrid: document.querySelector('#songGrid'),
    pagination: document.querySelector('#pagination'),
    videoTrack: document.querySelector('#videoTrack'),
    liveLink: document.querySelector('#liveLink'),
    toast: document.querySelector('#toast'),
  };

  let toastTimer;
  let renderFrame;
  let videoAutoFrame;
  let videoAutoPreviousTime;
  let videoAutoPausedUntil = 0;
  let videoRailKeyboardFocused = false;
  let videoDragState = null;
  let suppressVideoClick = false;
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const collator = new Intl.Collator('zh-Hans-u-co-pinyin', {
    numeric: true,
    sensitivity: 'base',
  });

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === ',' && !inQuotes) {
        row.push(cell);
        cell = '';
        continue;
      }

      if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && next === '\n') {
          index += 1;
        }
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        continue;
      }

      cell += char;
    }

    row.push(cell);
    rows.push(row);

    const usefulRows = rows.filter((item) => item.some((value) => value.trim() !== ''));
    if (usefulRows.length === 0) {
      return [];
    }

    const headers = usefulRows[0].map((header) => header.trim());
    return usefulRows.slice(1).map((item) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = (item[index] || '').trim();
      });
      return record;
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
  }

  function normalize(value) {
    return String(value || '').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
  }

  function getCategories() {
    const categories = [];
    state.songs.forEach((song) => {
      if (song.category && !categories.includes(song.category)) {
        categories.push(song.category);
      }
    });
    return ['全部'].concat(categories);
  }

  function getFilteredSongs() {
    const query = normalize(state.query);
    const filtered = state.songs.filter((song) => {
      const matchesCategory = state.category === '全部' || song.category === state.category;
      const matchesQuery = !query
        || normalize(song.title).includes(query)
        || normalize(song.singer).includes(query);
      return matchesCategory && matchesQuery;
    });

    if (state.sort === 'initial') {
      return filtered.sort((left, right) => collator.compare(left.title, right.title));
    }

    if (state.sort === 'length') {
      return filtered.sort((left, right) => {
        const diff = left.title.length - right.title.length;
        return diff || collator.compare(left.title, right.title);
      });
    }

    return filtered;
  }

  function toPixels(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getPageSize() {
    const grid = els.songGrid;
    const styles = window.getComputedStyle(grid);
    const width = grid.clientWidth;
    const height = grid.clientHeight;
    const rowGap = toPixels(styles.rowGap, 5);
    const columnGap = toPixels(styles.columnGap, 5);
    const rowHeight = toPixels(styles.getPropertyValue('--song-row-height'), 33);
    const minColumnWidth = toPixels(styles.getPropertyValue('--song-min-width'), 172);

    if (!width || !height) {
      return window.matchMedia('(max-width: 520px)').matches ? 12 : 48;
    }

    const columns = window.matchMedia('(max-width: 520px)').matches
      ? 1
      : Math.max(1, Math.floor((width + columnGap) / (minColumnWidth + columnGap)));
    const rows = Math.max(3, Math.floor((height + rowGap) / (rowHeight + rowGap)));

    return columns * rows;
  }

  function decodeCsvBuffer(buffer) {
    const bytes = new Uint8Array(buffer);

    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }

    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    } catch (error) {
      return new TextDecoder('gb18030').decode(bytes).replace(/^\uFEFF/, '');
    }
  }

  async function loadCsv(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`无法加载 ${path}`);
    }
    return parseCsv(decodeCsvBuffer(await response.arrayBuffer()));
  }

  function getSinger(song) {
    return song.singer || '未知歌手';
  }

  function renderCategories() {
    const categories = getCategories();

    els.categoryFilters.innerHTML = categories
      .map((category) => {
        const active = category === state.category ? ' class="is-active"' : '';
        return `<button type="button"${active} data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`;
      })
      .join('');

    els.categorySelect.innerHTML = categories
      .map((category) => {
        const selected = category === state.category ? ' selected' : '';
        return `<option value="${escapeAttribute(category)}"${selected}>${escapeHtml(category)}</option>`;
      })
      .join('');
  }

  function syncSortControls() {
    els.sortButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.sort === state.sort);
    });
    els.sortSelect.value = state.sort;
  }

  function setSort(sort) {
    state.sort = sort;
    state.page = 1;
    syncSortControls();
    renderSongs();
  }

  function scheduleRenderSongs() {
    window.cancelAnimationFrame(renderFrame);
    renderFrame = window.requestAnimationFrame(() => {
      renderSongs();
    });
  }

  function isMobileBrowser() {
    return /Android|iPhone|iPad|iPod|Windows Phone|OpenHarmony/i.test(navigator.userAgent);
  }

  function openLiveAppWithFallback(event) {
    if (!isMobileBrowser()) {
      return;
    }

    const link = event.currentTarget;
    const appUrl = link.dataset.appUrl;
    const webUrl = link.href;
    if (!appUrl || !webUrl) {
      return;
    }

    event.preventDefault();

    let pageHidden = document.hidden;
    let fallbackTimer;

    function cleanup() {
      window.clearTimeout(fallbackTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
    }

    function handleVisibilityChange() {
      if (!document.hidden) {
        return;
      }
      pageHidden = true;
      cleanup();
    }

    function handlePageHide() {
      pageHidden = true;
      cleanup();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);

    fallbackTimer = window.setTimeout(() => {
      cleanup();
      if (!pageHidden && !document.hidden) {
        window.location.href = webUrl;
      }
    }, 3000);

    window.location.href = appUrl;
  }

  function prepareSongTextScroll() {
    window.requestAnimationFrame(() => {
      els.songGrid.querySelectorAll('.song-title, .song-singer').forEach((field) => {
        const overflow = Math.ceil(field.scrollWidth - field.clientWidth);
        field.classList.toggle('is-scrollable', overflow > 2);
        field.style.setProperty('--song-scroll-distance', `${Math.max(0, overflow)}px`);
        field.style.setProperty('--song-scroll-duration', `${Math.min(5.4, Math.max(2.8, overflow / 26 + 2.2))}s`);
      });
    });
  }

  function renderSongs() {
    state.pageSize = getPageSize();
    const filtered = getFilteredSongs();
    const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const start = (state.page - 1) * state.pageSize;
    const pageItems = filtered.slice(start, start + state.pageSize);

    els.resultSummary.textContent = `${filtered.length} 首 · 第 ${state.page} / ${totalPages} 页`;

    if (pageItems.length === 0) {
      els.statusMessage.textContent = '没有找到匹配歌曲。';
      els.songGrid.innerHTML = '';
    } else {
      els.statusMessage.textContent = '';
      els.songGrid.innerHTML = pageItems.map((song) => `
        <button type="button" class="song-row" data-title="${escapeAttribute(song.title)}" title="复制：点歌 ${escapeAttribute(song.title)}">
          <div class="song-title"><span class="song-title-text">${escapeHtml(song.title)}</span></div>
          <div class="song-singer"><span class="song-singer-text">${escapeHtml(getSinger(song))}</span></div>
          <div class="song-category">${escapeHtml(song.category)}</div>
        </button>
      `).join('');
      prepareSongTextScroll();
    }

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    const pageButtons = [];
    const visiblePages = window.matchMedia('(max-width: 520px)').matches ? 3 : 5;
    const halfWindow = Math.floor(visiblePages / 2);
    const maxStart = Math.max(1, totalPages - visiblePages + 1);
    const start = Math.min(Math.max(1, state.page - halfWindow), maxStart);
    const end = Math.min(totalPages, start + visiblePages - 1);

    pageButtons.push(`<button type="button" class="pagination-first" data-page="1" ${state.page === 1 ? 'disabled' : ''}>首页</button>`);
    pageButtons.push(`<button type="button" class="pagination-prev" data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>上一页</button>`);
    for (let page = start; page <= end; page += 1) {
      pageButtons.push(`<button type="button" data-page="${page}" class="pagination-page-number${page === state.page ? ' is-active' : ''}">${page}</button>`);
    }
    pageButtons.push(`<button type="button" class="pagination-next" data-page="${state.page + 1}" ${state.page === totalPages ? 'disabled' : ''}>下一页</button>`);
    pageButtons.push(`<button type="button" class="pagination-last" data-page="${totalPages}" ${state.page === totalPages ? 'disabled' : ''}>末页</button>`);

    const pageOptions = Array.from({ length: totalPages }, (_, index) => {
      const page = index + 1;
      return `<option value="${page}"${page === state.page ? ' selected' : ''}>第 ${page} / ${totalPages} 页</option>`;
    }).join('');
    pageButtons.push(`<label class="page-select"><span class="sr-only">选择页码</span><select id="pageSelect" aria-label="选择页码">${pageOptions}</select></label>`);

    els.pagination.innerHTML = pageButtons.join('');
  }

  function renderVideos() {
    if (state.videos.length === 0) {
      els.videoTrack.innerHTML = '<p class="status">暂无投稿视频。</p>';
      return;
    }

    const cards = state.videos.map((video) => `
      <a class="video-card" href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer">
        <img src="${escapeHtml(video.cover)}" alt="${escapeHtml(video.title)}" loading="lazy" referrerpolicy="no-referrer">
        <div class="video-body">
          <div class="video-title">${escapeHtml(video.title)}</div>
          <div class="video-meta">
            <span>${escapeHtml(video.date)}</span>
            <span>${escapeHtml(video.tag || '投稿')}</span>
          </div>
        </div>
      </a>
    `).join('');

    els.videoTrack.innerHTML = cards + cards;
  }

  function pauseVideoAutoScroll(duration = 2600) {
    videoAutoPausedUntil = performance.now() + duration;
  }

  function startVideoAutoScroll() {
    if (reducedMotionQuery.matches) {
      return;
    }

    const rail = els.videoTrack.closest('.video-rail');
    window.cancelAnimationFrame(videoAutoFrame);
    videoAutoPreviousTime = undefined;

    function step(time) {
      const elapsed = videoAutoPreviousTime === undefined
        ? 0
        : Math.min(64, Math.max(0, time - videoAutoPreviousTime));
      videoAutoPreviousTime = time;

      if (
        !document.hidden
        && time >= videoAutoPausedUntil
        && !videoDragState
        && !videoRailKeyboardFocused
        && rail.scrollWidth > rail.clientWidth
      ) {
        rail.scrollLeft += elapsed * 0.035;
        const resetPoint = Math.max(0, els.videoTrack.scrollWidth / 2);
        if (resetPoint && rail.scrollLeft >= resetPoint) {
          rail.scrollLeft %= resetPoint;
        }
      }

      videoAutoFrame = window.requestAnimationFrame(step);
    }

    videoAutoFrame = window.requestAnimationFrame(step);
  }

  function handleReducedMotionChange(event) {
    if (event.matches) {
      window.cancelAnimationFrame(videoAutoFrame);
      videoAutoFrame = undefined;
      videoAutoPreviousTime = undefined;
      return;
    }

    startVideoAutoScroll();
  }

  function handleVideoVisibilityChange() {
    videoAutoPreviousTime = undefined;
    if (document.hidden || reducedMotionQuery.matches) {
      return;
    }

    startVideoAutoScroll();
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 1600);
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  async function copySong(title) {
    const command = `点歌 ${title}`;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(command);
      } catch (error) {
        fallbackCopy(command);
      }
    } else {
      fallbackCopy(command);
    }
    showToast(`已复制“${command}”，快去直播间点歌吧～`);
  }

  function copyRandomSong() {
    const candidates = getFilteredSongs();
    if (candidates.length === 0) {
      showToast('当前筛选下没有可随机的歌曲。');
      return;
    }

    const song = candidates[Math.floor(Math.random() * candidates.length)];
    copySong(song.title).catch(() => {
      showToast('复制失败，请再试一次。');
    });
  }

  function bindEvents() {
    els.liveLink.addEventListener('click', openLiveAppWithFallback);
    els.randomSongs.forEach((button) => {
      button.addEventListener('click', () => {
        copyRandomSong();
      });
    });

    els.searchInput.addEventListener('input', (event) => {
      state.query = event.target.value;
      state.page = 1;
      renderSongs();
    });

    els.categoryFilters.addEventListener('click', (event) => {
      const button = event.target.closest('[data-category]');
      if (!button) {
        return;
      }
      state.category = button.dataset.category;
      state.page = 1;
      renderCategories();
      renderSongs();
    });

    els.categorySelect.addEventListener('change', (event) => {
      state.category = event.target.value;
      state.page = 1;
      renderCategories();
      renderSongs();
    });

    els.songGrid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-title]');
      if (!button) {
        return;
      }
      copySong(button.dataset.title).catch(() => {
        showToast('复制失败，请手动复制歌名。');
      });
    });

    els.sortButtons.forEach((button) => {
      button.addEventListener('click', () => {
        setSort(button.dataset.sort);
      });
    });

    els.sortSelect.addEventListener('change', (event) => {
      setSort(event.target.value);
    });

    els.pagination.addEventListener('click', (event) => {
      const button = event.target.closest('[data-page]');
      if (!button || button.disabled) {
        return;
      }
      state.page = Number(button.dataset.page);
      renderSongs();
    });

    els.pagination.addEventListener('change', (event) => {
      const select = event.target.closest('#pageSelect');
      if (!select) {
        return;
      }
      state.page = Number(select.value);
      renderSongs();
    });

    window.addEventListener('resize', () => {
      scheduleRenderSongs();
    });

    window.addEventListener('load', () => {
      scheduleRenderSongs();
    });

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(scheduleRenderSongs).catch(() => {});
    }
  }

  function bindVideoDrag() {
    const rail = els.videoTrack.closest('.video-rail');

    rail.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse') {
        pauseVideoAutoScroll();
        return;
      }

      if (event.button !== 0) {
        return;
      }

      videoDragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        scrollLeft: rail.scrollLeft,
        moved: false,
      };
      rail.classList.add('is-dragging');
      rail.setPointerCapture(event.pointerId);
    });

    rail.addEventListener('pointermove', (event) => {
      if (!videoDragState || event.pointerId !== videoDragState.pointerId) {
        return;
      }

      const deltaX = event.clientX - videoDragState.startX;
      if (Math.abs(deltaX) > 3) {
        videoDragState.moved = true;
      }
      rail.scrollLeft = videoDragState.scrollLeft - deltaX;
    });

    function stopVideoDrag(event) {
      if (!videoDragState || event.pointerId !== videoDragState.pointerId) {
        return;
      }

      suppressVideoClick = videoDragState.moved;
      videoDragState = null;
      rail.classList.remove('is-dragging');
      window.setTimeout(() => {
        suppressVideoClick = false;
      }, 0);
    }

    rail.addEventListener('pointerup', stopVideoDrag);
    rail.addEventListener('pointercancel', stopVideoDrag);
    rail.addEventListener('click', (event) => {
      if (!suppressVideoClick) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }, true);

    rail.addEventListener('wheel', () => {
      pauseVideoAutoScroll(1200);
    }, { passive: true });
    rail.addEventListener('focusin', (event) => {
      videoRailKeyboardFocused = event.target.matches(':focus-visible');
    });
    rail.addEventListener('focusout', (event) => {
      if (!rail.contains(event.relatedTarget)) {
        videoRailKeyboardFocused = false;
      }
    });
  }

  async function init() {
    try {
      const results = await Promise.all([
        loadCsv('data/songs.csv'),
        loadCsv('data/videos.csv'),
      ]);

      state.songs = results[0].filter((song) => song.title);
      state.videos = results[1].filter((video) => video.title && video.url);
      els.songCount.textContent = `${state.songs.length} 首可点歌曲`;
      els.songCount.dataset.mobileText = `${state.songs.length}首`;

      renderVideos();
      renderCategories();
      bindEvents();
      bindVideoDrag();
      startVideoAutoScroll();
      reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
      document.addEventListener('visibilitychange', handleVideoVisibilityChange);
      scheduleRenderSongs();
    } catch (error) {
      els.statusMessage.textContent = `${error.message}。请通过本地服务器或 GitHub Pages 打开页面。`;
      els.songCount.textContent = '加载失败';
      els.songCount.dataset.mobileText = '加载失败';
      els.resultSummary.textContent = '加载失败';
    }
  }

  init();
}());
