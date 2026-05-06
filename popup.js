document.addEventListener('DOMContentLoaded', init);

function init() {
  loadData();
  setupTabs();
  setupDates();

  document.getElementById('exportBtn').addEventListener('click', exportCSV);
  document.getElementById('exportJsonBtn').addEventListener('click', exportJSON);
  document.getElementById('sendToLiveScope').addEventListener('click', sendToLiveScope);
  document.getElementById('clearBtn').addEventListener('click', clearData);

  document.getElementById('startFetch').addEventListener('click', startActiveFetch);
  document.getElementById('fetchTopCreators').addEventListener('click', fetchTopCreators);
  document.getElementById('exportActiveCSV').addEventListener('click', exportActiveCSV);
  document.getElementById('exportActiveJSON').addEventListener('click', exportActiveJSON);
  document.getElementById('sendActiveToLiveScope').addEventListener('click', sendActiveToLiveScope);
}

// ===== TABS =====
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });
}

function setupDates() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  document.getElementById('startDate').value = weekAgo;
  document.getElementById('endDate').value = today;
}

// ===== PASSIVE MODE =====
function loadData() {
  chrome.storage.local.get(['captures'], function(result) {
    const captures = result.captures || [];
    updateUI(captures);
  });
}

function updateUI(captures) {
  document.getElementById('captureCount').textContent = captures.length;

  const creators = new Map();
  const livestreams = [];

  captures.forEach(c => {
    if (c.pageType === 'creator_detail') {
      const match = c.pageUrl.match(/@([^/?&]+)/) || c.pageUrl.match(/creator\/([^/?&]+)/);
      if (match) {
        const name = match[1];
        creators.set(name, (creators.get(name) || 0) + 1);
      }
    }

    if (c.endpoint === 'queryList' && Array.isArray(c.data)) {
      c.data.forEach(item => {
        if (item.revenue || item.gpm || item.sale) {
          livestreams.push({
            ...item,
            _source: c.pageType,
            _creator: extractCreatorFromUrl(c.pageUrl),
            _capturedAt: c.timestamp
          });
        }
      });
    }

    if (c.pageType === 'livestream_detail' && c.data) {
      const d = Array.isArray(c.data) ? c.data : [c.data];
      d.forEach(item => {
        if (item.revenue || item.duration || item.gpm) {
          livestreams.push({
            ...item,
            _source: 'livestream_detail',
            _capturedAt: c.timestamp
          });
        }
      });
    }

    if (c.endpoint === 'total' && c.data && !Array.isArray(c.data)) {
      const creator = extractCreatorFromUrl(c.pageUrl);
      if (creator) {
        creators.set(creator, (creators.get(creator) || 0) + 1);
      }
    }
  });

  document.getElementById('creatorCount').textContent = creators.size;
  document.getElementById('livestreamCount').textContent = livestreams.length;

  const hasData = captures.length > 0;
  document.getElementById('emptyState').style.display = hasData ? 'none' : 'block';

  if (creators.size > 0) {
    document.getElementById('creatorSection').style.display = 'block';
    const list = document.getElementById('creatorList');
    list.innerHTML = Array.from(creators.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) =>
        `<div class="creator-item">
          <span class="creator-name">@${name}</span>
          <span class="creator-count">${count} calls</span>
        </div>`
      ).join('');
  }

  if (livestreams.length > 0) {
    document.getElementById('livestreamSection').style.display = 'block';
    const list = document.getElementById('livestreamList');
    const unique = new Map();
    livestreams.forEach(ls => {
      const key = ls.id || ls.description?.substring(0, 50) || Math.random();
      if (!unique.has(key)) unique.set(key, ls);
    });

    list.innerHTML = Array.from(unique.values()).slice(0, 50).map(ls => {
      const desc = (ls.description || ls.title || 'Untitled').substring(0, 60);
      const rev = ls.revenue || '';
      const dur = ls.duration || ls.live_duration || '';
      const creator = ls._creator || ls.creator_name || ls.username || '';
      return `<div class="ls-item">
        <div class="ls-title">${desc}${desc.length >= 60 ? '...' : ''}</div>
        <div class="ls-meta">
          ${creator ? '@' + creator + ' · ' : ''}
          ${rev ? '<span class="ls-revenue">' + rev + '</span> · ' : ''}
          ${dur ? '<span class="ls-duration">' + dur + '</span> · ' : ''}
          ${ls.views || ''} views
        </div>
      </div>`;
    }).join('');
  }
}

function extractCreatorFromUrl(url) {
  if (!url) return '';
  const match = url.match(/@([^/?&]+)/) || url.match(/creator\/([^/?&]+)/);
  return match ? match[1] : '';
}

// ===== ACTIVE MODE =====
let activeResults = [];

async function fetchTopCreators() {
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;

  setStatus('Fetching top creators from rankings...');
  showLog();
  log('Requesting livestream rankings...');

  const count = parseInt(document.getElementById('creatorCount').value) || 20;

  chrome.runtime.sendMessage({
    type: 'ACTIVE_FETCH_CREATORS',
    startDate,
    endDate,
    pageNo: 1,
    pageSize: count
  }, (response) => {
    if (!response || !response.success) {
      log('Failed: ' + (response?.error || 'No response — make sure you are logged into Kalodata'), 'error');
      setStatus('Failed to fetch creators');
      return;
    }

    const items = Array.isArray(response.data) ? response.data : (response.data?.list || []);
    if (items.length === 0) {
      log('No creators returned. Check your Kalodata session.', 'error');
      log('Raw response: ' + JSON.stringify(response.data).substring(0, 200));
      return;
    }

    // Rankings returns livestreams — extract the CREATOR id, not livestream id
    const seen = new Set();
    const ids = [];
    items.forEach(item => {
      // Try every possible creator ID field
      const creatorId = item.creator_id || item.creatorId || item.user_id || item.userId || item.seller_id || item.sellerId;
      const name = item.creator_name || item.username || item.nickname || item.seller_name || '';
      const id = creatorId || item.id; // fallback to item.id only if no creator field
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(name ? `${id} # ${name}` : id);
      }
    });

    if (ids.length === 0) {
      // Dump first item keys so we can see the structure
      log('Could not find creator IDs. First item keys: ' + Object.keys(items[0]).join(', '), 'error');
      log('First item sample: ' + JSON.stringify(items[0]).substring(0, 300));
      return;
    }

    document.getElementById('creatorIds').value = ids.join('\n');
    log(`Found ${ids.length} creators`, 'success');
    setStatus(`Loaded ${ids.length} creator IDs`);
  });
}

async function startActiveFetch() {
  const raw = document.getElementById('creatorIds').value.trim();
  if (!raw) {
    setStatus('Enter creator IDs first');
    return;
  }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const creators = lines.map(line => {
    const parts = line.split('#');
    const id = parts[0].trim();
    const name = parts[1] ? parts[1].trim() : id;
    return { id, name };
  });

  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const pageSize = parseInt(document.getElementById('pageSize').value) || 50;
  const delay = parseInt(document.getElementById('fetchDelay').value) || 2000;

  activeResults = [];
  showLog();
  document.getElementById('progressBar').style.display = 'block';
  document.getElementById('activeResults').style.display = 'none';
  log(`Starting fetch for ${creators.length} creators (${startDate} to ${endDate})...`);

  for (let i = 0; i < creators.length; i++) {
    const creator = creators[i];
    const pct = Math.round(((i + 1) / creators.length) * 100);
    document.getElementById('progressFill').style.width = pct + '%';
    setStatus(`Fetching ${i + 1}/${creators.length}: ${creator.name}`);

    try {
      const response = await sendMessageAsync({
        type: 'ACTIVE_FETCH',
        creatorId: creator.id,
        creatorName: creator.name,
        startDate,
        endDate,
        pageNo: 1,
        pageSize
      });

      if (response && response.success) {
        const items = Array.isArray(response.data) ? response.data : (response.data?.list || []);
        items.forEach(item => {
          activeResults.push({
            ...item,
            _creatorId: creator.id,
            _creatorName: creator.name,
            _fetchedAt: new Date().toISOString()
          });
        });
        log(`${creator.name}: ${items.length} results (${response.endpoint})`, 'success');
      } else {
        const err = response?.error || 'no data';
        log(`${creator.name}: ${err}`, 'error');
      }
    } catch (e) {
      log(`${creator.name}: ${e.message}`, 'error');
    }

    // Delay between requests to avoid rate limiting
    if (i < creators.length - 1) {
      await sleep(delay);
    }
  }

  document.getElementById('progressFill').style.width = '100%';
  setStatus(`Done — ${activeResults.length} total livestreams from ${creators.length} creators`);
  renderActiveResults();
}

function renderActiveResults() {
  if (activeResults.length === 0) return;

  document.getElementById('activeResults').style.display = 'block';

  // Count unique creators
  const creatorSet = new Set(activeResults.map(r => r._creatorId || r._creatorName));
  document.getElementById('activeCreatorCount').textContent = creatorSet.size;
  document.getElementById('activeLsCount').textContent = activeResults.length;

  // Sum revenue (try to parse various formats)
  let totalRev = 0;
  activeResults.forEach(r => {
    const rev = parseRevenue(r.revenue || r.gmv || r.sale || 0);
    totalRev += rev;
  });
  document.getElementById('activeTotalRev').textContent = formatRevenue(totalRev);

  // Render table
  const tbody = document.getElementById('activeResultsBody');
  tbody.innerHTML = activeResults.slice(0, 100).map(r => {
    const creator = r._creatorName || r.creator_name || r.username || '';
    const duration = r.duration || r.live_duration || r.time || '';
    const revenue = r.revenue || r.gmv || r.sale || '';
    const gpm = r.gpm || '';
    const products = r.product_count || r.products || r.item_count || '';
    return `<tr>
      <td>${creator}</td>
      <td>${duration}</td>
      <td>${revenue}</td>
      <td>${gpm}</td>
      <td>${products}</td>
    </tr>`;
  }).join('');

  // Also store in chrome storage for later export
  chrome.storage.local.set({ activeResults });
}

function parseRevenue(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const cleaned = val.replace(/[$,]/g, '');
    const num = parseFloat(cleaned);
    if (cleaned.includes('K') || cleaned.includes('k')) return num * 1000;
    if (cleaned.includes('M') || cleaned.includes('m')) return num * 1000000;
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

function formatRevenue(val) {
  if (val >= 1000000) return '$' + (val / 1000000).toFixed(1) + 'M';
  if (val >= 1000) return '$' + (val / 1000).toFixed(1) + 'K';
  if (val > 0) return '$' + val.toFixed(0);
  return '$0';
}

// ===== ACTIVE MODE EXPORTS =====
function exportActiveCSV() {
  if (activeResults.length === 0) {
    setStatus('No active results to export');
    return;
  }

  const headers = new Set(['creator', 'creator_id']);
  const rows = activeResults.map(r => {
    const row = {
      creator: r._creatorName || r.creator_name || r.username || '',
      creator_id: r._creatorId || r.id || ''
    };
    Object.keys(r).forEach(k => {
      if (k.startsWith('_')) return;
      if (typeof r[k] !== 'object') {
        headers.add(k);
        row[k] = r[k];
      }
    });
    return row;
  });

  const headerArr = Array.from(headers);
  const csv = [
    headerArr.join(','),
    ...rows.map(r =>
      headerArr.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(',')
    )
  ].join('\n');

  downloadFile(csv, `livescope-active-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv');
  setStatus(`Exported ${rows.length} rows`);
}

function exportActiveJSON() {
  if (activeResults.length === 0) {
    setStatus('No active results to export');
    return;
  }
  const json = JSON.stringify(activeResults, null, 2);
  downloadFile(json, `livescope-active-${new Date().toISOString().slice(0,10)}.json`, 'application/json');
  setStatus('JSON exported');
}

function sendActiveToLiveScope() {
  if (activeResults.length === 0) {
    setStatus('No active results to send');
    return;
  }

  const headers = new Set(['creator', 'creator_id']);
  const rows = activeResults.map(r => {
    const row = {
      creator: r._creatorName || r.creator_name || r.username || '',
      creator_id: r._creatorId || r.id || ''
    };
    Object.keys(r).forEach(k => {
      if (k.startsWith('_')) return;
      if (typeof r[k] !== 'object') {
        headers.add(k);
        row[k] = r[k];
      }
    });
    return row;
  });

  const headerArr = Array.from(headers);
  const csvContent = [
    headerArr.join(','),
    ...rows.map(r => headerArr.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv' });
  const form = new FormData();
  form.append('file', blob, 'livescope-active.csv');

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
}

// ===== PASSIVE MODE EXPORTS =====
function exportCSV() {
  chrome.storage.local.get(['captures'], function(result) {
    const captures = result.captures || [];
    if (captures.length === 0) {
      setStatus('No data to export');
      return;
    }

    const rows = [];
    const headers = new Set(['creator', 'endpoint', 'page_type', 'captured_at']);

    captures.forEach(c => {
      const items = Array.isArray(c.data) ? c.data : (c.data ? [c.data] : []);
      const creator = extractCreatorFromUrl(c.pageUrl);

      items.forEach(item => {
        if (typeof item !== 'object' || item === null) return;
        const row = {
          creator,
          endpoint: c.endpoint,
          page_type: c.pageType,
          captured_at: c.timestamp
        };
        Object.keys(item).forEach(k => {
          if (typeof item[k] !== 'object') {
            headers.add(k);
            row[k] = item[k];
          }
        });
        rows.push(row);
      });
    });

    const headerArr = Array.from(headers);
    const csv = [
      headerArr.join(','),
      ...rows.map(r =>
        headerArr.map(h => {
          const v = r[h] || '';
          return `"${String(v).replace(/"/g, '""')}"`;
        }).join(',')
      )
    ].join('\n');

    downloadFile(csv, `livescope-export-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv');
    setStatus(`Exported ${rows.length} rows`);
  });
}

function exportJSON() {
  chrome.storage.local.get(['captures'], function(result) {
    const json = JSON.stringify(result.captures || [], null, 2);
    downloadFile(json, `livescope-raw-${new Date().toISOString().slice(0,10)}.json`, 'application/json');
    setStatus('JSON exported');
  });
}

function sendToLiveScope() {
  chrome.storage.local.get(['captures'], function(result) {
    const captures = result.captures || [];
    if (captures.length === 0) {
      setStatus('No data to send');
      return;
    }

    const rows = [];
    const headers = new Set(['creator', 'endpoint', 'page_type', 'captured_at']);

    captures.forEach(c => {
      const items = Array.isArray(c.data) ? c.data : (c.data ? [c.data] : []);
      const creator = extractCreatorFromUrl(c.pageUrl);
      items.forEach(item => {
        if (typeof item !== 'object' || item === null) return;
        const row = { creator, endpoint: c.endpoint, page_type: c.pageType, captured_at: c.timestamp };
        Object.keys(item).forEach(k => {
          if (typeof item[k] !== 'object') { headers.add(k); row[k] = item[k]; }
        });
        rows.push(row);
      });
    });

    const headerArr = Array.from(headers);
    const csvContent = [
      headerArr.join(','),
      ...rows.map(r => headerArr.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const form = new FormData();
    form.append('file', blob, 'livescope-capture.csv');

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
    chrome.storage.local.set({ captures: [] }, function() {
      loadData();
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

function sendMessageAsync(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showLog() {
  document.getElementById('fetchLog').style.display = 'block';
}

function log(msg, type) {
  const el = document.getElementById('fetchLog');
  const line = document.createElement('div');
  if (type) line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
