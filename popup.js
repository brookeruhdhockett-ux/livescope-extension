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

  // Build ID-to-handle lookup from creator rankings first
  const idToHandle = new Map();

  // PASS 1: Extract all creators from rankings captures
  captures.forEach(c => {
    if (!c.data) return;
    const type = c.captureType || 'unknown';
    if (type !== 'creator_rankings') return;

    const itemList = unwrapData(c.data);
    itemList.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const handle = item.handle || item.nickname || item.username || '';
      if (!handle) return;

      const id = String(item.uid || item.id || '');
      creators.set(handle, {
        handle,
        nickname: item.nickname || item.handle || '',
        revenue: item.revenue,
        sale: item.sale,
        followers: item.followers,
        id: id,
        livestreams: [],
        products: [],
        durations: []
      });
      if (id) idToHandle.set(id, handle);
    });
  });

  // PASS 2: Process livestreams, products, and everything else
  captures.forEach(c => {
    if (!c.data) return;
    const type = c.captureType || 'unknown';
    if (type === 'creator_rankings') return; // Already processed

    // Figure out which creator this capture belongs to
    const pageCreatorId = extractCreatorIdFromUrl(c.pageUrl);
    const creatorHandle = idToHandle.get(pageCreatorId) || '';

    // Also check the request params for creator ID
    const paramId = c.params ? String(c.params.id || '') : '';
    const creatorFromParams = idToHandle.get(paramId) || '';
    const bestCreator = creatorHandle || creatorFromParams;

    const itemList = unwrapData(c.data);

    itemList.forEach(item => {
      if (!item || typeof item !== 'object') return;

      // LIVESTREAMS — from creator detail pages
      if (type === 'creator_livestreams' || type === 'creator_detail' ||
          (item.duration || item.liveDuration || item.live_duration || item.gpm)) {
        const ls = {
          id: item.id || item.videoId || '',
          title: item.title || item.description || '',
          duration: item.duration || item.live_duration || item.liveDuration || 0,
          revenue: item.revenue || 0,
          gpm: item.gpm || 0,
          sale: item.sale || 0,
          views: item.views || item.viewCount || item.view_count || 0,
          creator: bestCreator,
          date: item.date || item.createTime || item.liveTime || ''
        };
        livestreams.push(ls);

        if (bestCreator && creators.has(bestCreator)) {
          const cr = creators.get(bestCreator);
          cr.livestreams.push(ls);
          if (ls.duration) cr.durations.push(ls.duration);
        }
      }

      // PRODUCTS — from product list endpoints
      if (type === 'products' || item.productName || item.product_name ||
          (item.title && (item.price || item.unitPrice || item.unit_price))) {
        const prod = {
          title: item.title || item.productName || item.product_name || item.name || '',
          price: item.price || item.unitPrice || item.unit_price || 0,
          revenue: item.revenue || 0,
          sale: item.sale || item.saleCount || item.sale_count || 0,
          id: item.id || item.productId || item.product_id || '',
          image: item.image || item.coverUrl || item.cover_url || '',
          creator: bestCreator
        };
        if (prod.title) {
          products.push(prod);
          if (bestCreator && creators.has(bestCreator)) {
            const cr = creators.get(bestCreator);
            if (!cr.products.find(p => p.title === prod.title)) {
              cr.products.push(prod);
            }
          }
        }
      }

      // GENERIC FALLBACK for unknown types — try to identify by shape
      if (type === 'unknown' || type === 'video_detail') {
        if ((item.handle || item.nickname) && !creators.has(item.handle || item.nickname)) {
          const handle = item.handle || item.nickname || '';
          const id = String(item.uid || item.id || '');
          creators.set(handle, {
            handle, nickname: item.nickname || '', revenue: item.revenue,
            sale: item.sale, followers: item.followers,
            id: id, livestreams: [], products: [], durations: []
          });
          if (id) idToHandle.set(id, handle);
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

  // Show creator rows
  creators.forEach((cr, handle) => {
    const lsCount = cr.livestreams.length;
    const prodCount = cr.products.length;
    const prodNames = cr.products.map(p => p.title).slice(0, 3).join(', ');
    const prodDisplay = prodNames || (prodCount > 0 ? prodCount + ' products' : '—');

    // Best duration: average or first
    let durDisplay = '—';
    if (cr.durations.length > 0) {
      const totalSec = cr.durations.reduce((sum, d) => sum + (typeof d === 'number' ? d : 0), 0);
      durDisplay = fmtDuration(Math.round(totalSec / cr.durations.length));
    }

    rows.push(`<tr>
      <td>${esc(handle)}${lsCount > 0 ? ' <small style="color:#4ecdc4">(' + lsCount + ')</small>' : ''}</td>
      <td>${fmtRevenue(cr.revenue)}</td>
      <td>${durDisplay}</td>
      <td class="products" title="${esc(cr.products.map(p => p.title).join(', '))}">${esc(prodDisplay)}</td>
    </tr>`);
  });

  // Show unmatched livestreams grouped
  const orphans = livestreams.filter(ls => !ls.creator || !creators.has(ls.creator));
  if (orphans.length > 0) {
    rows.push(`<tr><td colspan="4" style="color:#777;font-size:10px;padding:6px 8px;border-bottom:1px solid #333">${orphans.length} unmatched livestreams</td></tr>`);
    orphans.slice(0, 10).forEach(ls => {
      rows.push(`<tr style="color:#888">
        <td>${esc(ls.title).substring(0, 30) || '—'}</td>
        <td>${fmtRevenue(ls.revenue)}</td>
        <td>${fmtDuration(ls.duration)}</td>
        <td class="products">—</td>
      </tr>`);
    });
  }

  tbody.innerHTML = rows.length > 0 ? rows.join('') : '<tr><td colspan="4" style="text-align:center;color:#777;padding:20px">No data yet. Browse Kalodata while recording.</td></tr>';

  // Store processed data for export
  chrome.storage.local.set({
    processedCreators: Array.from(creators.values()),
    processedLivestreams: livestreams,
    processedProducts: products
  });
}

// Unwrap Kalodata's response wrappers: {records:[...]}, {list:[...]}, or bare array/object
function unwrapData(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.records)) return data.records;
    if (Array.isArray(data.list)) return data.list;
    return [data];
  }
  return [];
}

function extractCreatorIdFromUrl(url) {
  if (!url) return '';
  const match = url.match(/[?&]id=(\d+)/);
  return match ? match[1] : '';
}

function fmtRevenue(val) {
  if (!val && val !== 0) return '—';
  const n = typeof val === 'string' ? parseFloat(val.replace(/[$,]/g, '')) : val;
  if (isNaN(n)) return String(val);
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n > 0) return '$' + n.toFixed(0);
  return '—';
}

function fmtDuration(val) {
  if (!val) return '—';
  if (typeof val === 'string') {
    // Already formatted like "11h 24m"
    if (val.includes('h') || val.includes('m')) return val;
    val = parseInt(val, 10);
    if (isNaN(val)) return '—';
  }
  if (typeof val === 'number' && val > 0) {
    const h = Math.floor(val / 3600);
    const m = Math.floor((val % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    return val + 's';
  }
  return '—';
}

function fmtNum(val) {
  if (!val && val !== 0) return '';
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n)) return String(val);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
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
