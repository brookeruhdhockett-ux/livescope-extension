// Runs in ISOLATED world (content script context) — has access to chrome.storage
// Listens for postMessage from interceptor.js and stores captures ONLY when recording
window.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'LIVESCOPE_CAPTURE') {
    chrome.storage.local.get(['captures', 'recording'], function(result) {
      if (!result.recording) return; // Only capture when recording is active
      const captures = result.captures || [];
      captures.push(event.data.record);
      if (captures.length > 5000) captures.splice(0, captures.length - 5000);
      chrome.storage.local.set({ captures });
    });
  }
});
