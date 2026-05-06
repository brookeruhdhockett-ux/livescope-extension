// Runs in MAIN world (page context) — patches XHR/fetch to capture Kalodata API responses
// Sends data to bridge.js via postMessage
(function() {
  'use strict';

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._lsUrl = url;
    this._lsMethod = method;
    return origOpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function(body) {
    this._lsBody = body;
    this.addEventListener('load', function() {
      try {
        if (this._lsUrl && this._lsUrl.includes('kalodata.com')) {
          captureResponse(this._lsUrl, this._lsMethod, this._lsBody, this.responseText);
        }
      } catch(e) {}
    });
    return origSend.call(this, body);
  };

  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init && init.method) || 'GET';
    const body = (init && init.body) || null;

    const response = await origFetch.call(this, input, init);

    if (url && url.includes('kalodata.com')) {
      try {
        const clone = response.clone();
        clone.text().then(text => {
          captureResponse(url, method, body, text);
        });
      } catch(e) {}
    }

    return response;
  };

  function captureResponse(url, method, requestBody, responseText) {
    try {
      const parsed = JSON.parse(responseText);
      if (!parsed) return;

      const urlPath = new URL(url, window.location.origin).pathname;

      // Skip noise endpoints
      if (urlPath.includes('/user/') || urlPath.includes('/api/') ||
          urlPath.includes('/features') || urlPath.includes('/homepage/') ||
          urlPath.includes('/focus/') || urlPath.includes('/access') ||
          urlPath.includes('/count') || urlPath.includes('/history/') ||
          urlPath.includes('searchShopList') || urlPath.includes('topLabel')) return;

      // Accept responses with success:true OR code:0 OR just having a data field
      const isSuccess = parsed.success === true || parsed.code === 0 || parsed.code === '0';
      const responseData = parsed.data || parsed.result || parsed.list || parsed.records;
      if (!isSuccess && !responseData) return;

      const data = responseData || parsed.data;

      let params = {};
      if (requestBody) {
        try { params = JSON.parse(requestBody); } catch(e) {}
      }

      // Tag the capture type based on URL path
      let captureType = 'unknown';
      if (urlPath.includes('/creator/queryList')) {
        captureType = 'creator_rankings';
      } else if (urlPath.includes('/creator/detail/video/queryList') || urlPath.includes('/creator/detail/livestream/queryList')) {
        captureType = 'creator_livestreams';
      } else if (urlPath.includes('queryProductList') || urlPath.includes('ProductList') || urlPath.includes('productList') || urlPath.includes('searchProducts')) {
        captureType = 'products';
      } else if (urlPath.includes('/livestream/detail') && urlPath.includes('query')) {
        captureType = 'livestream_detail';
      } else if (urlPath.includes('/creator/detail') && urlPath.includes('query')) {
        captureType = 'creator_detail';
      } else if (urlPath.includes('/video/detail') || urlPath.includes('/livestream/detail')) {
        captureType = 'video_detail';
      }

      const pageUrl = window.location.href;
      const record = {
        timestamp: new Date().toISOString(),
        captureType,
        urlPath,
        url: url.substring(0, 200),
        method,
        pageUrl: pageUrl.substring(0, 200),
        params,
        data: data,
        rawDataLength: Array.isArray(data) ? data.length : 1
      };

      window.postMessage({ type: 'LIVESCOPE_CAPTURE', record }, '*');
    } catch(e) {}
  }
})();
