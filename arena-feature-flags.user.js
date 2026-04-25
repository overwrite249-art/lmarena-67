// ==UserScript==
// @name         Arena.ai Feature Flag Unlocker
// @namespace    https://arena.ai/
// @version      5.1.0
// @description  Unlock all hidden developer flags, feature toggles, and locked models on arena.ai. v5.1: Fixed GUI resilience, auto-detected flags always shown, MutationObserver re-injection.
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

// ═══════════════════════════════════════════════════════════════════════════════
// v5.1 CHANGES (2025-04):
//   - FIXED: GUI now survives React re-renders / client-side navigation
//   - MutationObserver re-injects gear + panel if removed from DOM
//   - CSS uses !important to prevent site from hiding elements
//   - Auto-detected flags section ALWAYS shown at bottom (even if empty)
//   - Unknown flags without proper names displayed at bottom of panel
// ═══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const STORAGE_KEY = 'arena_flag_overrides';
  const MODELS_KEY = 'arena_models_unlocked';
  const POSTHOG_API_KEY = 'phc_LG7IJbVJqBsk584rbcKca0D5lV2vHguiijDrVji7yDM';
  const POSTHOG_KEY = `ph_${POSTHOG_API_KEY}_posthog`;
  const TOOLBAR_OVERRIDES_COOKIE = 'ph-toolbar-overrides';

  // ─── STEP 1: LOAD OVERRIDES & INTERCEPT RSC IMMEDIATELY ──────────────────
  // This MUST run before ANY other code to catch __next_f.push calls.

  let _overrides = {};
  let _unlockModels = false;
  try {
    _overrides = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    _unlockModels = localStorage.getItem(MODELS_KEY) === 'true';
  } catch { /* empty */ }

  // Track discovered flags that are NOT in FLAG_DEFS
  const _discoveredFlags = new Set();
  // Track discovered non-selectable models
  const _discoveredLockedModels = [];
  // Track all discovered flag values from RSC/decide
  const _discoveredFlagValues = {};

  // ─── RSC INTERCEPTOR ────────────────────────────────────────────────────
  // Hook __next_f.push to patch RSC flight data before React processes it.

  if (typeof self.__next_f === 'undefined') {
    self.__next_f = [];
  }

  const _origPush = self.__next_f.push.bind(self.__next_f);
  self.__next_f.push = function (chunk) {
    if (chunk && typeof chunk[1] === 'string') {
      let text = chunk[1];

      // ── Patch feature flags ──
      for (const [key, val] of Object.entries(_overrides)) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const valStr = typeof val === 'boolean' ? String(val) : '"' + val + '"';

        // Pattern 1: "key":"$undefined" (RSC null-like value)
        text = text.replace(
          new RegExp('"' + escapedKey + '":"\\$undefined"', 'g'),
          '"' + key + '":' + valStr
        );

        // Pattern 2: "key":false or "key":true (boolean values)
        text = text.replace(
          new RegExp('"' + escapedKey + '":(true|false)', 'g'),
          '"' + key + '":' + valStr
        );

        // Pattern 3: "key":"some-string-value" (string values like "control", "treatment-1")
        text = text.replace(
          new RegExp('"' + escapedKey + '":"[^"]*"', 'g'),
          '"' + key + '":' + valStr
        );
      }

      // ── Patch userSelectable:false → true (unlock hidden models) ──
      if (_unlockModels) {
        text = text.replace(
          /"userSelectable":false/g,
          '"userSelectable":true'
        );
      }

      // ── Discover unknown flags from RSC payload ──
      // Look for posthogFlags object and extract all keys with their values
      const phIdx = text.indexOf('posthogFlags');
      if (phIdx !== -1) {
        const phChunk = text.substring(phIdx, Math.min(text.length, phIdx + 10000));
        // Match patterns like \"flag-key\":value (string, bool, $undefined)
        const flagMatches = phChunk.matchAll(/"([a-zA-Z][a-zA-Z0-9_-]*)"\s*:\s*(?:"([^"]*)"|true|false|"\$undefined")/g);
        for (const m of flagMatches) {
          const flagKey = m[1];
          // Filter out non-flag keys (React internal keys)
          if (!['parallelRouterKey', 'error', 'errorStyles', 'errorScripts',
                'templateStyles', 'templateScripts', 'forbidden', 'unauthorized',
                'notFound', 'children', 'template', 'id', 'name', 'className',
                'key', 'ref', 'props', 'type', 'content', 'href', 'src',
                'style', 'action', 'method', 'target', 'rel', 'as', 'crossOrigin',
                'integrity', 'nonce', 'seed', 'initialModels', 'initialSeed',
                'modalities', 'models', 'capabilities', 'inputCapabilities',
                'outputCapabilities', 'rank', 'rankByModality', 'organization',
                'provider', 'publicName', 'displayName', 'userSelectable',
                'text', 'image', 'file', 'web', 'video', 'search',
                'multipleImages', 'requiresUpload', 'required', 'aspectRatios',
                'chat', 'webdev'].includes(flagKey)) {
            _discoveredFlags.add(flagKey);
            if (m[2] !== undefined) {
              _discoveredFlagValues[flagKey] = m[2];
            } else if (m[0].includes('true')) {
              _discoveredFlagValues[flagKey] = true;
            } else if (m[0].includes('false')) {
              _discoveredFlagValues[flagKey] = false;
            }
          }
        }
      }

      // ── Also discover flags from vercelFlags section ──
      const vfIdx = text.indexOf('vercelFlags');
      if (vfIdx !== -1) {
        const vfChunk = text.substring(vfIdx, Math.min(text.length, vfIdx + 3000));
        const vfMatches = vfChunk.matchAll(/"([a-zA-Z][a-zA-Z0-9_-]*)"\s*:\s*(?:"([^"]*)"|true|false)/g);
        for (const m of vfMatches) {
          const flagKey = m[1];
          if (!['parallelRouterKey', 'error', 'errorStyles', 'errorScripts',
                'templateStyles', 'templateScripts', 'forbidden', 'unauthorized',
                'notFound', 'children', 'template'].includes(flagKey)) {
            _discoveredFlags.add(flagKey);
            if (m[2] !== undefined) {
              _discoveredFlagValues[flagKey] = m[2];
            } else {
              _discoveredFlagValues[flagKey] = m[0].includes('true');
            }
          }
        }
      }

      // ── Discover locked models from RSC payload ──
      const lockedModelMatches = text.matchAll(/"publicName":"([^"]+)".*?"userSelectable":false/g);
      for (const m of lockedModelMatches) {
        const publicName = m[1];
        if (!_discoveredLockedModels.find(x => x.publicName === publicName)) {
          const displayNameMatch = text.match(new RegExp('"publicName":"' + publicName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '".*?"displayName":"([^"]*)"'));
          _discoveredLockedModels.push({
            publicName,
            displayName: displayNameMatch ? displayNameMatch[1] : publicName
          });
        }
      }

      chunk[1] = text;
    }
    return _origPush(chunk);
  };

  // ─── ADMIN ACCESS (Cookie Override Approach) ────────────────────────────
  let _adminAccessResult = null;

  function setAdminFlagCookies() {
    const flagOverrides = {};
    for (const [key, val] of Object.entries(_overrides)) {
      if (typeof val === 'boolean' || key === 'agentic') {
        flagOverrides[key] = val;
      }
    }

    if (Object.keys(flagOverrides).length === 0) return;

    const jsonStr = JSON.stringify(flagOverrides);
    const b64Str = btoa(jsonStr);

    // Format 1: Official PostHog toolbar overrides cookie (NEW — the site actually reads this!)
    document.cookie = `${TOOLBAR_OVERRIDES_COOKIE}=${encodeURIComponent(jsonStr)}; path=/; SameSite=Lax; max-age=604800`;

    // Format 2: URL-encoded JSON (Vercel flag overrides)
    document.cookie = `vercel-flag-overrides=${encodeURIComponent(jsonStr)}; path=/; SameSite=Lax; max-age=3600`;
    // Format 3: Base64 encoded
    document.cookie = `vercel-flag-overrides=${b64Str}; path=/; SameSite=Lax; max-age=3600`;
    // Format 4: Per-flag cookies
    for (const [key, val] of Object.entries(flagOverrides)) {
      const cookieVal = typeof val === 'boolean' ? String(val) : encodeURIComponent(val);
      document.cookie = `flag-${key}=${cookieVal}; path=/; SameSite=Lax; max-age=3600`;
    }
    // Format 5: NextAuth-style flags cookie
    document.cookie = `next-flags=${encodeURIComponent(jsonStr)}; path=/; SameSite=Lax; max-age=3600`;

    console.log('[Arena Flag Unlocker] Set admin flag cookies:', Object.keys(flagOverrides));
  }

  function testAdminAccess(path, callback) {
    setAdminFlagCookies();
    const origin = window.location.origin;

    GM_xmlhttpRequest({
      method: 'GET',
      url: origin + path,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'RSC': '1',
        'Next-Router-State-Tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22admin%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
      },
      redirect: 'manual',
      anonymous: false,
      onload: function(response) {
        const status = response.status;
        const responseText = response.responseText || '';

        console.log('[Arena Flag Unlocker] Admin test response:', {
          status, length: responseText.length,
          hasRedirect: responseText.includes('NEXT_REDIRECT') || status === 307 || status === 302
        });

        if (status === 307 || status === 302) {
          _adminAccessResult = 'blocked';
          callback({ success: false, reason: 'http-redirect', status });
        } else if (responseText.includes('NEXT_REDIRECT;replace;/')) {
          _adminAccessResult = 'blocked';
          callback({ success: false, reason: 'rsc-redirect', status });
        } else if (status === 200 && responseText.length > 1000 && !responseText.includes('NEXT_REDIRECT')) {
          _adminAccessResult = 'success';
          callback({ success: true, html: responseText, status });
        } else {
          _adminAccessResult = 'blocked';
          callback({ success: false, reason: 'unknown', status, length: responseText.length });
        }
      },
      onerror: function(error) {
        _adminAccessResult = 'blocked';
        callback({ success: false, reason: 'network-error', error });
      }
    });
  }

  function navigateToAdmin(path) {
    setAdminFlagCookies();
    window.location.href = path;
  }

  function openAdminInNewTab(path) {
    setAdminFlagCookies();
    window.open(path, '_blank');
  }

  window.__afu_navigateToAdmin = navigateToAdmin;
  window.__afu_openAdminInNewTab = openAdminInNewTab;
  window.__afu_testAdminAccess = testAdminAccess;

  GM_registerMenuCommand('Open Admin Dashboard', () => navigateToAdmin('/admin'));
  GM_registerMenuCommand('Admin (New Tab)', () => openAdminInNewTab('/admin'));

  // ─── FLAG DEFINITIONS ─────────────────────────────────────────────────────
  // Updated with Zod-validated treatment values from the latest arena.ai code
  const FLAG_DEFS = [
    // ── HIGH VALUE (Hidden / Off by default) ──
    { key: 'agentic',                              label: '🤖 Agent Mode',                    desc: 'Enable agentic AI mode (autonomous tool use, tool calling)',  type: 'string', rec: true },
    { key: 'isAdminDashboardVisible',              label: '👑 Admin Dashboard',               desc: 'Show the admin dashboard in navigation',                      type: 'bool',   rec: true, vercel: true },
    { key: 'isWebDevArenaEnabled',                 label: '🌐 Web Dev Arena',                 desc: 'Enable Web Dev Arena feature',                                type: 'bool',   rec: true, vercel: true },
    { key: 'fullstack-code-arena',                 label: '💻 Fullstack Code Arena',          desc: 'Enable fullstack code arena mode',                            type: 'string', rec: true },
    { key: 'factuality-demo',                      label: '🔍 Factuality Demo',              desc: 'Enable the factuality demo feature',                          type: 'string', rec: true },
    { key: 'credit-system-m1',                     label: '💳 Credit System',                 desc: 'Enable the credit system (M1)',                               type: 'string', rec: true },
    { key: 'audio-modality-enabled',               label: '🎤 Audio Modality',               desc: 'Enable audio modality for chat',                              type: 'string', rec: true },
    { key: 'code-arena-publish-site',              label: '🚀 Code Arena Publish',            desc: 'Enable code arena site publishing',                           type: 'string', rec: true },
    { key: 'document-non-pdf-upload',              label: '📄 Non-PDF Document Upload',       desc: 'Enable upload of non-PDF documents',                          type: 'string', rec: true },
    { key: 'use-video-workflow',                   label: '🎬 Video Workflow',               desc: 'Enable video workflow mode',                                  type: 'string', rec: true },
    { key: 'video-arena-higher-rate-limit',        label: '⬆️ Video Rate Limit',             desc: 'Higher rate limit on video arena',                            type: 'string', rec: true },
    { key: 'image-to-code',                        label: '🖼️ Image to Code',               desc: 'Enable image-to-code conversion',                             type: 'string', rec: true },
    { key: 'file-upload',                          label: '📁 File Upload',                  desc: 'Enable file upload feature',                                  type: 'string', rec: true },
    { key: 'domain-redirect',                      label: '🔀 Domain Redirect',              desc: 'Enable domain redirect feature',                              type: 'string', rec: true },
    { key: 'webdev-multifile-template-round-2',    label: '📂 WebDev Multifile Template',     desc: 'Enable multifile template in webdev',                          type: 'string', rec: true },
    { key: 'fuzzy-duplicative-prompters',          label: '🔄 Fuzzy Duplicative Detection',  desc: 'Enable fuzzy duplicate prompt detection',                     type: 'string', rec: true },
    { key: 'multi-modal-p2l',                      label: '🖼️ Multi-Modal P2L',             desc: 'Enable multi-modal p2l feature',                              type: 'string', rec: true },
    { key: 'fast-mode',                            label: '⚡ Fast Mode',                     desc: 'Fast mode with configurable delay',                           type: 'string', rec: true },
    { key: 'use-text-v6',                          label: '📝 Text V6',                       desc: 'Text v6 variant',                                             type: 'string', rec: true },
    { key: 'use-video-v6',                         label: '🎬 Video V6',                     desc: 'Video v6 variant',                                            type: 'string', rec: true },
    { key: 'use-search-v6',                        label: '🔍 Search V6',                    desc: 'Search v6 variant',                                           type: 'string', rec: true },

    // ── EXPERIMENTS ──
    { key: 'auto-modality-enabled',                label: '⚡ Auto Modality',                desc: 'Auto-detect modality for chat input',                         type: 'string' },
    { key: 'modality-buttons-experiment',          label: '🔘 Modality Buttons',             desc: 'Modality buttons experiment variant',                         type: 'string' },
    { key: 'new-model-selector',                   label: '🆕 New Model Selector',           desc: 'New model selector UI variant',                               type: 'string' },
    { key: 'new-model-selector-redux',             label: '🆕 Model Selector Redux',         desc: 'Redux version of new model selector',                         type: 'string' },
    { key: '3m-model-selector',                    label: '🎯 3M Model Selector',            desc: '3M model selector experiment',                                type: 'string' },
    { key: 'webdev-voting-buttons',                label: '👍 WebDev Voting Buttons',        desc: 'Voting buttons in webdev arena',                              type: 'string' },
    { key: 'webdev_v2_experiment',                 label: '🧪 WebDev V2 Experiment',        desc: 'WebDev arena v2 experiment',                                  type: 'string' },
    { key: 'use-webdev-workflow',                  label: '🔄 Use WebDev Workflow',          desc: 'WebDev workflow variant',                                     type: 'string' },
    { key: 'vote-translations-enabled',            label: '🌐 Vote Translations',            desc: 'Enable vote translations',                                    type: 'string' },
    { key: 'archive-chat-enabled',                 label: '📦 Archive Chat',                 desc: 'Enable chat archiving',                                       type: 'string' },
    { key: 'in-app-chat-notifications-m1-round-2', label: '🔔 Chat Notifications',           desc: 'In-app chat notifications experiment',                        type: 'string' },
    { key: 'stop-rerun',                           label: '🛑 Stop Rerun',                  desc: 'Stop-rerun behavior variant',                                 type: 'string' },
    { key: 'disable-opus',                         label: '🚫 Disable Opus',                desc: 'Opus model availability control',                             type: 'string' },
    { key: 'rebrand',                              label: '🏷️ Rebrand',                     desc: 'Rebrand experiment variant',                                  type: 'string' },
    { key: 'battles-in-direct-3',                  label: '⚔️ Battles in Direct',            desc: 'Battle mode in direct chat variant',                          type: 'string' },
    { key: 'direct-chat-force-login-exp-2',        label: '🔐 Force Login Exp 2',           desc: 'Direct chat force login experiment 2',                        type: 'string' },
    { key: 'image-modality-rate-limiting',         label: '🖼️ Image Rate Limiting',         desc: 'Image modality rate limiting variant',                        type: 'string' },
    { key: 'edit-image-button-enabled',            label: '✏️ Edit Image Button',           desc: 'Show edit image button',                                      type: 'string' },
    { key: 'video-edit',                           label: '🎬 Video Edit',                   desc: 'Video edit feature variant',                                  type: 'string' },
    { key: 'dnn-bot-scoring',                      label: '🤖 DNN Bot Scoring',             desc: 'DNN-based bot scoring variant',                               type: 'string' },
    { key: 'leverage-arena-lion-bot-score',        label: '🦁 Lion Bot Score',              desc: 'Leverage arena lion bot scoring',                             type: 'string' },
    { key: 'p2l-release',                          label: '📈 P2L Release',                 desc: 'P2L release variant',                                         type: 'string' },
    { key: 'dlp-pii-detection',                    label: '🔒 PII Detection',               desc: 'DLP PII detection mode',                                      type: 'string' },
    { key: 'bid-skip-wait',                        label: '⏭️ Bid Skip Wait',              desc: 'Bid skip wait time variant',                                  type: 'string' },
    { key: 'login-gate2',                          label: '🚪 Login Gate 2',                desc: 'Login gate experiment variant',                               type: 'string' },
    { key: 'better-first-experience',              label: '✨ Better First Experience',      desc: 'First experience experiment',                                 type: 'string' },
    { key: 'better-first-experience-extended',     label: '✨ Better First Experience Ext',  desc: 'Extended first experience experiment',                        type: 'string' },
    { key: 'bfe-anb-gate',                         label: '🚧 BFE ANB Gate',                desc: 'Better first experience ANB gate',                            type: 'string' },
    { key: 'email-login-full-name-screen-visibility', label: '📧 Email Login Full Name',    desc: 'Full name screen visibility on email login',                  type: 'string' },
    { key: 'user-login-email',                     label: '📧 User Login Email',            desc: 'User login email experiment',                                 type: 'string' },
    { key: 'recaptcha-v2-fallback-signup',         label: '🤖 reCAPTCHA Fallback Signup',   desc: 'reCAPTCHA v2 fallback for signup',                           type: 'string' },
    { key: 'recaptcha-v2-login-gate',              label: '🤖 reCAPTCHA Login Gate',        desc: 'reCAPTCHA v2 login gate',                                    type: 'string' },
    { key: 'email-optin-copy',                     label: '📧 Email Optin Copy',            desc: 'Email opt-in copy variant',                                   type: 'string' },
    { key: 'app-banner-enabled',                   label: '📢 App Banner',                  desc: 'Show app banner',                                             type: 'bool' },
    { key: 'code_arena_cta',                       label: '💻 Code Arena CTA',              desc: 'Show code arena call-to-action',                              type: 'bool' },
    { key: 'pointwise-feedback-enabled',           label: '💬 Pointwise Feedback',          desc: 'Enable pointwise feedback',                                   type: 'bool' },
    { key: 'leaderboard-nav-pareto',               label: '📊 Leaderboard Nav Pareto',      desc: 'Pareto navigation on leaderboard',                            type: 'bool' },
    { key: 'model-selector-featured-models',       label: '⭐ Featured Models',             desc: 'Show featured models in selector',                            type: 'bool' },
    { key: 'model-selector-priority-models',       label: '🔝 Priority Models',             desc: 'Show priority models in selector',                            type: 'bool' },
    { key: 'recaptcha-force-low-bot-score',        label: '🤖 Force Low Bot Score',         desc: 'Force low reCAPTCHA bot score',                               type: 'bool' },
    { key: 'video-image-pricedata',                label: '💰 Video/Image Price Data',      desc: 'Show pricing data for video/image',                           type: 'bool' },
    { key: 'isCspReportOnly',                      label: '🛡️ CSP Report Only',             desc: 'Set CSP to report-only mode',                                 type: 'bool', vercel: true },
    { key: 'isE2ETest',                            label: '🧪 E2E Test Mode',               desc: 'Mark session as E2E test',                                    type: 'bool', vercel: true },
  ];

  const KNOWN_FLAG_KEYS = new Set(FLAG_DEFS.map(f => f.key));

  // ─── ZOD-VALIDATED TREATMENT VALUES ─────────────────────────────────────
  // These are the ACTUAL allowed values from arena.ai's Zod schemas.
  // Using the correct treatment variant is critical — wrong values get rejected.
  const TREATMENT_MAP = {
    // ── High-value flags with Zod-validated values ──
    'agentic': 'treatment-1',                           // was "treatment", now "treatment-1" per Zod schema
    'fullstack-code-arena': 'treatment-1',              // Zod: "control" | "treatment-1"
    'factuality-demo': 'factuality-enabled',            // Zod: "control" | "factuality-enabled"
    'credit-system-m1': 'treatment',                    // from decide endpoint
    'audio-modality-enabled': 'treatment',              // from decide endpoint
    'code-arena-publish-site': 'treatment',             // from decide endpoint
    'document-non-pdf-upload': 'treatment',             // from decide endpoint
    'use-video-workflow': 'treatment-1',                // Zod: "control" | "treatment-1"
    'video-arena-higher-rate-limit': 'treatment',       // from decide endpoint
    'image-to-code': 'treatment-1',                     // Zod: "control" | "treatment-1"
    'file-upload': 'treatment-1',                       // from decide endpoint
    'domain-redirect': 'treatment',                     // from decide endpoint
    'webdev-multifile-template-round-2': 'treatment',   // from decide endpoint
    'fuzzy-duplicative-prompters': 'treatment',         // from decide endpoint
    'multi-modal-p2l': 'multi-modal-p2l-enabled',       // Zod: "control" | "multi-modal-p2l-enabled"
    'fast-mode': 'no-delay',                            // Zod: "control" | "no-delay" | "4-second-delay" | "8-second-delay" | "12-second-delay"
    'use-text-v6': 'treatment-1',                       // from decide endpoint
    'use-video-v6': 'treatment-1',                      // from decide endpoint
    'use-search-v6': 'treatment-1',                     // Zod: "control" | "treatment-1" (was "control" in decide, force treatment)

    // ── Experiment flags with Zod-validated values ──
    'auto-modality-enabled': 'treatment-3',             // Zod: "control" | "treatment-1" | "treatment-2" | "treatment-3" | "treatment-4"
    'modality-buttons-experiment': 'treatment1',        // Zod: "control" | "treatment1"
    'new-model-selector': 'treatment',                  // from decide endpoint
    'new-model-selector-redux': 'treatment',            // from decide endpoint
    '3m-model-selector': 'treatment',                   // from decide endpoint
    'webdev-voting-buttons': 'treatment',               // Zod: "control" | "treatment"
    'webdev_v2_experiment': 'treatment-2',              // from decide endpoint
    'use-webdev-workflow': 'treatment-1',               // Zod: "control" | "treatment-1"
    'vote-translations-enabled': 'treatment-1',         // Zod: "control" | "treatment-1"
    'archive-chat-enabled': 'treatment',                // Zod: "control" | "treatment"
    'in-app-chat-notifications-m1-round-2': 'treatment-1', // Zod: "control" | "treatment-1"
    'stop-rerun': 'stop-rerun-enabled',                 // Zod: "control" | "stop-rerun-enabled"
    'disable-opus': 'control',                          // Zod: "control" | "disable-opus" — we WANT opus enabled, so "control"
    'rebrand': 'treatment',                             // from decide endpoint
    'battles-in-direct-3': 'treatment',                 // from decide endpoint
    'direct-chat-force-login-exp-2': 'direct-chat-force-login', // from decide endpoint
    'image-modality-rate-limiting': 'treatment-3',      // from decide endpoint
    'edit-image-button-enabled': 'treatment',           // from decide endpoint
    'video-edit': 'treatment',                          // from decide endpoint
    'dnn-bot-scoring': 'treatment-1',                   // from decide endpoint
    'leverage-arena-lion-bot-score': 'treatment',       // from decide endpoint
    'p2l-release': 'arcstride',                         // from decide endpoint (current value)
    'dlp-pii-detection': 'treatment',                   // from decide endpoint
    'bid-skip-wait': 'treatment',                       // from decide endpoint
    'login-gate2': 'treatment',                         // from decide endpoint
    'better-first-experience': 'treatment',             // from decide endpoint
    'better-first-experience-extended': 'treatment',    // from decide endpoint
    'bfe-anb-gate': 'treatment',                        // from decide endpoint
    'email-login-full-name-screen-visibility': 'treatment', // from decide endpoint
    'user-login-email': 'treatment',                    // from decide endpoint
    'recaptcha-v2-fallback-signup': 'v2-fallback-on-low-score', // Zod: "control" | "v2-fallback-on-low-score"
    'recaptcha-v2-login-gate': 'treatment',             // Zod: "control" | "treatment"
    'email-optin-copy': 'treatment-1',                  // Zod: "control" | "treatment-1" | "treatment-2" | "treatment-3" | "treatment-4" | "treatment-5"
  };

  function getEnableValue(flagDef) {
    if (flagDef.type === 'bool') return true;
    return TREATMENT_MAP[flagDef.key] || 'treatment';
  }

  function loadOverrides() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
  }

  function saveOverrides(overrides) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  }

  // ─── POSTHOG TOOLBAR OVERRIDES COOKIE SYNC ──────────────────────────────
  // NEW in v5: The site now syncs PostHog toolbar overrides to a cookie
  // named "ph-toolbar-overrides". The server-side middleware reads this
  // cookie to apply flag overrides. This is the OFFICIAL override channel.
  function syncToolbarOverridesCookie(overrides) {
    try {
      const flagOverrides = {};
      for (const [key, val] of Object.entries(overrides)) {
        flagOverrides[key] = val;
      }
      if (Object.keys(flagOverrides).length === 0) return;
      const jsonStr = JSON.stringify(flagOverrides);
      document.cookie = `${TOOLBAR_OVERRIDES_COOKIE}=${encodeURIComponent(jsonStr)}; path=/; SameSite=Lax; max-age=604800`;
      console.log('[Arena Flag Unlocker] Synced toolbar overrides cookie');
    } catch (e) {
      console.warn('[Arena Flag Unlocker] Toolbar cookie sync failed:', e);
    }
  }

  // ─── POSTHOG $override_feature_flags (Toolbar Mechanism) ─────────────────
  // NEW in v5: PostHog's official toolbar override mechanism stores overrides
  // in localStorage under the "$override_feature_flags" property.
  // This is more reliable than raw string replacement.
  function setPosthogToolbarOverrides(overrides) {
    try {
      let raw = localStorage.getItem(POSTHOG_KEY);
      let data;
      if (raw) {
        data = JSON.parse(raw);
      } else {
        data = {};
      }

      // Set the $override_feature_flags property (PostHog toolbar mechanism)
      data['$override_feature_flags'] = overrides;

      localStorage.setItem(POSTHOG_KEY, JSON.stringify(data));
      console.log('[Arena Flag Unlocker] Set $override_feature_flags in PostHog localStorage');
    } catch (e) {
      console.warn('[Arena Flag Unlocker] PostHog toolbar override failed:', e);
    }
  }

  // ─── POSTHOG LOCAL STORAGE PATCHING (Legacy — still works) ──────────────
  function patchPosthogLocalStorage(overrides) {
    try {
      let raw = localStorage.getItem(POSTHOG_KEY);
      if (!raw) return;

      for (const [key, val] of Object.entries(overrides)) {
        const valStr = typeof val === 'boolean' ? String(val) : '"' + val + '"';
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        raw = raw.replace(
          new RegExp('"' + escapedKey + '"\\s*:\\s*(true|false)', 'g'),
          '"' + key + '":' + valStr
        );
        raw = raw.replace(
          new RegExp('"' + escapedKey + '"\\s*:\\s*"[^"]*"', 'g'),
          '"' + key + '":' + valStr
        );
      }

      localStorage.setItem(POSTHOG_KEY, raw);
    } catch (e) {
      console.warn('[Arena Flag Unlocker] PostHog localStorage patch failed:', e);
    }
  }

  // ─── POSTHOG DECIDE ENDPOINT INTERCEPTION ─────────────────────────────────
  // Updated for v5: PostHog is now proxied at /rpc instead of us.i.posthog.com
  // The fetch interception must match both /rpc/decide and direct PostHog URLs
  function interceptPostHogDecide(overrides) {
    if (Object.keys(overrides).length === 0 && !_unlockModels) return;

    const origFetch = window.fetch;
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then(async (response) => {
        try {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          // Match both /rpc/decide (proxied) and /decide (direct PostHog)
          if (url.includes('/decide') || url.includes('/flags') || url.includes('/rpc/')) {
            const clone = response.clone();
            const data = await clone.json();
            if (data.featureFlags) {
              for (const [key, val] of Object.entries(overrides)) {
                data.featureFlags[key] = val;
              }
              return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }
          }
        } catch (e) { /* not our endpoint */ }
        return response;
      });
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._afuUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      const url = this._afuUrl || '';
      if (url.includes('/decide') || url.includes('/flags') || url.includes('/rpc/')) {
        this.addEventListener('readystatechange', function () {
          if (this.readyState === 4 && this.status === 200) {
            try {
              const data = JSON.parse(this.responseText);
              if (data.featureFlags) {
                for (const [key, val] of Object.entries(overrides)) {
                  data.featureFlags[key] = val;
                }
                Object.defineProperty(this, 'responseText', { writable: true, value: JSON.stringify(data) });
                Object.defineProperty(this, 'response', { writable: true, value: JSON.stringify(data) });
              }
            } catch (e) { /* not JSON */ }
          }
        });
      }
      return origSend.apply(this, args);
    };
  }

  // ─── POSTHOG SDK OVERRIDE (after SDK loads) ──────────────────────────────
  function applyPosthogOverrides(overrides) {
    const tryOverride = () => {
      try {
        if (typeof posthog !== 'undefined' && typeof posthog.featureFlags?.override === 'function') {
          posthog.featureFlags.override(overrides);
          console.log('[Arena Flag Unlocker] PostHog SDK override applied (global)');
          return true;
        }
      } catch (e) { /* not found */ }

      try {
        for (const key of Object.getOwnPropertyNames(window)) {
          try {
            const obj = window[key];
            if (obj && typeof obj === 'object' && typeof obj.getFeatureFlag === 'function' && typeof obj.featureFlags?.override === 'function') {
              obj.featureFlags.override(overrides);
              console.log('[Arena Flag Unlocker] PostHog SDK override applied (window search)');
              return true;
            }
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* not found */ }

      return false;
    };

    if (!tryOverride()) {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (tryOverride() || attempts > 100) clearInterval(interval);
      }, 300);
    }
  }

  // ─── POSTHOG BOOTSTRAP OVERRIDE ──────────────────────────────────────────
  // NEW in v5: PostHog init uses bootstrap.featureFlags from RSC data.
  // We hook the posthog.init call to override the bootstrap flags.
  function interceptPosthogBootstrap(overrides) {
    // Wait for posthog to load, then override
    const tryHook = () => {
      try {
        if (typeof posthog !== 'undefined') {
          // Apply overrides immediately via SDK
          if (typeof posthog.featureFlags?.override === 'function') {
            posthog.featureFlags.override(overrides);
            console.log('[Arena Flag Unlocker] PostHog bootstrap override applied');
            return true;
          }
        }
      } catch (e) { /* not ready */ }
      return false;
    };

    if (!tryHook()) {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (tryHook() || attempts > 50) clearInterval(interval);
      }, 200);
    }
  }

  // ─── REACT CONTEXT OVERRIDE (Vercel Flags Provider) ─────────────────────
  // NEW in v5: Try to hook into React's context system to override
  // Vercel flags that are delivered via RSC but read via React context.
  function hookVercelFlagContext() {
    // We'll try to find and override the Vercel flags context
    // by watching for flag reads in the React fiber tree
    const tryHook = () => {
      try {
        const rootEl = document.getElementById('__next');
        if (!rootEl || !rootEl._reactRootContainer) return false;

        // Walk the fiber tree looking for flag provider context
        // This is a best-effort approach
        const fiber = rootEl._reactRootContainer?._internalRoot?.current;
        if (!fiber) return false;

        let found = false;
        const walkFiber = (node) => {
          if (!node) return;
          try {
            const ctx = node.memoizedState;
            if (ctx && ctx.memoizedState && typeof ctx.memoizedState === 'object') {
              const state = ctx.memoizedState;
              if ('isAdminDashboardVisible' in state || 'isWebDevArenaEnabled' in state) {
                // Found the Vercel flags context! Override values.
                if (_overrides.isAdminDashboardVisible !== undefined) {
                  state.isAdminDashboardVisible = _overrides.isAdminDashboardVisible;
                }
                if (_overrides.isWebDevArenaEnabled !== undefined) {
                  state.isWebDevArenaEnabled = _overrides.isWebDevArenaEnabled;
                }
                if (_overrides.isCspReportOnly !== undefined) {
                  state.isCspReportOnly = _overrides.isCspReportOnly;
                }
                found = true;
              }
            }
          } catch (e) { /* skip */ }
          if (node.child) walkFiber(node.child);
          if (node.sibling) walkFiber(node.sibling);
        };

        walkFiber(fiber);
        return found;
      } catch (e) {
        return false;
      }
    };

    // Try after React has rendered
    setTimeout(() => {
      if (!tryHook()) {
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          if (tryHook() || attempts > 30) clearInterval(interval);
        }, 500);
      }
    }, 1000);
  }

  // ─── GUI ──────────────────────────────────────────────────────────────────
  // v5.1: GUI is now resilient to React re-renders and client-side navigation.
  // - MutationObserver re-injects if elements are removed
  // - CSS uses !important to prevent site overrides
  // - Auto-detected flags ALWAYS shown at bottom

  let _guiInstances = 0;
  let _panelWasOpen = false;
  let _mutationObserver = null;

  function createGUI(overrides) {
    // Remove any existing instances first (clean slate)
    const existingGear = document.getElementById('afu-gear');
    const existingPanel = document.getElementById('afu-panel');
    if (existingGear) existingGear.remove();
    if (existingPanel) existingPanel.remove();

    _guiInstances++;

    // ── Inject styles with !important ──
    const styleId = 'afu-styles';
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        #afu-gear {
          position: fixed !important; bottom: 20px !important; right: 20px !important;
          width: 44px !important; height: 44px !important; border-radius: 50% !important;
          background: #1a1a2e !important; border: 2px solid #4a4a6a !important;
          color: #e0e0ff !important; font-size: 22px !important;
          display: flex !important; align-items: center !important; justify-content: center !important;
          cursor: pointer !important; z-index: 2147483647 !important;
          transition: all 0.3s ease !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important;
          user-select: none !important;
          pointer-events: auto !important;
          opacity: 1 !important;
          visibility: visible !important;
        }
        #afu-gear:hover {
          background: #2a2a4e !important; border-color: #7a7aaa !important;
          transform: rotate(45deg) scale(1.1) !important;
        }
        #afu-panel {
          position: fixed !important; bottom: 74px !important; right: 20px !important;
          width: 460px !important; max-height: 85vh !important;
          background: #0d0d1a !important; border: 1px solid #2a2a4a !important;
          border-radius: 12px !important; z-index: 2147483646 !important;
          overflow: hidden !important; box-shadow: 0 8px 32px rgba(0,0,0,0.6) !important;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
          display: none !important; flex-direction: column !important;
          pointer-events: auto !important;
          opacity: 1 !important;
          visibility: visible !important;
        }
        #afu-panel.open { display: flex !important; }
        .afu-header {
          padding: 14px 18px !important;
          background: linear-gradient(135deg, #1a1a3e, #0d0d2a) !important;
          border-bottom: 1px solid #2a2a4a !important;
          display: flex !important; align-items: center !important; justify-content: space-between !important;
          cursor: move !important;
        }
        .afu-header h3 { margin: 0 !important; color: #c0c0ff !important; font-size: 15px !important; font-weight: 600 !important; }
        .afu-version { color: #4a4a6a !important; font-size: 9px !important; margin-left: 8px !important; font-weight: 400 !important; }
        .afu-header-btns { display: flex !important; gap: 8px !important; }
        .afu-header-btns button {
          background: rgba(255,255,255,0.08) !important; border: 1px solid rgba(255,255,255,0.12) !important;
          color: #aaaacc !important; padding: 4px 10px !important; border-radius: 6px !important; cursor: pointer !important;
          font-size: 11px !important; transition: all 0.2s !important;
        }
        .afu-header-btns button:hover { background: rgba(255,255,255,0.15) !important; color: #fff !important; }
        .afu-body { overflow-y: auto !important; flex: 1 !important; padding: 8px 0 !important; }
        .afu-body::-webkit-scrollbar { width: 6px !important; }
        .afu-body::-webkit-scrollbar-track { background: transparent !important; }
        .afu-body::-webkit-scrollbar-thumb { background: #2a2a4a !important; border-radius: 3px !important; }
        .afu-section { padding: 6px 14px !important; }
        .afu-section-title {
          color: #6a6a9a !important; font-size: 10px !important; text-transform: uppercase !important;
          letter-spacing: 1.2px !important; margin: 10px 0 6px !important; font-weight: 600 !important;
        }
        .afu-flag-row {
          display: flex !important; align-items: center !important; justify-content: space-between !important;
          padding: 7px 14px !important; transition: background 0.15s !important; border-radius: 6px !important; margin: 0 4px !important;
        }
        .afu-flag-row:hover { background: rgba(255,255,255,0.04) !important; }
        .afu-flag-info { flex: 1 !important; min-width: 0 !important; margin-right: 12px !important; }
        .afu-flag-label {
          color: #d0d0ee !important; font-size: 13px !important; font-weight: 500 !important;
          white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
        }
        .afu-flag-desc {
          color: #6a6a8a !important; font-size: 11px !important; margin-top: 2px !important;
          white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
        }
        .afu-flag-key {
          color: #4a4a6a !important; font-size: 9px !important;
          font-family: 'SF Mono', 'Fira Code', monospace !important; margin-top: 1px !important;
        }
        .afu-flag-value {
          color: #3a8a3a !important; font-size: 9px !important;
          font-family: 'SF Mono', 'Fira Code', monospace !important; margin-top: 1px !important;
        }
        .afu-toggle { position: relative !important; width: 40px !important; height: 22px !important; flex-shrink: 0 !important; }
        .afu-toggle input { opacity: 0 !important; width: 0 !important; height: 0 !important; }
        .afu-toggle-slider {
          position: absolute !important; cursor: pointer !important;
          top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
          background: #2a2a3a !important; border-radius: 11px !important;
          transition: 0.3s !important; border: 1px solid #3a3a5a !important;
        }
        .afu-toggle-slider:before {
          position: absolute !important; content: "" !important;
          height: 16px !important; width: 16px !important; left: 2px !important; bottom: 2px !important;
          background: #666 !important; border-radius: 50% !important; transition: 0.3s !important;
        }
        .afu-toggle input:checked + .afu-toggle-slider {
          background: #2d5a1e !important; border-color: #4a8a2a !important;
        }
        .afu-toggle input:checked + .afu-toggle-slider:before {
          transform: translateX(18px) !important; background: #6aff3a !important;
          box-shadow: 0 0 8px rgba(106,255,58,0.4) !important;
        }
        .afu-rec-badge {
          background: #ff4444 !important; color: white !important; font-size: 8px !important;
          padding: 1px 5px !important; border-radius: 4px !important; font-weight: 700 !important;
          margin-left: 6px !important; text-transform: uppercase !important; letter-spacing: 0.5px !important;
        }
        .afu-new-badge {
          background: #ffaa00 !important; color: #000 !important; font-size: 8px !important;
          padding: 1px 5px !important; border-radius: 4px !important; font-weight: 700 !important;
          margin-left: 6px !important; text-transform: uppercase !important; letter-spacing: 0.5px !important;
        }
        .afu-models-row {
          display: flex !important; align-items: center !important; justify-content: space-between !important;
          padding: 10px 14px !important; background: rgba(106,58,170,0.12) !important;
          border: 1px solid rgba(106,58,170,0.25) !important; border-radius: 8px !important; margin: 4px 10px !important;
        }
        .afu-models-info { flex: 1 !important; margin-right: 12px !important; }
        .afu-models-label {
          color: #d0b0ff !important; font-size: 14px !important; font-weight: 600 !important;
        }
        .afu-models-count {
          color: #8a6aaa !important; font-size: 11px !important; margin-top: 3px !important;
        }
        .afu-models-list {
          padding: 6px 14px 10px !important; max-height: 180px !important; overflow-y: auto !important;
          background: rgba(0,0,0,0.2) !important; margin: 4px 10px !important; border-radius: 6px !important;
        }
        .afu-models-list::-webkit-scrollbar { width: 4px !important; }
        .afu-models-list::-webkit-scrollbar-thumb { background: #3a3a5a !important; border-radius: 2px !important; }
        .afu-model-item {
          color: #9a9acc !important; font-size: 11px !important; padding: 3px 0 !important;
          font-family: 'SF Mono', 'Fira Code', monospace !important;
          border-bottom: 1px solid rgba(255,255,255,0.03) !important;
        }
        .afu-model-item:last-child { border-bottom: none !important; }
        .afu-footer {
          padding: 10px 14px !important; border-top: 1px solid #2a2a4a !important; text-align: center !important;
        }
        .afu-footer button {
          background: linear-gradient(135deg, #4a1a8a, #2a0a5a) !important;
          color: #d0b0ff !important; border: 1px solid #6a3aaa !important;
          padding: 8px 24px !important; border-radius: 8px !important; cursor: pointer !important;
          font-size: 13px !important; font-weight: 600 !important; transition: all 0.2s !important;
        }
        .afu-footer button:hover {
          background: linear-gradient(135deg, #6a2aaa, #4a1a8a) !important;
          box-shadow: 0 0 12px rgba(106,58,170,0.4) !important;
        }
        .afu-status-bar {
          padding: 6px 14px !important; border-top: 1px solid #1a1a2a !important;
          background: rgba(0,0,0,0.3) !important; font-size: 10px !important; color: #4a4a6a !important;
          display: flex !important; justify-content: space-between !important;
        }
        .afu-unknown-flag-row {
          display: flex !important; align-items: center !important; justify-content: space-between !important;
          padding: 6px 14px !important; border-radius: 6px !important; margin: 0 4px !important;
          background: rgba(255,170,0,0.05) !important; border: 1px solid rgba(255,170,0,0.1) !important;
        }
        .afu-unknown-flag-info { flex: 1 !important; min-width: 0 !important; margin-right: 12px !important; }
        .afu-unknown-flag-key {
          color: #ffaa44 !important; font-size: 12px !important; font-weight: 600 !important;
          font-family: 'SF Mono', 'Fira Code', monospace !important;
          word-break: break-all !important;
        }
        .afu-unknown-flag-val {
          color: #6a6a8a !important; font-size: 10px !important; margin-top: 2px !important;
          font-family: 'SF Mono', 'Fira Code', monospace !important;
        }
        .afu-empty-hint {
          color: #4a4a6a !important; font-size: 11px !important; padding: 8px 14px !important;
          font-style: italic !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    const gear = document.createElement('div');
    gear.id = 'afu-gear';
    gear.innerHTML = '\u2699';
    gear.title = 'Arena Feature Flags';
    document.body.appendChild(gear);

    const panel = document.createElement('div');
    panel.id = 'afu-panel';
    if (_panelWasOpen) panel.classList.add('open');
    document.body.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'afu-header';
    header.innerHTML = `
      <h3>\uD83D\uDE80 Arena Flag Unlocker<span class="afu-version">v5.1</span></h3>
      <div class="afu-header-btns">
        <button id="afu-enable-all" title="Enable all recommended flags">Enable All \u2605</button>
        <button id="afu-disable-all" title="Reset all flags to defaults">Reset All</button>
      </div>
    `;
    panel.appendChild(header);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'afu-body';
    panel.appendChild(bodyEl);

    const recommendedFlags = FLAG_DEFS.filter(f => f.rec);
    const experimentFlags = FLAG_DEFS.filter(f => !f.rec && !f.vercel);
    const vercelFlags = FLAG_DEFS.filter(f => f.vercel);

    // ── Models Unlock Section ──
    const modelsSection = document.createElement('div');
    modelsSection.className = 'afu-section';
    const modelsTitle = document.createElement('div');
    modelsTitle.className = 'afu-section-title';
    modelsTitle.textContent = 'UNLOCK MODELS';
    modelsSection.appendChild(modelsTitle);

    const modelsRow = document.createElement('div');
    modelsRow.className = 'afu-models-row';
    const modelsInfo = document.createElement('div');
    modelsInfo.className = 'afu-models-info';
    modelsInfo.innerHTML = `
      <div class="afu-models-label">Unlock All Hidden Models</div>
      <div class="afu-models-count">Set userSelectable=true for ${_discoveredLockedModels.length} locked model(s)</div>
    `;
    const modelsToggle = document.createElement('label');
    modelsToggle.className = 'afu-toggle';
    const modelsInput = document.createElement('input');
    modelsInput.type = 'checkbox';
    modelsInput.checked = _unlockModels;
    modelsInput.id = 'afu-models-toggle';
    const modelsSlider = document.createElement('span');
    modelsSlider.className = 'afu-toggle-slider';
    modelsToggle.appendChild(modelsInput);
    modelsToggle.appendChild(modelsSlider);

    modelsInput.addEventListener('change', () => {
      _unlockModels = modelsInput.checked;
      localStorage.setItem(MODELS_KEY, String(_unlockModels));
    });

    modelsRow.appendChild(modelsInfo);
    modelsRow.appendChild(modelsToggle);
    modelsSection.appendChild(modelsRow);

    if (_discoveredLockedModels.length > 0) {
      const modelsList = document.createElement('div');
      modelsList.className = 'afu-models-list';
      const countLine = document.createElement('div');
      countLine.style.cssText = 'color:#ffaa00;font-size:10px;padding-bottom:6px;font-weight:600;';
      countLine.textContent = `${_discoveredLockedModels.length} locked model(s) detected:`;
      modelsList.appendChild(countLine);

      _discoveredLockedModels.sort((a, b) => a.displayName.localeCompare(b.displayName));
      for (const model of _discoveredLockedModels) {
        const item = document.createElement('div');
        item.className = 'afu-model-item';
        item.textContent = model.displayName;
        modelsList.appendChild(item);
      }
      modelsSection.appendChild(modelsList);
    }

    bodyEl.appendChild(modelsSection);

    // ── Recommended Flags Section ──
    const recSection = document.createElement('div');
    recSection.className = 'afu-section';
    const recTitle = document.createElement('div');
    recTitle.className = 'afu-section-title';
    recTitle.textContent = 'RECOMMENDED FLAGS';
    recSection.appendChild(recTitle);

    for (const flag of recommendedFlags) {
      recSection.appendChild(createFlagRow(flag, overrides));
    }
    bodyEl.appendChild(recSection);

    // ── Experiment Flags Section ──
    const expSection = document.createElement('div');
    expSection.className = 'afu-section';
    const expTitle = document.createElement('div');
    expTitle.className = 'afu-section-title';
    expTitle.textContent = 'EXPERIMENTS';
    expSection.appendChild(expTitle);

    for (const flag of experimentFlags) {
      expSection.appendChild(createFlagRow(flag, overrides));
    }
    bodyEl.appendChild(expSection);

    // ── Vercel Flags Section ──
    const vfSection = document.createElement('div');
    vfSection.className = 'afu-section';
    const vfTitle = document.createElement('div');
    vfTitle.className = 'afu-section-title';
    vfTitle.textContent = 'VERCEL FLAGS (Server-Side)';
    vfSection.appendChild(vfTitle);

    for (const flag of vercelFlags) {
      vfSection.appendChild(createFlagRow(flag, overrides));
    }
    bodyEl.appendChild(vfSection);

    // ── Auto-Discovered / Unknown Flags Section (ALWAYS shown) ──
    const newFlags = [..._discoveredFlags].filter(k => !KNOWN_FLAG_KEYS.has(k));
    const newSection = document.createElement('div');
    newSection.className = 'afu-section';
    const newTitle = document.createElement('div');
    newTitle.className = 'afu-section-title';
    newTitle.textContent = 'NEW / UNKNOWN FLAGS';
    newSection.appendChild(newTitle);

    if (newFlags.length > 0) {
      for (const flagKey of newFlags.sort()) {
        // Show each unknown flag with its key name and current value
        const row = document.createElement('div');
        row.className = 'afu-unknown-flag-row';

        const info = document.createElement('div');
        info.className = 'afu-unknown-flag-info';

        const keyLine = document.createElement('div');
        keyLine.className = 'afu-unknown-flag-key';
        keyLine.textContent = flagKey;

        const valLine = document.createElement('div');
        valLine.className = 'afu-unknown-flag-val';
        const discoveredVal = _discoveredFlagValues[flagKey];
        if (discoveredVal !== undefined) {
          valLine.textContent = 'current: ' + JSON.stringify(discoveredVal);
        } else {
          valLine.textContent = 'value unknown';
        }

        info.appendChild(keyLine);
        info.appendChild(valLine);

        // Add toggle for unknown flags too
        const toggle = document.createElement('label');
        toggle.className = 'afu-toggle';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = overrides[flagKey] !== undefined;
        const slider = document.createElement('span');
        slider.className = 'afu-toggle-slider';
        toggle.appendChild(input);
        toggle.appendChild(slider);

        input.addEventListener('change', () => {
          const current = loadOverrides();
          if (input.checked) {
            // For unknown flags, use 'treatment' as default enable value
            current[flagKey] = TREATMENT_MAP[flagKey] || 'treatment';
          } else {
            delete current[flagKey];
          }
          saveOverrides(current);
          syncToolbarOverridesCookie(current);
          setPosthogToolbarOverrides(current);
          patchPosthogLocalStorage(current);
          applyPosthogOverrides(current);
        });

        row.appendChild(info);
        row.appendChild(toggle);
        newSection.appendChild(row);
      }
    } else {
      const hint = document.createElement('div');
      hint.className = 'afu-empty-hint';
      hint.textContent = 'No unknown flags detected yet — they appear here when new flags are found in RSC data.';
      newSection.appendChild(hint);
    }
    bodyEl.appendChild(newSection);

    // ── Admin Dashboard Access Section ──
    const adminSection = document.createElement('div');
    adminSection.className = 'afu-section';
    const adminTitle = document.createElement('div');
    adminTitle.className = 'afu-section-title';
    adminTitle.textContent = 'ADMIN DASHBOARD';
    adminSection.appendChild(adminTitle);

    const adminDesc = document.createElement('div');
    adminDesc.style.cssText = 'color:#8a6aaa;font-size:11px;padding:4px 0 8px;line-height:1.5;';
    adminDesc.innerHTML = 'Admin pages are <b style="color:#ff8888">server-side protected</b>. The v5 script now sets the <b style="color:#c0a0ee">ph-toolbar-overrides</b> cookie which the server actually reads. If that works, you get in. If not, you just land on home (site stays fine).';
    adminSection.appendChild(adminDesc);

    const testRow = document.createElement('div');
    testRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';

    const testBtn = document.createElement('button');
    testBtn.style.cssText = `
      flex:1;display:inline-flex;align-items:center;justify-content:center;gap:4px;
      background:rgba(255,165,0,0.12);border:1px solid rgba(255,165,0,0.3);
      color:#ffaa44;padding:6px 10px;border-radius:6px;
      font-size:11px;cursor:pointer;transition:all 0.2s;font-weight:600;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    `;
    testBtn.textContent = 'Test Admin Access';
    const testResult = document.createElement('div');
    testResult.style.cssText = 'color:#9a9acc;font-size:10px;padding:4px 0;min-height:16px;';

    testBtn.addEventListener('click', () => {
      testResult.textContent = 'Testing...';
      testResult.style.color = '#ffaa44';
      window.__afu_testAdminAccess('/admin', (result) => {
        if (result.success) {
          testResult.textContent = 'Access possible! Click a link below.';
          testResult.style.color = '#6aff3a';
        } else if (result.reason === 'http-redirect') {
          testResult.textContent = 'Server returns 307 redirect — server-protected.';
          testResult.style.color = '#ff6666';
        } else if (result.reason === 'rsc-redirect') {
          testResult.textContent = 'Server sends RSC redirect — server-protected.';
          testResult.style.color = '#ff6666';
        } else {
          testResult.textContent = 'Cannot access admin — server-side protection.';
          testResult.style.color = '#ff6666';
        }
      });
    });
    testRow.appendChild(testBtn);
    adminSection.appendChild(testRow);
    adminSection.appendChild(testResult);

    // Admin link buttons
    const adminLinks = document.createElement('div');
    adminLinks.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;';

    const adminPages = [
      { path: '/admin', label: 'Admin Home' },
      { path: '/admin/audit', label: 'Audit' },
      { path: '/admin/bot-debug', label: 'Bot Debug' },
      { path: '/admin/dataset-viewer', label: 'Dataset' },
      { path: '/admin/god-mode', label: 'God Mode' },
      { path: '/admin/tools', label: 'Tools' },
    ];

    for (const page of adminPages) {
      const btn = document.createElement('button');
      btn.style.cssText = `
        background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);
        color:#9a9acc;padding:4px 8px;border-radius:5px;cursor:pointer;
        font-size:10px;transition:all 0.2s;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      `;
      btn.textContent = page.label;
      btn.addEventListener('click', () => openAdminInNewTab(page.path));
      adminLinks.appendChild(btn);
    }
    adminSection.appendChild(adminLinks);
    bodyEl.appendChild(adminSection);

    // ── Footer ──
    const footer = document.createElement('div');
    footer.className = 'afu-footer';
    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = 'Apply & Reload Page';
    reloadBtn.addEventListener('click', () => {
      syncToolbarOverridesCookie(overrides);
      setAdminFlagCookies();
      window.location.reload();
    });
    footer.appendChild(reloadBtn);
    panel.appendChild(footer);

    // ── Status bar ──
    const statusBar = document.createElement('div');
    statusBar.className = 'afu-status-bar';
    const activeCount = Object.keys(overrides).length;
    const modelCount = _discoveredLockedModels.length;
    statusBar.innerHTML = `<span>Active: ${activeCount} flags | ${modelCount} hidden models</span><span>v5.1 | PostHog proxied</span>`;
    panel.appendChild(statusBar);

    // ── Toggle panel ──
    gear.addEventListener('click', () => {
      panel.classList.toggle('open');
    });

    // ── Enable All ──
    document.getElementById('afu-enable-all').addEventListener('click', () => {
      const newOverrides = {};
      for (const flag of FLAG_DEFS.filter(f => f.rec)) {
        newOverrides[flag.key] = getEnableValue(flag);
      }
      saveOverrides(newOverrides);
      syncToolbarOverridesCookie(newOverrides);
      setPosthogToolbarOverrides(newOverrides);
      setAdminFlagCookies();
      // Re-apply immediately
      applyPosthogOverrides(newOverrides);
      patchPosthogLocalStorage(newOverrides);
      window.location.reload();
    });

    // ── Disable All ──
    document.getElementById('afu-disable-all').addEventListener('click', () => {
      saveOverrides({});
      // Clear toolbar overrides
      document.cookie = `${TOOLBAR_OVERRIDES_COOKIE}=; path=/; max-age=0`;
      // Clear $override_feature_flags
      try {
        let raw = localStorage.getItem(POSTHOG_KEY);
        if (raw) {
          const data = JSON.parse(raw);
          delete data['$override_feature_flags'];
          localStorage.setItem(POSTHOG_KEY, JSON.stringify(data));
        }
      } catch (e) { /* empty */ }
      localStorage.removeItem(STORAGE_KEY);
      window.location.reload();
    });

    // ── Make panel draggable ──
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = e.clientX - dragOffset.x;
      const y = e.clientY - dragOffset.y;
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  function createFlagRow(flag, overrides) {
    const row = document.createElement('div');
    row.className = 'afu-flag-row';

    const info = document.createElement('div');
    info.className = 'afu-flag-info';

    const label = document.createElement('div');
    label.className = 'afu-flag-label';
    label.textContent = flag.label;
    if (flag.rec) {
      const badge = document.createElement('span');
      badge.className = 'afu-rec-badge';
      badge.textContent = 'REC';
      label.appendChild(badge);
    }

    const desc = document.createElement('div');
    desc.className = 'afu-flag-desc';
    desc.textContent = flag.desc;

    const keyLine = document.createElement('div');
    keyLine.className = 'afu-flag-key';
    const enableVal = getEnableValue(flag);
    keyLine.textContent = `${flag.key}  \u2192  ${typeof enableVal === 'boolean' ? enableVal : '"' + enableVal + '"'}`;

    info.appendChild(label);
    info.appendChild(desc);
    info.appendChild(keyLine);

    // Show discovered value if available
    if (_discoveredFlagValues[flag.key] !== undefined) {
      const valLine = document.createElement('div');
      valLine.className = 'afu-flag-value';
      valLine.textContent = `current: ${JSON.stringify(_discoveredFlagValues[flag.key])}`;
      info.appendChild(valLine);
    }

    const toggle = document.createElement('label');
    toggle.className = 'afu-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = overrides[flag.key] !== undefined;
    const slider = document.createElement('span');
    slider.className = 'afu-toggle-slider';
    toggle.appendChild(input);
    toggle.appendChild(slider);

    input.addEventListener('change', () => {
      const current = loadOverrides();
      if (input.checked) {
        current[flag.key] = getEnableValue(flag);
      } else {
        delete current[flag.key];
      }
      saveOverrides(current);
      // Immediately apply via all channels
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

  // 1. Intercept PostHog decide endpoint (must be early)
  interceptPostHogDecide(overrides);

  // 2. Intercept PostHog bootstrap at init time
  interceptPosthogBootstrap(overrides);

  // 3. Patch localStorage early if we have overrides
  if (Object.keys(overrides).length > 0) {
    patchPosthogLocalStorage(overrides);
    setPosthogToolbarOverrides(overrides);
    syncToolbarOverridesCookie(overrides);
  }

  // ─── GUI PERSISTENCE: MutationObserver + Navigation Re-injection ──────────
  // The gear icon and panel get destroyed by React re-renders and Next.js
  // client-side navigation. We watch for removal and re-inject.

  function initGUI() {
    createGUI(overrides);
    applyPosthogOverrides(overrides);
    hookVercelFlagContext();
  }

  // Watch for the gear being removed from DOM (React re-render)
  function startGUIWatcher() {
    if (_mutationObserver) {
      try { _mutationObserver.disconnect(); } catch (e) { /* ignore */ }
    }

    _mutationObserver = new MutationObserver((mutations) => {
      // Check if our gear was removed
      const gear = document.getElementById('afu-gear');
      if (!gear && document.body && document.readyState !== 'loading') {
        // Gear was removed — re-inject after a small delay to avoid
        // fighting with React during active re-renders
        setTimeout(() => {
          if (!document.getElementById('afu-gear')) {
            initGUI();
            startGUIWatcher(); // re-attach observer to new elements
          }
        }, 250);
      }
    });

    // Observe the body for child removals
    if (document.body) {
      _mutationObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ── Next.js client-side navigation re-injection ──
  // When Next.js does client-side navigation (pushState/replaceState),
  // React re-renders the page content which can remove our GUI elements.
  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;

  history.pushState = function (...args) {
    _origPushState.apply(this, args);
    setTimeout(() => {
      if (!document.getElementById('afu-gear')) initGUI();
      startGUIWatcher();
    }, 300);
  };

  history.replaceState = function (...args) {
    _origReplaceState.apply(this, args);
    setTimeout(() => {
      if (!document.getElementById('afu-gear')) initGUI();
      startGUIWatcher();
    }, 300);
  };

  window.addEventListener('popstate', () => {
    setTimeout(() => {
      if (!document.getElementById('afu-gear')) initGUI();
      startGUIWatcher();
    }, 300);
  });

  // Track panel open state so we can restore it after re-injection
  document.addEventListener('click', (e) => {
    const gear = document.getElementById('afu-gear');
    if (gear && (e.target === gear || gear.contains(e.target))) {
      _panelWasOpen = !_panelWasOpen;
    }
  });

  // ── Initial GUI creation ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initGUI();
      startGUIWatcher();
    });
  } else {
    // DOM already loaded (can happen with Tampermonkey injection timing)
    initGUI();
    startGUIWatcher();
  }

  // ── Also try a delayed injection in case DOMContentLoaded fired too early ──
  setTimeout(() => {
    if (!document.getElementById('afu-gear')) {
      initGUI();
      startGUIWatcher();
    }
  }, 1500);

  // ── And another attempt after full page load ──
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (!document.getElementById('afu-gear')) {
        initGUI();
        startGUIWatcher();
      }
    }, 500);
  });

  console.log('[Arena Flag Unlocker] v5.1 initialized. RSC interceptor active, PostHog proxied at /rpc, GUI with MutationObserver re-injection.');

})();
