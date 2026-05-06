// Intercepts all XHR/fetch responses from Kalodata's API
// Runs at document_start so we catch everything
(function() {
  'use strict';

  // Patch XMLHttpRequest
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

  // Patch fetch
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
      const data = JSON.parse(responseText);
      if (!data || !data.success) return;

      // Determine the endpoint name from URL
      const urlPath = new URL(url, window.location.origin).pathname;
      const endpoint = urlPath.split('/').pop();

      // Parse request body for context
      let params = {};
      if (requestBody) {
        try { params = JSON.parse(requestBody); } catch(e) {}
      }

      // Get the current page context
      const pageUrl = window.location.href;
      const pageType = detectPageType(pageUrl);

      const record = {
        timestamp: new Date().toISOString(),
        endpoint,
        url: url.substring(0, 200),
        method,
        pageType,
        pageUrl: pageUrl.substring(0, 200),
        params,
        data: data.data,
        rawDataLength: Array.isArray(data.data) ? data.data.length : 1
      };

      // Send to extension storage via custom event
      window.postMessage({
        type: 'LIVESCOPE_CAPTURE',
        record
      }, '*');

    } catch(e) {
      // Not JSON or parse error — skip
    }
  }

  function detectPageType(url) {
    if (url.includes('/livestream/') || url.includes('livestreamDetail')) return 'livestream_detail';
    if (url.includes('/livestream')) return 'livestream_rankings';
    if (url.includes('/creator/') || url.includes('creatorDetail')) return 'creator_detail';
    if (url.includes('/creator')) return 'creator_rankings';
    if (url.includes('/product/')) return 'product_detail';
    if (url.includes('/product')) return 'product_rankings';
    if (url.includes('/shop')) return 'shop';
    return 'other';
  }

  // Listen for messages from the extension popup
  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'LIVESCOPE_CAPTURE') {
      chrome.storage.local.get(['captures'], function(result) {
        const captures = result.captures || [];
        captures.push(event.data.record);
        // Keep last 5000 records max
        if (captures.length > 5000) captures.splice(0, captures.length - 5000);
        chrome.storage.local.set({ captures });
      });
    }
  });

})();
