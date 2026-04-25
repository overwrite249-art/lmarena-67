// ==UserScript==
// @name         Arena Flag Loader
// @namespace    https://arena.ai/
// @version      1.0.0
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
// @noframes
// ==/UserScript==

// ═══════════════════════════════════════════════════════════════════════════════
// Arena Flag Loader v1.0
//
// This is a BOOTLOADER — you install this ONCE in Tampermonkey and it handles
// everything else. On each page load it:
//
//   1. Checks if a cached version of the main script exists
//   2. If YES → injects it INSTANTLY (no delay, no refresh, catches RSC data)
//   3. In the background, checks GitHub for a new version
//   4. If a new version exists → downloads it, caches it, reloads the page ONCE
//   5. On the reload → the new version is injected instantly
//
// First run flow: no cache → download → cache → reload → injected ✓
// Normal run flow: cache → instant inject ✓ (background version check, silent)
// Update flow: old cache → inject old → new version found → download → reload → new ✓
// ═══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const REPO = 'overwrite249-art/lmarena-67';
  const BRANCH = 'main';
  const BASE_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
  const VERSION_URL = `${BASE_URL}/version.json`;
  const SCRIPT_URL = `${BASE_URL}/arena-feature-flags.user.js`;

  // Storage keys (using GM storage for cross-page persistence)
  const CACHE_KEY = 'afu_cached_script';
  const CACHE_VERSION_KEY = 'afu_cached_version';
  const JUST_UPDATED_KEY = 'afu_just_updated';

  // ─── STEP 1: TRY INSTANT INJECT FROM CACHE ────────────────────────────────
  // This runs IMMEDIATELY at document-start — zero delay.

  let cachedScript = null;
  let cachedVersion = null;

  try {
    cachedScript = GM_getValue(CACHE_KEY, null);
    cachedVersion = GM_getValue(CACHE_VERSION_KEY, null);
  } catch (e) { /* GM storage unavailable */ }

  // Check if we just did an update reload (prevent infinite loop)
  const justUpdated = GM_getValue(JUST_UPDATED_KEY, false);
  if (justUpdated) {
    GM_setValue(JUST_UPDATED_KEY, false);
  }

  // Inject cached script instantly if available and not in post-update reload
  if (cachedScript && cachedScript.length > 500) {
    if (!justUpdated) {
      try {
        // Execute the main script in this context
        // eval() in the IIFE scope has access to GM_ functions from this script's @grant
        (0, eval)(cachedScript);
        console.log(`[Arena Loader] Injected cached script v${cachedVersion} instantly`);
      } catch (e) {
        console.error('[Arena Loader] Failed to inject cached script:', e);
      }
    } else {
      // Post-update reload — still inject immediately, just log differently
      try {
        (0, eval)(cachedScript);
        console.log(`[Arena Loader] Injected UPDATED script v${cachedVersion} after reload`);
      } catch (e) {
        console.error('[Arena Loader] Failed to inject updated script:', e);
      }
    }
  } else {
    console.log('[Arena Loader] No cached script found — downloading...');
  }

  // ─── STEP 2: BACKGROUND VERSION CHECK ──────────────────────────────────────
  // This runs asynchronously — doesn't block the instant inject above.

  // If no cache at all, we need to download FIRST, then reload
  if (!cachedScript || cachedScript.length < 500) {
    // FIRST RUN — download immediately, no delay
    console.log('[Arena Loader] First run — downloading main script...');
    downloadScript('initial');
  } else {
    // Normal run — check for updates in background
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
            downloadScript(remoteVersion);
          } else {
            console.log(`[Arena Loader] Script up to date (v${remoteVersion})`);
          }
        } catch (e) {
          console.warn('[Arena Loader] Version check parse error:', e);
        }
      },
      onerror: function () {
        console.warn('[Arena Loader] Version check network error (offline?)');
      },
      ontimeout: function () {
        console.warn('[Arena Loader] Version check timeout');
      }
    });
  }

  function downloadScript(newVersion) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SCRIPT_URL,
      responseType: 'text',
      timeout: 15000,
      onload: function (response) {
        if (response.status === 200 && response.responseText && response.responseText.length > 1000) {
          // Cache the new script
          GM_setValue(CACHE_KEY, response.responseText);
          GM_setValue(CACHE_VERSION_KEY, newVersion || 'unknown');
          GM_setValue(JUST_UPDATED_KEY, true);

          console.log(`[Arena Loader] Downloaded v${newVersion}, reloading page...`);

          // Reload so the new script runs from document-start
          // (we need to catch RSC __next_f.push data before React processes it)
          window.location.reload();
        } else {
          console.error('[Arena Loader] Download failed — invalid response (status:', response.status, 'length:', response.responseText?.length, ')');
          // If we have a cached version, keep using it
          if (!cachedScript) {
            // No cache at all — retry after 5 seconds
            setTimeout(() => downloadScript(newVersion), 5000);
          }
        }
      },
      onerror: function () {
        console.error('[Arena Loader] Script download network error');
        if (!cachedScript) {
          setTimeout(() => downloadScript(newVersion), 5000);
        }
      },
      ontimeout: function () {
        console.error('[Arena Loader] Script download timeout');
        if (!cachedScript) {
          setTimeout(() => downloadScript(newVersion), 5000);
        }
      }
    });
  }

  // ─── LOADER MENU COMMANDS ──────────────────────────────────────────────────
  GM_registerMenuCommand('🔄 Force Update Check', () => {
    console.log('[Arena Loader] Force update check triggered');
    GM_setValue(JUST_UPDATED_KEY, false);
    checkForUpdate();
  });

  GM_registerMenuCommand('🗑️ Clear Cached Script', () => {
    GM_setValue(CACHE_KEY, null);
    GM_setValue(CACHE_VERSION_KEY, null);
    GM_setValue(JUST_UPDATED_KEY, false);
    console.log('[Arena Loader] Cache cleared');
    alert('Arena Loader: Cache cleared. Reload to re-download the script.');
  });

  GM_registerMenuCommand('📋 Show Cache Info', () => {
    const v = GM_getValue(CACHE_VERSION_KEY, 'none');
    const len = GM_getValue(CACHE_KEY, '')?.length || 0;
    alert(`Arena Loader v1.0\n\nCached version: ${v}\nCache size: ${(len / 1024).toFixed(1)} KB\n\nThe main script is auto-updated from GitHub.`);
  });

})();
