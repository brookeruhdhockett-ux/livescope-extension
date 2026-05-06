// Runs in ISOLATED world (content script context) — has access to chrome.storage
// Listens for postMessage from interceptor.js and stores captures ONLY when recording
window.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'LIVESCOPE_CAPTURE') {
    try {
      chrome.storage.local.get(['captures', 'recording'], function(result) {
        if (chrome.runtime.lastError) return; // Extension was reloaded
        if (!result.recording) return;
        const captures = result.captures || [];
        captures.push(event.data.record);
        if (captures.length > 5000) captures.splice(0, captures.length - 5000);
        chrome.storage.local.set({ captures });
      });
    } catch(e) {
      // Extension context invalidated — page needs refresh
    }
  }
});
