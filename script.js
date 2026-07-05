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
    toast: document.querySelector('#toast'),
  };

  let toastTimer;
  let renderFrame;
  let videoAutoFrame;
  let videoAutoPreviousTime;
  let videoAutoPausedUntil = 0;
  let videoDragState = null;
  let suppressVideoClick = false;

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

  async function loadCsv(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`无法加载 ${path}`);
    }
    return parseCsv(await response.text());
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
          <div class="song-title">${escapeHtml(song.title)}</div>
          <div class="song-singer">${escapeHtml(getSinger(song))}</div>
          <div class="song-category">${escapeHtml(song.category)}</div>
        </button>
      `).join('');
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

    pageButtons.push(`<button type="button" data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>上一页</button>`);
    for (let page = start; page <= end; page += 1) {
      pageButtons.push(`<button type="button" data-page="${page}" class="${page === state.page ? 'is-active' : ''}">${page}</button>`);
    }
    pageButtons.push(`<button type="button" data-page="${state.page + 1}" ${state.page === totalPages ? 'disabled' : ''}>下一页</button>`);

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
    const rail = els.videoTrack.closest('.video-rail');
    window.cancelAnimationFrame(videoAutoFrame);
    videoAutoPreviousTime = undefined;

    function step(time) {
      if (videoAutoPreviousTime === undefined) {
        videoAutoPreviousTime = time;
      }

      const elapsed = time - videoAutoPreviousTime;
      videoAutoPreviousTime = time;

      if (time >= videoAutoPausedUntil && !videoDragState && rail.scrollWidth > rail.clientWidth) {
        rail.scrollLeft += elapsed * 0.035;
        const resetPoint = Math.max(0, els.videoTrack.scrollWidth / 2);
        if (resetPoint && rail.scrollLeft >= resetPoint) {
          rail.scrollLeft -= resetPoint;
        }
      }

      videoAutoFrame = window.requestAnimationFrame(step);
    }

    videoAutoFrame = window.requestAnimationFrame(step);
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
      await navigator.clipboard.writeText(command);
    } else {
      fallbackCopy(command);
    }
    showToast(`已复制“${command}”，快去直播间点歌吧～`);
  }

  function bindEvents() {
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
      pauseVideoAutoScroll();

      if (event.pointerType !== 'mouse' || event.button !== 0) {
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

    rail.addEventListener('mouseenter', () => {
      pauseVideoAutoScroll(900);
    });
    rail.addEventListener('focusin', () => {
      pauseVideoAutoScroll(1800);
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

      renderVideos();
      renderCategories();
      bindEvents();
      bindVideoDrag();
      startVideoAutoScroll();
      scheduleRenderSongs();
    } catch (error) {
      els.statusMessage.textContent = `${error.message}。请通过本地服务器或 GitHub Pages 打开页面。`;
      els.resultSummary.textContent = '加载失败';
    }
  }

  init();
}());
