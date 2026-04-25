// ==UserScript==
// @name         Arena Flag Loader
// @namespace    https://arena.ai/
// @version      1.1.0
// @description  Lightweight bootloader for Arena Flag Unlocker. Auto-updates from GitHub. Install ONCE, it handles the rest.
// @author       Super Z
// @match        https://arena.ai/*
// @match        https://lmarena.ai/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @connect      arena.ai
// @connect      lmarena.ai
// @connect      us.i.posthog.com
// @connect      us.posthog.com
// @downloadURL  https://raw.githubusercontent.com/overwrite249-art/lmarena-67/main/loader.user.js
// @updateURL    https://raw.githubusercontent.com/overwrite249-art/lmarena-67/main/loader.user.js
// @noframes
// ==/UserScript==

// ═══════════════════════════════════════════════════════════════════════════════
// Arena Flag Loader v1.1
//
// BOOTLOADER — install this ONCE in Tampermonkey, it handles the rest.
//
// First run:   No cache → show "Installing..." → download → cache → reload → done
// Normal run:  Cache → INSTANT inject (zero delay) → background check → silent
// Update:      Old cache → inject old → "Updating..." → download → reload → new
// ═══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const REPO = 'overwrite249-art/lmarena-67';
  const BRANCH = 'main';
  const BASE_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
  const VERSION_URL = `${BASE_URL}/version.json`;
  const SCRIPT_URL = `${BASE_URL}/arena-feature-flags.user.js`;

  const CACHE_KEY = 'afu_cached_script';
  const CACHE_VERSION_KEY = 'afu_cached_version';
  const JUST_UPDATED_KEY = 'afu_just_updated';

  // ─── TOAST NOTIFICATION SYSTEM ─────────────────────────────────────────────
  // Shows a floating notification in the bottom-left corner of the page.
  // Works at document-start (before DOM loads) by injecting styles + element
  // into the document as soon as it's available.

  const TOAST_STYLES = `
    #afu-toast-container {
      position: fixed; bottom: 20px; left: 20px; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .afu-toast {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 18px; border-radius: 10px;
      background: rgba(13, 13, 26, 0.95); border: 1px solid rgba(42, 42, 74, 0.8);
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      color: #c0c0e0; font-size: 13px; font-weight: 500;
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      animation: afu-toast-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: auto; max-width: 380px;
    }
    .afu-toast.fade-out {
      animation: afu-toast-out 0.4s ease forwards;
    }
    .afu-toast-icon {
      width: 28px; height: 28px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0;
    }
    .afu-toast-icon.loading {
      background: rgba(100,60,200,0.2); border: 1px solid rgba(100,60,200,0.4);
      animation: afu-spin 1s linear infinite;
    }
    .afu-toast-icon.success {
      background: rgba(40,120,40,0.2); border: 1px solid rgba(60,150,60,0.4);
    }
    .afu-toast-icon.update {
      background: rgba(200,130,0,0.2); border: 1px solid rgba(200,150,0,0.4);
    }
    .afu-toast-icon.error {
      background: rgba(200,40,40,0.2); border: 1px solid rgba(200,60,60,0.4);
    }
    .afu-toast-body { display: flex; flex-direction: column; gap: 2px; }
    .afu-toast-title { font-weight: 700; font-size: 13px; }
    .afu-toast-sub { color: #6a6a9a; font-size: 11px; }
    .afu-toast-progress {
      width: 100%; height: 2px; border-radius: 1px;
      background: rgba(255,255,255,0.06); margin-top: 6px; overflow: hidden;
    }
    .afu-toast-progress-bar {
      height: 100%; border-radius: 1px;
      background: linear-gradient(90deg, #6a2aaa, #a060ff);
      transition: width 0.3s ease;
    }
    .afu-toast.loading .afu-toast-title { color: #a080ff; }
    .afu-toast.success .afu-toast-title { color: #6aff3a; }
    .afu-toast.update .afu-toast-title { color: #ffaa44; }
    .afu-toast.error .afu-toast-title { color: #ff6666; }
    @keyframes afu-toast-in {
      from { opacity: 0; transform: translateX(-30px) scale(0.95); }
      to { opacity: 1; transform: translateX(0) scale(1); }
    }
    @keyframes afu-toast-out {
      from { opacity: 1; transform: translateX(0) scale(1); }
      to { opacity: 0; transform: translateX(-30px) scale(0.9); }
    }
    @keyframes afu-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;

  let toastContainer = null;
  let stylesInjected = false;

  function ensureToastReady() {
    if (stylesInjected) return;
    // Inject styles as early as possible
    if (document.head || document.documentElement) {
      const style = document.createElement('style');
      style.textContent = TOAST_STYLES;
      (document.head || document.documentElement).appendChild(style);
      stylesInjected = true;
    }
  }

  function ensureToastContainer() {
    ensureToastReady();
    if (toastContainer && toastContainer.parentNode) return toastContainer;
    // Wait for body if not available yet
    const parent = document.body || document.documentElement;
    if (!parent) return null;
    toastContainer = document.createElement('div');
    toastContainer.id = 'afu-toast-container';
    parent.appendChild(toastContainer);
    return toastContainer;
  }

  // Create a toast notification. Returns { update, remove } for controlling it.
  function showToast(type, title, sub, options = {}) {
    const container = ensureToastContainer();
    if (!container) return { update: () => {}, remove: () => {} };

    const toast = document.createElement('div');
    toast.className = `afu-toast ${type}`;

    const icons = {
      loading: '\u27F3',   // ⟳
      success: '\u2713',   // ✓
      update: '\u2191',    // ↑
      error: '\u2717',     // ✗
    };

    toast.innerHTML = `
      <div class="afu-toast-icon ${type}">${icons[type] || '?'}</div>
      <div class="afu-toast-body">
        <div class="afu-toast-title">${title}</div>
        ${sub ? `<div class="afu-toast-sub">${sub}</div>` : ''}
        ${options.progress !== undefined ? `<div class="afu-toast-progress"><div class="afu-toast-progress-bar" style="width:${options.progress}%"></div></div>` : ''}
      </div>
    `;

    container.appendChild(toast);
    return {
      update(newType, newTitle, newSub, newOptions) {
        toast.className = `afu-toast ${newType}`;
        const icon = toast.querySelector('.afu-toast-icon');
        if (icon) { icon.className = `afu-toast-icon ${newType}`; icon.textContent = icons[newType] || '?'; }
        const titleEl = toast.querySelector('.afu-toast-title');
        if (titleEl && newTitle) titleEl.textContent = newTitle;
        const subEl = toast.querySelector('.afu-toast-sub');
        if (subEl && newSub) subEl.textContent = newSub;
        // Handle progress bar
        let progBar = toast.querySelector('.afu-toast-progress-bar');
        if (newOptions && newOptions.progress !== undefined) {
          let progContainer = toast.querySelector('.afu-toast-progress');
          if (!progContainer) {
            progContainer = document.createElement('div');
            progContainer.className = 'afu-toast-progress';
            progContainer.innerHTML = '<div class="afu-toast-progress-bar"></div>';
            toast.querySelector('.afu-toast-body').appendChild(progContainer);
            progBar = progContainer.querySelector('.afu-toast-progress-bar');
          }
          if (progBar) progBar.style.width = newOptions.progress + '%';
        }
      },
      remove(delay = 0) {
        if (delay > 0) {
          setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 400);
          }, delay);
        } else {
          toast.classList.add('fade-out');
          setTimeout(() => toast.remove(), 400);
        }
      }
    };
  }

  // ─── STEP 1: TRY INSTANT INJECT FROM CACHE ────────────────────────────────

  let cachedScript = null;
  let cachedVersion = null;

  try {
    cachedScript = GM_getValue(CACHE_KEY, null);
    cachedVersion = GM_getValue(CACHE_VERSION_KEY, null);
  } catch (e) { /* GM storage unavailable */ }

  const justUpdated = GM_getValue(JUST_UPDATED_KEY, false);
  if (justUpdated) {
    GM_setValue(JUST_UPDATED_KEY, false);
  }

  // Inject cached script instantly
  if (cachedScript && cachedScript.length > 500) {
    try {
      (0, eval)(cachedScript);
      console.log(`[Arena Loader] Injected cached script v${cachedVersion} instantly`);
    } catch (e) {
      console.error('[Arena Loader] Failed to inject cached script:', e);
    }

    // Show "update applied" toast if we just reloaded after an update
    if (justUpdated) {
      document.addEventListener('DOMContentLoaded', () => {
        const t = showToast('success', 'Script Updated!', `Arena Flag Unlocker v${cachedVersion} is now active`);
        t.remove(4000);
      });
    }
  } else {
    console.log('[Arena Loader] No cached script found — downloading...');
  }

  // ─── STEP 2: DOWNLOAD OR CHECK FOR UPDATES ────────────────────────────────

  if (!cachedScript || cachedScript.length < 500) {
    // FIRST RUN — show install toast and download
    document.addEventListener('DOMContentLoaded', () => {
      const t = showToast('loading', 'Installing Arena Flag Unlocker...', 'Downloading script from GitHub', { progress: 0 });
      downloadScript('initial', t);
    });
    // Also try injecting styles early
    ensureToastReady();
  } else {
    // Normal run — silent background check
    checkForUpdate();
  }

  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: VERSION_URL,
      responseType: 'text',
      timeout: 8000,
      onload: function (response) {
        try {
          const versionData = JSON.parse(response.responseText);
          const remoteVersion = versionData.version;

          if (remoteVersion !== cachedVersion) {
            console.log(`[Arena Loader] Update available: v${cachedVersion} → v${remoteVersion}`);
            const t = showToast('update', 'Updating Script...', `v${cachedVersion} → v${remoteVersion}`, { progress: 0 });
            downloadScript(remoteVersion, t);
          } else {
            console.log(`[Arena Loader] Script up to date (v${remoteVersion})`);
          }
        } catch (e) {
          console.warn('[Arena Loader] Version check parse error:', e);
        }
      },
      onerror: function () {
        console.warn('[Arena Loader] Version check network error');
      },
      ontimeout: function () {
        console.warn('[Arena Loader] Version check timeout');
      }
    });
  }

  function downloadScript(newVersion, toast) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SCRIPT_URL,
      responseType: 'text',
      timeout: 30000,
      onprogress: function (response) {
        // Update progress bar if we have content-length
        if (toast && response.total > 0) {
          const pct = Math.min(100, Math.round((response.loaded / response.total) * 100));
          toast.update('loading', toast._title || 'Downloading...', null, { progress: pct });
        }
      },
      onload: function (response) {
        if (response.status === 200 && response.responseText && response.responseText.length > 1000) {
          const sizeKB = (response.responseText.length / 1024).toFixed(1);

          GM_setValue(CACHE_KEY, response.responseText);
          GM_setValue(CACHE_VERSION_KEY, newVersion || 'unknown');
          GM_setValue(JUST_UPDATED_KEY, true);

          console.log(`[Arena Loader] Downloaded v${newVersion} (${sizeKB} KB), reloading page...`);

          if (toast) {
            toast.update('success', 'Download Complete!', `${sizeKB} KB — Reloading page...`, { progress: 100 });
            // Reload after a short delay so the user sees the success toast
            setTimeout(() => window.location.reload(), 1200);
          } else {
            window.location.reload();
          }
        } else {
          console.error('[Arena Loader] Download failed — invalid response');
          if (toast) {
            toast.update('error', 'Download Failed', `HTTP ${response.status} — retrying in 5s...`);
          }
          if (!cachedScript) {
            setTimeout(() => downloadScript(newVersion, toast), 5000);
          }
        }
      },
      onerror: function () {
        console.error('[Arena Loader] Script download network error');
        if (toast) {
          toast.update('error', 'Network Error', 'Cannot reach GitHub — retrying in 5s...');
        }
        if (!cachedScript) {
          setTimeout(() => downloadScript(newVersion, toast), 5000);
        }
      },
      ontimeout: function () {
        console.error('[Arena Loader] Script download timeout');
        if (toast) {
          toast.update('error', 'Download Timeout', 'GitHub is slow — retrying in 5s...');
        }
        if (!cachedScript) {
          setTimeout(() => downloadScript(newVersion, toast), 5000);
        }
      }
    });
  }

  // ─── LOADER MENU COMMANDS ──────────────────────────────────────────────────
  GM_registerMenuCommand('Force Update Check', () => {
    GM_setValue(JUST_UPDATED_KEY, false);
    const t = showToast('loading', 'Checking for updates...', 'Contacting GitHub');
    // Override the toast in the callback
    GM_xmlhttpRequest({
      method: 'GET',
      url: VERSION_URL,
      responseType: 'text',
      timeout: 8000,
      onload: function (response) {
        try {
          const versionData = JSON.parse(response.responseText);
          const remoteVersion = versionData.version;
          if (remoteVersion !== cachedVersion) {
            t.update('update', 'Update Found!', `v${cachedVersion} → v${remoteVersion}`, { progress: 0 });
            downloadScript(remoteVersion, t);
          } else {
            t.update('success', 'Up to Date!', `v${remoteVersion} is the latest version`);
            t.remove(3000);
          }
        } catch (e) {
          t.update('error', 'Check Failed', 'Could not parse version info');
          t.remove(3000);
        }
      },
      onerror: function () {
        t.update('error', 'Network Error', 'Cannot reach GitHub');
        t.remove(3000);
      },
      ontimeout: function () {
        t.update('error', 'Timeout', 'GitHub took too long');
        t.remove(3000);
      }
    });
  });

  GM_registerMenuCommand('Clear Cached Script', () => {
    GM_setValue(CACHE_KEY, null);
    GM_setValue(CACHE_VERSION_KEY, null);
    GM_setValue(JUST_UPDATED_KEY, false);
    const t = showToast('success', 'Cache Cleared', 'Will re-download on next page load');
    t.remove(3000);
  });

  GM_registerMenuCommand('Show Cache Info', () => {
    const v = GM_getValue(CACHE_VERSION_KEY, 'none');
    const len = GM_getValue(CACHE_KEY, '')?.length || 0;
    const sizeKB = (len / 1024).toFixed(1);
    const t = showToast('success', 'Arena Flag Loader v1.1', `Cached: v${v} (${sizeKB} KB) — auto-updates from GitHub`);
    t.remove(5000);
  });

})();
