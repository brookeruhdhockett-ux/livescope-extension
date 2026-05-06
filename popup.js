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

  captures.forEach(c => {
    if (!c.data) return;
    const items = Array.isArray(c.data) ? c.data : [c.data];

    items.forEach(item => {
      // Creator data (from creator rankings or detail)
      if (item.handle || item.nickname || item.username) {
        const handle = item.handle || item.nickname || item.username;
        if (!creators.has(handle)) {
          creators.set(handle, {
            handle,
            nickname: item.nickname || item.handle || '',
            revenue: item.revenue || '',
            sale: item.sale || '',
            followers: item.followers || '',
            id: item.id || item.uid || '',
            livestreams: [],
            products: [],
            durations: []
          });
        }
        const existing = creators.get(handle);
        // Update with richer data if available
        if (item.revenue && !existing.revenue) existing.revenue = item.revenue;
        if (item.followers && !existing.followers) existing.followers = item.followers;
      }

      // Livestream/video data (has duration, gpm, views in a stream context)
      if (item.duration || item.live_duration || item.gpm) {
        const ls = {
          id: item.id,
          title: item.title || item.description || '',
          duration: item.duration || item.live_duration || '',
          revenue: item.revenue || '',
          gpm: item.gpm || '',
          sale: item.sale || '',
          views: item.views || '',
          creator: item.handle || item.creator_name || item.username || extractCreatorFromCapture(c) || ''
        };
        livestreams.push(ls);

        // Attach to creator if we can match
        if (ls.creator && creators.has(ls.creator)) {
          const cr = creators.get(ls.creator);
          cr.livestreams.push(ls);
          if (ls.duration) cr.durations.push(ls.duration);
        }
      }

      // Product data (has title + price or product-like fields)
      if (item.title && (item.price || item.unit_price || item.product_id || item.product_name)) {
        const prod = {
          title: item.title || item.product_name || item.name || '',
          price: item.price || item.unit_price || '',
          revenue: item.revenue || '',
          sale: item.sale || '',
          id: item.id || item.product_id || ''
        };
        products.push(prod);
      }
    });
  });

  // Also try to match livestreams to creators by looking at capture page URLs
  captures.forEach(c => {
    const creator = extractCreatorFromCapture(c);
    if (creator && creators.has(creator)) {
      const cr = creators.get(creator);
      const items = Array.isArray(c.data) ? c.data : [c.data];
      items.forEach(item => {
        // Products from creator detail pages
        if (item.title && (item.price || item.unit_price || item.sale)) {
          const name = item.title || item.product_name || '';
          if (name && !cr.products.find(p => p.title === name)) {
            cr.products.push({ title: name, price: item.price || item.unit_price || '', revenue: item.revenue || '' });
          }
        }
      });
    }
  });

  // Render
  document.getElementById('creatorCount').textContent = creators.size;
  document.getElementById('livestreamCount').textContent = livestreams.length;
  document.getElementById('productCount').textContent = products.length;

  const tbody = document.getElementById('resultsBody');
  const rows = [];

  // If we have livestreams, show per-livestream rows
  if (livestreams.length > 0) {
    livestreams.forEach(ls => {
      rows.push(`<tr>
        <td>${ls.creator || '—'}</td>
        <td>${ls.revenue || '—'}</td>
        <td>${ls.duration || '—'}</td>
        <td class="products">—</td>
      </tr>`);
    });
  }

  // Always show creator-level rows
  creators.forEach((cr, handle) => {
    const prodNames = cr.products.map(p => p.title).slice(0, 3).join(', ');
    const prodDisplay = prodNames || (cr.products.length > 0 ? cr.products.length + ' products' : '—');
    const durDisplay = cr.durations.length > 0 ? cr.durations[0] : '—';
    rows.push(`<tr>
      <td>${handle}</td>
      <td>${cr.revenue || '—'}</td>
      <td>${durDisplay}</td>
      <td class="products" title="${cr.products.map(p => p.title).join(', ')}">${prodDisplay}</td>
    </tr>`);
  });

  tbody.innerHTML = rows.join('');

  // Store processed data for export
  chrome.storage.local.set({
    processedCreators: Array.from(creators.values()),
    processedLivestreams: livestreams,
    processedProducts: products
  });
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
