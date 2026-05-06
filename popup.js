document.addEventListener('DOMContentLoaded', init);

function init() {
  document.getElementById('recordBtn').addEventListener('click', startRecording);
  document.getElementById('stopBtn').addEventListener('click', stopRecording);
  document.getElementById('recordMoreBtn').addEventListener('click', startRecording);
  document.getElementById('exportCSV').addEventListener('click', exportCSV);
  document.getElementById('exportJSON').addEventListener('click', exportJSON);
  document.getElementById('sendToLiveScope').addEventListener('click', sendToLiveScope);
  document.getElementById('clearBtn').addEventListener('click', clearData);

  // Check if we're currently recording
  chrome.storage.local.get(['recording', 'captures'], function(result) {
    if (result.recording) {
      showRecordingView();
      updateCaptureCount(result.captures || []);
    } else if (result.captures && result.captures.length > 0) {
      showResultsView(result.captures);
    }
  });
}

// ===== RECORDING =====
function startRecording() {
  chrome.storage.local.set({ recording: true }, function() {
    showRecordingView();
    feedLog('Recording started — browse Kalodata now', 'success');
  });
}

function stopRecording() {
  chrome.storage.local.set({ recording: false }, function() {
    chrome.storage.local.get(['captures'], function(result) {
      const captures = result.captures || [];
      showResultsView(captures);
    });
  });
}

function showRecordingView() {
  document.getElementById('startView').style.display = 'none';
  document.getElementById('recordingView').style.display = 'block';
  document.getElementById('resultsView').style.display = 'none';
  document.getElementById('recordingIndicator').classList.add('active');

  // Poll for new captures
  pollCaptures();
}

function showResultsView(captures) {
  document.getElementById('startView').style.display = 'none';
  document.getElementById('recordingView').style.display = 'none';
  document.getElementById('resultsView').style.display = 'block';
  document.getElementById('recordingIndicator').classList.remove('active');

  processAndRender(captures);
}

let pollInterval;
function pollCaptures() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    chrome.storage.local.get(['captures', 'recording'], function(result) {
      if (!result.recording) {
        clearInterval(pollInterval);
        return;
      }
      updateCaptureCount(result.captures || []);
    });
  }, 1000);
}

function updateCaptureCount(captures) {
  document.getElementById('captureCounter').textContent = captures.length;
}

// ===== PROCESS CAPTURED DATA =====
function processAndRender(captures) {
  const creators = new Map(); // handle -> { revenue, livestreams, products }
  const livestreams = [];
  const products = [];

  // Track which creator we're looking at based on page URL
  let lastCreatorId = '';
  let lastCreatorName = '';

  captures.forEach(c => {
    if (!c.data) return;

    // Extract creator context from page URL
    const pageCreatorId = extractCreatorIdFromUrl(c.pageUrl);
    if (pageCreatorId) {
      lastCreatorId = pageCreatorId;
    }

    const type = c.captureType || 'unknown';
    const items = Array.isArray(c.data) ? c.data : (c.data.records || c.data.list || [c.data]);

    // Handle pagination wrapper: {records: [...], total: N}
    let itemList = items;
    if (!Array.isArray(items) && items.records) {
      itemList = items.records;
    } else if (!Array.isArray(items) && items.list) {
      itemList = items.list;
    }
    if (!Array.isArray(itemList)) itemList = [itemList];

    itemList.forEach(item => {
      if (!item || typeof item !== 'object') return;

      // CREATOR RANKINGS — from /creator/queryList
      if (type === 'creator_rankings') {
        const handle = item.handle || item.nickname || item.username || '';
        if (handle) {
          creators.set(handle, {
            handle,
            nickname: item.nickname || item.handle || '',
            revenue: formatNum(item.revenue),
            sale: formatNum(item.sale),
            followers: formatNum(item.followers),
            id: item.uid || item.id || '',
            livestreams: [],
            products: [],
            durations: []
          });
        }
      }

      // CREATOR LIVESTREAMS — from /creator/detail/video/queryList
      if (type === 'creator_livestreams' || type === 'creator_detail') {
        const creatorName = findCreatorByPageId(pageCreatorId, creators) || lastCreatorName || '';
        const ls = {
          id: item.id || item.videoId || '',
          title: item.title || item.description || '',
          duration: formatDuration(item.duration || item.live_duration || item.liveDuration || ''),
          revenue: formatNum(item.revenue),
          gpm: formatNum(item.gpm),
          sale: formatNum(item.sale),
          views: formatNum(item.views || item.viewCount || item.view_count),
          creator: creatorName,
          date: item.date || item.createTime || item.liveTime || ''
        };
        livestreams.push(ls);

        if (creatorName && creators.has(creatorName)) {
          const cr = creators.get(creatorName);
          cr.livestreams.push(ls);
          if (ls.duration) cr.durations.push(ls.duration);
        }
      }

      // PRODUCTS — from /video/detail/stat/queryProductList
      if (type === 'products') {
        const prod = {
          title: item.title || item.productName || item.product_name || item.name || '',
          price: formatPrice(item.price || item.unitPrice || item.unit_price || ''),
          revenue: formatNum(item.revenue),
          sale: formatNum(item.sale || item.saleCount || item.sale_count),
          id: item.id || item.productId || item.product_id || '',
          image: item.image || item.coverUrl || item.cover_url || ''
        };
        if (prod.title) {
          products.push(prod);

          // Try to attach to a creator via the livestream page context
          const creatorName = findCreatorByPageId(pageCreatorId, creators);
          if (creatorName && creators.has(creatorName)) {
            const cr = creators.get(creatorName);
            if (!cr.products.find(p => p.title === prod.title)) {
              cr.products.push(prod);
            }
          }
        }
      }

      // GENERIC FALLBACK — try to identify data by its shape
      if (type === 'unknown' || type === 'video_detail') {
        // Creator-like
        if ((item.handle || item.nickname) && !item.duration && !item.productName) {
          const handle = item.handle || item.nickname || '';
          if (handle && !creators.has(handle)) {
            creators.set(handle, {
              handle, nickname: item.nickname || '', revenue: formatNum(item.revenue),
              sale: formatNum(item.sale), followers: formatNum(item.followers),
              id: item.uid || item.id || '', livestreams: [], products: [], durations: []
            });
          }
        }
        // Livestream-like
        if (item.duration || item.liveDuration || item.gpm) {
          const creatorName = item.handle || findCreatorByPageId(pageCreatorId, creators) || '';
          livestreams.push({
            id: item.id || '', title: item.title || '', duration: formatDuration(item.duration || item.liveDuration || ''),
            revenue: formatNum(item.revenue), gpm: formatNum(item.gpm), sale: formatNum(item.sale),
            views: formatNum(item.views), creator: creatorName, date: item.date || ''
          });
        }
        // Product-like
        if (item.title && (item.price || item.unitPrice || item.productId)) {
          const prod = { title: item.title || '', price: formatPrice(item.price || item.unitPrice || ''),
            revenue: formatNum(item.revenue), sale: formatNum(item.sale), id: item.id || item.productId || '' };
          products.push(prod);
        }
      }
    });
  });

  // Render
  document.getElementById('creatorCount').textContent = creators.size;
  document.getElementById('livestreamCount').textContent = livestreams.length;
  document.getElementById('productCount').textContent = products.length;

  const tbody = document.getElementById('resultsBody');
  const rows = [];

  // Show creator rows with their livestream/product counts
  creators.forEach((cr, handle) => {
    const lsCount = cr.livestreams.length;
    const prodNames = cr.products.map(p => p.title).slice(0, 3).join(', ');
    const prodDisplay = prodNames || (cr.products.length > 0 ? cr.products.length + ' products' : '—');
    const durDisplay = cr.durations.length > 0 ? cr.durations[0] : '—';
    rows.push(`<tr>
      <td>${esc(handle)}${lsCount > 0 ? ' <small style="color:#4ecdc4">(' + lsCount + ' streams)</small>' : ''}</td>
      <td>${esc(cr.revenue) || '—'}</td>
      <td>${esc(durDisplay)}</td>
      <td class="products" title="${esc(cr.products.map(p => p.title).join(', '))}">${esc(prodDisplay)}</td>
    </tr>`);
  });

  // Show standalone livestreams not attached to creators
  const orphanStreams = livestreams.filter(ls => !ls.creator || !creators.has(ls.creator));
  orphanStreams.forEach(ls => {
    rows.push(`<tr>
      <td>${esc(ls.creator) || '—'}</td>
      <td>${esc(ls.revenue) || '—'}</td>
      <td>${esc(ls.duration) || '—'}</td>
      <td class="products">—</td>
    </tr>`);
  });

  tbody.innerHTML = rows.length > 0 ? rows.join('') : '<tr><td colspan="4" style="text-align:center;color:#777;padding:20px">No data captured yet. Browse Kalodata creator pages while recording.</td></tr>';

  // Store processed data for export
  chrome.storage.local.set({
    processedCreators: Array.from(creators.values()),
    processedLivestreams: livestreams,
    processedProducts: products
  });
}

function extractCreatorIdFromUrl(url) {
  if (!url) return '';
  const match = url.match(/[?&]id=(\d+)/);
  return match ? match[1] : '';
}

function findCreatorByPageId(id, creators) {
  if (!id) return '';
  for (const [handle, cr] of creators) {
    if (cr.id === id) return handle;
  }
  return '';
}

function formatNum(val) {
  if (!val && val !== 0) return '';
  if (typeof val === 'string') return val;
  if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
  if (val >= 1000) return (val / 1000).toFixed(1) + 'K';
  return String(val);
}

function formatDuration(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  // If it's seconds, convert
  if (typeof val === 'number' && val > 60) {
    const h = Math.floor(val / 3600);
    const m = Math.floor((val % 3600) / 60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }
  return String(val);
}

function formatPrice(val) {
  if (!val && val !== 0) return '';
  if (typeof val === 'string') return val;
  return '$' + Number(val).toFixed(2);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function extractCreatorFromCapture(capture) {
  if (!capture.pageUrl) return '';
  const match = capture.pageUrl.match(/@([^/?&]+)/) || capture.pageUrl.match(/creator\/([^/?&]+)/);
  return match ? match[1] : '';
}

// ===== EXPORTS =====
function exportCSV() {
  chrome.storage.local.get(['processedCreators', 'processedLivestreams'], function(result) {
    const creators = result.processedCreators || [];
    if (creators.length === 0) {
      setStatus('No data to export');
      return;
    }

    const headers = ['creator', 'revenue', 'items_sold', 'followers', 'livestream_count', 'durations', 'products'];
    const csv = [
      headers.join(','),
      ...creators.map(cr => [
        `"${cr.handle}"`,
        `"${cr.revenue}"`,
        `"${cr.sale}"`,
        `"${cr.followers}"`,
        `"${cr.livestreams.length}"`,
        `"${cr.durations.join('; ')}"`,
        `"${cr.products.map(p => p.title).join('; ').replace(/"/g, '""')}"`
      ].join(','))
    ].join('\n');

    downloadFile(csv, `livescope-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv');
    setStatus(`Exported ${creators.length} creators`);
  });
}

function exportJSON() {
  chrome.storage.local.get(['processedCreators', 'processedLivestreams', 'processedProducts'], function(result) {
    const json = JSON.stringify({
      creators: result.processedCreators || [],
      livestreams: result.processedLivestreams || [],
      products: result.processedProducts || [],
      exportedAt: new Date().toISOString()
    }, null, 2);
    downloadFile(json, `livescope-${new Date().toISOString().slice(0,10)}.json`, 'application/json');
    setStatus('JSON exported');
  });
}

function sendToLiveScope() {
  chrome.storage.local.get(['processedCreators'], function(result) {
    const creators = result.processedCreators || [];
    if (creators.length === 0) {
      setStatus('No data to send');
      return;
    }

    const headers = ['creator', 'revenue', 'items_sold', 'followers', 'livestream_count', 'durations', 'products'];
    const csv = [
      headers.join(','),
      ...creators.map(cr => [
        `"${cr.handle}"`,
        `"${cr.revenue}"`,
        `"${cr.sale}"`,
        `"${cr.followers}"`,
        `"${cr.livestreams.length}"`,
        `"${cr.durations.join('; ')}"`,
        `"${cr.products.map(p => p.title).join('; ').replace(/"/g, '""')}"`
      ].join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const form = new FormData();
    form.append('file', blob, 'livescope.csv');

    fetch('https://livescope-production.up.railway.app/api/upload', {
      method: 'POST',
      body: form
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        setStatus('Error: ' + data.error);
      } else {
        setStatus(`Sent ${data.rows} rows to LiveScope`);
        window.open('https://livescope-production.up.railway.app', '_blank');
      }
    })
    .catch(e => setStatus('Send failed: ' + e.message));
  });
}

function clearData() {
  if (confirm('Clear all captured data?')) {
    chrome.storage.local.set({
      captures: [],
      recording: false,
      processedCreators: [],
      processedLivestreams: [],
      processedProducts: []
    }, function() {
      document.getElementById('startView').style.display = 'block';
      document.getElementById('recordingView').style.display = 'none';
      document.getElementById('resultsView').style.display = 'none';
      document.getElementById('recordingIndicator').classList.remove('active');
      setStatus('Cleared');
    });
  }
}

// ===== HELPERS =====
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function setStatus(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  setTimeout(() => el.textContent = '', 5000);
}

function feedLog(msg, type) {
  const el = document.getElementById('liveFeed');
  const line = document.createElement('div');
  if (type) line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
