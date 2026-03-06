# Code Review: Browser Extension Download vs. Upload Distinction

**Date**: 2026-03-05
**Scope**: Download/upload signal flow between browser extension service worker, browser plugin, and agent instructions
**Files Reviewed**:
- `packages/browser-extension/src/service-worker.js` (2049 LOC) — `handleClick`, `handleNavigate`, `handleDownload`, `handleFileUpload`, CDP event handlers, `consumeRecentDownload`
- `src/agent/src/plugins/browser-plugin.ts` (1324 LOC) — `browser_click`, `browser_download`, `browser_upload_file` tool definitions and handlers
- `src/agent/src/agent/agent.ts` (2387 LOC) — `browser_instructions` system prompt
**Focus**: Tracing actual code paths for 6 specific scenarios

---

## Overall Assessment

The download/upload distinction architecture is **well-designed** with clear separation of concerns:
- Downloads: `Browser.downloadWillBegin` → `recentDownloads[]` → `consumeRecentDownload()` → `download_triggered` signal → `browser_download action=wait`
- Uploads: `intercept_file_chooser=true` → `Page.setInterceptFileChooserDialog` → `Page.fileChooserOpened` → `pendingFileChoosers` → `file_chooser_opened` signal → `browser_upload_file`

The recent commits (`aeb3ed6`, `a474b5e`) specifically addressed the `showSaveFilePicker` collision by making file chooser interception opt-in. The DataTransfer injection approach eliminates the chrome.downloads popup issue. These were excellent fixes.

However, tracing through the actual code paths reveals **5 issues** ranging from medium to low severity, plus 2 known limitations worth documenting.

---

## Critical Issues

None found.

---

## High Priority

### H1. Stale File Chooser Interception on Error (Missing try/finally)

**Severity**: High | **Location**: `service-worker.js:346-393`

If `handleClick` throws **after** enabling `Page.setInterceptFileChooserDialog` (line 348) but **before** reaching the cleanup code (lines 384-393), the interception remains enabled indefinitely.

**Concrete failure path**:
1. Agent calls `browser_click(selector="#upload-btn", intercept_file_chooser=true)`
2. Line 348: `Page.setInterceptFileChooserDialog({ enabled: true })` → **succeeds**
3. Line 338: `getElementCenter(tid, "#upload-btn")` → **throws** "Element not found"
4. Error propagates up — lines 384-393 never execute
5. Interception stays enabled for this tab

**Impact**: Subsequent non-upload file dialogs on that tab (save-as, `showSaveFilePicker()`) would be intercepted and silently swallowed by CDP, creating a confusing dead-end for the user. The interception only resets on the next `handleClick` with `intercept_file_chooser=true` (which clears stale state on line 347) or on tab close.

**Fix**:
```javascript
async function handleClick({ selector, x, y, tabId, button, clickCount: count, pierce, intercept_file_chooser }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  // Enable file chooser interception on-demand
  if (intercept_file_chooser) {
    pendingFileChoosers.delete(tid);
    await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
  }

  try {
    let clickX = x;
    let clickY = y;

    if (selector) {
      const coords = pierce ? await resolveElementCoords(tid, selector) : await getElementCenter(tid, selector);
      clickX = coords.x;
      clickY = coords.y;
    } else if (clickX === undefined || clickY === undefined) {
      throw new Error("Click requires either 'selector' or both 'x' and 'y' coordinates");
    }

    // ... click dispatch code ...
    // ... 300ms delay ...

    const dl = consumeRecentDownload(tid);
    const result = { tabId: tid, element: selector || `(${clickX},${clickY})` };
    if (dl) result.download_triggered = { /* ... */ };

    if (intercept_file_chooser && pendingFileChoosers.has(tid)) {
      const fc = pendingFileChoosers.get(tid);
      result.file_chooser_opened = { /* ... */ };
    } else if (intercept_file_chooser) {
      await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    return result;
  } catch (err) {
    // Clean up interception if we enabled it but the click failed
    if (intercept_file_chooser) {
      await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    throw err;
  }
}
```

---

## Medium Priority

### M1. 300ms Race Window Can Miss Slow-Starting Downloads

**Severity**: Medium | **Location**: `service-worker.js:374`

The `handleClick` function waits only 300ms before checking `consumeRecentDownload()`. For clicks that trigger server-side processing before initiating a download (e.g., "Generate Report" → AJAX call → server builds PDF → browser starts download), the `Browser.downloadWillBegin` event may arrive after the 300ms window.

**What actually happens**: The download still completes in Chrome's download manager. The agent just doesn't get the `download_triggered` hint in the click response. The download is **not lost** — it's invisible to the immediate click response, but `browser_download action=list` or `action=wait` would still find it.

**Impact**: The agent doesn't know a download was triggered by the click, so it won't automatically call `browser_download action=wait`. The agent may need to take a screenshot or extract to figure out what happened, wasting turns.

**Possible mitigation** (not urgent): The current approach prioritizes responsiveness (300ms) over detection completeness. An alternative would be returning an optimistic response immediately and using a follow-up notification, but the current approach is a reasonable trade-off. Consider adding a note to the `browser_instructions` telling the agent:

```
If you expect a download but don't see download_triggered, try browser_download action=list after a few seconds — some downloads start with a delay.
```

### M2. File Upload via DataTransfer May Not Trigger Framework-Specific Handlers

**Severity**: Medium | **Location**: `service-worker.js:1138-1150` (`SET_FILE_JS`)

The injected `SET_FILE_JS` function dispatches `change` and `input` events:
```javascript
this.dispatchEvent(new Event('change', { bubbles: true }));
this.dispatchEvent(new Event('input', { bubbles: true }));
```

However, some frameworks use synthetic event systems that may not react to standard DOM events:
- **React 16+**: Uses a synthetic event system that reads from `event.nativeEvent`. Standard `Event()` might work because React listens on the document for bubbled events, but this depends on the React version and whether the component uses controlled or uncontrolled inputs.
- **Angular**: Typically uses `(change)` bindings which listen for the native `change` event — this should work.
- **Dropzone.js / FilePond / custom upload widgets**: May listen specifically for their own custom events or use `MutationObserver` on the `files` property.

**Impact**: File upload may appear to succeed (no error thrown) but the website doesn't process the file because its framework didn't detect the change.

**Possible mitigation**: After setting files, also dispatch an `InputEvent` (not just `Event`) with proper `inputType`:
```javascript
this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' }));
```
And consider triggering React's internal setter if detected:
```javascript
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype, 'value')?.set;
// React workaround for synthetic events
const reactFiber = Object.keys(this).find(k => k.startsWith('__reactFiber$'));
if (reactFiber) {
  this.dispatchEvent(new Event('change', { bubbles: true }));
}
```
This is a known challenge for all browser automation tools and the current implementation covers the majority of cases.

### M3. `showSaveFilePicker()` Downloads Are Invisible to the Agent

**Severity**: Medium | **Location**: Architectural gap

`showSaveFilePicker()` (File System Access API) bypasses Chrome's download manager entirely. The flow is:
1. Website JavaScript calls `showSaveFilePicker()` → OS save dialog appears
2. User picks location → `FileSystemWritableStream` returned
3. Website writes file data directly to disk via stream

**What the agent sees**: Nothing. `Browser.downloadWillBegin` does NOT fire. `chrome.downloads` API has no record. `browser_download action=wait` times out.

This specifically affects sites like Gemini (confirmed in commit `aeb3ed6` message: "Gemini's Download button using showSaveFilePicker").

**Impact**: When `intercept_file_chooser` is false (correct for downloads), the native save dialog appears. But the agent can't interact with OS-level dialogs. The file is saved to the user's chosen location, not captured by the agent.

**Current mitigation**: The opt-in `intercept_file_chooser` change (`aeb3ed6`) ensures we don't *break* this flow. But the agent has no way to *capture* files downloaded via `showSaveFilePicker()`.

**Possible future improvement**: Monkey-patch `showSaveFilePicker` in page context via `browser_execute` before clicking:
```javascript
// Intercept showSaveFilePicker to capture the file data
const origPicker = window.showSaveFilePicker;
window.showSaveFilePicker = async function(...args) {
  const handle = await origPicker.apply(this, args);
  const origCreateWritable = handle.createWritable.bind(handle);
  handle.createWritable = async function() {
    const writable = await origCreateWritable();
    // Wrap write() to capture data...
    return writable;
  };
  return handle;
};
```
This is complex and low-priority since `showSaveFilePicker()` usage is relatively rare.

---

## Low Priority

### L1. browser_instructions Don't Cover Error Recovery for Wrong intercept_file_chooser

**Severity**: Low | **Location**: `agent.ts:1371-1372`

The instructions say:
> "Do NOT use intercept_file_chooser for download buttons."

But they don't explain what happens if the agent guesses wrong. The code actually handles this gracefully (download proceeds, `download_triggered` is returned, interception is disabled), but the agent doesn't know this.

**Suggested addition**:
```
If you set intercept_file_chooser=true but the response contains download_triggered instead of file_chooser_opened, the download was NOT lost — proceed with browser_download action=wait as normal.
```

### L2. Drag-and-Drop File Upload Not Supported

**Severity**: Low (known limitation) | **Location**: `service-worker.js:728-786`

The `handleDrag` function dispatches raw mouse events (`mousePressed`, `mouseMoved`, `mouseReleased`). These do NOT carry `DataTransfer` payloads with file data. Websites using drag-and-drop upload zones (e.g., Gmail attachments, Slack, many modern upload UIs) cannot be targeted with `browser_drag`.

**Workaround**: The agent can use `browser_execute` to programmatically dispatch a `drop` event:
```javascript
const file = new File([bytes], 'test.pdf', { type: 'application/pdf' });
const dt = new DataTransfer();
dt.items.add(file);
const dropZone = document.querySelector('.drop-zone');
dropZone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
```

Or, most drag-and-drop zones also have a hidden `<input type="file">` fallback — the agent can use `browser_upload_file` with a CSS selector targeting it.

**Recommendation**: This is worth mentioning in `browser_instructions` or in the `browser_drag` tool description.

---

## Scenario Trace-Through: Answers to Review Questions

### Q1: Can a click trigger BOTH download_triggered AND file_chooser_opened simultaneously?

**Answer: Yes, technically, but it's handled correctly.**

In `handleClick` (lines 374-393), the download check and file chooser check are **independent** — not in an `if/else if` chain:
```javascript
const dl = consumeRecentDownload(tid);         // Check 1: download
if (dl) result.download_triggered = { ... };
if (intercept_file_chooser && pendingFileChoosers.has(tid)) {  // Check 2: file chooser
  result.file_chooser_opened = { ... };
}
```

Both fields can coexist in the response. In practice, a single click won't trigger both CDP events (`Browser.downloadWillBegin` and `Page.fileChooserOpened` are mutually exclusive for the same user action). The code is safe.

### Q2: Does showSaveFilePicker() get intercepted when intercept_file_chooser is false?

**Answer: No, correctly handled.**

File chooser interception is disabled by default (confirmed in `ensureDebugger` at line 1840-1842, introduced in commit `aeb3ed6`). `Page.setInterceptFileChooserDialog` is only enabled when the agent explicitly passes `intercept_file_chooser=true`.

Furthermore, even if interception were enabled, `showSaveFilePicker()` does NOT trigger `Page.fileChooserOpened` — it's a different browser API path (File System Access API vs. `<input type="file">`).

**However**, see M3 above — these downloads are also invisible to `Browser.downloadWillBegin`, so the agent can't capture them.

### Q3: Do anchor tags with download attribute trigger Browser.downloadWillBegin or Page.fileChooserOpened?

**Answer: `Browser.downloadWillBegin` — correctly detected as download.**

`<a href="file.pdf" download>` triggers a standard HTTP download. Chrome fires `Browser.downloadWillBegin` which is tracked in `recentDownloads[]`. The agent receives `download_triggered` in the click response and can use `browser_download action=wait`.

`Page.fileChooserOpened` is NOT fired — anchor downloads don't involve file input elements.

### Q4: If intercept_file_chooser=true but button triggers download, is the download lost?

**Answer: No — download is preserved correctly.**

Traced path:
1. Line 348: `Page.setInterceptFileChooserDialog({ enabled: true })` ✓
2. Click dispatched → `Browser.downloadWillBegin` fires → stored in `recentDownloads`
3. Line 374: 300ms delay
4. Line 375: `consumeRecentDownload(tid)` → finds download → `result.download_triggered` set ✓
5. Line 384: `pendingFileChoosers.has(tid)` → false (no file chooser opened)
6. Line 390: `else if (intercept_file_chooser)` → disables interception ✓
7. Agent sees `download_triggered`, calls `browser_download action=wait` → succeeds ✓

The download proceeds via `Browser.setDownloadBehavior({ behavior: "allow" })` which auto-accepts it.

### Q5: Are browser_instructions clear enough?

**Answer: Mostly yes, but with gaps.** See L1 for missing error recovery guidance. The upload and download workflows are described, but:
- No mention of direct `browser_upload_file` with selector (fallback mode)
- No guidance on drag-and-drop upload workarounds
- No advice on slow-starting downloads that miss `download_triggered`

### Q6: Can the agent handle drag-and-drop file upload?

**Answer: Not with existing tools.** See L2. `browser_drag` only dispatches mouse events, not `DragEvent` with `DataTransfer`. Workaround is `browser_execute` with custom JS, or finding the hidden `<input type="file">` element.

---

## Positive Observations

1. **Opt-in interception design** (commit `aeb3ed6`) is architecturally sound — it prevents the exact `showSaveFilePicker` collision that was reported
2. **DataTransfer injection** (commit `a474b5e`) eliminates the `chrome.downloads` popup elegantly — no temp files, no browser chrome intrusion
3. **Stale state cleanup** on `pendingFileChoosers.delete(tid)` (line 347) before re-enabling interception prevents ghost file choosers
4. **Tab close cleanup** (lines 2028-2048) properly clears all state maps including `pendingFileChoosers` and `recentDownloads`
5. **Consumer pattern** with `consumeRecentDownload()` (splice from array) prevents duplicate download signals
6. **Both signals in click response** — combining `download_triggered` and `file_chooser_opened` in the same response gives the agent immediate feedback without requiring a separate polling step
7. **Clear defensive comment** at line 1840-1842 explaining WHY interception is not global

---

## Recommended Actions (Prioritized)

1. **[High] Fix H1**: Add try/catch around click dispatch in `handleClick` to clean up `Page.setInterceptFileChooserDialog` on error
2. **[Medium] Improve M1**: Add instruction about slow downloads to `browser_instructions`
3. **[Medium] Document M3**: Add a known limitation note about `showSaveFilePicker()` downloads being invisible
4. **[Low] Improve L1**: Add error recovery guidance to `browser_instructions`
5. **[Low] Document L2**: Note drag-and-drop limitation in tool descriptions or instructions

---

## Metrics

- **Type Coverage**: N/A (service-worker.js is plain JavaScript; browser-plugin.ts uses `Record<string, any>` for handler args)
- **Test Coverage**: Not measured (no test files found for these modules)
- **Linting Issues**: Not checked (would require biome run)
- **Security Issues**: None found — file data flows through authenticated endpoints (`?token=...`), no credential exposure in signals

---

## Unresolved Questions

1. Does Chrome's `Page.fileChooserOpened` fire for `showOpenFilePicker()` (File System Access API for OPEN)? If sites use this instead of `<input type="file">`, the current interception might not work. Would need Chrome version-specific testing.
2. The `SET_FILE_JS` approach sets `this.files` on the element. For Shadow DOM `<input type="file">` inside web components, does `DOM.resolveNode` + `Runtime.callFunctionOn` correctly reach the shadow element? The `pierce` flag exists for selectors but the file chooser path uses `backendNodeId` directly — this likely works but hasn't been verified.
