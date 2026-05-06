// Background service worker — routes active mode requests through the Kalodata tab

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ACTIVE_FETCH') {
    runInKaloTab(buildFetchCode('livestream', msg)).then(sendResponse);
    return true;
  }
  if (msg.type === 'ACTIVE_FETCH_CREATORS') {
    runInKaloTab(buildCreatorListCode(msg)).then(sendResponse);
    return true;
  }
  if (msg.type === 'ACTIVE_FETCH_PRODUCTS') {
    runInKaloTab(buildProductFetchCode(msg)).then(sendResponse);
    return true;
  }
  if (msg.type === 'GRAB_PAGE_CREATORS') {
    grabCreatorsFromPage().then(sendResponse);
    return true;
  }
  if (msg.type === 'ACTIVE_FETCH_CREATOR_LIVESTREAMS') {
    runInKaloTab({ action: 'fetch_creator_livestreams', creatorId: msg.creatorId, startDate: msg.startDate, endDate: msg.endDate }).then(sendResponse);
    return true;
  }
});

async function runInKaloTab(code) {
  try {
    // Find an open Kalodata tab
    const tabs = await chrome.tabs.query({ url: 'https://www.kalodata.com/*' });
    if (tabs.length === 0) {
      return { success: false, error: 'No Kalodata tab open. Open kalodata.com and log in first.' };
    }

    const tabId = tabs[0].id;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: executeFetch,
      args: [code]
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
    return { success: false, error: 'No result from tab' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function grabCreatorsFromPage() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.kalodata.com/*' });
    if (tabs.length === 0) {
      return { success: false, error: 'No Kalodata tab open.' };
    }

    const tabId = tabs[0].id;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeCreatorsFromDOM
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
    return { success: false, error: 'Could not read page' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function scrapeCreatorsFromDOM() {
  try {
    const creators = [];

    // Method 1: Look for links to creator detail pages
    const links = document.querySelectorAll('a[href*="/creator/"]');
    const seen = new Set();
    links.forEach(link => {
      const href = link.getAttribute('href') || '';
      // Extract creator ID from URL like /creator/detail?id=123
      const idMatch = href.match(/[?&]id=(\d+)/);
      if (idMatch && !seen.has(idMatch[1])) {
        seen.add(idMatch[1]);
        // Try to get the handle/name from nearby text
        const row = link.closest('tr, [class*="row"], [class*="item"], [class*="card"]');
        const nameEl = row ? (row.querySelector('[class*="name"], [class*="handle"], [class*="nickname"]') || link) : link;
        const name = nameEl.textContent.trim().replace('@', '');
        creators.push({ id: idMatch[1], name });
      }
    });

    // Method 2: Look for table rows with creator data
    if (creators.length === 0) {
      const rows = document.querySelectorAll('table tbody tr, [class*="table"] [class*="row"]');
      rows.forEach(row => {
        const link = row.querySelector('a[href*="creator"]');
        const cells = row.querySelectorAll('td, [class*="cell"]');
        if (link) {
          const href = link.getAttribute('href') || '';
          const idMatch = href.match(/[?&]id=(\d+)/);
          if (idMatch && !seen.has(idMatch[1])) {
            seen.add(idMatch[1]);
            creators.push({ id: idMatch[1], name: link.textContent.trim() });
          }
        }
      });
    }

    // Method 3: Check for any element with creator IDs in data attributes
    if (creators.length === 0) {
      const allLinks = document.querySelectorAll('a[href]');
      allLinks.forEach(link => {
        const href = link.getAttribute('href') || '';
        const idMatch = href.match(/id=(\d{15,})/);
        if (idMatch && !seen.has(idMatch[1])) {
          seen.add(idMatch[1]);
          creators.push({ id: idMatch[1], name: link.textContent.trim().substring(0, 50) });
        }
      });
    }

    if (creators.length === 0) {
      // Dump page info for debugging
      const allHrefs = Array.from(document.querySelectorAll('a[href]')).slice(0, 10).map(a => a.href);
      return { success: false, error: 'No creators found on page. Sample links: ' + allHrefs.join(', ').substring(0, 200) };
    }

    return { success: true, data: creators };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function buildFetchCode(type, msg) {
  return {
    action: 'fetch_creator',
    creatorId: msg.creatorId,
    creatorName: msg.creatorName,
    startDate: msg.startDate,
    endDate: msg.endDate,
    pageNo: msg.pageNo || 1,
    pageSize: msg.pageSize || 50
  };
}

function buildCreatorListCode(msg) {
  return {
    action: 'fetch_rankings',
    startDate: msg.startDate,
    endDate: msg.endDate,
    pageNo: msg.pageNo || 1,
    pageSize: msg.pageSize || 20
  };
}

function buildProductFetchCode(msg) {
  return {
    action: 'fetch_products',
    livestreamId: msg.livestreamId,
    startDate: msg.startDate,
    endDate: msg.endDate
  };
}

// This function runs INSIDE the Kalodata tab (has cookies)
async function executeFetch(params) {
  try {
    if (params.action === 'fetch_creator') {
      // Try livestream endpoint first
      let resp = await fetch('https://www.kalodata.com/creator/detail/livestream/queryList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: params.creatorId,
          startDate: params.startDate,
          endDate: params.endDate,
          catoids: [],
          sellerId: '',
          pageNo: params.pageNo,
          pageSize: params.pageSize,
          sort: { filter: 'revenue', type: 'DESC' },
          authority: true
        })
      });

      let text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch(e) {
        // Try video endpoint as fallback
        resp = await fetch('https://www.kalodata.com/creator/detail/video/queryList', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            id: params.creatorId,
            startDate: params.startDate,
            endDate: params.endDate,
            catoids: [],
            sellerId: '',
            pageNo: params.pageNo,
            pageSize: params.pageSize,
            sort: { filter: 'revenue', type: 'DESC' },
            videoType: '',
            authority: true
          })
        });
        text = await resp.text();
        try { data = JSON.parse(text); } catch(e2) {
          return { success: false, error: 'Not JSON: ' + text.substring(0, 100), creatorId: params.creatorId, creatorName: params.creatorName };
        }
        return { success: !!data.success, data: data.data, creatorId: params.creatorId, creatorName: params.creatorName, endpoint: 'video' };
      }

      if (data.success) {
        return { success: true, data: data.data, creatorId: params.creatorId, creatorName: params.creatorName, endpoint: 'livestream' };
      }

      // Livestream failed, try video
      resp = await fetch('https://www.kalodata.com/creator/detail/video/queryList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: params.creatorId,
          startDate: params.startDate,
          endDate: params.endDate,
          catoids: [],
          sellerId: '',
          pageNo: params.pageNo,
          pageSize: params.pageSize,
          sort: { filter: 'revenue', type: 'DESC' },
          videoType: '',
          authority: true
        })
      });
      text = await resp.text();
      try { data = JSON.parse(text); } catch(e) {
        return { success: false, error: 'Not JSON: ' + text.substring(0, 100), creatorId: params.creatorId, creatorName: params.creatorName };
      }
      return { success: !!data.success, data: data.data, creatorId: params.creatorId, creatorName: params.creatorName, endpoint: 'video' };

    } else if (params.action === 'fetch_creator_livestreams') {
      const resp = await fetch('https://www.kalodata.com/creator/detail/video/queryList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: params.creatorId,
          startDate: params.startDate,
          endDate: params.endDate,
          catoids: [],
          sellerId: '',
          pageNo: 1,
          pageSize: 50,
          sort: { filter: 'revenue', type: 'DESC' },
          videoType: 'LIVE',
          authority: true
        })
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch(e) {
        return { success: false, error: 'Not JSON: ' + text.substring(0, 100) };
      }
      return { success: !!data.success, data: data.data, creatorId: params.creatorId };

    } else if (params.action === 'fetch_products') {
      const resp = await fetch('https://www.kalodata.com/video/detail/stat/queryProductList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: params.livestreamId,
          startDate: params.startDate,
          endDate: params.endDate,
          authority: true
        })
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch(e) {
        return { success: false, error: 'Not JSON: ' + text.substring(0, 100), livestreamId: params.livestreamId };
      }
      return { success: !!data.success, data: data.data, livestreamId: params.livestreamId };

    } else if (params.action === 'fetch_rankings') {
      const resp = await fetch('https://www.kalodata.com/creator/queryList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          country: 'US',
          startDate: params.startDate,
          endDate: params.endDate,
          cateIds: [],
          showCateIds: [],
          'creator.filter.content_type': 'LIVE',
          'creator.filter.creator_type': 'INDEPENDENT',
          pageNo: params.pageNo,
          pageSize: params.pageSize,
          sort: [{ field: 'revenue', type: 'DESC' }]
        })
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch(e) {
        return { success: false, error: 'Not JSON: ' + text.substring(0, 100) };
      }
      return { success: !!data.success, data: data.data };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}
