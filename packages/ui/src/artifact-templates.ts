// HTML document templates for sandboxed artifact iframes

const HTML_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src https:; connect-src 'none';">`;

const REACT_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src data: blob: https:; font-src https:; connect-src 'none';">`;

const RESIZE_SCRIPT = `<script>
(function() {
  var lastH = 0;
  function notifyHeight() {
    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (h !== lastH) { lastH = h; parent.postMessage({ type: "artifact-resize", height: h }, "*"); }
  }
  new MutationObserver(notifyHeight).observe(document.body, { childList: true, subtree: true, attributes: true });
  window.addEventListener("load", notifyHeight);
  notifyHeight();
  window.onerror = function(msg, _src, line, _col, _err) {
    parent.postMessage({ type: "artifact-error", message: String(msg), line: line }, "*");
  };
})();
</script>`;

const BASE_STYLES = `<style>body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }</style>`;

export function htmlArtifactTemplate(sanitizedHtml: string): string {
  return `<!DOCTYPE html>
<html><head>
${HTML_CSP}
${BASE_STYLES}
</head><body>
${sanitizedHtml}
${RESIZE_SCRIPT}
</body></html>`;
}

export function reactArtifactTemplate(jsxCode: string): string {
  return `<!DOCTYPE html>
<html><head>
${REACT_CSP}
<script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
${BASE_STYLES}
</head><body>
<div id="root"></div>
${RESIZE_SCRIPT}
<script type="text/babel" data-type="module">
try {
  ${jsxCode}

  // Auto-detect default export or App/Default component
  const Component = typeof App !== 'undefined' ? App
    : typeof Default !== 'undefined' ? Default
    : null;

  if (Component) {
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Component));
  }
} catch(e) {
  document.getElementById('root').innerHTML = '<pre style="color:red;padding:16px">' + e.message + '</pre>';
  parent.postMessage({ type: "artifact-error", message: e.message }, "*");
}
</script>
</body></html>`;
}
