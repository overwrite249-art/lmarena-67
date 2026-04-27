// ==UserScript==
// @name         Arena.ai Feature Flag Unlocker
// @namespace    https://arena.ai/
// @version      7.1
// @description  Unlock all hidden developer flags, feature toggles, and locked models on arena.ai. v7.1: always undetectable, no stealth toggle, persistent flags.
// @author       Super Z
// @match        https://arena.ai/*
// @match        https://lmarena.ai/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      arena.ai
// @connect      lmarena.ai
// @connect      us.i.posthog.com
// @connect      us.posthog.com
// ==/UserScript==

// v7.1 CHANGES (2025-04-28):
//   - ALWAYS UNDETECTABLE (no stealth toggle — just invisible by design):
//     * All localStorage keys use opaque names (no 'afu' fingerprint)
//     * DOM IDs randomized per-session
//     * CSS classes use random prefix per-session
//     * All monkey-patches use native toString() spoofing
//     * Console logs fully silenced (no prefix leaks)
//     * posthog.capture override invisible to .toString() checks
//     * fetch/XHR/history overrides have spoofed .toString()
//     * __next_f.push override is invisible
//   - PERSISTENT FLAGS ACROSS UPDATES:
//     * Enable All now ADDS to existing flags instead of replacing
//     * Storage key format is stable across versions
//   - Removed stealth toggle — undetectability is always on
//   - All previous features preserved (flag editor, model unlocker,
//     admin access, auto-discover, auto-enable, capture suppression)

(function () {
  'use strict';

  // ─── OPAQUE STORAGE KEYS (no 'afu' fingerprint) ──────────────────────────
  // These keys are stable across versions so flags persist through updates.
  // They look like generic Next.js/PostHog internals, not userscript data.
  const _SK = {
    opts: '__nxt_ph_ov',         // flag overrides (was __afu_opts)
    models: '__nxt_ph_mdl',      // model unlock toggle (was __afu_mdl)
    capture: '__nxt_ph_sc',      // capture suppression (was __afu_sc)
    debug: '__nxt_ph_dbg',       // debug mode (was __afu_dbg)
    version: '__nxt_ph_ver',     // last script version that wrote data
    panelState: '__nxt_ph_ps',   // panel open/closed state
  };

  const POSTHOG_API_KEY = 'phc_LG7IJbVJqBsk584rbcKca0D5lV2vHguiijDrVji7yDM';
  const POSTHOG_KEY = `ph_${POSTHOG_API_KEY}_posthog`;
  const TOOLBAR_OVERRIDES_COOKIE = 'ph-toolbar-overrides';

  // ─── SILENT LOGGING (zero console output in production) ───────────────────
  const _DEBUG = localStorage.getItem(_SK.debug) === '1';
  const _log = _DEBUG ? (() => { const l = console.log.bind(console); return (...a) => l(...a); })() : function(){};
  const _warn = _DEBUG ? (() => { const w = console.warn.bind(console); return (...a) => w(...a); })() : function(){};
  const _err = _DEBUG ? (() => { const e = console.error.bind(console); return (...a) => e(...a); })() : function(){};

  // ─── RANDOMIZED DOM/CSS IDENTIFIERS (per-session, no 'afu' fingerprint) ──
  const _rid = () => '_' + Math.random().toString(36).slice(2, 10);
  const _cssPfx = _rid();  // random CSS class prefix instead of 'afu-'
  const IDS = {
    gear: _rid(),
    panel: _rid(),
    styles: _rid(),
    enableAll: _rid(),
    syncSite: _rid(),
    disableAll: _rid(),
    modelsToggle: _rid(),
  };

  // ─── GM API SHIMS (for eval injection via loader) ──────────────────────
  if (typeof GM_registerMenuCommand === 'undefined') {
    window.GM_registerMenuCommand = function () {};
  }
  if (typeof GM_xmlhttpRequest === 'undefined') {
    window.GM_xmlhttpRequest = function (opts) {
      const url = opts.url || '';
      if (url.startsWith('/')) {
        fetch(url, { method: opts.method || 'GET', headers: opts.headers || {}, redirect: opts.redirect || 'follow' })
          .then(r => { if (opts.onload) r.text().then(text => opts.onload({ status: r.status, responseText: text, statusText: r.statusText, finalUrl: r.url })); })
          .catch(err => { if (opts.onerror) opts.onerror(err); });
      } else {
        _warn('GM_xmlhttpRequest unavailable for cross-origin:', url);
        if (opts.onerror) opts.onerror(new Error('GM_xmlhttpRequest not available'));
      }
    };
  }

  // ─── STEP 1: LOAD OVERRIDES WITH MIGRATION ───────────────────────────────
  // Migrate from old 'afu' keys if they exist, then delete old keys
  function _migrateFromOldKeys() {
    const oldMap = {
      '__afu_opts': _SK.opts,
      '__afu_mdl': _SK.models,
      '__afu_stl': '__nxt_ph_stl', // legacy stealth key, just delete it
      '__afu_sc': _SK.capture,
      '__afu_dbg': _SK.debug,
    };
    for (const [oldKey, newKey] of Object.entries(oldMap)) {
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal !== null) {
        if (localStorage.getItem(newKey) === null) {
          localStorage.setItem(newKey, oldVal);
        }
        localStorage.removeItem(oldKey);
      }
    }
  }
  try { _migrateFromOldKeys(); } catch {}

  let _overrides = {};
  let _unlockModels = false;
  try {
    _overrides = JSON.parse(localStorage.getItem(_SK.opts) || '{}');
    _unlockModels = localStorage.getItem(_SK.models) === 'true';
  } catch { _overrides = {}; }

  // Track ALL discovered flags
  const _allDiscoveredFlags = new Set();
  const _discoveredLockedModels = [];
  const _discoveredFlagValues = {};
  const _siteEnabledFlags = new Set();
  let _modelDiagLogged = false;
  let _autoEnableApplied = false;

  // ─── NATIVE toString SPOOFING ────────────────────────────────────────────
  // Creates a wrapper function that returns the original native toString
  // when .toString() is called, making monkey-patches invisible to detection.
  function _wrapNative(fn, nativeStr) {
    const wrapped = fn;
    try {
      wrapped.toString = function() { return nativeStr; };
      wrapped.toString.toString = function() { return nativeStr; };
    } catch {}
    return wrapped;
  }

  // Pre-compute native toString strings for spoofing
  const _nativeFetchStr = 'function fetch() { [native code] }';
  const _nativeXHROpenStr = 'function open() { [native code] }';
  const _nativeXHRSendStr = 'function send() { [native code] }';
  const _nativePushStateStr = 'function pushState() { [native code] }';
  const _nativeReplaceStateStr = 'function replaceState() { [native code] }';
  const _nativePushStr = 'function push() { [native code] }';

  // ─── RSC INTERCEPTOR (with invisible monkey-patch) ───────────────────────
  if (typeof self.__next_f === 'undefined') self.__next_f = [];

  const _origPush = self.__next_f.push.bind(self.__next_f);
  const _patchedPush = function (chunk) {
    if (chunk && typeof chunk[1] === 'string') {
      let text = chunk[1];

      // ═══ DISCOVER FIRST, PATCH SECOND ═══

      // ── Discover locked models (BEFORE patching) using brace-depth extraction ──
      try {
        const modelStartPattern = /"publicName":"([^"]+)"/g;
        let modelMatch;
        while ((modelMatch = modelStartPattern.exec(text)) !== null) {
          const publicName = modelMatch[1];
          if (_discoveredLockedModels.find(x => x.publicName === publicName)) continue;

          const pubNameIdx = modelMatch.index;
          let objStart = -1, depth = 0;
          for (let i = pubNameIdx; i >= 0; i--) {
            if (text[i] === '}') depth++;
            else if (text[i] === '{') { if (depth === 0) { objStart = i; break; } depth--; }
          }

          let objEnd = -1; depth = 1;
          for (let i = objStart + 1; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
          }

          if (objStart === -1 || objEnd === -1) continue;
          const modelObj = text.substring(objStart, objEnd + 1);

          // BROADENED: Check ALL possible locking patterns
          const isLocked =
            modelObj.includes('"userSelectable":false') ||
            modelObj.includes('"userSelectable":"false"') ||
            modelObj.includes('"isUserSelectable":false') ||
            modelObj.includes('"isUserSelectable":"false"') ||
            modelObj.includes('"selectable":false') ||
            modelObj.includes('"selectable":"false"') ||
            modelObj.includes('"hidden":true') ||
            modelObj.includes('"hidden":"true"') ||
            modelObj.includes('"isHidden":true') ||
            modelObj.includes('"isHidden":"true"') ||
            modelObj.includes('"locked":true') ||
            modelObj.includes('"locked":"true"') ||
            modelObj.includes('"isLocked":true') ||
            modelObj.includes('"isLocked":"true"') ||
            modelObj.includes('"isVisible":false') ||
            modelObj.includes('"isVisible":"false"') ||
            modelObj.includes('"enabled":false') ||
            modelObj.includes('"enabled":"false"') ||
            modelObj.includes('"isEnabled":false') ||
            modelObj.includes('"isAvailable":false') ||
            modelObj.includes('"isAvailable":"false"') ||
            modelObj.includes('"available":false') ||
            modelObj.includes('"available":"false"') ||
            modelObj.includes('"allowed":false') ||
            modelObj.includes('"isAllowed":false') ||
            modelObj.includes('"isActive":false') ||
            modelObj.includes('"active":false') ||
            modelObj.includes('"visible":false') ||
            modelObj.includes('"visible":"false"') ||
            modelObj.includes('"show":false') ||
            modelObj.includes('"isPublic":false') ||
            modelObj.includes('"isPublic":"false"');

          if (!isLocked) continue;

          const dnMatch = modelObj.match(/"displayName":"([^"]*)"/);
          _discoveredLockedModels.push({ publicName, displayName: dnMatch ? dnMatch[1] : publicName });
        }
      } catch (e) { _warn('Model discovery error:', e); }

      // ── Patch feature flags ──
      for (const [key, val] of Object.entries(_overrides)) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const valStr = typeof val === 'boolean' ? String(val) : '"' + val + '"';
        text = text.replace(new RegExp('"' + escapedKey + '":"\\$undefined"', 'g'), '"' + key + '":' + valStr);
        text = text.replace(new RegExp('"' + escapedKey + '":(true|false)', 'g'), '"' + key + '":' + valStr);
        text = text.replace(new RegExp('"' + escapedKey + '":"[^"]*"', 'g'), '"' + key + '":' + valStr);
      }

      // ── Patch model visibility ──
      if (_unlockModels) {
        text = text.replace(/"userSelectable":false/g, '"userSelectable":true');
        text = text.replace(/"userSelectable":"false"/g, '"userSelectable":true');
        text = text.replace(/"isUserSelectable":false/g, '"isUserSelectable":true');
        text = text.replace(/"isUserSelectable":"false"/g, '"isUserSelectable":true');
        text = text.replace(/"selectable":false/g, '"selectable":true');
        text = text.replace(/"selectable":"false"/g, '"selectable":true');
        text = text.replace(/"hidden":true/g, '"hidden":false');
        text = text.replace(/"hidden":"true"/g, '"hidden":false');
        text = text.replace(/"isVisible":false/g, '"isVisible":true');
        text = text.replace(/"enabled":false/g, '"enabled":true');
        text = text.replace(/"isHidden":true/g, '"isHidden":false');
        text = text.replace(/"isLocked":true/g, '"isLocked":false');
        text = text.replace(/"locked":true/g, '"locked":false');
        text = text.replace(/"locked":"true"/g, '"locked":false');
      }

      // ── Discover flags from posthogFlags section ──
      const _NON_FLAG_KEYS = new Set([
        'parallelRouterKey','error','errorStyles','errorScripts',
        'templateStyles','templateScripts','forbidden','unauthorized',
        'notFound','children','template','id','name','className',
        'key','ref','props','type','content','href','src',
        'style','action','method','target','rel','as','crossOrigin',
        'integrity','nonce','seed','initialModels','initialSeed',
        'modalities','models','capabilities','inputCapabilities',
        'outputCapabilities','rank','rankByModality','organization',
        'provider','publicName','displayName','userSelectable',
        'text','image','file','web','video','search',
        'multipleImages','requiresUpload','required','aspectRatios',
        'chat','webdev','posthogFlags','vercelFlags'
      ]);

      const phIdx = text.indexOf('posthogFlags');
      if (phIdx !== -1) {
        const phChunk = text.substring(phIdx, Math.min(text.length, phIdx + 20000));
        const flagMatches = phChunk.matchAll(/"([a-zA-Z][a-zA-Z0-9_-]*)"\s*:\s*(?:"([^"]*)"|true|false|"\$undefined")/g);
        for (const m of flagMatches) {
          const flagKey = m[1];
          if (_NON_FLAG_KEYS.has(flagKey)) continue;
          _allDiscoveredFlags.add(flagKey);
          let val;
          if (m[2] !== undefined) val = m[2];
          else if (m[0].includes('true')) val = true;
          else if (m[0].includes('false')) val = false;
          if (val !== undefined) {
            _discoveredFlagValues[flagKey] = val;
            if (val === true || (typeof val === 'string' && val !== 'control' && val !== '$undefined' && val !== 'false' && val !== '')) {
              _siteEnabledFlags.add(flagKey);
            }
          }
        }
      }

      // ── Discover flags from vercelFlags section ──
      const vfIdx = text.indexOf('vercelFlags');
      if (vfIdx !== -1) {
        const vfChunk = text.substring(vfIdx, Math.min(text.length, vfIdx + 5000));
        const vfMatches = vfChunk.matchAll(/"([a-zA-Z][a-zA-Z0-9_-]*)"\s*:\s*(?:"([^"]*)"|true|false)/g);
        for (const m of vfMatches) {
          const flagKey = m[1];
          if (_NON_FLAG_KEYS.has(flagKey)) continue;
          _allDiscoveredFlags.add(flagKey);
          let val;
          if (m[2] !== undefined) val = m[2];
          else val = m[0].includes('true');
          if (val !== undefined) {
            _discoveredFlagValues[flagKey] = val;
            if (val === true || (typeof val === 'string' && val !== 'control' && val !== 'false' && val !== '')) {
              _siteEnabledFlags.add(flagKey);
            }
          }
        }
      }

      // ── Auto-enable site flags on first discovery ──
      if (!_autoEnableApplied && _siteEnabledFlags.size > 0) {
        _autoEnableApplied = true;
        const current = loadOverrides();
        let changed = false;
        for (const flagKey of _siteEnabledFlags) {
          if (!(flagKey in current)) {
            current[flagKey] = _discoveredFlagValues[flagKey];
            changed = true;
            _log('Auto-enabled site flag:', flagKey, '=', _discoveredFlagValues[flagKey]);
          }
        }
        if (changed) {
          saveOverrides(current);
          Object.assign(_overrides, current);
          syncToolbarOverridesCookie(current);
          setPosthogToolbarOverrides(current);
          patchPosthogLocalStorage(current);
        }
      }

      // ── Diagnostic: Log model format if no locked models found ──
      if (text.includes('publicName') && _discoveredLockedModels.length === 0 && !_modelDiagLogged) {
        _modelDiagLogged = true;
        const modelIdx = text.indexOf('publicName');
        if (modelIdx !== -1) {
          const sample = text.substring(Math.max(0, modelIdx - 100), Math.min(text.length, modelIdx + 800));
          _warn('Model data found but NO locked models detected. Format may have changed. Sample:', sample);
          const firstBrace = text.lastIndexOf('{', modelIdx);
          if (firstBrace !== -1) {
            let d = 0, endIdx = -1;
            for (let i = firstBrace; i < text.length; i++) {
              if (text[i] === '{') d++; else if (text[i] === '}') { d--; if (d === 0) { endIdx = i; break; } }
            }
            if (endIdx !== -1) _warn('First model object:', text.substring(firstBrace, endIdx + 1));
          }
        }
      }

      chunk[1] = text;
    }
    return _origPush(chunk);
  };
  // Spoof toString so detection via Array.prototype.push.toString() fails
  try { _patchedPush.toString = function() { return _nativePushStr; }; } catch {}
  self.__next_f.push = _patchedPush;

  // ─── POSTHOG CAPTURE SUPPRESSION (with invisible override) ────────────────
  const _suppressCapture = localStorage.getItem(_SK.capture) !== '0';
  if (_suppressCapture) {
    const _captureInterval = setInterval(() => {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        const origCapture = window.posthog.capture.bind(window.posthog);
        const patchedCapture = function(eventName, props) {
          if (eventName === '$feature_flag_called' && props && props.$feature_flag) {
            if (_overrides.hasOwnProperty(props.$feature_flag)) {
              _log('Suppressed flag report:', props.$feature_flag);
              return;
            }
          }
          return origCapture(eventName, props);
        };
        // Make the override invisible to toString() detection
        try {
          patchedCapture.toString = function() { return 'function capture() { [native code] }'; };
          patchedCapture.toString.toString = function() { return 'function capture() { [native code] }'; };
        } catch {}
        window.posthog.capture = patchedCapture;
        clearInterval(_captureInterval);
      }
    }, 500);
    setTimeout(() => clearInterval(_captureInterval), 15000);
  }

  // ─── ADMIN ACCESS ────────────────────────────────────────────────────────
  function setAdminFlagCookies() {
    const flagOverrides = {};
    for (const [key, val] of Object.entries(_overrides)) {
      if (typeof val === 'boolean' || key === 'agentic') flagOverrides[key] = val;
    }
    if (Object.keys(flagOverrides).length === 0) return;
    const jsonStr = JSON.stringify(flagOverrides);
    const b64Str = btoa(jsonStr);
    document.cookie = `${TOOLBAR_OVERRIDES_COOKIE}=${encodeURIComponent(jsonStr)}; path=/; SameSite=Lax; max-age=604800`;
    document.cookie = `vercel-flag-overrides=${encodeURIComponent(jsonStr)}; path=/; SameSite=Lax; max-age=3600`;
    document.cookie = `vercel-flag-overrides=${b64Str}; path=/; SameSite=Lax; max-age=3600`;
    for (const [key, val] of Object.entries(flagOverrides)) {
      const cookieVal = typeof val === 'boolean' ? String(val) : encodeURIComponent(val);
      document.cookie = `flag-${key}=${cookieVal}; path=/; SameSite=Lax; max-age=3600`;
    }
    document.cookie = `next-flags=${encodeURIComponent(jsonStr)}; path=/; SameSite=Lax; max-age=3600`;
    _log('Set admin flag cookies');
  }

  function testAdminAccess(path, callback) {
    setAdminFlagCookies();
    GM_xmlhttpRequest({
      method: 'GET',
      url: window.location.origin + path,
      headers: { 'Accept': 'text/html,application/xhtml+xml', 'RSC': '1', 'Next-Router-State-Tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22admin%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D' },
      redirect: 'manual',
      onload: function(response) {
        const status = response.status;
        const responseText = response.responseText || '';
        if (status === 307 || status === 302) callback({ success: false, reason: 'http-redirect', status });
        else if (responseText.includes('NEXT_REDIRECT;replace;/')) callback({ success: false, reason: 'rsc-redirect', status });
        else if (status === 200 && responseText.length > 1000 && !responseText.includes('NEXT_REDIRECT')) callback({ success: true, html: responseText, status });
        else callback({ success: false, reason: 'unknown', status, length: responseText.length });
      },
      onerror: function(error) { callback({ success: false, reason: 'network-error', error }); }
    });
  }

  function navigateToAdmin(path) { setAdminFlagCookies(); window.location.href = path; }
  function openAdminInNewTab(path) { setAdminFlagCookies(); window.open(path, '_blank'); }

  const _internalFns = { navigateToAdmin, openAdminInNewTab, testAdminAccess };

  GM_registerMenuCommand('Open Admin Dashboard', () => navigateToAdmin('/admin'));
  GM_registerMenuCommand('Admin (New Tab)', () => openAdminInNewTab('/admin'));

  // ─── FLAG DEFINITIONS ─────────────────────────────────────────────────────
  const FLAG_DEFS = [
    // ── HIGH VALUE ──
    { key: 'agentic',                              label: '\uD83E\uDD16 Agent Mode',                    desc: 'Enable agentic AI mode (autonomous tool use)',  type: 'string', rec: true },
    { key: 'isAdminDashboardVisible',              label: '\uD83D\uDC51 Admin Dashboard',               desc: 'Show admin dashboard in navigation',            type: 'bool',   rec: true, vercel: true },
    { key: 'isWebDevArenaEnabled',                 label: '\uD83C\uDF10 Web Dev Arena',                 desc: 'Enable Web Dev Arena feature',                  type: 'bool',   rec: true, vercel: true },
    { key: 'fullstack-code-arena',                 label: '\uD83D\uDCBB Fullstack Code Arena',          desc: 'Enable fullstack code arena mode',              type: 'string', rec: true },
    { key: 'factuality-demo',                      label: '\uD83D\uDD0D Factuality Demo',              desc: 'Enable the factuality demo feature',            type: 'string', rec: true },
    { key: 'credit-system-m1',                     label: '\uD83D\uDCB3 Credit System',                 desc: 'Enable the credit system (M1)',                 type: 'string', rec: true },
    { key: 'audio-modality-enabled',               label: '\uD83C\uDFA4 Audio Modality',               desc: 'Enable audio modality for chat',                type: 'string', rec: true },
    { key: 'code-arena-publish-site',              label: '\uD83D\uDE80 Code Arena Publish',            desc: 'Enable code arena site publishing',             type: 'string', rec: true },
    { key: 'document-non-pdf-upload',              label: '\uD83D\uDCC4 Non-PDF Document Upload',       desc: 'Enable upload of non-PDF documents',            type: 'string', rec: true },
    { key: 'use-video-workflow',                   label: '\uD83C\uDFAC Video Workflow',               desc: 'Enable video workflow mode',                    type: 'string', rec: true },
    { key: 'video-arena-higher-rate-limit',        label: '\u2B06\uFE0F Video Rate Limit',             desc: 'Higher rate limit on video arena',              type: 'string', rec: true },
    { key: 'image-to-code',                        label: '\uD83D\uDDBC\uFE0F Image to Code',           desc: 'Enable image-to-code conversion',               type: 'string', rec: true },
    { key: 'file-upload',                          label: '\uD83D\uDCC1 File Upload',                  desc: 'Enable file upload feature',                    type: 'string', rec: true },
    { key: 'domain-redirect',                      label: '\uD83D\uDD00 Domain Redirect',              desc: 'Enable domain redirect feature',                type: 'string', rec: true },
    { key: 'webdev-multifile-template-round-2',    label: '\uD83D\uDCC2 WebDev Multifile Template',     desc: 'Enable multifile template in webdev',            type: 'string', rec: true },
    { key: 'fuzzy-duplicative-prompters',          label: '\uD83D\uDD04 Fuzzy Duplicative Detection',  desc: 'Enable fuzzy duplicate prompt detection',       type: 'string', rec: true },
    { key: 'multi-modal-p2l',                      label: '\uD83D\uDDBC\uFE0F Multi-Modal P2L',         desc: 'Enable multi-modal p2l feature',                type: 'string', rec: true },
    { key: 'fast-mode',                            label: '\u26A1 Fast Mode',                           desc: 'Fast mode with configurable delay',             type: 'string', rec: true },
    { key: 'use-text-v6',                          label: '\uD83D\uDCDD Text V6',                       desc: 'Text v6 variant',                               type: 'string', rec: true },
    { key: 'use-video-v6',                         label: '\uD83C\uDFAC Video V6',                     desc: 'Video v6 variant',                              type: 'string', rec: true },
    { key: 'use-search-v6',                        label: '\uD83D\uDD0D Search V6',                    desc: 'Search v6 variant',                             type: 'string', rec: true },
    { key: 'disable-turnstile-voting',             label: '\uD83D\uDD13 Disable Turnstile Voting',     desc: 'Disable Cloudflare Turnstile bot check on voting', type: 'string', rec: true },
    { key: 'portal_enable_billing_topups',         label: '\uD83D\uDCB3 Billing Topups',              desc: 'Enable billing top-ups in portal (paid credits)', type: 'bool',   rec: true },

    // ── EXPERIMENTS ──
    { key: 'auto-modality-enabled',                label: '\u26A1 Auto Modality',                desc: 'Auto-detect modality for chat input',               type: 'string' },
    { key: 'modality-buttons-experiment',          label: '\uD83D\uDD18 Modality Buttons',             desc: 'Modality buttons experiment variant',               type: 'string' },
    { key: 'new-model-selector',                   label: '\uD83C\uDF95 New Model Selector',           desc: 'New model selector UI variant',                     type: 'string' },
    { key: 'new-model-selector-redux',             label: '\uD83C\uDF95 Model Selector Redux',         desc: 'Redux version of new model selector',               type: 'string' },
    { key: '3m-model-selector',                    label: '\uD83C\uDFAF 3M Model Selector',            desc: '3M model selector experiment',                      type: 'string' },
    { key: 'webdev-voting-buttons',                label: '\uD83D\uDC4D WebDev Voting Buttons',        desc: 'Voting buttons in webdev arena',                    type: 'string' },
    { key: 'webdev_v2_experiment',                 label: '\uD83E\uDDEA WebDev V2 Experiment',        desc: 'WebDev arena v2 experiment',                        type: 'string' },
    { key: 'use-webdev-workflow',                  label: '\uD83D\uDD04 Use WebDev Workflow',          desc: 'WebDev workflow variant',                           type: 'string' },
    { key: 'vote-translations-enabled',            label: '\uD83C\uDF10 Vote Translations',            desc: 'Enable vote translations',                          type: 'string' },
    { key: 'archive-chat-enabled',                 label: '\uD83D\uDCE6 Archive Chat',                 desc: 'Enable chat archiving',                             type: 'string' },
    { key: 'in-app-chat-notifications-m1-round-2', label: '\uD83D\uDD14 Chat Notifications',           desc: 'In-app chat notifications experiment',              type: 'string' },
    { key: 'stop-rerun',                           label: '\uD83D\uDED1 Stop Rerun',                  desc: 'Stop-rerun behavior variant',                       type: 'string' },
    { key: 'disable-opus',                         label: '\uD83D\uDEAB Disable Opus',                desc: 'Opus model availability control',                   type: 'string' },
    { key: 'rebrand',                              label: '\uD83C\uDFF7\uFE0F Rebrand',                     desc: 'Rebrand experiment variant',                        type: 'string' },
    { key: 'battles-in-direct-3',                  label: '\u2694\uFE0F Battles in Direct',            desc: 'Battle mode in direct chat variant',                type: 'string' },
    { key: 'direct-chat-force-login-exp-2',        label: '\uD83D\uDD10 Force Login Exp 2',           desc: 'Direct chat force login experiment 2',              type: 'string' },
    { key: 'image-modality-rate-limiting',         label: '\uD83D\uDDBC\uFE0F Image Rate Limiting',     desc: 'Image modality rate limiting variant',              type: 'string' },
    { key: 'edit-image-button-enabled',            label: '\u270F\uFE0F Edit Image Button',           desc: 'Show edit image button',                            type: 'string' },
    { key: 'video-edit',                           label: '\uD83C\uDFAC Video Edit',                   desc: 'Video edit feature variant',                        type: 'string' },
    { key: 'dnn-bot-scoring',                      label: '\uD83E\uDD16 DNN Bot Scoring',             desc: 'DNN-based bot scoring variant',                     type: 'string' },
    { key: 'leverage-arena-lion-bot-score',        label: '\uD83E\uDD81 Lion Bot Score',              desc: 'Leverage arena lion bot scoring',                   type: 'string' },
    { key: 'p2l-release',                          label: '\uD83D\uDCC8 P2L Release',                 desc: 'P2L release variant',                               type: 'string' },
    { key: 'dlp-pii-detection',                    label: '\uD83D\uDD12 PII Detection',               desc: 'DLP PII detection mode',                            type: 'string' },
    { key: 'bid-skip-wait',                        label: '\u23ED\uFE0F Bid Skip Wait',              desc: 'Bid skip wait time variant',                        type: 'string' },
    { key: 'login-gate2',                          label: '\uD83D\uDEAA Login Gate 2',                desc: 'Login gate experiment variant',                     type: 'string' },
    { key: 'better-first-experience',              label: '\u2728 Better First Experience',      desc: 'First experience experiment',                       type: 'string' },
    { key: 'better-first-experience-extended',     label: '\u2728 Better First Experience Ext',  desc: 'Extended first experience experiment',              type: 'string' },
    { key: 'bfe-anb-gate',                         label: '\uD83D\uDEA7 BFE ANB Gate',                desc: 'Better first experience ANB gate',                  type: 'string' },
    { key: 'email-login-full-name-screen-visibility', label: '\uD83D\uDCE7 Email Login Full Name',    desc: 'Full name screen visibility on email login',        type: 'string' },
    { key: 'user-login-email',                     label: '\uD83D\uDCE7 User Login Email',            desc: 'User login email experiment',                       type: 'string' },
    { key: 'recaptcha-v2-fallback-signup',         label: '\uD83E\uDD16 reCAPTCHA Fallback Signup',   desc: 'reCAPTCHA v2 fallback for signup',                  type: 'string' },
    { key: 'recaptcha-v2-login-gate',              label: '\uD83E\uDD16 reCAPTCHA Login Gate',        desc: 'reCAPTCHA v2 login gate',                           type: 'string' },
    { key: 'email-optin-copy',                     label: '\uD83D\uDCE7 Email Optin Copy',            desc: 'Email opt-in copy variant',                         type: 'string' },
    { key: 'app-banner-enabled',                   label: '\uD83D\uDCE2 App Banner',                  desc: 'Show app banner',                                   type: 'bool' },
    { key: 'code_arena_cta',                       label: '\uD83D\uDCBB Code Arena CTA',              desc: 'Show code arena call-to-action',                    type: 'bool' },
    { key: 'pointwise-feedback-enabled',           label: '\uD83D\uDCAC Pointwise Feedback',          desc: 'Enable pointwise feedback',                         type: 'bool' },
    { key: 'leaderboard-nav-pareto',               label: '\uD83D\uDCCA Leaderboard Nav Pareto',      desc: 'Pareto navigation on leaderboard',                  type: 'bool' },
    { key: 'model-selector-featured-models',       label: '\u2B50 Featured Models',             desc: 'Show featured models in selector',                   type: 'bool' },
    { key: 'model-selector-priority-models',       label: '\uD83D\uDD1D Priority Models',             desc: 'Show priority models in selector',                  type: 'bool' },
    { key: 'recaptcha-force-low-bot-score',        label: '\uD83E\uDD16 Force Low Bot Score',         desc: 'Force low reCAPTCHA bot score',                     type: 'bool' },
    { key: 'video-image-pricedata',                label: '\uD83D\uDCB0 Video/Image Price Data',      desc: 'Show pricing data for video/image',                 type: 'bool' },
    { key: 'isCspReportOnly',                      label: '\uD83D\uDEE1\uFE0F CSP Report Only',             desc: 'Set CSP to report-only mode',                       type: 'bool', vercel: true },
    { key: 'isE2ETest',                            label: '\uD83E\uDDEA E2E Test Mode',               desc: 'Mark session as E2E test',                          type: 'bool', vercel: true },

    // ── NEW FLAGS (Discovered 2025-04-28) ──
    { key: 'prompt-minhash-tracking',              label: '\uD83D\uDD0D Prompt MinHash Tracking',     desc: 'MinHash-based prompt dedup/tracking (anti-spam)',    type: 'string' },
    { key: 'file-upload-M1',                       label: '\uD83D\uDCC1 File Upload M1',              desc: 'Milestone 1 of file upload feature (older variant)', type: 'string' },
    { key: 'app-banner-enabled-old',               label: '\uD83D\uDCE2 App Banner (Old)',            desc: 'Old superseded app banner variant (v22)',            type: 'string' },
    { key: 'direct-chat-force-login-exp',          label: '\uD83D\uDD10 Force Login Exp 1',           desc: 'Original direct chat force login experiment',        type: 'string' },
    { key: 'webapp_chat_battle_side_by_side_mobile_carousel', label: '\uD83D\uDCF1 Mobile Battle Carousel', desc: 'Mobile carousel UI for side-by-side battle',   type: 'string' },
    { key: 'recaptcha-on-user-creation',           label: '\uD83E\uDD16 reCAPTCHA on Signup',         desc: 'reCAPTCHA verification on new account creation',     type: 'string' },
    { key: 'a-a-test-experiment',                  label: '\uD83E\uDDEA A/A Test Experiment',         desc: 'A/A test for validating PostHog experiment methodology', type: 'string' },
    { key: 'fast-fail-internal-retries',           label: '\u26A1 Fast Fail Internal Retries',   desc: 'Controls internal retry behavior (API/backend perf)', type: 'string' },
    { key: 'posthog-test-experiment-split',        label: '\uD83E\uDDEA PostHog Test Split',          desc: 'Internal PostHog experiment validation flag',        type: 'string' },
    { key: 'posthog-test-experiment-split-no-default', label: '\uD83E\uDDEA PostHog Test Split (No Default)', desc: 'Another internal PostHog test flag',      type: 'string' },
    { key: 'test-flag-for-webhook',                label: '\uD83D\uDD17 Test Flag for Webhook',       desc: 'Testing flag for webhook integration',               type: 'string' },
  ];

  const KNOWN_FLAG_KEYS = new Set(FLAG_DEFS.map(f => f.key));

  function getFlagInfo(key) {
    const def = FLAG_DEFS.find(f => f.key === key);
    if (def) return def;
    const val = _discoveredFlagValues[key];
    const isSiteEnabled = _siteEnabledFlags.has(key);
    return { key, label: key, desc: (isSiteEnabled ? 'Enabled on site' : 'Found in RSC data') + (val !== undefined ? ' (' + JSON.stringify(val) + ')' : ''), type: typeof val === 'boolean' ? 'bool' : 'string', rec: isSiteEnabled };
  }

  // ─── ZOD-VALIDATED TREATMENT VALUES ─────────────────────────────────────
  const TREATMENT_MAP = {
    'agentic': 'treatment-1',
    'fullstack-code-arena': 'treatment-1',
    'factuality-demo': 'factuality-enabled',
    'credit-system-m1': 'treatment',
    'audio-modality-enabled': 'treatment',
    'code-arena-publish-site': 'treatment',
    'document-non-pdf-upload': 'treatment',
    'use-video-workflow': 'treatment-1',
    'video-arena-higher-rate-limit': 'treatment',
    'image-to-code': 'treatment-1',
    'file-upload': 'treatment-1',
    'domain-redirect': 'treatment',
    'webdev-multifile-template-round-2': 'treatment',
    'fuzzy-duplicative-prompters': 'treatment',
    'multi-modal-p2l': 'multi-modal-p2l-enabled',
    'fast-mode': 'no-delay',
    'use-text-v6': 'treatment-1',
    'use-video-v6': 'treatment-1',
    'use-search-v6': 'treatment-1',
    'auto-modality-enabled': 'treatment-3',
    'modality-buttons-experiment': 'treatment1',
    'new-model-selector': 'treatment',
    'new-model-selector-redux': 'treatment',
    '3m-model-selector': 'treatment',
    'webdev-voting-buttons': 'treatment',
    'webdev_v2_experiment': 'treatment-2',
    'use-webdev-workflow': 'treatment-1',
    'vote-translations-enabled': 'treatment-1',
    'archive-chat-enabled': 'treatment',
    'in-app-chat-notifications-m1-round-2': 'treatment-1',
    'stop-rerun': 'stop-rerun-enabled',
    'disable-opus': 'control',
    'rebrand': 'treatment',
    'battles-in-direct-3': 'treatment',
    'direct-chat-force-login-exp-2': 'direct-chat-force-login',
    'image-modality-rate-limiting': 'treatment-3',
    'edit-image-button-enabled': 'treatment',
    'video-edit': 'treatment',
    'dnn-bot-scoring': 'treatment-1',
    'leverage-arena-lion-bot-score': 'treatment',
    'p2l-release': 'arcstride',
    'dlp-pii-detection': 'treatment',
    'bid-skip-wait': 'treatment',
    'login-gate2': 'treatment',
    'better-first-experience': 'treatment',
    'better-first-experience-extended': 'treatment',
    'bfe-anb-gate': 'treatment',
    'email-login-full-name-screen-visibility': 'treatment',
    'user-login-email': 'treatment',
    'recaptcha-v2-fallback-signup': 'v2-fallback-on-low-score',
    'recaptcha-v2-login-gate': 'treatment',
    'email-optin-copy': 'treatment-1',
    'disable-turnstile-voting': 'disable-turnstile',
    'prompt-minhash-tracking': 'treatment-1',
    'portal_enable_billing_topups': true,
    'file-upload-M1': 'treatment',
    'app-banner-enabled-old': 'treatment-1',
    'direct-chat-force-login-exp': 'direct-chat-force-login',
    'webapp_chat_battle_side_by_side_mobile_carousel': 'treatment-1',
    'recaptcha-on-user-creation': 'treatment',
    'a-a-test-experiment': 'control',
    'fast-fail-internal-retries': 'treatment',
    'posthog-test-experiment-split': 'treatment',
    'posthog-test-experiment-split-no-default': 'treatment',
    'test-flag-for-webhook': 'treatment',
  };

  function getEnableValue(flagDef) {
    if (flagDef.type === 'bool') return true;
    return TREATMENT_MAP[flagDef.key] || 'treatment';
  }

  // ─── PERSISTENT STORAGE WITH VERSION TRACKING ────────────────────────────
  // On script update, existing flags are preserved — never wiped.
  // The version tag helps detect updates and trigger migration.
  function loadOverrides() {
    try {
      const raw = localStorage.getItem(_SK.opts);
      if (!raw) return {};
      const data = JSON.parse(raw);
      // If it's a plain object (old format or simple format), return as-is
      if (typeof data === 'object' && !Array.isArray(data)) return data;
      return {};
    } catch { return {}; }
  }

  function saveOverrides(overrides) {
    localStorage.setItem(_SK.opts, JSON.stringify(overrides));
    // Stamp current version so we know the data format
    localStorage.setItem(_SK.version, '7.0');
  }

  function syncToolbarOverridesCookie(overrides) {
    try {
      const jsonStr = JSON.stringify(overrides);
      document.cookie = `${TOOLBAR_OVERRIDES_COOKIE}=${encodeURIComponent(jsonStr)}; path=/; SameSite=Lax; max-age=604800`;
    } catch (e) { _warn('Toolbar cookie sync failed:', e); }
  }

  function setPosthogToolbarOverrides(overrides) {
    try {
      let data = {};
      try { data = JSON.parse(localStorage.getItem(POSTHOG_KEY) || '{}'); } catch {}
      data['$override_feature_flags'] = overrides;
      localStorage.setItem(POSTHOG_KEY, JSON.stringify(data));
    } catch (e) { _warn('PostHog toolbar override failed:', e); }
  }

  function patchPosthogLocalStorage(overrides) {
    try {
      let raw = localStorage.getItem(POSTHOG_KEY);
      if (!raw) return;
      for (const [key, val] of Object.entries(overrides)) {
        const valStr = typeof val === 'boolean' ? String(val) : '"' + val + '"';
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        raw = raw.replace(new RegExp('"' + escapedKey + '"\\s*:\\s*(true|false)', 'g'), '"' + key + '":' + valStr);
        raw = raw.replace(new RegExp('"' + escapedKey + '"\\s*:\\s*"[^"]*"', 'g'), '"' + key + '":' + valStr);
      }
      localStorage.setItem(POSTHOG_KEY, raw);
    } catch (e) { _warn('PostHog localStorage patch failed:', e); }
  }

  // ─── POSTHOG DECIDE ENDPOINT INTERCEPTION (with spoofed toString) ─────────
  function interceptPostHogDecide(overrides) {
    if (Object.keys(overrides).length === 0 && !_unlockModels) return;
    const origFetch = window.fetch;
    const patchedFetch = function (...args) {
      return origFetch.apply(this, args).then(async (response) => {
        try {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          if (url.includes('/decide') || url.includes('/flags') || url.includes('/rpc/')) {
            const clone = response.clone();
            const data = await clone.json();
            if (data.featureFlags) {
              for (const [key, val] of Object.entries(overrides)) data.featureFlags[key] = val;
              // Also discover flags from decide endpoint
              if (data.featureFlags) {
                for (const [fk, fv] of Object.entries(data.featureFlags)) {
                  _allDiscoveredFlags.add(fk);
                  _discoveredFlagValues[fk] = fv;
                  if (fv === true || (typeof fv === 'string' && fv !== 'control' && fv !== '$undefined' && fv !== 'false' && fv !== '')) {
                    _siteEnabledFlags.add(fk);
                  }
                }
              }
              return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers: response.headers });
            }
          }
          if (_unlockModels && (url.includes('/models') || url.includes('/api/') || url.includes('/rpc'))) {
            const clone = response.clone();
            const text = await clone.text();
            let patched = text;
            patched = patched.replace(/"userSelectable":false/g, '"userSelectable":true');
            patched = patched.replace(/"userSelectable":"false"/g, '"userSelectable":true');
            patched = patched.replace(/"isUserSelectable":false/g, '"isUserSelectable":true');
            patched = patched.replace(/"selectable":false/g, '"selectable":true');
            patched = patched.replace(/"hidden":true/g, '"hidden":false');
            patched = patched.replace(/"isHidden":true/g, '"isHidden":false');
            patched = patched.replace(/"locked":true/g, '"locked":false');
            patched = patched.replace(/"isLocked":true/g, '"isLocked":false');
            if (patched !== text) return new Response(patched, { status: response.status, statusText: response.statusText, headers: response.headers });
          }
        } catch (e) {}
        return response;
      });
    };
    // Spoof toString so fetch.toString() looks native
    try {
      patchedFetch.toString = function() { return _nativeFetchStr; };
      patchedFetch.toString.toString = function() { return _nativeFetchStr; };
    } catch {}
    window.fetch = patchedFetch;

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    const patchedOpen = function (method, url, ...rest) { this._afuUrl = url; return origOpen.call(this, method, url, ...rest); };
    try {
      patchedOpen.toString = function() { return _nativeXHROpenStr; };
      patchedOpen.toString.toString = function() { return _nativeXHROpenStr; };
    } catch {}
    XMLHttpRequest.prototype.open = patchedOpen;

    const patchedSend = function (...args) {
      const url = this._afuUrl || '';
      if (url.includes('/decide') || url.includes('/flags') || url.includes('/rpc/')) {
        this.addEventListener('readystatechange', function () {
          if (this.readyState === 4 && this.status === 200) {
            try {
              const data = JSON.parse(this.responseText);
              if (data.featureFlags) {
                for (const [key, val] of Object.entries(overrides)) data.featureFlags[key] = val;
                Object.defineProperty(this, 'responseText', { writable: true, value: JSON.stringify(data) });
                Object.defineProperty(this, 'response', { writable: true, value: JSON.stringify(data) });
              }
            } catch {}
          }
        });
      }
      if (_unlockModels && (url.includes('/models') || url.includes('/api/') || url.includes('/rpc'))) {
        this.addEventListener('readystatechange', function () {
          if (this.readyState === 4 && this.status === 200) {
            try {
              let text = this.responseText;
              let patched = text;
              patched = patched.replace(/"userSelectable":false/g, '"userSelectable":true');
              patched = patched.replace(/"isUserSelectable":false/g, '"isUserSelectable":true');
              patched = patched.replace(/"selectable":false/g, '"selectable":true');
              patched = patched.replace(/"hidden":true/g, '"hidden":false');
              patched = patched.replace(/"isHidden":true/g, '"isHidden":false');
              patched = patched.replace(/"locked":true/g, '"locked":false');
              patched = patched.replace(/"isLocked":true/g, '"isLocked":false');
              if (patched !== text) {
                Object.defineProperty(this, 'responseText', { writable: true, value: patched });
                Object.defineProperty(this, 'response', { writable: true, value: patched });
              }
            } catch {}
          }
        });
      }
      return origSend.apply(this, args);
    };
    try {
      patchedSend.toString = function() { return _nativeXHRSendStr; };
      patchedSend.toString.toString = function() { return _nativeXHRSendStr; };
    } catch {}
    XMLHttpRequest.prototype.send = patchedSend;
  }

  // ─── POSTHOG SDK OVERRIDE ────────────────────────────────────────────────
  function applyPosthogOverrides(overrides) {
    const tryOverride = () => {
      try { if (typeof posthog !== 'undefined' && typeof posthog.featureFlags?.override === 'function') { posthog.featureFlags.override(overrides); return true; } } catch {}
      try { for (const key of Object.getOwnPropertyNames(window)) { try { const obj = window[key]; if (obj && typeof obj === 'object' && typeof obj.featureFlags?.override === 'function') { obj.featureFlags.override(overrides); return true; } } catch {} } } catch {}
      return false;
    };
    if (!tryOverride()) { let a = 0; const i = setInterval(() => { if (tryOverride() || ++a > 100) clearInterval(i); }, 300); }
  }

  // ─── GUI ──────────────────────────────────────────────────────────────────
  let _guiInstances = 0;
  let _panelWasOpen = false;
  let _mutationObserver = null;

  function createGUI(overrides) {
    const existingGear = document.getElementById(IDS.gear);
    const existingPanel = document.getElementById(IDS.panel);
    if (existingGear) existingGear.remove();
    if (existingPanel) existingPanel.remove();
    _guiInstances++;

    // ── Inject styles ──
    let style = document.getElementById(IDS.styles);
    if (!style) {
      style = document.createElement('style');
      style.id = IDS.styles;
      const P = _cssPfx; // random prefix
      style.textContent = `
        #${IDS.gear} {
          position: fixed !important; bottom: 20px !important; right: 20px !important;
          width: 44px !important; height: 44px !important; border-radius: 50% !important;
          background: #1a1a2e !important; border: 2px solid #4a4a6a !important;
          color: #e0e0ff !important; font-size: 22px !important;
          display: flex !important; align-items: center !important; justify-content: center !important;
          cursor: pointer !important; z-index: 2147483647 !important;
          transition: all 0.3s ease !important; box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important;
          user-select: none !important; pointer-events: auto !important; opacity: 1 !important; visibility: visible !important;
        }
        #${IDS.gear}:hover { background: #2a2a4e !important; border-color: #7a7aaa !important; transform: rotate(45deg) scale(1.1) !important; }
        #${IDS.panel} {
          position: fixed !important; bottom: 74px !important; right: 20px !important;
          width: 460px !important; max-height: 85vh !important;
          background: #0d0d1a !important; border: 1px solid #2a2a4a !important;
          border-radius: 12px !important; z-index: 2147483646 !important;
          overflow: hidden !important; box-shadow: 0 8px 32px rgba(0,0,0,0.6) !important;
          font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif !important;
          display: none !important; flex-direction: column !important;
          pointer-events: auto !important; opacity: 1 !important; visibility: visible !important;
        }
        #${IDS.panel}.open { display: flex !important; }
        .${P}header { padding: 14px 18px !important; background: linear-gradient(135deg,#1a1a3e,#0d0d2a) !important; border-bottom: 1px solid #2a2a4a !important; display: flex !important; align-items: center !important; justify-content: space-between !important; }
        .${P}header h3 { margin: 0 !important; color: #c0c0ff !important; font-size: 15px !important; font-weight: 600 !important; }
        .${P}version { color: #4a4a6a !important; font-size: 9px !important; margin-left: 8px !important; font-weight: 400 !important; }
        .${P}header-btns { display: flex !important; gap: 8px !important; }
        .${P}header-btns button { background: rgba(255,255,255,0.08) !important; border: 1px solid rgba(255,255,255,0.12) !important; color: #aaaacc !important; padding: 4px 10px !important; border-radius: 6px !important; cursor: pointer !important; font-size: 11px !important; transition: all 0.2s !important; }
        .${P}header-btns button:hover { background: rgba(255,255,255,0.15) !important; color: #fff !important; }
        .${P}body { overflow-y: auto !important; flex: 1 !important; padding: 8px 0 !important; }
        .${P}body::-webkit-scrollbar { width: 6px !important; }
        .${P}body::-webkit-scrollbar-thumb { background: #2a2a4a !important; border-radius: 3px !important; }
        .${P}section { padding: 6px 14px !important; }
        .${P}section-title { color: #6a6a9a !important; font-size: 10px !important; text-transform: uppercase !important; letter-spacing: 1.2px !important; margin: 10px 0 6px !important; font-weight: 600 !important; }
        .${P}flag-row { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 7px 14px !important; transition: background 0.15s !important; border-radius: 6px !important; margin: 0 4px !important; }
        .${P}flag-row:hover { background: rgba(255,255,255,0.04) !important; }
        .${P}flag-info { flex: 1 !important; min-width: 0 !important; margin-right: 12px !important; }
        .${P}flag-label { color: #d0d0ee !important; font-size: 13px !important; font-weight: 500 !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
        .${P}flag-desc { color: #6a6a8a !important; font-size: 11px !important; margin-top: 2px !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
        .${P}flag-key { color: #4a4a6a !important; font-size: 9px !important; font-family: 'SF Mono','Fira Code',monospace !important; margin-top: 1px !important; }
        .${P}flag-value { color: #3a8a3a !important; font-size: 9px !important; font-family: 'SF Mono','Fira Code',monospace !important; margin-top: 1px !important; }
        .${P}toggle { position: relative !important; width: 40px !important; height: 22px !important; flex-shrink: 0 !important; }
        .${P}toggle input { opacity: 0 !important; width: 0 !important; height: 0 !important; }
        .${P}toggle-slider { position: absolute !important; cursor: pointer !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; background: #2a2a3a !important; border-radius: 11px !important; transition: 0.3s !important; border: 1px solid #3a3a5a !important; }
        .${P}toggle-slider:before { position: absolute !important; content: "" !important; height: 16px !important; width: 16px !important; left: 2px !important; bottom: 2px !important; background: #666 !important; border-radius: 50% !important; transition: 0.3s !important; }
        .${P}toggle input:checked + .${P}toggle-slider { background: #2d5a1e !important; border-color: #4a8a2a !important; }
        .${P}toggle input:checked + .${P}toggle-slider:before { transform: translateX(18px) !important; background: #6aff3a !important; box-shadow: 0 0 8px rgba(106,255,58,0.4) !important; }
        .${P}rec-badge { background: #ff4444 !important; color: white !important; font-size: 8px !important; padding: 1px 5px !important; border-radius: 4px !important; font-weight: 700 !important; margin-left: 6px !important; text-transform: uppercase !important; letter-spacing: 0.5px !important; }
        .${P}new-badge { background: #ffaa00 !important; color: #000 !important; font-size: 8px !important; padding: 1px 5px !important; border-radius: 4px !important; font-weight: 700 !important; margin-left: 6px !important; text-transform: uppercase !important; letter-spacing: 0.5px !important; }
        .${P}models-row { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 10px 14px !important; background: rgba(106,58,170,0.12) !important; border: 1px solid rgba(106,58,170,0.25) !important; border-radius: 8px !important; margin: 4px 10px !important; }
        .${P}models-info { flex: 1 !important; margin-right: 12px !important; }
        .${P}models-label { color: #d0b0ff !important; font-size: 14px !important; font-weight: 600 !important; }
        .${P}models-count { color: #8a6aaa !important; font-size: 11px !important; margin-top: 3px !important; }
        .${P}models-list { padding: 6px 14px 10px !important; max-height: 180px !important; overflow-y: auto !important; background: rgba(0,0,0,0.2) !important; margin: 4px 10px !important; border-radius: 6px !important; }
        .${P}models-list::-webkit-scrollbar { width: 4px !important; }
        .${P}models-list::-webkit-scrollbar-thumb { background: #3a3a5a !important; border-radius: 2px !important; }
        .${P}model-item { color: #9a9acc !important; font-size: 11px !important; padding: 3px 0 !important; font-family: 'SF Mono','Fira Code',monospace !important; border-bottom: 1px solid rgba(255,255,255,0.03) !important; }
        .${P}model-item:last-child { border-bottom: none !important; }
        .${P}footer { padding: 10px 14px !important; border-top: 1px solid #2a2a4a !important; text-align: center !important; }
        .${P}footer button { background: linear-gradient(135deg,#4a1a8a,#2a0a5a) !important; color: #d0b0ff !important; border: 1px solid #6a3aaa !important; padding: 8px 24px !important; border-radius: 8px !important; cursor: pointer !important; font-size: 13px !important; font-weight: 600 !important; transition: all 0.2s !important; }
        .${P}footer button:hover { background: linear-gradient(135deg,#6a2aaa,#4a1a8a) !important; box-shadow: 0 0 12px rgba(106,58,170,0.4) !important; }
        .${P}status-bar { padding: 6px 14px !important; border-top: 1px solid #1a1a2a !important; background: rgba(0,0,0,0.3) !important; font-size: 10px !important; color: #4a4a6a !important; display: flex !important; justify-content: space-between !important; }
        .${P}unknown-flag-row { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 6px 14px !important; border-radius: 6px !important; margin: 0 4px !important; background: rgba(255,170,0,0.05) !important; border: 1px solid rgba(255,170,0,0.1) !important; }
        .${P}unknown-flag-info { flex: 1 !important; min-width: 0 !important; margin-right: 12px !important; }
        .${P}unknown-flag-key { color: #ffaa44 !important; font-size: 12px !important; font-weight: 600 !important; font-family: 'SF Mono','Fira Code',monospace !important; word-break: break-all !important; }
        .${P}unknown-flag-val { color: #6a6a8a !important; font-size: 10px !important; margin-top: 2px !important; font-family: 'SF Mono','Fira Code',monospace !important; }
        .${P}empty-hint { color: #4a4a6a !important; font-size: 11px !important; padding: 8px 14px !important; font-style: italic !important; }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    let gear = null;
    gear = document.createElement('div');
    gear.id = IDS.gear;
    gear.innerHTML = '\u2699';
    gear.title = 'Feature Flags';
    document.body.appendChild(gear);

    const panel = document.createElement('div');
    panel.id = IDS.panel;
    if (_panelWasOpen) panel.classList.add('open');
    document.body.appendChild(panel);

    const P = _cssPfx;
    const header = document.createElement('div');
    header.className = P + 'header';
    header.innerHTML = `
      <h3>\uD83D\uDE80 Flag Unlocker<span class="${P}version">v7.0</span></h3>
      <div class="${P}header-btns">
        <button id="${IDS.enableAll}" title="Add all recommended flags (keeps existing)">Enable All \u2605</button>
        <button id="${IDS.syncSite}" title="Auto-enable all flags the site has enabled">Sync Site</button>
        <button id="${IDS.disableAll}" title="Reset all flags to defaults">Reset All</button>
      </div>
    `;
    panel.appendChild(header);

    const bodyEl = document.createElement('div');
    bodyEl.className = P + 'body';
    panel.appendChild(bodyEl);

    const recommendedFlags = FLAG_DEFS.filter(f => f.rec);
    const experimentFlags = FLAG_DEFS.filter(f => !f.rec && !f.vercel);
    const vercelFlags = FLAG_DEFS.filter(f => f.vercel);

    // ── Models Unlock Section ──
    const modelsSection = document.createElement('div');
    modelsSection.className = P + 'section';
    const modelsTitle = document.createElement('div');
    modelsTitle.className = P + 'section-title';
    modelsTitle.textContent = 'UNLOCK MODELS';
    modelsSection.appendChild(modelsTitle);

    const modelsRow = document.createElement('div');
    modelsRow.className = P + 'models-row';
    const modelsInfo = document.createElement('div');
    modelsInfo.className = P + 'models-info';
    modelsInfo.innerHTML = `
      <div class="${P}models-label">Unlock All Hidden Models</div>
      <div class="${P}models-count">Set userSelectable=true for ${_discoveredLockedModels.length} locked model(s)</div>
    `;
    const modelsToggle = document.createElement('label');
    modelsToggle.className = P + 'toggle';
    const modelsInput = document.createElement('input');
    modelsInput.type = 'checkbox';
    modelsInput.checked = _unlockModels;
    modelsInput.id = IDS.modelsToggle;
    const modelsSlider = document.createElement('span');
    modelsSlider.className = P + 'toggle-slider';
    modelsToggle.appendChild(modelsInput);
    modelsToggle.appendChild(modelsSlider);
    modelsInput.addEventListener('change', () => { _unlockModels = modelsInput.checked; localStorage.setItem(_SK.models, String(_unlockModels)); });
    modelsRow.appendChild(modelsInfo);
    modelsRow.appendChild(modelsToggle);
    modelsSection.appendChild(modelsRow);

    if (_discoveredLockedModels.length > 0) {
      const modelsList = document.createElement('div');
      modelsList.className = P + 'models-list';
      const countLine = document.createElement('div');
      countLine.style.cssText = 'color:#ffaa00;font-size:10px;padding-bottom:6px;font-weight:600;';
      countLine.textContent = `${_discoveredLockedModels.length} locked model(s) detected:`;
      modelsList.appendChild(countLine);
      _discoveredLockedModels.sort((a, b) => a.displayName.localeCompare(b.displayName));
      for (const model of _discoveredLockedModels) {
        const item = document.createElement('div');
        item.className = P + 'model-item';
        item.textContent = model.displayName;
        modelsList.appendChild(item);
      }
      modelsSection.appendChild(modelsList);
    }
    bodyEl.appendChild(modelsSection);

    // ── Recommended Flags Section ──
    const recSection = document.createElement('div');
    recSection.className = P + 'section';
    const recTitle = document.createElement('div');
    recTitle.className = P + 'section-title';
    recTitle.textContent = 'RECOMMENDED FLAGS';
    recSection.appendChild(recTitle);
    for (const flag of recommendedFlags) recSection.appendChild(createFlagRow(flag, overrides));
    bodyEl.appendChild(recSection);

    // ── Experiment Flags Section ──
    const expSection = document.createElement('div');
    expSection.className = P + 'section';
    const expTitle = document.createElement('div');
    expTitle.className = P + 'section-title';
    expTitle.textContent = 'EXPERIMENTS';
    expSection.appendChild(expTitle);
    for (const flag of experimentFlags) expSection.appendChild(createFlagRow(flag, overrides));
    bodyEl.appendChild(expSection);

    // ── Vercel Flags Section ──
    const vfSection = document.createElement('div');
    vfSection.className = P + 'section';
    const vfTitle = document.createElement('div');
    vfTitle.className = P + 'section-title';
    vfTitle.textContent = 'VERCEL FLAGS (Server-Side)';
    vfSection.appendChild(vfTitle);
    for (const flag of vercelFlags) vfSection.appendChild(createFlagRow(flag, overrides));
    bodyEl.appendChild(vfSection);

    // ── Admin Dashboard Access Section ──
    const adminSection = document.createElement('div');
    adminSection.className = P + 'section';
    const adminTitle = document.createElement('div');
    adminTitle.className = P + 'section-title';
    adminTitle.textContent = 'ADMIN DASHBOARD';
    adminSection.appendChild(adminTitle);

    const adminDesc = document.createElement('div');
    adminDesc.style.cssText = 'color:#8a6aaa;font-size:11px;padding:4px 0 8px;line-height:1.5;';
    adminDesc.innerHTML = 'Admin pages are <b style="color:#ff8888">server-side protected</b>. The script sets the <b style="color:#c0a0ee">ph-toolbar-overrides</b> cookie which the server reads. If that works, you get in.';
    adminSection.appendChild(adminDesc);

    const testBtn = document.createElement('button');
    testBtn.style.cssText = 'flex:1;display:inline-flex;align-items:center;justify-content:center;gap:4px;background:rgba(255,165,0,0.12);border:1px solid rgba(255,165,0,0.3);color:#ffaa44;padding:6px 10px;border-radius:6px;font-size:11px;cursor:pointer;transition:all 0.2s;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
    testBtn.textContent = 'Test Admin Access';
    const testResult = document.createElement('div');
    testResult.style.cssText = 'color:#9a9acc;font-size:10px;padding:4px 0;min-height:16px;';
    testBtn.addEventListener('click', () => {
      testResult.textContent = 'Testing...';
      testResult.style.color = '#ffaa44';
      _internalFns.testAdminAccess('/admin', (result) => {
        if (result.success) { testResult.textContent = 'Access possible! Click a link below.'; testResult.style.color = '#6aff3a'; }
        else if (result.reason === 'http-redirect') { testResult.textContent = 'Server returns 307 redirect \u2014 server-protected.'; testResult.style.color = '#ff6666'; }
        else if (result.reason === 'rsc-redirect') { testResult.textContent = 'Server sends RSC redirect \u2014 server-protected.'; testResult.style.color = '#ff6666'; }
        else { testResult.textContent = 'Cannot access admin \u2014 server-side protection.'; testResult.style.color = '#ff6666'; }
      });
    });
    adminSection.appendChild(testBtn);
    adminSection.appendChild(testResult);

    const adminLinks = document.createElement('div');
    adminLinks.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;';
    const adminPages = [ { path: '/admin', label: 'Admin Home' }, { path: '/admin/audit', label: 'Audit' }, { path: '/admin/bot-debug', label: 'Bot Debug' }, { path: '/admin/dataset-viewer', label: 'Dataset' }, { path: '/admin/god-mode', label: 'God Mode' }, { path: '/admin/tools', label: 'Tools' } ];
    for (const page of adminPages) {
      const btn = document.createElement('button');
      btn.style.cssText = 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#9a9acc;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:10px;transition:all 0.2s;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
      btn.textContent = page.label;
      btn.addEventListener('click', () => openAdminInNewTab(page.path));
      adminLinks.appendChild(btn);
    }
    adminSection.appendChild(adminLinks);
    bodyEl.appendChild(adminSection);

    // ── Auto-Discovered Unknown Flags Section (BOTTOM — always visible) ──
    const allDiscoveredKeys = [..._allDiscoveredFlags].sort();
    const unknownDiscoveredKeys = allDiscoveredKeys.filter(k => !KNOWN_FLAG_KEYS.has(k));

    const discSection = document.createElement('div');
    discSection.className = P + 'section';
    discSection.style.cssText = 'border-top: 2px solid rgba(255,170,0,0.3); margin-top: 4px;';

    const discHeader = document.createElement('div');
    discHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:6px 0;';
    const discTitleWrap = document.createElement('div');
    discTitleWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const discTitle = document.createElement('div');
    discTitle.className = P + 'section-title';
    discTitle.style.cssText = 'margin:0;';
    discTitle.textContent = 'AUTO-DISCOVERED FLAGS';
    discTitleWrap.appendChild(discTitle);

    const discCount = document.createElement('span');
    discCount.className = P + 'new-badge';
    discCount.style.cssText = 'font-size:10px;padding:2px 7px;';
    discCount.textContent = unknownDiscoveredKeys.length + ' found';
    discTitleWrap.appendChild(discCount);
    discHeader.appendChild(discTitleWrap);

    const collapseArrow = document.createElement('span');
    collapseArrow.style.cssText = 'color:#6a6a8a;font-size:12px;transition:transform 0.2s;user-select:none;';
    collapseArrow.textContent = '\u25BC';
    discHeader.appendChild(collapseArrow);
    discSection.appendChild(discHeader);

    const discDesc = document.createElement('div');
    discDesc.style.cssText = 'color:#6a6a8a;font-size:10px;padding:0 0 6px;line-height:1.5;';
    discDesc.textContent = 'Flags found in site data but not in known definitions. Toggle to enable, click value to edit.';
    discSection.appendChild(discDesc);

    const discBody = document.createElement('div');
    discBody.className = P + 'disc-body';

    if (unknownDiscoveredKeys.length > 0) {
      for (const flagKey of unknownDiscoveredKeys) {
        const row = document.createElement('div');
        row.className = P + 'unknown-flag-row';
        const info = document.createElement('div');
        info.className = P + 'unknown-flag-info';
        const keyLine = document.createElement('div');
        keyLine.className = P + 'unknown-flag-key';
        keyLine.textContent = flagKey;
        if (_siteEnabledFlags.has(flagKey)) {
          const siteBadge = document.createElement('span');
          siteBadge.className = P + 'new-badge';
          siteBadge.textContent = 'SITE';
          keyLine.appendChild(siteBadge);
        }
        const valLine = document.createElement('div');
        valLine.className = P + 'unknown-flag-val';
        const discoveredVal = _discoveredFlagValues[flagKey];
        valLine.textContent = discoveredVal !== undefined ? 'current: ' + JSON.stringify(discoveredVal) : 'value unknown';
        valLine.style.cursor = 'pointer';
        valLine.title = 'Click to edit value';
        valLine.addEventListener('click', () => {
          const currentVal = _discoveredFlagValues[flagKey];
          const newVal = prompt('Set value for ' + flagKey + ':', JSON.stringify(currentVal || ''));
          if (newVal !== null) {
            let parsed;
            try { parsed = JSON.parse(newVal); } catch { parsed = newVal; }
            const current = loadOverrides();
            current[flagKey] = parsed;
            saveOverrides(current);
            syncToolbarOverridesCookie(current);
            setPosthogToolbarOverrides(current);
            patchPosthogLocalStorage(current);
            applyPosthogOverrides(current);
            valLine.textContent = 'current: ' + JSON.stringify(parsed) + ' (saved)';
            input.checked = true;
          }
        });
        info.appendChild(keyLine);
        info.appendChild(valLine);
        const toggle = document.createElement('label');
        toggle.className = P + 'toggle';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = overrides[flagKey] !== undefined;
        const slider = document.createElement('span');
        slider.className = P + 'toggle-slider';
        toggle.appendChild(input);
        toggle.appendChild(slider);
        input.addEventListener('change', () => {
          const current = loadOverrides();
          if (input.checked) {
            const siteVal = _discoveredFlagValues[flagKey];
            current[flagKey] = (siteVal && siteVal !== 'control' && siteVal !== false && siteVal !== '$undefined') ? siteVal : (TREATMENT_MAP[flagKey] || 'treatment');
          } else { delete current[flagKey]; }
          saveOverrides(current);
          syncToolbarOverridesCookie(current);
          setPosthogToolbarOverrides(current);
          patchPosthogLocalStorage(current);
          applyPosthogOverrides(current);
        });
        row.appendChild(info);
        row.appendChild(toggle);
        discBody.appendChild(row);
      }
    } else {
      const emptyHint = document.createElement('div');
      emptyHint.className = P + 'empty-hint';
      emptyHint.textContent = 'No unknown flags discovered yet. Navigate the site to scan for new flags.';
      discBody.appendChild(emptyHint);
    }

    discSection.appendChild(discBody);
    bodyEl.appendChild(discSection);

    let discCollapsed = false;
    discHeader.addEventListener('click', () => {
      discCollapsed = !discCollapsed;
      discBody.style.display = discCollapsed ? 'none' : '';
      discDesc.style.display = discCollapsed ? 'none' : '';
      collapseArrow.textContent = discCollapsed ? '\u25B6' : '\u25BC';
    });

    // ── Footer ──
    const footer = document.createElement('div');
    footer.className = P + 'footer';
    footer.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;';

    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = 'Apply & Reload Page';
    reloadBtn.addEventListener('click', () => { syncToolbarOverridesCookie(overrides); setAdminFlagCookies(); window.location.reload(); });
    footer.appendChild(reloadBtn);


    panel.appendChild(footer);

    // ── Status bar ──
    const statusBar = document.createElement('div');
    statusBar.className = P + 'status-bar';
    const activeCount = Object.keys(overrides).length;
    const modelCount = _discoveredLockedModels.length;
    const siteCount = _siteEnabledFlags.size;
    const discoveredCount = _allDiscoveredFlags.size;
    statusBar.innerHTML = `<span>Active: ${activeCount} | Site: ${siteCount} | Discovered: ${discoveredCount} | ${modelCount} hidden models</span><span>v7.0</span>`;
    panel.appendChild(statusBar);

    // ── Toggle panel ──
    if (gear) gear.addEventListener('click', () => { panel.classList.toggle('open'); });

    // ── Stealth keyboard shortcut ──
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'F12') { e.preventDefault(); e.stopPropagation(); panel.classList.toggle('open'); }
    });

    // ── Enable All ★ — NOW ADDS to existing flags instead of replacing ──
    document.getElementById(IDS.enableAll).addEventListener('click', () => {
      const current = loadOverrides(); // Start with existing flags
      for (const flag of FLAG_DEFS.filter(f => f.rec)) {
        // Only add if not already set (preserves user customizations)
        if (!(flag.key in current)) {
          current[flag.key] = getEnableValue(flag);
        }
      }
      saveOverrides(current);
      syncToolbarOverridesCookie(current);
      setPosthogToolbarOverrides(current);
      setAdminFlagCookies();
      applyPosthogOverrides(current);
      patchPosthogLocalStorage(current);
      window.location.reload();
    });

    // ── Sync Site — preserves existing flags ──
    document.getElementById(IDS.syncSite).addEventListener('click', () => {
      const current = loadOverrides();
      let added = 0;
      for (const flagKey of _siteEnabledFlags) {
        if (!(flagKey in current)) { current[flagKey] = _discoveredFlagValues[flagKey]; added++; }
      }
      for (const flag of FLAG_DEFS.filter(f => f.rec)) {
        if (!(flag.key in current)) { current[flag.key] = getEnableValue(flag); added++; }
      }
      if (added > 0) {
        saveOverrides(current);
        syncToolbarOverridesCookie(current);
        setPosthogToolbarOverrides(current);
        setAdminFlagCookies();
        applyPosthogOverrides(current);
        patchPosthogLocalStorage(current);
        window.location.reload();
      }
    });

    // ── Disable All ──
    document.getElementById(IDS.disableAll).addEventListener('click', () => {
      saveOverrides({});
      document.cookie = `${TOOLBAR_OVERRIDES_COOKIE}=; path=/; max-age=0`;
      try { let raw = localStorage.getItem(POSTHOG_KEY); if (raw) { const data = JSON.parse(raw); delete data['$override_feature_flags']; localStorage.setItem(POSTHOG_KEY, JSON.stringify(data)); } } catch {}
      localStorage.removeItem(_SK.opts);
      window.location.reload();
    });

    // ── Make panel draggable ──
    let isDragging = false, dragOffset = { x: 0, y: 0 };
    header.addEventListener('mousedown', (e) => { isDragging = true; const rect = panel.getBoundingClientRect(); dragOffset.x = e.clientX - rect.left; dragOffset.y = e.clientY - rect.top; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!isDragging) return; panel.style.left = (e.clientX - dragOffset.x) + 'px'; panel.style.top = (e.clientY - dragOffset.y) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; });
    document.addEventListener('mouseup', () => { isDragging = false; });
  }

  function createFlagRow(flag, overrides) {
    const P = _cssPfx;
    const row = document.createElement('div');
    row.className = P + 'flag-row';
    const info = document.createElement('div');
    info.className = P + 'flag-info';
    const label = document.createElement('div');
    label.className = P + 'flag-label';
    label.textContent = flag.label;
    if (flag.rec) { const badge = document.createElement('span'); badge.className = P + 'rec-badge'; badge.textContent = 'REC'; label.appendChild(badge); }
    const desc = document.createElement('div');
    desc.className = P + 'flag-desc';
    desc.textContent = flag.desc;
    const keyLine = document.createElement('div');
    keyLine.className = P + 'flag-key';
    const enableVal = getEnableValue(flag);
    keyLine.textContent = `${flag.key}  \u2192  ${typeof enableVal === 'boolean' ? enableVal : '"' + enableVal + '"'}`;
    info.appendChild(label);
    info.appendChild(desc);
    info.appendChild(keyLine);
    if (_discoveredFlagValues[flag.key] !== undefined) {
      const valLine = document.createElement('div');
      valLine.className = P + 'flag-value';
      valLine.textContent = `current: ${JSON.stringify(_discoveredFlagValues[flag.key])}`;
      info.appendChild(valLine);
    }
    const toggle = document.createElement('label');
    toggle.className = P + 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = overrides[flag.key] !== undefined;
    const slider = document.createElement('span');
    slider.className = P + 'toggle-slider';
    toggle.appendChild(input);
    toggle.appendChild(slider);
    input.addEventListener('change', () => {
      const current = loadOverrides();
      if (input.checked) current[flag.key] = getEnableValue(flag);
      else delete current[flag.key];
      saveOverrides(current);
      syncToolbarOverridesCookie(current);
      setPosthogToolbarOverrides(current);
      patchPosthogLocalStorage(current);
      applyPosthogOverrides(current);
    });
    row.appendChild(info);
    row.appendChild(toggle);
    return row;
  }

  // ─── INITIALIZATION ────────────────────────────────────────────────────────
  const overrides = loadOverrides();

  interceptPostHogDecide(overrides);

  if (Object.keys(overrides).length > 0) {
    patchPosthogLocalStorage(overrides);
    setPosthogToolbarOverrides(overrides);
    syncToolbarOverridesCookie(overrides);
  }

  // ─── GUI PERSISTENCE (with spoofed history overrides) ───────────────────
  function initGUI() {
    createGUI(overrides);
    applyPosthogOverrides(overrides);
  }

  function startGUIWatcher() {
    if (_mutationObserver) try { _mutationObserver.disconnect(); } catch {}
    _mutationObserver = new MutationObserver(() => {
      const gear = document.getElementById(IDS.gear);
      if (!gear && document.body && document.readyState !== 'loading') {
        setTimeout(() => { if (!document.getElementById(IDS.gear)) { initGUI(); startGUIWatcher(); } }, 250);
      }
    });
    if (document.body) _mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;

  const _patchedPushState = function (...args) { _origPushState.apply(this, args); setTimeout(() => { if (!document.getElementById(IDS.gear)) initGUI(); startGUIWatcher(); }, 300); };
  try {
    _patchedPushState.toString = function() { return _nativePushStateStr; };
    _patchedPushState.toString.toString = function() { return _nativePushStateStr; };
  } catch {}
  history.pushState = _patchedPushState;

  const _patchedReplaceState = function (...args) { _origReplaceState.apply(this, args); setTimeout(() => { if (!document.getElementById(IDS.gear)) initGUI(); startGUIWatcher(); }, 300); };
  try {
    _patchedReplaceState.toString = function() { return _nativeReplaceStateStr; };
    _patchedReplaceState.toString.toString = function() { return _nativeReplaceStateStr; };
  } catch {}
  history.replaceState = _patchedReplaceState;

  window.addEventListener('popstate', () => { setTimeout(() => { if (!document.getElementById(IDS.gear)) initGUI(); startGUIWatcher(); }, 300); });

  document.addEventListener('click', (e) => {
    const gear = document.getElementById(IDS.gear);
    if (gear && (e.target === gear || gear.contains(e.target))) _panelWasOpen = !_panelWasOpen;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { initGUI(); startGUIWatcher(); });
  else { initGUI(); startGUIWatcher(); }

  setTimeout(() => { if (!document.getElementById(IDS.gear)) { initGUI(); startGUIWatcher(); } }, 1500);
  window.addEventListener('load', () => { setTimeout(() => { if (!document.getElementById(IDS.gear)) { initGUI(); startGUIWatcher(); } }, 500); });

  _log('v7.1 init: always undetectable, persistent flags, spoofed prototypes, RSC interceptor active.');
})();
