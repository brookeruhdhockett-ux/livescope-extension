// Background service worker for active mode fetching
// Uses the browser's existing Kalodata session cookies

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ACTIVE_FETCH') {
    handleActiveFetch(msg).then(sendResponse);
    return true; // keep channel open for async
  }
  if (msg.type === 'ACTIVE_FETCH_CREATORS') {
    handleFetchCreatorList(msg).then(sendResponse);
    return true;
  }
});

async function handleActiveFetch({ creatorId, creatorName, startDate, endDate, pageNo, pageSize }) {
  try {
    // Fetch livestream data for a specific creator
    const response = await fetch('https://www.kalodata.com/creator/detail/livestream/queryList', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        id: creatorId,
        startDate: startDate,
        endDate: endDate,
        catoids: [],
        sellerId: '',
        pageNo: pageNo || 1,
        pageSize: pageSize || 50,
        sort: { filter: 'revenue', type: 'DESC' },
        authority: true
      })
    });

    const data = await response.json();
    if (!data.success) {
      // Try the video endpoint as fallback
      const resp2 = await fetch('https://www.kalodata.com/creator/detail/video/queryList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: creatorId,
          startDate,
          endDate,
          catoids: [],
          sellerId: '',
          pageNo: pageNo || 1,
          pageSize: pageSize || 50,
          sort: { filter: 'revenue', type: 'DESC' },
          videoType: '',
          authority: true
        })
      });
      const data2 = await resp2.json();
      return { success: data2.success, data: data2.data, creatorId, creatorName, endpoint: 'video' };
    }

    return { success: true, data: data.data, creatorId, creatorName, endpoint: 'livestream' };
  } catch (e) {
    return { success: false, error: e.message, creatorId, creatorName };
  }
}

async function handleFetchCreatorList({ startDate, endDate, pageNo, pageSize }) {
  try {
    // Fetch top livestream creators from rankings
    const response = await fetch('https://www.kalodata.com/livestream/queryList', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        startDate,
        endDate,
        catoids: [],
        pageNo: pageNo || 1,
        pageSize: pageSize || 20,
        sort: { filter: 'revenue', type: 'DESC' },
        country: 'US',
        authority: true
      })
    });

    const data = await response.json();
    return { success: data.success, data: data.data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
