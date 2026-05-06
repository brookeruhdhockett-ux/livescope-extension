document.addEventListener('DOMContentLoaded', init);

function init() {
  setupDates();
  loadActiveFromStorage();

  document.getElementById('grabFromPage').addEventListener('click', grabFromPage);
  document.getElementById('startFetch').addEventListener('click', startActiveFetch);
  document.getElementById('exportActiveCSV').addEventListener('click', exportActiveCSV);
  document.getElementById('exportActiveJSON').addEventListener('click', exportActiveJSON);
  document.getElementById('sendActiveToLiveScope').addEventListener('click', sendActiveToLiveScope);
  document.getElementById('clearBtn').addEventListener('click', clearData);
}

function setupDates() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  document.getElementById('startDate').value = weekAgo;
  document.getElementById('endDate').value = today;
}

// ===== RESULTS STATE =====
let activeResults = [];

function loadActiveFromStorage() {
  chrome.storage.local.get(['activeResults'], function(result) {
    if (result.activeResults && result.activeResults.length > 0) {
      activeResults = result.activeResults;
      renderActiveResults();
    }
  });
}

// ===== GRAB FROM PAGE =====
function grabFromPage() {
  setStatus('Reading creators from captured data...');
  showLog();
  log('Looking for creator data in passive captures...');

  chrome.storage.local.get(['captures'], function(result) {
    const captures = result.captures || [];

    let creatorData = null;
    for (let i = captures.length - 1; i >= 0; i--) {
      const c = captures[i];
      if (c.endpoint === 'queryList' && Array.isArray(c.data) && c.data.length > 0) {
        const first = c.data[0];
        if (first.handle || first.nickname || first.username) {
          creatorData = c.data;
          log(`Found creator data from ${c.timestamp} (${c.data.length} creators)`, 'success');
          break;
        }
      }
    }

    if (!creatorData) {
      log('No creator data found. Browse to Kalodata Creator Rankings first, then try again.', 'error');
      setStatus('Browse Kalodata first');
      return;
    }

    const ids = creatorData.map(c => {
      const id = c.id || c.uid;
      const name = c.handle || c.nickname || c.username || '';
      return name ? `${id} # ${name}` : id;
    });
    document.getElementById('creatorIds').value = ids.join('\n');

    activeResults = creatorData.map(item => ({
      ...item,
      _creatorId: item.id || item.uid,
      _creatorName: item.handle || item.nickname || item.username || '',
      _products: [],
      _fetchedAt: new Date().toISOString()
    }));
    renderActiveResults();
    setStatus(`Loaded ${creatorData.length} creators — click "Fetch Livestreams + Products" for details`);
    chrome.storage.local.set({ activeResults });
  });
}

// ===== FETCH LIVESTREAMS + PRODUCTS =====
async function startActiveFetch() {
  if (activeResults.length === 0) {
    setStatus('Grab creators first');
    return;
  }

  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const delay = parseInt(document.getElementById('fetchDelay').value) || 2000;

  showLog();
  document.getElementById('progressBar').style.display = 'block';
  log(`Fetching livestreams + products for ${activeResults.length} creators...`);

  for (let i = 0; i < activeResults.length; i++) {
    const creator = activeResults[i];
    const handle = creator._creatorName || creator.handle || creator.id;
    const creatorId = creator._creatorId || creator.id;
    const pct = Math.round(((i + 1) / activeResults.length) * 100);
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
        log(`${handle}: ${livestreams.length} livestreams`, 'success');

        creator._livestreams = livestreams;
        creator._livestreamCount = livestreams.length;
        creator._durations = livestreams.map(ls => ls.duration || ls.live_duration || '').filter(Boolean);

        // Step 2: Get products for each livestream (up to 5)
        let allProducts = [];
        for (let j = 0; j < Math.min(livestreams.length, 5); j++) {
          const ls = livestreams[j];
          if (!ls.id) continue;

          await sleep(delay);
          try {
            const prodResponse = await sendMessageAsync({
              type: 'ACTIVE_FETCH_PRODUCTS',
              livestreamId: ls.id,
              startDate,
              endDate
            });

            if (prodResponse && prodResponse.success) {
              const products = Array.isArray(prodResponse.data) ? prodResponse.data : (prodResponse.data?.list || []);
              allProducts = allProducts.concat(products);
              log(`  ${handle} stream ${j+1}: ${products.length} products`, 'success');
            } else {
              log(`  ${handle} stream ${j+1}: ${prodResponse?.error || 'no products'}`, 'error');
            }
          } catch(e) {
            log(`  ${handle} stream ${j+1}: ${e.message}`, 'error');
          }
        }

        // Dedupe products
        const seen = new Set();
        const unique = [];
        allProducts.forEach(p => {
          const name = p.title || p.name || p.product_name || '';
          if (name && !seen.has(name)) {
            seen.add(name);
            unique.push(p);
          }
        });

        creator._products = unique;
        creator._productNames = unique.map(p => p.title || p.name || p.product_name || '').filter(Boolean);
        creator._productCount = unique.length;
        log(`${handle}: ${unique.length} unique products`, 'success');
      } else {
        log(`${handle}: ${lsResponse?.error || 'livestream fetch failed'}`, 'error');
      }
    } catch (e) {
      log(`${handle}: ${e.message}`, 'error');
    }

    if (i < activeResults.length - 1) await sleep(delay);
  }

  document.getElementById('progressFill').style.width = '100%';
  renderActiveResults();
  setStatus(`Done — ${activeResults.length} creators with livestreams + products`);
  chrome.storage.local.set({ activeResults });
}

// ===== RENDER =====
function renderActiveResults() {
  if (activeResults.length === 0) return;

  document.getElementById('activeResults').style.display = 'block';

  const creatorSet = new Set(activeResults.map(r => r._creatorId || r.id));
  document.getElementById('activeCreatorCount').textContent = creatorSet.size;

  const totalLs = activeResults.reduce((sum, r) => sum + (r._livestreamCount || 0), 0);
  document.getElementById('activeLsCount').textContent = totalLs;

  let totalRev = 0;
  activeResults.forEach(r => {
    totalRev += parseRevenue(r.revenue || 0);
  });
  document.getElementById('activeTotalRev').textContent = formatRevenue(totalRev);

  const tbody = document.getElementById('activeResultsBody');
  tbody.innerHTML = activeResults.slice(0, 100).map(r => {
    const creator = r._creatorName || r.handle || '';
    const revenue = r.revenue || '';
    const items = r.sale || '';
    const products = r._productNames && r._productNames.length > 0
      ? r._productNames.slice(0, 3).join(', ') + (r._productNames.length > 3 ? ` +${r._productNames.length - 3} more` : '')
      : (r._productCount ? r._productCount + ' products' : '—');
    return `<tr>
      <td>${creator}</td>
      <td>${revenue}</td>
      <td>${items}</td>
      <td>${products}</td>
    </tr>`;
  }).join('');
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

// ===== EXPORTS =====
function exportActiveCSV() {
  ensureResults(() => {
    const headers = new Set(['creator', 'creator_id', 'revenue', 'sale', 'followers', 'products', 'livestream_count', 'durations']);
    const rows = activeResults.map(r => {
      const row = {
        creator: r._creatorName || r.handle || '',
        creator_id: r._creatorId || r.id || '',
        revenue: r.revenue || '',
        sale: r.sale || '',
        followers: r.followers || '',
        products: (r._productNames || []).join('; '),
        livestream_count: r._livestreamCount || 0,
        durations: (r._durations || []).join('; ')
      };
      return row;
    });

    const headerArr = Array.from(headers);
    const csv = [
      headerArr.join(','),
      ...rows.map(r =>
        headerArr.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(',')
      )
    ].join('\n');

    downloadFile(csv, `livescope-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv');
    setStatus(`Exported ${rows.length} rows`);
  });
}

function exportActiveJSON() {
  ensureResults(() => {
    const json = JSON.stringify(activeResults, null, 2);
    downloadFile(json, `livescope-${new Date().toISOString().slice(0,10)}.json`, 'application/json');
    setStatus('JSON exported');
  });
}

function sendActiveToLiveScope() {
  ensureResults(() => {
    const headers = ['creator', 'creator_id', 'revenue', 'sale', 'followers', 'products', 'livestream_count', 'durations'];
    const rows = activeResults.map(r => ({
      creator: r._creatorName || r.handle || '',
      creator_id: r._creatorId || r.id || '',
      revenue: r.revenue || '',
      sale: r.sale || '',
      followers: r.followers || '',
      products: (r._productNames || []).join('; '),
      livestream_count: r._livestreamCount || 0,
      durations: (r._durations || []).join('; ')
    }));

    const csvContent = [
      headers.join(','),
      ...rows.map(r => headers.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','))
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
  });
}

function ensureResults(callback) {
  if (activeResults.length > 0) {
    callback();
    return;
  }
  chrome.storage.local.get(['activeResults'], function(result) {
    if (result.activeResults && result.activeResults.length > 0) {
      activeResults = result.activeResults;
      callback();
    } else {
      setStatus('No data to export');
    }
  });
}

function clearData() {
  if (confirm('Clear all data?')) {
    activeResults = [];
    chrome.storage.local.set({ captures: [], activeResults: [] }, function() {
      document.getElementById('activeResults').style.display = 'none';
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
