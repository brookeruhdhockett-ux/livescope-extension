document.addEventListener('DOMContentLoaded', init);

function init() {
  loadData();
  loadActiveFromStorage();
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

function loadActiveFromStorage() {
  chrome.storage.local.get(['activeResults'], function(result) {
    if (result.activeResults && result.activeResults.length > 0) {
      activeResults = result.activeResults;
      renderActiveResults();
    }
  });
}

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

    // Log first item structure for debugging
    log(`Got ${items.length} creators from rankings`);
    log('Fields: ' + Object.keys(items[0]).join(', '));

    // Populate creator IDs
    const seen = new Set();
    const ids = [];
    items.forEach(item => {
      const creatorId = item.uid || item.id || item.creator_id;
      const name = item.handle || item.username || item.nickname || '';
      if (creatorId && !seen.has(creatorId)) {
        seen.add(creatorId);
        ids.push(name ? `${creatorId} # ${name}` : creatorId);
      }
    });

    document.getElementById('creatorIds').value = ids.join('\n');
    log(`Found ${ids.length} unique creators`, 'success');

    // Load creator data as results, then fetch products per creator
    activeResults = items.map(item => ({
      ...item,
      _creatorId: item.uid || item.id || item.creator_id,
      _creatorName: item.handle || item.username || item.nickname || '',
      _products: [],
      _fetchedAt: new Date().toISOString()
    }));
    renderActiveResults();
    setStatus(`Loaded ${items.length} livestreams — now fetching products...`);

    // Fetch products for each livestream
    fetchProductsForAll(items);
  });
}

async function fetchProductsForAll(creators) {
  const delay = parseInt(document.getElementById('fetchDelay').value) || 2000;
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  document.getElementById('progressBar').style.display = 'block';

  for (let i = 0; i < creators.length; i++) {
    const creator = creators[i];
    const handle = creator.handle || creator._creatorName || creator.id;
    const creatorId = creator.id;
    const pct = Math.round(((i + 1) / creators.length) * 100);
    document.getElementById('progressFill').style.width = pct + '%';

    // Step 1: Get this creator's livestreams
    log(`${handle}: fetching livestreams...`);
    try {
      const lsResponse = await sendMessageAsync({
        type: 'ACTIVE_FETCH_CREATOR_LIVESTREAMS',
        creatorId,
        startDate,
        endDate
      });

      if (lsResponse && lsResponse.success) {
        const livestreams = Array.isArray(lsResponse.data) ? lsResponse.data : (lsResponse.data?.list || []);
        log(`${handle}: ${livestreams.length} livestreams found`, 'success');

        // Update the creator result with livestream details
        const match = activeResults.find(r => r.id === creatorId);
        if (match) {
          match._livestreams = livestreams;
          match._livestreamCount = livestreams.length;
          // Collect duration info
          match._durations = livestreams.map(ls => ls.duration || ls.live_duration || '').filter(Boolean);
        }

        // Step 2: Get products for each livestream
        let allProducts = [];
        for (let j = 0; j < Math.min(livestreams.length, 5); j++) {
          const ls = livestreams[j];
          const lsId = ls.id;
          if (!lsId) continue;

          await sleep(delay);
          try {
            const prodResponse = await sendMessageAsync({
              type: 'ACTIVE_FETCH_PRODUCTS',
              livestreamId: lsId,
              startDate,
              endDate
            });

            if (prodResponse && prodResponse.success) {
              const products = Array.isArray(prodResponse.data) ? prodResponse.data : (prodResponse.data?.list || []);
              allProducts = allProducts.concat(products);
              log(`  ${handle} livestream ${j+1}: ${products.length} products`, 'success');
            } else {
              log(`  ${handle} livestream ${j+1}: ${prodResponse?.error || 'no products'}`, 'error');
            }
          } catch(e) {
            log(`  ${handle} livestream ${j+1}: ${e.message}`, 'error');
          }
        }

        // Dedupe products by name/title
        const seen = new Set();
        const uniqueProducts = [];
        allProducts.forEach(p => {
          const name = p.title || p.name || p.product_name || '';
          if (name && !seen.has(name)) {
            seen.add(name);
            uniqueProducts.push(p);
          }
        });

        if (match) {
          match._products = uniqueProducts;
          match._productNames = uniqueProducts.map(p => p.title || p.name || p.product_name || '').filter(Boolean);
          match._productCount = uniqueProducts.length;
        }
        log(`${handle}: ${uniqueProducts.length} unique products total`, 'success');
      } else {
        log(`${handle}: ${lsResponse?.error || 'livestream fetch failed'}`, 'error');
      }
    } catch (e) {
      log(`${handle}: ${e.message}`, 'error');
    }

    if (i < creators.length - 1) await sleep(delay);
  }

  document.getElementById('progressFill').style.width = '100%';
  renderActiveResults();
  setStatus(`Done — ${activeResults.length} livestreams with products loaded`);
  chrome.storage.local.set({ activeResults });
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
    const creator = r._creatorName || r.handle || r.creator_name || r.username || '';
    const duration = r.duration || r.live_duration || '';
    const revenue = r.revenue || r.gmv || '';
    const gpm = r.gpm || '';
    const products = r._productNames && r._productNames.length > 0
      ? r._productNames.slice(0, 3).join(', ') + (r._productNames.length > 3 ? ` +${r._productNames.length - 3} more` : '')
      : (r._productCount || r.sale || '');
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
    // Try loading from storage
    chrome.storage.local.get(['activeResults'], function(result) {
      if (result.activeResults && result.activeResults.length > 0) {
        activeResults = result.activeResults;
        doExportActiveCSV();
      } else {
        setStatus('No active results to export');
      }
    });
    return;
  }
  doExportActiveCSV();
}

function doExportActiveCSV() {

  const headers = new Set(['creator', 'creator_id', 'products']);
  const rows = activeResults.map(r => {
    const row = {
      creator: r._creatorName || r.handle || r.creator_name || '',
      creator_id: r._creatorId || r.uid || r.id || '',
      products: (r._productNames || []).join('; ')
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
  const doExport = (data) => {
    const json = JSON.stringify(data, null, 2);
    downloadFile(json, `livescope-active-${new Date().toISOString().slice(0,10)}.json`, 'application/json');
    setStatus('JSON exported');
  };

  if (activeResults.length === 0) {
    chrome.storage.local.get(['activeResults'], function(result) {
      if (result.activeResults && result.activeResults.length > 0) {
        activeResults = result.activeResults;
        doExport(activeResults);
      } else {
        setStatus('No active results to export');
      }
    });
    return;
  }
  doExport(activeResults);
}

function sendActiveToLiveScope() {
  if (activeResults.length === 0) {
    chrome.storage.local.get(['activeResults'], function(result) {
      if (result.activeResults && result.activeResults.length > 0) {
        activeResults = result.activeResults;
        doSendActiveToLiveScope();
      } else {
        setStatus('No active results to send');
      }
    });
    return;
  }
  doSendActiveToLiveScope();
}

function doSendActiveToLiveScope() {

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
