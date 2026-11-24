// ==UserScript==
// @name         番薯大家族
// @namespace    hans-ro-survivors-tools
// @version      1.0.9
// @updateURL    https://raw.githubusercontent.com/potato316/sweet-potato-family/main/SweetPotatoFamily.user.js
// @downloadURL  https://raw.githubusercontent.com/potato316/sweet-potato-family/main/SweetPotatoFamily.user.js
// @description  v0.8.5 整理設定介面：分類折疊、簡化資訊顯示；保留 v0.8.4.16 自動化功能。
// @match        https://ro.hans-webgametw.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// ==/UserScript==

/* ===== 肉塊／磁鐵自動吸取（精簡保留版） ===== */
(() => {
  'use strict';

  const VERSION = '1.0.9';
  const PICKUP_KINDS = new Set(['magnet', 'meat', 'chest', 'loot', 'card', 'egg']);
  const pickupArrays = new Set();
  const settings = { enabled: true, utility: true, chest: true, rewards: true };

  let panel = null;
  let statusEl = null;
  let toggleEl = null;
  let lastSeenCount = 0;
  let lastStatus = '';
  let gameCache = null;
  const pickupOwners = new WeakMap();
  let captureMode = '等待遊戲建立';

  // The Vite game module keeps its Game instance private. At document-start,
  // observe the one-time initialization of its `pickups` property. Its
  // transpiled class-field helper uses Object.defineProperty when a property
  // already exists on the prototype, otherwise direct assignment.
  function installGameCapture() {
    const originalDefine = Object.defineProperty;
    const oldDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'pickups');
    function record(owner, arr) {
      if (!owner || typeof owner !== 'object' || !Array.isArray(arr)) return;
      // Game has already initialized these adjacent fields when pickups is set.
      if (!Object.prototype.hasOwnProperty.call(owner, 'enemies') ||
          !Object.prototype.hasOwnProperty.call(owner, 'projectiles')) return;
      pickupOwners.set(arr, owner);
      gameCache = owner;
      captureMode = '已擷取遊戲實例';
    }
    // Do not overwrite a pre-existing prototype descriptor from another tool.
    if (!oldDescriptor) {
      originalDefine(Object.prototype, 'pickups', {
        configurable: true, enumerable: false,
        get() { return undefined; },
        set(value) {
          originalDefine(this, 'pickups', {
            value, writable: true, configurable: true, enumerable: true
          });
          record(this, value);
        }
      });
    }
    Object.defineProperty = function(target, key, descriptor) {
      const result = Reflect.apply(originalDefine, Object, [target, key, descriptor]);
      if (key === 'pickups' && descriptor && 'value' in descriptor)
        record(target, descriptor.value);
      return result;
    };
    // Keep the capture observer active across stage transitions. The game may
    // construct a NEW Game instance after returning to town; removing this
    // hook after the first capture leaves remote chest opening bound to the
    // previous run. Each new pickups array is mapped to its actual owner.
    // The descriptor remains configurable and writes an own property on first
    // assignment, so it does not keep intercepting subsequent reads/writes.

  }
  installGameCapture();

  function findGame(arr) {
    const candidate = pickupOwners.get(arr);
    if (candidate && candidate.pickups === arr && candidate.player &&
        Number.isFinite(candidate.player.x) && Number.isFinite(candidate.player.y))
      return candidate;
    // updatePickups() removes dead drops using this.pickups = this.pickups.filter(...).
    // This replaces the array without triggering push or the one-time property
    // initialization capture. Rebind the new array to its live Game owner.
    if (gameCache && gameCache.pickups === arr && gameCache.player &&
        Number.isFinite(gameCache.player.x) && Number.isFinite(gameCache.player.y)) {
      pickupOwners.set(arr, gameCache);
      return gameCache;
    }
    return null;
  }
  let lastRemoteChestAttempt = 0;
  let remoteChestError = '';
  function openChestRemotely(chest, game) {
    if (!settings.enabled || !settings.chest || !game || chest.dead || game.state !== 'playing') return;
    // In co-op the chest take/open path is synchronized by the host.
    // Do not bypass the network flow on either host or replica.
    if (game.coop || inPartyMode()) return;
    if (!Array.isArray(game.pickups) || !game.pickups.includes(chest)) return;
    if (!game.player || game.player.dead || game.openingChest) return;
    if (typeof game.tryOpenChest !== 'function' || typeof game.chestCost !== 'function') return;
    const cost = game.chestCost();
    if (!Number.isFinite(cost) || !Number.isFinite(game.zeny) || game.zeny < cost) return;
    // One attempt per interval, not per chest; tryOpenChest changes the game
    // state to levelup synchronously when a chest reward picker opens.
    const now = Date.now();
    if (now - lastRemoteChestAttempt < 400) return;
    lastRemoteChestAttempt = now;
    try {
      game.tryOpenChest(chest);
      remoteChestError = '';
    } catch (error) {
      remoteChestError = String(error?.message || error).slice(0, 120);
      console.warn('[HANS remote chest]', error);
    }
  }

  function isPickup(value) {
    try {
      return !!value && typeof value === 'object' &&
        PICKUP_KINDS.has(value.kind) &&
        Number.isFinite(value.x) && Number.isFinite(value.y) &&
        !!value.view && typeof value.update === 'function';
    } catch (_) {
      return false;
    }
  }

  // Capture only arrays receiving the game's meat/magnet pickup objects.
  function installPickupArrayObserver() {
    const proto = Array.prototype;
    const originalPush = proto.push;
    if (originalPush && originalPush.__hansUtilityLootHook) return;

    function observedPush(...items) {
      const result = Reflect.apply(originalPush, this, items);
      try {
        if (Array.isArray(this) && items.some(isPickup)) pickupArrays.add(this);
      } catch (_) {
        // Never interrupt the game's own array operation.
      }
      return result;
    }

    Object.defineProperty(observedPush, '__hansUtilityLootHook', { value: true });
    Object.defineProperty(proto, 'push', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: observedPush
    });
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      el.getClientRects().length > 0;
  }

  function inPartyMode() {
    const party = document.getElementById('run-party');
    return !!party && isVisible(party);
  }

  function applyMagnet(pickup) {
    if (!settings.enabled || !isPickup(pickup) || pickup.dead) return;
    if (pickup.kind === 'chest') return;
    const enabled = pickup.kind === 'meat' || pickup.kind === 'magnet'
      ? settings.utility
      : settings.rewards && (pickup.kind === 'loot' || pickup.kind === 'card' || pickup.kind === 'egg');
    if (!enabled) return;
    // In party replica mode collection is server-mediated; leave it to the game.
    if (inPartyMode()) return;
    try {
      pickup.magnet = true;
      pickup.vacuum = true;
    } catch (_) {
      // Some future game builds may seal pickup objects; simply skip those.
    }
  }

  function updateStatus(message, count = 0) {
    if (!statusEl) return;
    const extra = count ? ` · 監測 ${count}` : '';
    const next = `${message}${extra}`;
    if (next !== lastStatus) {
      statusEl.textContent = next;
      lastStatus = next;
    }
  }

  function collectUtilityPickups() {
    // When disabled, do not traverse pickup arrays at all.
    if (!settings.enabled || (!settings.utility && !settings.chest && !settings.rewards)) {
      updateStatus('所有自動吸取目前已停用。');
      return;
    }
    // Game replaces its pickups array whenever a dead drop is cleaned up.
    // Keep tracking the current array, even when no new drop was pushed yet.
    if (gameCache && Array.isArray(gameCache.pickups)) {
      pickupOwners.set(gameCache.pickups, gameCache);
      pickupArrays.add(gameCache.pickups);
    }
    if (!pickupArrays.size) {
      updateStatus('尚未偵測到肉塊／磁鐵／寶箱／裝備／卡片／寵物蛋資料；請進入冒險並等待掉落。');
      return;
    }

    let total = 0;
    const liveArrays = [];
    for (const arr of pickupArrays) {
      if (!Array.isArray(arr)) continue;
      liveArrays.push(arr);
      for (const pickup of arr) {
        if (!isPickup(pickup) || pickup.dead) continue;
        total++;
        if (pickup.kind === 'chest') openChestRemotely(pickup, findGame(arr));
        else applyMagnet(pickup);
      }
    }
    lastSeenCount = total;

    for (const arr of [...pickupArrays]) {
      if (!Array.isArray(arr) || (arr.length === 0 && liveArrays.length > 1) ||
          (gameCache && arr !== gameCache.pickups && pickupOwners.has(arr))) pickupArrays.delete(arr);
    }

    if (inPartyMode() && settings.enabled && (settings.utility || settings.rewards)) {
      updateStatus(`已偵測 ${total} 個肉塊／磁鐵／寶箱／獎勵；隊伍模式暫停自動吸取，避免同步問題。`, total);
    } else if (!settings.enabled || (!settings.utility && !settings.chest && !settings.rewards)) {
      updateStatus('所有自動吸取目前已停用。', total);
    } else {
      updateStatus(`偵測 ${total} 個掉落物；寶箱角色定位${gameCache?.player ? "成功" : "待確認"}（${captureMode}）${remoteChestError ? "；遠距開箱錯誤：" + remoteChestError : ""}。`, total);
    }
  }

  function setEnabled(value) {
    settings.enabled = !!value;
    if (toggleEl) {
      toggleEl.textContent = settings.enabled ? '已啟用' : '已暫停';
      toggleEl.classList.toggle('off', !settings.enabled);
    }
    if (!settings.enabled) updateStatus('自動吸取已暫停。', lastSeenCount);
  }

  function createPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('section');
    panel.id = 'hans-auto-loot-panel'; // Shared mount point used by the other retained modules.
    panel.innerHTML = `
      <header class="hal-head">
        <strong>番薯大家族 <small>v${VERSION}</small></strong>
        <button type="button" class="hal-collapse" title="收合">−</button>
      </header>
      <div class="hal-body">
        <button type="button" class="hal-toggle">已啟用</button>
        <label><input type="checkbox" data-setting="utility" checked> 肉塊／磁鐵</label>
        <label><input type="checkbox" data-setting="chest" checked> 遠距自動開啟寶箱（單人）</label>
        <label><input type="checkbox" data-setting="rewards" checked> 自動吸取裝備／卡片／寵物蛋</label>
        <p class="hal-note">三種吸取項目及總開關皆預設啟用；寶箱使用原生開箱流程，不移動寶箱，Zeny 不足時不開啟。多人模式停用遠距開箱。F8 可快速暫停／啟用。</p>
        <div class="hal-status">等待肉塊／磁鐵／寶箱／裝備／卡片／寵物蛋資料…</div>
      </div>`;

    const style = document.createElement('style');
    style.textContent = `
      #hans-auto-loot-panel{position:fixed;right:16px;bottom:18px;z-index:2147483000;width:278px;max-height:85vh;overflow:auto;color:#f6edda;background:rgba(24,27,35,.96);border:1px solid rgba(231,190,112,.7);border-radius:10px;box-shadow:0 5px 22px rgba(0,0,0,.42);font:13px/1.45 system-ui,"Microsoft JhengHei",sans-serif;user-select:none}
      #hans-auto-loot-panel *{box-sizing:border-box}
      #hans-auto-loot-panel .hal-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:rgba(160,112,48,.24);border-radius:10px 10px 0 0;cursor:move}
      #hans-auto-loot-panel .hal-head strong{font-size:13px}#hans-auto-loot-panel .hal-head small{font-size:10px;color:#d7c6a6;font-weight:400}
      #hans-auto-loot-panel button{font:inherit;cursor:pointer;border:0;border-radius:6px;padding:5px 9px;color:#fff;background:#347b50}
      #hans-auto-loot-panel button.off{background:#8b4646}#hans-auto-loot-panel .hal-collapse{padding:1px 8px;background:transparent;font-size:18px}
      #hans-auto-loot-panel .hal-body{padding:9px 11px 10px;display:grid;gap:7px}
      #hans-auto-loot-panel .hal-body>label{display:flex;align-items:center;gap:7px;cursor:pointer}
      #hans-auto-loot-panel input{accent-color:#d6a74f;margin:0}
      #hans-auto-loot-panel .hal-toggle{width:100%;font-weight:700}
      #hans-auto-loot-panel .hal-note{margin:0;color:#cbb995;font-size:11px}
      #hans-auto-loot-panel .hal-status{padding:6px 7px;background:rgba(255,255,255,.07);border-radius:6px;color:#e5d6ba;font-size:11px;min-height:30px}
      #hans-auto-loot-panel.collapsed .hal-body{display:none}
    `;
    (document.head || document.documentElement).appendChild(style);
    document.body.appendChild(panel);

    statusEl = panel.querySelector('.hal-status');
    toggleEl = panel.querySelector('.hal-toggle');
    toggleEl.addEventListener('click', () => setEnabled(!settings.enabled));
    panel.querySelectorAll('input[data-setting]').forEach(input => {
      input.addEventListener('change', () => {
        settings[input.dataset.setting] = input.checked;
        collectUtilityPickups();
      });
    });
    panel.querySelector('.hal-collapse').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      panel.querySelector('.hal-collapse').textContent = panel.classList.contains('collapsed') ? '+' : '−';
    });

    // Draggable header. Panel interaction does not affect game controls.
    const head = panel.querySelector('.hal-head');
    let drag = null;
    head.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      drag = {
        x: event.clientX,
        y: event.clientY,
        right: window.innerWidth - panel.getBoundingClientRect().right,
        bottom: window.innerHeight - panel.getBoundingClientRect().bottom
      };
      head.setPointerCapture?.(event.pointerId);
    });
    head.addEventListener('pointermove', event => {
      if (!drag) return;
      panel.style.right = `${Math.max(0, drag.right - (event.clientX - drag.x))}px`;
      panel.style.bottom = `${Math.max(0, drag.bottom - (event.clientY - drag.y))}px`;
    });
    head.addEventListener('pointerup', () => { drag = null; });
    head.addEventListener('pointercancel', () => { drag = null; });
  }

  function installInputGuard() {
    document.addEventListener('keydown', event => {
      if (!event.isTrusted) return;
      if (event.key.toLowerCase() === 'f8' &&
          !(event.target instanceof HTMLInputElement) &&
          !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        setEnabled(!settings.enabled);
      }
    }, true);
  }

  installPickupArrayObserver();
  installInputGuard();

  function bootPanel() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', bootPanel, { once: true });
      return;
    }
    createPanel();
    collectUtilityPickups();
    window.setInterval(collectUtilityPickups, 500);
  }
  bootPanel();
})();

/* ===== 翻牌相關次數不限模組（全部刷新／單張重抽／專注／放逐；整合版 v0.8.3） ===== */
(() => {
  'use strict';

  const GLOBAL_KEY = '__HANS_REROLL_UNLIMITED_V083__';
  if (window[GLOBAL_KEY]) return;

  const nativeDefineProperty = Object.defineProperty;
  const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const nativeHasOwn = Object.prototype.hasOwnProperty;

  // These four counters back the full-deck reroll, single-card reroll,
  // Focus, and Banish actions in both level-up and chest pickers.
  const UNLIMITED_KEYS = new Set(['reroll', 'reroll_card', 'focus', 'banish']);

  const state = {
    enabled: true,
    installedAt: Date.now(),
    hookedRuns: 0,
    hookedMaxObjects: 0,
    counterCalls: { reroll: 0, reroll_card: 0, focus: 0, banish: 0 },
    lastHookAt: 0,
    hookReady: false,
    panel: null,
    note: '等待遊戲建立冒險物件…'
  };

  const leftProxySet = new WeakSet();
  const maxProxySet = new WeakSet();

  function wrapLeft(value) {
    if (!value || typeof value !== 'object') return value;
    if (leftProxySet.has(value)) return value;

    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        if (UNLIMITED_KEYS.has(key) && state.enabled) return 999999;
        return Reflect.get(target, key, receiver);
      },
      set(target, key, next, receiver) {
        if (UNLIMITED_KEYS.has(key) && state.enabled) {
          // The game's actions use post-decrement (counter--). Keep the real
          // underlying counter consistent, while the UI reads the unlimited value.
          const before = Number(Reflect.get(target, key, target)) || 0;
          Reflect.set(target, key, Math.max(0, before - 1), target);
          state.counterCalls[key] = (state.counterCalls[key] || 0) + 1;
          updatePanel();
          return true;
        }
        return Reflect.set(target, key, next, receiver);
      }
    });

    leftProxySet.add(proxy);
    state.hookedRuns += 1;
    state.lastHookAt = Date.now();
    state.hookReady = true;
    state.note = '已接管刷新次數';
    updatePanel();
    return proxy;
  }

  function wrapMax(value) {
    if (!value || typeof value !== 'object') return value;
    if (maxProxySet.has(value)) return value;

    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        if (UNLIMITED_KEYS.has(key) && state.enabled) {
          const current = Number(Reflect.get(target, key, receiver)) || 0;
          // The game hides an action when its max entitlement is zero. Keep
          // each unlimited action visible as well as keeping its remaining count high.
          return Math.max(1, current);
        }
        return Reflect.get(target, key, receiver);
      }
    });

    maxProxySet.add(proxy);
    state.hookedMaxObjects += 1;
    updatePanel();
    return proxy;
  }

  function installMarker(name) {
    const existing = nativeGetOwnPropertyDescriptor(Object.prototype, name);
    if (existing && !existing.configurable) {
      throw new Error(`Object.prototype.${name} 已存在且不可設定`);
    }
    if (!existing) {
      // The game bundle's field helper checks `key in instance` before defining
      // the field. This marker routes only these two fields through defineProperty.
      nativeDefineProperty(Object.prototype, name, {
        configurable: true,
        enumerable: false,
        value: undefined,
        writable: true
      });
    }
  }

  try {
    installMarker('perksLeft');
    installMarker('perksMax');

    // The current game bundle captures Object.defineProperty at module evaluation
    // and uses it for fields found on the prototype chain. Intercepting that
    // definition lets us wrap the private run object's counters without needing
    // a window.game export or changing the website's server files.
    Object.defineProperty = function (target, key, descriptor) {
      if (key === 'perksLeft' && descriptor && nativeHasOwn.call(descriptor, 'value')) {
        let current = wrapLeft(descriptor.value);
        return nativeDefineProperty(target, key, {
          configurable: true,
          enumerable: descriptor.enumerable !== false,
          get() { return current; },
          set(next) { current = wrapLeft(next); }
        });
      }

      if (key === 'perksMax' && descriptor && nativeHasOwn.call(descriptor, 'value')) {
        let current = wrapMax(descriptor.value);
        return nativeDefineProperty(target, key, {
          configurable: true,
          enumerable: descriptor.enumerable !== false,
          get() { return current; },
          set(next) { current = wrapMax(next); }
        });
      }

      return nativeDefineProperty(target, key, descriptor);
    };

    state.note = '攔截器已就緒，等待遊戲物件';
  } catch (error) {
    state.note = `安裝失敗：${error && error.message ? error.message : String(error)}`;
    console.error('[HANS Integrated Tools] reroll hook install failed:', error);
  }

  nativeDefineProperty(window, GLOBAL_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: state
  });

  function ensurePanel() {
    if (!document.documentElement || state.panel) return;

    // Attach reroll controls to the existing Auto-Loot panel, so the user installs
    // and operates only one userscript and sees only one consolidated panel.
    const host = document.querySelector('#hans-auto-loot-panel .hal-body');
    if (!host) return;

    const section = document.createElement('section');
    section.id = 'hans-reroll-unlimited-panel';
    section.className = 'hru-section';
    section.innerHTML = `
      <div class="hru-title">翻牌刷新（技能／寶箱）</div>
      <div class="hru-status">狀態：<span class="hru-note"></span></div>
      <div class="hru-info">已接管遊戲物件：<b class="hru-hooked">0</b></div>
      <div class="hru-info">本次冒險已使用：</div>
      <div class="hru-info hru-count">全部刷新 0 · 單張重抽 0 · 專注 0 · 放逐 0</div>
      <button type="button" class="hru-toggle">無限次數：啟用</button>
      <div class="hru-foot">支援：全部刷新／單張重抽／專注／放逐（技能與寶箱）</div>`;

    const style = document.createElement('style');
    style.textContent = `
      #hans-auto-loot-panel .hru-section{margin-top:2px;padding-top:8px;border-top:1px solid rgba(255,255,255,.15);display:grid;gap:5px}
      #hans-auto-loot-panel .hru-title{font-size:12px;font-weight:700;color:#f2d9a8}
      #hans-auto-loot-panel .hru-status{color:#c7d6f5;font-size:11px;overflow-wrap:anywhere}
      #hans-auto-loot-panel .hru-info{margin:0;color:#d7deee;font-size:11px}
      #hans-auto-loot-panel .hru-count{font-size:10px;line-height:1.45;overflow-wrap:anywhere;color:#f0d9ac}
      #hans-auto-loot-panel .hru-toggle{width:100%;font-weight:700;background:#216b4b}
      #hans-auto-loot-panel .hru-foot{color:#cbb995;font-size:10px}`;

    (document.head || document.documentElement).appendChild(style);
    host.appendChild(section);
    state.panel = section;
    section.querySelector('.hru-toggle').addEventListener('click', () => {
      state.enabled = !state.enabled;
      updatePanel();
    });
    updatePanel();
  }

  function updatePanel() {
    const panel = state.panel;
    if (!panel) return;
    const note = panel.querySelector('.hru-note');
    const hooked = panel.querySelector('.hru-hooked');
    const count = panel.querySelector('.hru-count');
    const toggle = panel.querySelector('.hru-toggle');
    if (note) note.textContent = state.note;
    if (hooked) hooked.textContent = String(state.hookedRuns);
    if (count) {
      const c = state.counterCalls;
      count.textContent = `全部刷新 ${c.reroll} · 單張重抽 ${c.reroll_card} · 專注 ${c.focus} · 放逐 ${c.banish}`;
    }
    if (toggle) {
      toggle.textContent = `無限次數：${state.enabled ? '啟用' : '停用'}`;
      toggle.style.background = state.enabled ? '#216b4b' : '#6b4550';
    }
  }

  const panelTimer = setInterval(() => {
    ensurePanel();
    if (Date.now() - state.installedAt > 12000 && !state.hookReady && state.note === '攔截器已就緒，等待遊戲物件') {
      state.note = '尚未攔截到遊戲物件；可能是注入時機不符';
      updatePanel();
    }
  }, 250);

  window.addEventListener('beforeunload', () => clearInterval(panelTimer), { once: true });
})();


/* ===== 技能／寶箱偏好自動選擇＋Keyword 自動放逐（整合版 v0.8.3） ===== */
(() => {
  'use strict';

  const GLOBAL_KEY = '__HANS_AUTO_CHOICE_V083__';
  if (window[GLOBAL_KEY]) return;

  const STORAGE_KEY = 'hans-ro-toolkit-auto-choice-v070';
  const defaults = {
    skillEnabled: false,
    stopFlipEnabled: false,
    stopFlipLevel: 300,
    chestEnabled: false,
    skillPriority: '',
    chestPriority: '',
    chestAutoReroll: false,
    firstFallback: false,
    banishEnabled: false,
    banishKeywords: '',
    specialEnabled: false,
    specialSkills: ['', '', '', '', '', ''],
    specialCounts: [1, 1, 1, 1, 1, 1]
  };
  const state = {
    ...defaults,
    panel: null,
    statusEl: null,
    lastSignature: '',
    busy: false,
    lastDecision: '',
    choiceRetrySignature: '',
    choiceRetryCount: 0,
    choiceLastAt: 0,
    chestRerollCount: 0,
    chestRerollLastAt: 0,
    banishedLabels: new Set(),
    specialStages: new Map(),
    specialPending: null,
    specialPendingAt: 0,
    stopFlipLastClickAt: 0,
    stopFlipHandled: false,
    lastObservedLevel: 0,
    lastOpenAt: 0
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const key of Object.keys(defaults)) {
        if (key === 'specialSkills' && Array.isArray(saved[key])) {
          state[key] = Array.from({length: 6}, (_, i) => typeof saved[key][i] === 'string' ? saved[key][i] : '');
        } else if (key === 'specialCounts') {
          state[key] = Array.from({length: 6}, (_, i) => Math.min(999, Math.max(1, Math.floor(Number(saved[key]?.[i]) || 1))));
        } else if (typeof saved[key] === typeof defaults[key]) state[key] = saved[key];
      }
    } catch (_) { /* Use defaults when storage is unavailable or invalid. */ }
  }

  function saveSettings() {
    try {
      const saved = {};
      for (const key of Object.keys(defaults)) saved[key] = state[key];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (_) {
      setStatus('設定無法寫入瀏覽器儲存空間；本次頁面仍可使用。');
    }
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      !el.classList.contains('hidden') && el.getClientRects().length > 0;
  }

  function normalize(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[\s\u3000·・,，、;；:：+＋()[\]{}「」『』]/g, '');
  }

  function parsePriority(value) {
    return String(value || '')
      .split(/[\n\r,，、;；]+/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  function getPicker() {
    const picker = document.getElementById('picker');
    if (!visible(picker) || picker.classList.contains('closing')) return null;
    const cardsRoot = document.getElementById('pk-cards');
    if (!cardsRoot) return null;
    const cards = [...cardsRoot.querySelectorAll('.pk-card')];
    return cards.length ? { picker, cards, cardsRoot } : null;
  }

  function classifyPicker(picker) {
    const title = document.getElementById('pk-title')?.textContent || '';
    const subtitle = document.getElementById('pk-sub')?.textContent || '';
    const gain = document.getElementById('pk-gain');
    const sockets = document.getElementById('lu-sockets');
    const combined = `${title} ${subtitle}`;

    // Classify chest first: its picker exposes the equipment socket panel and a
    // chest title / Zeny price. This also avoids mistaking other reward pickers.
    if (visible(sockets) &&
        (/(cofre|treasure\s*chest|chest|寶箱|宝箱|開箱|开箱)/i.test(combined) ||
         /(?:zeny|[-−]\s*[\d,]+)/i.test(subtitle))) {
      return 'chest';
    }

    // The game localizes the title. Prefer the visible gain line, but also
    // recognize localized level-up titles if CSS/layout temporarily hides it.
    const gainText = String(gain?.textContent || '').trim();
    const hasGain = !!gainText; // The game writes this only for the level-up picker.
    const levelTitle = /(level\s*up|subiste\s*de\s*nivel|升[級级]|升等|提升等級)/i.test(combined);
    if (hasGain || levelTitle) return 'skill';

    return null;
  }

  function cardLabel(card) {
    const name = card.querySelector('.pk-name');
    const sub = card.querySelector('.pk-sub');
    const badge = card.querySelector('.pk-badge');
    const text = [name?.textContent, sub?.textContent, badge?.textContent, card.innerText, card.textContent]
      .filter(Boolean).join(' ');
    return text.trim();
  }

  function chooseKeywordIndex(cards, keywords) {
    if (!keywords.length) return -1;
    const labels = cards.map(card => normalize(cardLabel(card)));
    // Continue to the next matching card after a previous banish in this picker.
    for (const keyword of keywords) {
      const needle = normalize(keyword);
      if (!needle) continue;
      const found = labels.findIndex((label, index) =>
        label.includes(needle) &&
        !isProtectedSpecial(cards[index]) &&
        !state.banishedLabels.has(normalize(
          (cards[index].querySelector('.pk-name')?.textContent || cardLabel(cards[index])).trim()
        ))
      );
      if (found >= 0) return found;
    }
    return -1;
  }

  // The game's Banish button is rendered BELOW the card as a sibling control
  // inside the card slot. Search the slot/parent, not only descendants of .pk-card.
  // Never click the card itself: that would select the skill/item instead.
  function findBanishControl(card) {
    const slot = card.closest('.pk-slot');
    const scopes = [...new Set([
      slot,
      card.parentElement,
      card.closest('#pk-cards')
    ].filter(Boolean))];
    const selector = 'button,[role="button"],[data-action],.pk-banish,[aria-label],[title]';
    const candidates = scopes.flatMap(scope => [...scope.querySelectorAll(selector)]);
    const words = /(banish|exile|放逐|除外|移除)/i;
    return candidates.find(el => {
      if (!visible(el) || el === card || el.classList.contains('pk-card')) return false;
      // The correct control sits outside the card, normally directly below it.
      if (el.closest('.pk-card')) return false;
      if (slot && !slot.contains(el)) return false;
      const description = [
        el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'),
        el.getAttribute('data-action'), el.className
      ].filter(Boolean).join(' ');
      return words.test(description);
    }) || null;
  }

  function chooseIndex(cards, priorities) {
    if (!priorities.length) return -1;
    const labels = cards.map(card => normalize(cardLabel(card)));
    for (const preferred of priorities) {
      const needle = normalize(preferred);
      if (!needle) continue;
      const found = labels.findIndex(label => label.includes(needle));
      if (found >= 0) return found;
    }
    return -1;
  }

  function setStatus(message) {
    if (state.statusEl && state.statusEl.textContent !== message) state.statusEl.textContent = message;
  }

  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  async function performBanish(kind, index, signature, label) {
    if (state.busy) return;
    state.busy = true;
    state.lastDecision = signature;
    try {
      await wait(420 + document.querySelectorAll('#pk-cards .pk-card').length * 120 + 180);
      const current = getPicker();
      if (!current || state.lastDecision !== signature || index >= current.cards.length ||
          classifyPicker(current.picker) !== kind) {
        setStatus('放逐畫面已變更；本次自動放逐取消，請手動處理。');
        return;
      }
      const target = current.cards[index];
      if (!target || !target.isConnected) {
        setStatus('目標卡片已更新；本次自動放逐取消。');
        return;
      }
      const control = findBanishControl(target);
      if (!control) {
        setStatus(`命中放逐關鍵字「${label}」，但卡片下方找不到可辨識的放逐按鈕；為避免誤選，已停止自動操作。`);
        return;
      }
      control.click();
      state.banishedLabels.add(normalize(label));
      setStatus(`已對「${label}」送出放逐操作；等待遊戲更新選單…`);
      // Let the game finish the banish animation and rebuild the picker.
      await wait(700);
      const latest = getPicker();
      if (!latest) {
        setStatus(`已放逐「${label}」；等待下一個選擇畫面。`);
      } else {
        setStatus(`已處理「${label}」；重新檢查剩餘技能並接續自動選擇。`);
      }
    } catch (error) {
      console.warn('[HANS Auto Banish] operation failed:', error);
      setStatus('自動放逐沒有完成，請手動放逐。');
    } finally {
      state.busy = false;
      // A MutationObserver may have fired while busy and been intentionally ignored.
      // Clear the old decision and inspect the latest picker after the action settles.
      state.lastSignature = '';
      state.lastDecision = '';
      window.setTimeout(() => inspectPicker(), 120);
    }
  }

  // Only use the game's own full-deck reroll button. Do not simulate a card click.
  // Continue rerolling until a preferred item appears or the game disables reroll.
  async function performChestReroll(signature) {
    if (state.busy) return;
    const bar = document.getElementById('pk-bar');
    // A picker can have multiple bar actions; identify the full-deck reroll.
    const reroll = [...(bar?.querySelectorAll('.pk-act[data-act^="bar:"]:not([disabled])') || [])]
      .find(el => /重抽整組|全部刷新|整組重抽|reroll deck|reroll all|refresh all|刷新整組/i.test(
        `${el.textContent || ''} ${el.title || ''}`));
    if (!reroll) {
      setStatus('寶箱沒有符合偏好道具，但「重抽整組」按鈕不可用；等待手動選擇。');
      return;
    }
    state.busy = true;
    state.lastDecision = signature;
    try {
      // Wait for the game's card entrance lock before pressing its real control.
      await wait(420 + document.querySelectorAll('#pk-cards .pk-card').length * 120 + 180);
      const current = getPicker();
      if (!current || classifyPicker(current.picker) !== 'chest' ||
          !state.chestEnabled || !state.chestAutoReroll ||
          state.lastDecision !== signature || !reroll.isConnected || reroll.disabled) return;
      reroll.click();
      state.chestRerollCount++;
      state.chestRerollLastAt = Date.now();
      setStatus(`寶箱無符合偏好道具，已按「重抽整組」第 ${state.chestRerollCount} 次；等待新道具…`);
      await wait(750);
    } catch (error) {
      console.warn('[HANS chest reroll]', error);
      setStatus('寶箱自動重抽失敗，請手動處理。');
    } finally {
      state.busy = false;
      state.lastDecision = '';
      state.lastSignature = '';
      window.setTimeout(inspectPicker, 150);
    }
  }

  async function performChoice(kind, index, signature, label) {
    if (state.busy) return;
    state.busy = true;
    state.lastDecision = signature;
    try {
      // The game's own picker refuses selections for 380 + 120 ms per card.
      // Wait beyond that animation/lock period before invoking its actual click handler.
      await wait(420 + document.querySelectorAll('#pk-cards .pk-card').length * 120 + 180);
      const current = getPicker();
      if (!current || state.lastDecision !== signature || index >= current.cards.length) {
        setStatus('選擇視窗已變更；本次自動選擇取消，請手動選擇。');
        return;
      }
      const currentKind = classifyPicker(current.picker);
      if (currentKind !== kind) {
        setStatus(`已偵測到選單，但類型判斷改變（${currentKind || '未辨識'}）；請手動選擇。`);
        return;
      }
      const target = current.cards[index];
      if (!target || !target.isConnected) {
        setStatus('技能／道具卡片已更新；本次自動選擇取消。');
        return;
      }
      // Record the actual click time. A failed game-side click must not lock
      // the same visible picker forever; inspectPicker can retry cautiously.
      state.choiceLastAt = Date.now();
      state.choiceRetrySignature = signature;
      state.choiceRetryCount += 1;
      target.click();
      setStatus(`已送出自動選擇（第 ${state.choiceRetryCount} 次）：${kind === 'skill' ? '技能' : '寶箱道具'}「${label}」`);

      // If the chosen chest item replaces an equipped item, the game opens a
      // second confirmation face. Confirm only that exact preference-selected card.
      await wait(260);
      const latest = getPicker();
      if (!latest || state.lastDecision !== signature) return;
      const slot = latest.picker.querySelectorAll('#pk-cards .pk-slot')[index];
      if (slot && slot.classList.contains('asking')) {
        const yes = slot.querySelector('[data-yes]');
        if (yes && visible(yes)) {
          yes.click();
          setStatus(`已確認替換並選擇：${label}`);
        }
      }
    } catch (error) {
      console.warn('[HANS Auto Choice] selection failed:', error);
      setStatus('自動選擇沒有完成，請手動點選。');
    } finally {
      state.busy = false;
    }
  }

  // Each configured skill has its own one-time select -> banish -> done lifecycle.
  // Exact normalized name matching avoids accidental substring matches.
  function isProtectedSpecial(card) {
    const name = normalize(card.querySelector('.pk-name')?.textContent || '');
    return state.specialEnabled && !!name && state.specialSkills.some(value => normalize(value) === name);
  }

  function specialMatch(cards) {
    if (!state.specialEnabled) return null;
    const configured = state.specialSkills.map((name, slot) => ({name: normalize(name), slot})).filter(x => x.name);
    for (const {name, slot} of configured) {
      if (configured.some(x => x.name === name && x.slot < slot)) continue;
      if (state.specialStages.get(slot) === -1) continue;
      const index = cards.findIndex(card => normalize(card.querySelector('.pk-name')?.textContent || '') === name);
      if (index >= 0) return {index, slot, name};
    }
    return null;
  }

  async function performSpecial(kind, match, signature, label) {
    if (state.busy || !['skill', 'chest'].includes(kind)) return;
    state.busy = true;
    state.lastDecision = signature;
    const stage = state.specialStages.get(match.slot) || 0;
    try {
      await wait(420 + document.querySelectorAll('#pk-cards .pk-card').length * 120 + 180);
      const current = getPicker();
      if (!current || classifyPicker(current.picker) !== kind ||
          state.lastDecision !== signature ||
          normalize(current.cards[match.index]?.querySelector('.pk-name')?.textContent || '') !== match.name) {
        setStatus('指定技能／寶箱道具選單已變更，這次不操作。');
        return;
      }
      if (stage < state.specialCounts[match.slot]) {
        current.cards[match.index].click();
        // Do not count a selection merely because the click handler was invoked.
        // A closed picker indicates the game accepted the selection.
        await wait(260);
        if (kind === 'chest') {
          const latest = getPicker();
          const slot = latest?.picker.querySelectorAll('#pk-cards .pk-slot')[match.index];
          if (latest && classifyPicker(latest.picker) === kind &&
              normalize(latest.cards[match.index]?.querySelector('.pk-name')?.textContent || '') === match.name &&
              slot?.classList.contains('asking')) {
            const yes = slot.querySelector('[data-yes]');
            if (!yes || !visible(yes)) { setStatus('指定寶箱道具等待手動確認替換，未累計。'); return; }
            yes.click();
          }
        }
        await wait(420);
        const afterClick = getPicker();
        const afterSignature = afterClick ? `${classifyPicker(afterClick.picker)}|${document.getElementById('pk-title')?.textContent || ''}|${afterClick.cards.map(cardLabel).join('|')}` : '';
        if (!afterClick || afterSignature !== signature) {
          // The game may open the next level-up picker without an observable closed frame.
          state.specialStages.set(match.slot, stage + 1);
          state.specialPending = null;
          setStatus(`指定技能／寶箱道具「${label}」已選擇 ${stage + 1}/${state.specialCounts[match.slot]} 次；達標後下次出現時放逐。`);
        } else {
          // Keep the first-click confirmation pending, but do not freeze automation forever.
          state.specialPending = {slot: match.slot, name: match.name, signature};
          state.specialPendingAt = Date.now();
          setStatus(`已點選「${label}」，等待選單更新後累計選擇次數。`);
        }
      } else {
        const control = findBanishControl(current.cards[match.index]);
        if (!control) {
          setStatus(`指定技能／寶箱道具「${label}」找不到卡片下方放逐按鈕，未執行放逐。`);
          return;
        }
        control.click();
        state.specialStages.set(match.slot, -1);
        state.banishedLabels.add(normalize(label));
        setStatus(`指定技能／寶箱道具「${label}」達指定次數後已送出放逐；此欄位本局不再執行。`);
        await wait(700);
      }
    } catch (error) {
      console.warn('[HANS special skill]', error);
      setStatus('指定技能／寶箱道具操作失敗，請手動處理。');
    } finally {
      state.busy = false;
      state.lastSignature = '';
      state.lastDecision = '';
      window.setTimeout(inspectPicker, 120);
    }
  }

  // The updated game stores a level-up card until the player clicks 開啟（B）.
  // Reuse the existing stopFlipEnabled/stopFlipLevel preference as the cap.
  function readPickerLevel(current) {
    const gain = document.getElementById('pk-gain')?.textContent || '';
    const sub = document.getElementById('pk-sub')?.textContent || '';
    const text = `${gain} ${sub} ${current?.picker?.textContent || ''}`;
    const match = `${gain} ${sub}`.match(/(?:\bLv\.?|等級|等级)\s*[:：]?\s*(\d{1,5})/i)
      || text.match(/(?:▲|\bLv\.?)\s*(\d{1,5})\s*[:：]?\s*(?:傷害|伤害|HP)/i);
    if (match) state.lastObservedLevel = Number(match[1]);
    return state.lastObservedLevel;
  }

  function handleSavedLevelCard() {
    if (!state.stopFlipEnabled || !state.skillEnabled) return;
    // Avoid unrelated '開啟' controls; require the nearby saved-card indicator.
    const candidates = [...document.querySelectorAll('button,[role="button"]')]
      .filter(el => visible(el) && !el.disabled && /^(?:開啟|开启)\s*[（(]\s*B\s*[）)]\s*$/i.test((el.textContent || '').trim()));
    if (candidates.length !== 1) return;
    const button = candidates[0];
    const context = button.parentElement?.parentElement?.textContent || '';
    if (!/(?:已保存|已儲存|已储存)\s*[:：]?\s*卡片\s*\d+/i.test(context)) return;
    const threshold = Math.max(1, Math.floor(Number(state.stopFlipLevel) || 1));
    // The current Lv is shown inside the level-up picker, which only appears
    // after pressing 開啟. Bootstrap once when Lv is still unknown.
    // This first card may open at/above the threshold; subsequent cards obey it.
    if (!state.lastObservedLevel) {
      if (Date.now() - state.lastOpenAt < 1800) return;
      state.lastOpenAt = Date.now();
      setStatus('尚未取得 Lv：先按「開啟」一次，等待技能畫面讀取等級。');
      button.click();
      return;
    }
    if (state.lastObservedLevel >= threshold) {
      setStatus(`Lv ${state.lastObservedLevel} 已達 ${threshold}：保留卡片，不再按「開啟」。`);
      return;
    }
    if (Date.now() - state.lastOpenAt < 1800) return;
    state.lastOpenAt = Date.now();
    setStatus(`Lv ${state.lastObservedLevel} 未達 ${threshold}：自動開啟已保存卡片。`);
    button.click();
  }

  function inspectPicker() {
    const current = getPicker();
    if (state.busy) return;
    if (state.specialPending) {
      if (!current) {
        state.specialStages.set(state.specialPending.slot, (state.specialStages.get(state.specialPending.slot) || 0) + 1);
        state.specialPending = null;
      } else {
        const pendingSignature = `${classifyPicker(current.picker)}|${document.getElementById('pk-title')?.textContent || ''}|${current.cards.map(cardLabel).join('|')}`;
        if (pendingSignature !== state.specialPending.signature) {
          state.specialStages.set(state.specialPending.slot, (state.specialStages.get(state.specialPending.slot) || 0) + 1);
          state.specialPending = null;
          state.lastSignature = '';
        } else if (Date.now() - state.specialPendingAt > 2500) {
          // Same cards still visible: do not assume the click was accepted.
          // Release the lock and retry the first selection only when cards change.
          state.specialPending = null;
          state.lastSignature = pendingSignature;
          setStatus('指定技能／寶箱道具點擊後選單未變更；暫停重複點擊，請確認遊戲是否接受選擇。');
        } else return;
      }
    }
    if (!current) {
      handleSavedLevelCard();
      state.lastSignature = '';
      state.lastDecision = '';
      state.choiceRetrySignature = '';
      state.choiceRetryCount = 0;
      state.choiceLastAt = 0;
      state.banishedLabels.clear();
      state.chestRerollCount = 0;
      return;
    }

    const kind = classifyPicker(current.picker);
    if (!kind) return;
    if (kind === 'skill') readPickerLevel(current);

    const labels = current.cards.map(cardLabel);
    const signature = `${kind}|${document.getElementById('pk-title')?.textContent || ''}|${labels.join('|')}`;
    // Only retry ordinary card selection when the same picker is still
    // visible after a reasonable confirmation window. Do not automatically
    // retry banishment, rerolls or special-skill actions.
    if (signature === state.choiceRetrySignature && state.choiceRetryCount > 0) {
      const elapsed = Date.now() - state.choiceLastAt;
      if (elapsed < 3000) return;
      if (state.choiceRetryCount >= 3) {
        setStatus('自動選擇已重試 3 次，畫面仍未更新；為避免誤點已停止重試，請手動處理。');
        return;
      }
      state.lastSignature = '';
      state.lastDecision = '';
      setStatus(`技能／道具選單仍未更新，準備重新確認並重試（${state.choiceRetryCount}/3）。`);
    } else if (signature !== state.choiceRetrySignature) {
      state.choiceRetrySignature = '';
      state.choiceRetryCount = 0;
      state.choiceLastAt = 0;
    }
    if (signature === state.lastSignature || signature === state.lastDecision) return;

    // Special skills have absolute priority over ordinary selection and keyword banish.
    {
      const match = specialMatch(current.cards);
      if (match) {
        const label = current.cards[match.index].querySelector('.pk-name')?.textContent?.trim() || labels[match.index];
        state.lastSignature = signature;
        performSpecial(kind, match, signature, label);
        return;
      }
    }

    // Keyword banish is checked first and applies to both skill and chest pickers.
    if (state.banishEnabled) {
      const banishIndex = chooseKeywordIndex(current.cards, parsePriority(state.banishKeywords));
      if (banishIndex >= 0) {
        const banishLabel = (current.cards[banishIndex].querySelector('.pk-name')?.textContent || labels[banishIndex]).trim();
        // Do not repeat the same banish forever if the game keeps the card visible.
        if (!state.banishedLabels.has(normalize(banishLabel))) {
          state.lastSignature = signature;
          performBanish(kind, banishIndex, signature, banishLabel);
          return;
        }
      }
    }

    const enabled = kind === 'skill' ? state.skillEnabled : state.chestEnabled;
    if (!enabled) return;

    const priorities = parsePriority(kind === 'skill' ? state.skillPriority : state.chestPriority);
    state.lastSignature = signature;
    let index = chooseIndex(current.cards, priorities);
    if (index < 0 && kind === 'chest' && state.chestAutoReroll && priorities.length) {
      state.lastSignature = signature;
      performChestReroll(signature);
      return;
    }
    if (index < 0 && state.firstFallback) index = 0;
    if (index < 0) {
      const typeName = kind === 'skill' ? '技能' : '寶箱道具';
      const shown = labels.map((value, i) => `${i + 1}.${(current.cards[i].querySelector('.pk-name')?.textContent || value).trim()}`)
        .join('／').slice(0, 150);
      setStatus(`${typeName}畫面已偵測；沒有符合偏好，保留手動。當前選項：${shown || '讀取不到名稱'}`);
      return;
    }

    const label = (current.cards[index].querySelector('.pk-name')?.textContent || labels[index] || `第 ${index + 1} 張`).trim();
    performChoice(kind, index, signature, label);
  }

  function mountPanel() {
    const host = document.querySelector('#hans-auto-loot-panel .hal-body');
    if (!host || state.panel) return;

    const section = document.createElement('div');
    section.id = 'hans-auto-choice-settings';
    section.className = 'hac-section';
    section.innerHTML = `
      <details class="hac-group">
        <summary>自動選擇技能／寶箱道具</summary>
        <div class="hac-content">
          <label><input type="checkbox" data-choice="stopFlipEnabled"> 自動開啟已保存的升級卡片；達指定 Lv 後不再開啟（預設關閉）</label>
          <label class="hac-field">停止自動開啟等級（Lv）
            <input type="number" min="1" max="99999" step="1" data-choice="stopFlipLevel" style="width:100%;padding:5px;background:#171b24;border:1px solid #596174;border-radius:5px;color:#fff;user-select:text">
          </label>
          <label><input type="checkbox" data-choice="skillEnabled"> 自動選擇升級技能</label>
          <label class="hac-field">技能優先順序（每行一個）
            <textarea data-choice="skillPriority" rows="3" placeholder="例如：火箭術、雷擊術、治癒術"></textarea>
          </label>
          <label><input type="checkbox" data-choice="chestEnabled"> 自動選擇寶箱道具</label>
          <label class="hac-field">寶箱道具優先順序（每行一個）
            <textarea data-choice="chestPriority" rows="3" placeholder="例如：力量戒指、敏捷披風、魔力項鍊"></textarea>
          </label>
          <label><input type="checkbox" data-choice="chestAutoReroll"> 寶箱沒有偏好道具時，自動重抽整組（不限次數）</label>
          <label><input type="checkbox" data-choice="firstFallback"> 沒有符合偏好時，選擇第一個</label>
        </div>
      </details>
      <details class="hac-group">
        <summary>自動放逐</summary>
        <div class="hac-content">
          <label><input type="checkbox" data-choice="banishEnabled"> 啟用 Keyword 自動放逐（技能＋寶箱）</label>
          <label class="hac-field">放逐關鍵字（每行一個）
            <textarea data-choice="banishKeywords" rows="3" placeholder="例如：不需要的技能、低優先技能"></textarea>
          </label>
          <div class="hac-special-body">
              <label class="hac-special-toggle"><input type="checkbox" data-choice="specialEnabled"> 啟用指定技能／寶箱道具規則</label>
              <div class="hac-special-help"><strong>📖 使用說明</strong><br>輸入完整技能或寶箱道具名稱，設定選取次數（1～999，預設 1）。<br>例如設定 200 次：選滿 200 次後，第 201 次出現時自動放逐，不再選取。<br>六格各自累計，每局重新計算。<br>指定名稱優先於 Keyword 放逐；未達次數時不會被 Keyword 放逐。技能與寶箱共用六格。</div>
              ${Array.from({length: 6}, (_, i) => `<label>指定 ${i + 1}<span style="display:flex;gap:5px;align-items:center"><input style="flex:1;min-width:0" type="text" data-special-slot="${i}" placeholder="輸入完整技能或道具名稱"><select aria-label="指定 ${i + 1} 選擇次數" data-special-count="${i}" style="width:72px;background:#171b24;color:#fff;border:1px solid #596174;border-radius:4px">${Array.from({length:999},(_,j)=>`<option value="${j+1}">${j+1} 次</option>`).join('')}</select></span></label>`).join('')}
          </div>
          <div class="hac-status">尚未啟用自動選擇／放逐。</div>
        </div>
      </details>`;

    const style = document.createElement('style');
    style.textContent = `
      #hans-auto-loot-panel .hac-group{border-top:1px solid rgba(255,255,255,.15);padding:7px 0 3px;margin-top:2px}
      #hans-auto-loot-panel .hac-group>summary{cursor:pointer;font-weight:700;color:#f2d9a8;font-size:12px;outline:none}
      #hans-auto-loot-panel .hac-special-help{border:1px solid #485363;border-radius:5px;padding:6px;color:#cbd5e1;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
      #hans-auto-loot-panel .hac-special-help strong{color:#f2d9a8}
      #hans-auto-loot-panel .hac-special-body{display:grid;gap:5px;padding:6px 0}
      #hans-auto-loot-panel .hac-special-body label{display:grid;gap:3px;font-size:11px}
      #hans-auto-loot-panel .hac-special-body label.hac-special-toggle{display:flex;align-items:center;justify-content:flex-start;gap:7px;font-size:12px;cursor:pointer;padding:0;margin:0}
      #hans-auto-loot-panel .hac-special-body label.hac-special-toggle input[type=checkbox]{flex:0 0 auto;margin:0;vertical-align:middle}
      #hans-auto-loot-panel .hac-special-body input[type=text]{width:100%;padding:4px;background:#171b24;border:1px solid #596174;border-radius:4px;color:#fff;font:12px system-ui;user-select:text}
      #hans-auto-loot-panel .hac-section{border-top:1px solid rgba(255,255,255,.15);padding-top:7px;margin-top:2px}
      #hans-auto-loot-panel .hac-content{display:grid;gap:7px;padding-top:8px}
      #hans-auto-loot-panel .hac-content>label:not(.hac-field){display:flex;align-items:center;gap:7px;cursor:pointer}
      #hans-auto-loot-panel .hac-field{display:grid;gap:4px;color:#e5d6ba;font-size:11px}
      #hans-auto-loot-panel .hac-field textarea{width:100%;resize:vertical;min-height:54px;background:#171b24;border:1px solid #596174;border-radius:5px;color:#fff;padding:6px;font:12px/1.4 system-ui,"Microsoft JhengHei",sans-serif;user-select:text}
      #hans-auto-loot-panel .hac-status{background:rgba(255,255,255,.07);border-radius:5px;padding:6px;color:#d7e5ff;font-size:11px;min-height:28px;overflow-wrap:anywhere}
      #hans-auto-loot-panel .hac-divider{width:100%;border:0;border-top:1px solid rgba(255,255,255,.15);margin:2px 0}
      #hans-auto-loot-panel .hac-content input{accent-color:#d6a74f}`;
    (document.head || document.documentElement).appendChild(style);
    host.appendChild(section);
    state.panel = section;
    state.statusEl = section.querySelector('.hac-status');

    section.querySelectorAll('[data-choice]').forEach(input => {
      const key = input.dataset.choice;
      if (input.type === 'checkbox') input.checked = !!state[key];
      else input.value = state[key] ?? '';
      const update = () => {
        state[key] = input.type === 'checkbox' ? input.checked : (input.type === 'number' ? Math.max(1, Math.floor(Number(input.value) || 1)) : input.value);
        saveSettings();
        state.lastSignature = '';
        if (state.banishEnabled) setStatus('放逐設定已儲存；等待符合關鍵字的技能／寶箱卡片。');
        else if (!state.skillEnabled && !state.chestEnabled) setStatus('尚未啟用自動選擇／放逐。');
        else setStatus('設定已儲存；等待技能或寶箱選擇畫面。');
      };
      input.addEventListener('change', update);
      if (input.tagName === 'TEXTAREA') input.addEventListener('input', update);
    });

    section.querySelectorAll('[data-special-slot]').forEach(input => {
      const slot = Number(input.dataset.specialSlot);
      input.value = state.specialSkills[slot];
      input.addEventListener('input', () => {
        state.specialSkills[slot] = input.value;
        state.specialStages.delete(slot);
        saveSettings();
        state.lastSignature = '';
      });
    });

    section.querySelectorAll('[data-special-count]').forEach(input => {
      const slot = Number(input.dataset.specialCount);
      input.value = String(state.specialCounts[slot]);
      input.addEventListener('change', () => {
        state.specialCounts[slot] = Math.min(999, Math.max(1, Number(input.value) || 1));
        saveSettings();
        state.lastSignature = '';
      });
    });

    setStatus(state.banishEnabled
      ? '放逐設定已載入；等待符合關鍵字的技能／寶箱卡片。'
      : (state.skillEnabled || state.chestEnabled
        ? '設定已載入；等待技能或寶箱選擇畫面。'
        : '尚未啟用自動選擇／放逐。'));
  }

  // A new expedition starts a fresh select-once -> banish-once lifecycle.
  // Reset on the actual result-screen "返回角色" click (manual or automatic).
  // Do not reset on picker closure: it closes many times within one run.
  function resetRunChoiceState() {
    state.specialStages.clear();
    state.specialPending = null;
    state.specialPendingAt = 0;
    state.banishedLabels.clear();
    state.lastSignature = '';
    state.lastDecision = '';
    state.choiceRetrySignature = '';
    state.choiceRetryCount = 0;
    state.choiceLastAt = 0;
    state.busy = false;
    state.chestRerollCount = 0;
    state.chestRerollLastAt = 0;
    state.stopFlipLastClickAt = 0;
    state.stopFlipHandled = false;
    state.lastObservedLevel = 0;
    state.lastOpenAt = 0;
    setStatus('本局指定技能／寶箱道具／放逐進度已重置；偏好設定保留。');
  }
  // A fresh expedition is a new run even when the prior result-screen
  // button was missed (e.g. navigation/reload). Reset only on the actual
  // departure action, not on skill-picker closure.
  document.addEventListener('click', event => {
    const button = event.target?.closest?.('button,[role="button"]');
    if (!button || !/^出發$/.test((button.textContent || '').replace(/\s+/g, ''))) return;
    const visible = button.getClientRects().length &&
      getComputedStyle(button).visibility !== 'hidden';
    if (!visible || button.disabled) return;
    resetRunChoiceState();
    setStatus('按下出發：本局技能／放逐進度重新開始。');
  }, true);
  document.addEventListener('click', event => {
    const button = event.target?.closest?.('button,[role="button"]');
    if (!button || !/(?:返回角色|回到角色)/.test((button.textContent || '').replace(/\s+/g, ''))) return;
    // Ensure this is a result screen, not a similarly named navigation button.
    const screenText = (document.body?.innerText || '');
    if (!/你死了|你活下來了|你活下來了！|你陣亡了|戰鬥結算|結算/.test(screenText)) return;
    resetRunChoiceState();
  }, true);

  loadSettings();
  Object.defineProperty(window, GLOBAL_KEY, {
    configurable: false, enumerable: false, writable: false,
    value: { inspectPicker, state }
  });

  let observerQueued = false;
  const observer = new MutationObserver(() => {
    if (observerQueued) return;
    observerQueued = true;
    window.setTimeout(() => {
      observerQueued = false;
      mountPanel();
      inspectPicker();
    }, 100);
  });
  const start = () => {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style']
    });
    mountPanel();
    window.setInterval(() => { mountPanel(); inspectPicker(); }, 250);
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();


/* ===== v0.8.4 自動選關／難度／結算循環（獨立折疊；預設關閉） ===== */
(() => {
  'use strict';
  const KEY = 'HANS_AUTO_STAGE_V084';
  const defaults = { enabled:false, stage:'夢羅克金字塔', cycle:1, loop:true,
    mob:100, damage:100, hp:100, speed:100, events:100, level:1, characterName:'', characterNames:[], discardUnfinished:false, autoClear:false, farmCycle:1, farmStage:'夢羅克金字塔', clearCycle:1, clearStage:'普隆德拉原野' };
  let cfg = {...defaults};
  try { const old=JSON.parse(localStorage.getItem(KEY)||'{}');
    for(const k of Object.keys(defaults)) if(typeof old[k]===typeof defaults[k]) cfg[k]=old[k];
  } catch (_) {}
  // Keep the user-selected automation state across game reloads.
  // On first install defaults.enabled remains false; user can pause manually.
  // Character login follows the same persisted cfg.enabled switch.
  // Expedition stage names: base labels are shared by all six cycles.
  // Cycle 2 displays ・改; cycle 3 displays ・改²; later suffixes are inferred.
  // Exclude Prontera City story stage from all cycles.
  const BASE_STAGES = ['普隆德拉原野','普隆德拉地下水道','失事輪','柏伊亞嵐島',
    '斐揚森林','斐揚洞穴','獸人村','夢羅克金字塔','迷宮森林','聖誕節','元宵燈會'];
  const CHAPTER2_STAGES=['吉芬地下迷宮','時計塔地下','深淵之湖','克雷斯特漢姆修道院','尼芙菲姆原野'];
  const chapterOf=cycle=>cycle>6?2:1;
  const roundOf=cycle=>(cycle-1)%6+1;
  const stagesFor=cycle=>chapterOf(cycle)===2?CHAPTER2_STAGES:BASE_STAGES;
  const stageForCycle=(base,cycle)=>{const round=roundOf(cycle);return base+(stagesFor(cycle).includes(base)&&round>1?'・改'+(round===2?'':round===3?'²':round===4?'³':round===5?'⁴':'⁵'):'');};
  const stripCycle=t=>String(t||'').replace(/[\s　]*[・·]\s*改(?:[²³⁴⁵]|[2-5]|\^[2-5])?\s*$/,'').trim();
  // Normalize previously saved suffixed names, so a cycle change doesn't
  // accidentally carry an old cycle's suffix into stage matching.
  cfg.stage=stripCycle(cfg.stage);
  // Preserve existing saved stage selections after the game renamed 元宵節.
  if(cfg.stage==='元宵節') cfg.stage='元宵燈會';
  if(/普隆德拉城/.test(cfg.stage))cfg.stage=BASE_STAGES[0];
  if(cfg.cycle<1||cfg.cycle>12)cfg.cycle=1;
  // Keep the saved first-chapter stage; switch to a valid stage when moving chapters.
  if(!stagesFor(cfg.cycle).includes(cfg.stage) && (BASE_STAGES.includes(cfg.stage)||CHAPTER2_STAGES.includes(cfg.stage)))cfg.stage=stagesFor(cfg.cycle)[0];
  // Independent presets: the active cycle/stage are used by the existing game automation.
  // The farm and clearance selections are saved separately and never overwrite each other.
  const savedRaw=(()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch(_){return {}}})();
  if(!Object.prototype.hasOwnProperty.call(savedRaw,'farmCycle')){
    cfg.farmCycle=cfg.autoClear?1:cfg.cycle;
    cfg.farmStage=cfg.autoClear?'夢羅克金字塔':cfg.stage;
  }
  if(!Object.prototype.hasOwnProperty.call(savedRaw,'clearCycle')){
    cfg.clearCycle=cfg.autoClear?cfg.cycle:1;
    cfg.clearStage=cfg.autoClear?cfg.stage:'普隆德拉原野';
  }
  const validCycle=n=>Number.isInteger(Number(n))&&Number(n)>=1&&Number(n)<=12?Number(n):1;
  const normalizedStage=(name,cycle)=>{
    let stage=stripCycle(name);
    if(stage==='元宵節')stage='元宵燈會';
    return stagesFor(cycle).includes(stage)?stage:stagesFor(cycle)[0];
  };
  cfg.farmCycle=validCycle(cfg.farmCycle);
  cfg.clearCycle=validCycle(cfg.clearCycle);
  cfg.farmStage=normalizedStage(cfg.farmStage,cfg.farmCycle);
  cfg.clearStage=normalizedStage(cfg.clearStage,cfg.clearCycle);
  cfg.cycle=cfg.autoClear?cfg.clearCycle:cfg.farmCycle;
  cfg.stage=cfg.autoClear?cfg.clearStage:cfg.farmStage;
  function saveActiveSelection(){
    if(cfg.autoClear){cfg.clearCycle=cfg.cycle;cfg.clearStage=cfg.stage;}
    else{cfg.farmCycle=cfg.cycle;cfg.farmStage=cfg.stage;}
  }
  function switchMode(toClear){
    saveActiveSelection();
    cfg.autoClear=!!toClear;
    cfg.cycle=toClear?cfg.clearCycle:cfg.farmCycle;
    cfg.stage=toClear?cfg.clearStage:cfg.farmStage;
    cfg.enabled=true;
    expeditionSince=0;awaitingResult=false;pendingClearStage='';
    tick._cycleClicked=0;tick._cycleClickedAt=0;
    tick._selectedStage='';tick._selectedAt=0;tick._scrollTarget='';tick._scrollCount=0;
    save();syncClearUI();
  }
  // Sequential clearance: preserve the chapter/round order and existing stage list.
  const CLEAR_TIMEOUT=30000;
  let expeditionSince=0;
  let awaitingResult=false;
  let pendingClearStage='';
  const clearIndex=()=>stagesFor(cfg.cycle).indexOf(cfg.stage);
  const clearStatus=()=>cfg.autoClear?'自動通關中：'+(chapterOf(cfg.cycle)===1?'第一章':'第二章')+roundOf(cfg.cycle)+'周目 '+cfg.stage:'自動通關已關閉';
  // When a clearance stage cannot launch, farm the immediately preceding
  // stage instead. Cross a chapter/round boundary when needed.
  function previousClearTarget(cycle,stage){
    const stages=stagesFor(cycle);
    const index=stages.indexOf(stage);
    if(index>0)return {cycle,stage:stages[index-1]};
    if(index===0&&cycle>1){
      const previousCycle=cycle-1;
      const previousStages=stagesFor(previousCycle);
      return {cycle:previousCycle,stage:previousStages[previousStages.length-1]};
    }
    // No preceding stage exists (first stage of the first round).
    return {cycle,stage};
  }
  function stopClear(reason,farmPrevious=false){
    saveActiveSelection();
    if(farmPrevious){
      const target=previousClearTarget(cfg.clearCycle,cfg.clearStage);
      cfg.farmCycle=target.cycle;
      cfg.farmStage=target.stage;
      cfg.loop=true; // fallback must continuously farm the chosen stage
    }
    cfg.autoClear=false;cfg.enabled=true;awaitingResult=false;pendingClearStage='';expeditionSince=0;
    cfg.cycle=cfg.farmCycle;cfg.stage=cfg.farmStage;
    tick._cycleClicked=0;tick._cycleClickedAt=0;
    tick._selectedStage='';tick._selectedAt=0;tick._scrollTarget='';tick._scrollCount=0;
    save();syncClearUI();
    setInfo(reason+'；已切換循環刷關：'+(chapterOf(cfg.cycle)===1?'第一章':'第二章')+roundOf(cfg.cycle)+'周目 '+cfg.stage);
  }
  function advanceClear(){
    let i=clearIndex();
    if(i<0){stopClear('指定關卡不在目前章節清單');return;}
    const stages=stagesFor(cfg.cycle);
    if(i+1<stages.length)cfg.stage=stages[i+1];
    else if(cfg.cycle<12){cfg.cycle++;cfg.stage=stagesFor(cfg.cycle)[0];}
    else{stopClear('第一章至第二章六周目全部完成');return;}
    saveActiveSelection();save();expeditionSince=0;tick._cycleClicked=0;tick._cycleClickedAt=0;
    tick._selectedStage='';tick._selectedAt=0;tick._scrollTarget='';tick._scrollCount=0;
    syncClearUI();setInfo('通關成功，下一關：'+clearStatus());
  }
  let syncClearUI=()=>{};
  const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(cfg));}catch(_){}};
  let section, info, busyUntil=0, lastStep='', entered=false, returnedAt=0;
  const labels=['敵人數量','敵人傷害','敵人 HP','敵人速度','事件數量','刷關等級'];
  const keys=['mob','damage','hp','speed','events','level'];
  const shown=e=>{if(!e||!e.isConnected)return false;const st=getComputedStyle(e);return st.display!=='none'&&st.visibility!=='hidden'&&e.getClientRects().length>0&& !e.closest('#hans-auto-loot-panel');};
  const norm=t=>String(t||'').replace(/\s+/g,'').trim();
  const text=e=>norm(e?.innerText||e?.textContent||'');
  const buttons=()=>[...document.querySelectorAll('button,[role="button"],input[type="button"]')].filter(shown);
  function btn(re,scope=document){return buttons().find(e=>scope.contains(e)&&re.test(text(e)||e.value||'')&&!e.disabled);}
  function press(e,step){if(!e||Date.now()<busyUntil)return false;busyUntil=Date.now()+1100;lastStep=step;e.click();setInfo('已執行：'+step);return true;}
  function setInfo(msg){if(info)info.textContent=msg;}
  function modalFor(re){return [...document.querySelectorAll('[role="dialog"],.modal,.overlay,.dialog,[class*="modal"],[class*="dialog"]')].filter(shown).find(e=>re.test(text(e).slice(0,250)));}
  function parentPanel(e){return e?.closest('[role="dialog"],.modal,.dialog,[class*="modal"],[class*="dialog"]')||e?.parentElement?.parentElement?.parentElement||document;}
  function setRange(el,target){
    const min=Number(el.min||0),max=Number(el.max||100),step=Number(el.step||1);
    if(!Number.isFinite(min)||!Number.isFinite(max)||max<=min)return false;
    // Game's five difficulty sliders normally store 1..20; UI shows 100%..2000%.
    let val=(max<=30 && target>30)?target/100:target;
    val=Math.min(max,Math.max(min,Math.round((val-min)/step)*step+min));
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(setter)setter.call(el,String(val));else el.value=String(val);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  }
  function applyDifficulty(root){
    const ranges=[...root.querySelectorAll('input[type="range"]')].filter(shown);
    if(ranges.length<6){setInfo('偵測到難度畫面，但找不到完整的六個滑桿，已暫停自動出發');return false;}
    // Use their on-screen order, matching the six sliders in the user's game UI.
    for(let i=0;i<6;i++)if(!setRange(ranges[i],cfg[keys[i]]))return false;
    return true;
  }
  function chooseCycle(root){
    const chapter=chapterOf(cfg.cycle),round=roundOf(cfg.cycle);
    const chapterLabel=chapter===1?'第一章':'第二章';
    const candidates=[...root.querySelectorAll('button,[role="button"]')].filter(shown);
    const chapterButton=candidates.find(e=>text(e)===chapterLabel);
    if(!chapterButton){setInfo('找不到「'+chapterLabel+'」頁籤，等待遠征畫面更新');return false;}
    // Chapter tabs precede cycle tabs. Detect which chapter is currently
    // rendered from its stage names, rather than trusting button CSS alone.
    const visibleNames=[...root.querySelectorAll('button,[role="button"],div,span')].filter(shown).map(text);
    const currentStages=stagesFor(cfg.cycle),otherStages=chapter===1?CHAPTER2_STAGES:BASE_STAGES;
    const stageVisible=visibleNames.some(t=>currentStages.some(n=>t.startsWith(n)&&t.length<n.length+65));
    const otherVisible=visibleNames.some(t=>otherStages.some(n=>t.startsWith(n)&&t.length<n.length+65));
    const chapterSelected=chapterButton.getAttribute('aria-selected')==='true'||chapterButton.getAttribute('aria-pressed')==='true'||/(?:^|\s)(?:active|selected|current)(?:\s|$)/i.test(String(chapterButton.className||''));
    if((otherVisible&&!stageVisible)||(!stageVisible&&!chapterSelected)){
      if(press(chapterButton,'切換至'+chapterLabel)){
        tick._cycleClicked=0;tick._cycleClickedAt=0;
        tick._selectedStage='';tick._selectedAt=0;
      }
      return false;
    }
    const desired=['','一周目','二周目','三周目','四周目','五周目','六周目'][round];
    const tabs=candidates.filter(e=>/^[一二三四五六]周目$/.test(text(e)));
    const match=tabs.find(e=>text(e)===desired);
    // Chapter 2 currently only exposes chapter tabs in the supplied screenshot.
    // Its first cycle is selectable without separate cycle tabs.
    if(!match){
      if(round===1)return true;
      setInfo(chapterLabel+'尚未顯示「'+desired+'」頁籤，請確認該周目已解鎖');return false;
    }
    const selected=match.getAttribute('aria-selected')==='true'||match.getAttribute('aria-pressed')==='true'||
      /(?:^|\s)(?:active|selected|current)(?:\s|$)/i.test(String(match.className||''));
    if(selected)return true;
    if(round===1&&!tabs.some(e=>e!==match&&(e.getAttribute('aria-selected')==='true'||e.getAttribute('aria-pressed')==='true'||/(?:^|\s)(?:active|selected|current)(?:\s|$)/i.test(String(e.className||'')))))return true;
    const now=Date.now();
    if(tick._cycleClicked===cfg.cycle&&now-(tick._cycleClickedAt||0)<12000)return true;
    if(press(match,'切換至'+chapterLabel+desired)){
      tick._cycleClicked=cfg.cycle;tick._cycleClickedAt=now;
      tick._selectedStage='';tick._selectedAt=0;
    }
    return false;
  }
  // Exact game structure verified in the game's own client script:
  // #slots > .slot; each occupied slot contains .slot-name and uses
  // onclick to select, ondblclick to enter. Never use visual grid indices.
  function characterCards(){
    const root=document.querySelector('#charselect');
    if(!root||!shown(root))return [];
    return [...root.querySelectorAll('#slots > .slot:not(.empty)')]
      .filter(shown).map(el=>({el,name:(el.querySelector('.slot-name')?.textContent||'').trim()}))
      .filter(c=>c.name);
  }
  let loginPhase='',loginAt=0;
  function loginTick(now){
    if(!cfg.enabled)return false;
    const cards=characterCards();
    if(cards.length){
      if(!cfg.characterName){setInfo('自動登入：請先讀取並選擇角色姓名');return true;}
      const matches=cards.filter(c=>c.name===cfg.characterName);
      if(matches.length!==1){setInfo('自動登入已停止：角色「'+cfg.characterName+'」符合 '+matches.length+' 張卡片');return true;}
      const card=matches[0].el;
      // Click the actual #slots > .slot element (not an ancestor).
      // The game handler selects the character and rebuilds #slots.
      if(!card.classList.contains('selected')){
        card.click();loginPhase='select';loginAt=now;busyUntil=now+950;
        setInfo('已點選角色「'+cfg.characterName+'」，等待遊戲確認選取');return true;
      }
      // Recheck after the game rerendered its slot elements.
      if(loginPhase!=='selected'){loginPhase='selected';loginAt=now;busyUntil=now+700;setInfo('已確認選中「'+cfg.characterName+'」，準備進入');return true;}
      if(now-loginAt<700)return true;
      // Game's native ondblclick on .slot invokes enter-selected-character.
      card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));
      loginPhase='enter';loginAt=now;busyUntil=now+3000;
      setInfo('已對「'+cfg.characterName+'」的原生角色卡觸發雙擊');return true;
    }
    loginPhase='';
    const unfinished=[...document.querySelectorAll('h1,h2,h3,h4,div,span')].find(e=>shown(e)&&/^(?:未完成的一局|尚未結束的一局)$/.test(text(e)));
    if(unfinished){
      const action=cfg.discardUnfinished?'捨棄':'繼續';
      const titleRect=unfinished.getBoundingClientRect();
      const candidates=buttons().filter(e=>!e.disabled&&text(e)===action);
      const chosen=candidates.find(e=>{
        const r=e.getBoundingClientRect();
        return r.top>=titleRect.top && r.top-titleRect.top<360 &&
          Math.abs(r.left-titleRect.left)<Math.max(520,window.innerWidth*.8);
      });
      if(chosen){press(chosen,'未完成的一局：'+action);return true;}
      setInfo('未完成的一局：等待「'+action+'」按鈕');
      return true;
    }
    // Avoid clicking unrelated start buttons: only operate on splash screen.
    const splash=document.querySelector('#splash');
    if(splash&&shown(splash)){
      const start=[...splash.querySelectorAll('button,[role="button"],input[type="button"]')].find(e=>shown(e)&&!e.disabled&&/^(?:進入遊戲[!！]?|開始遊戲[!！]?|繼續)$/.test(text(e)||norm(e.value)));
      if(start){press(start,'登入入口：開始遊戲');return true;}
    }
    return false;
  }
  function tick(){
    if(!section)return;
    const now=Date.now();if(now<busyUntil)return;
    if(loginTick(now))return;
    if(!cfg.enabled)return;
    const b=buttons();
    // Final-stage story prompt appears BEFORE the result screen. Only accept
    // when its unique title and body belong to the same visible container.
    const storyTitle=[...document.querySelectorAll('h1,h2,h3,h4,header,div,span,strong')]
      .find(e=>shown(e)&&text(e)==='未完待續……'&&e.getBoundingClientRect().width<600);
    if(storyTitle){
      const accept=b.find(e=>/^(?:✓|✔|\u2713)?接受$/.test(text(e)));
      if(accept){
        let ancestor=accept.parentElement, matched=false;
        for(let depth=0;ancestor&&depth<9&&ancestor!==document.body;depth++,ancestor=ancestor.parentElement){
          if(ancestor.contains(storyTitle)&&text(ancestor).includes('未完待續')&&text(ancestor).length<1800){matched=true;break;}
        }
        if(matched){press(accept,'最終關劇情提示：接受');return;}
      }
      setInfo('偵測到最終關劇情提示，但尚未定位「接受」按鈕');
      return;
    }
    // Both modes use the SAME result-screen return flow. Only auto-clear
    // changes the next target after a confirmed successful expedition.
    const back=b.find(e=>/(?:返回角色|回到角色)/.test(text(e)));
    if(back){
      let advanceAfterReturn=false;
      if(cfg.autoClear){
        const resultRoot=parentPanel(back);
        // The game's actual result screen may say "你活下來了！" rather
        // than the generic "勝利/通關成功" labels.
        const resultText=text(resultRoot).slice(0,4000);
        const won=/(?:你活下來了|通關成功|挑戰成功|勝利|通關完成|關卡完成|遠征成功|VICTORY|STAGE\s*CLEAR)/i.test(resultText);
        const lost=/(?:你死了|你陣亡了|挑戰失敗|通關失敗|戰敗|死亡|陣亡|GAME\s*OVER|DEFEAT)/i.test(resultText);
        if(won&&!lost){advanceAfterReturn=true;setInfo('本關已完成，返回角色後將前往下一關');}
        else if(lost){setInfo('本關失敗，返回角色後重試原關卡');}
        else{setInfo('結算結果尚未辨識；先返回角色，不跳過目前關卡');}
      }
      if(!cfg.loop&&!cfg.autoClear&&entered){cfg.enabled=false;save();setInfo('單次模式：本場結束，已停止');return;}
      if(press(back,'結算返回角色')){
        returnedAt=now;entered=false;busyUntil=now+3500;
        if(cfg.autoClear&&advanceAfterReturn)advanceClear();
      }
      return;
    }
    // Select the renamed offline lobby button; never join an online lobby.
    const offline=b.find(e=>/^離線玩$/.test(text(e)));
    if(offline){press(offline,'選擇離線玩');busyUntil=now+2800;return;}
    // Handle the high-difficulty warning by anchoring on its visible title.
    // The footer button may be outside the title's inner panel, and the
    // label can include a checkmark or non-breaking spaces.
    const warningTitles=[...document.querySelectorAll('h1,h2,h3,h4,header,div,span,strong')]
      .filter(e=>shown(e)&&text(e)==='高難度提醒'&&e.getBoundingClientRect().width<650);
    if(warningTitles.length){
      // Use the smallest visible title node so nested containers do not
      // confuse the dialog position. Keep checking until it actually closes.
      const title=warningTitles.sort((a,b)=>a.getBoundingClientRect().width-b.getBoundingClientRect().width)[0];
      const titleRect=title.getBoundingClientRect();
      const matched=b.filter(e=>{
        if(e.disabled || !/(?:^|[✓✔√])入場$/.test(text(e)))return false;
        const r=e.getBoundingClientRect();
        return r.top>=titleRect.top && r.top-titleRect.top<550 &&
          Math.abs(r.left-titleRect.left)<Math.max(600,window.innerWidth*.8);
      }).sort((x,y)=>Math.abs(x.getBoundingClientRect().top-titleRect.bottom)-Math.abs(y.getBoundingClientRect().top-titleRect.bottom));
      if(matched.length){
        if(press(matched[0],'高難度提醒：確認入場（若視窗未關閉將重試）')){
          // Do not mark the stage entered until the warning disappears.
          busyUntil=Date.now()+1600;
        }
      }else{
        setInfo('高難度提醒仍在畫面上：等待可點擊的「入場」按鈕');
      }
      return;
    }
    // Difficulty window: set sliders first, only then depart.
    const go=b.find(e=>/前往野外/.test(text(e)));
    if(go){const root=parentPanel(go);if(!applyDifficulty(root))return;
      if(press(go,'設定六項難度並前往野外')){entered=true;expeditionSince=0;busyUntil=now+650;}return;}
    // Expedition: select the actual left-hand stage row, scrolling the list if needed.
    const depart=b.find(e=>/^出發$/.test(text(e)));
    if(depart){
      if(cfg.autoClear){if(!expeditionSince)expeditionSince=now; if(now-expeditionSince>=CLEAR_TIMEOUT){stopClear('遠征畫面停留超過30秒，可能尚未解鎖或無法進入',true);return;}}
      const target=norm(stageForCycle(cfg.stage,cfg.cycle));
      if(!target){setInfo('請先選擇指定關卡');return;}
      let root=depart.parentElement;
      for(let i=0;i<9 && root?.parentElement;i++){
        if(text(root).includes('遠征') && root.getBoundingClientRect().width>500)break;
        root=root.parentElement;
      }
      root=root||document;
      if(!chooseCycle(root))return;
      const rr=root.getBoundingClientRect();
      const split=rr.left+rr.width*.43;
      // The right-hand banner often wraps the stage name with MVP/level text.
      // Match a small leaf element, not the entire expedition dialog.
      const titleNodes=[...root.querySelectorAll('div,span,b,strong,h1,h2,h3,h4,p')].filter(e=>{
        if(!shown(e))return false;
        const t=text(e), r=e.getBoundingClientRect();
        return (t===target || (t.startsWith(target)&&t.length<target.length+65)) &&
          r.width>0 && r.width<Math.max(470,rr.width*.65) && r.height<160;
      });
      const rightSelected=titleNodes.some(e=>{
        const r=e.getBoundingClientRect();
        return r.left>=split && r.right<=rr.right+5;
      });
      const leftTitle=[...root.querySelectorAll('div,span,b,strong,button')].filter(shown).find(e=>{
        const r=e.getBoundingClientRect(),t=text(e);
        return r.left<split && r.width>0 && r.width<350 && r.height<85 &&
          (t===target || (t.startsWith(target)&&t.length<target.length+12));
      });
      // When we have just clicked this exact stage, let React render the
      // selected right-hand banner before clicking Depart. If the banner text
      // is canvas-rendered, fall back to the last clicked stage after 1.4s.
      const recentSelection=tick._selectedStage===target &&
        now-(tick._selectedAt||0)>1400 && now-(tick._selectedAt||0)<30000;
      // Seasonal / special stages can render the title in a different
      // element than regular stages. Verify the left row's selected state
      // and its exact label instead of requiring the banner text layout.
      const stageRows=[...root.querySelectorAll('button,[role="button"],div,li')].filter(e=>{
        if(!shown(e))return false;
        const r=e.getBoundingClientRect();
        return r.left<split && r.width>=130 && r.width<rr.width*.55 &&
          r.height>=40 && r.height<190 && text(e).startsWith(target);
      });
      const selectedRow=stageRows.some(e=>{
        const r=e.getBoundingClientRect();
        if(text(e).length>target.length+90)return false;
        return e.getAttribute('aria-selected')==='true' ||
          e.getAttribute('aria-current')==='true' ||
          /(?:^|\s)(?:selected|active|current)(?:\s|$)/i.test(String(e.className||''));
      });
      // A special-event stage can show its selected title in a large banner
      // instead of a small leaf node. Match the banner's displayed stage name
      // and require its position to be on the right half of the dialog.
      const rightBanner=[...root.querySelectorAll('div,span,strong,b')].some(e=>{
        if(!shown(e))return false;
        const r=e.getBoundingClientRect(),t=text(e);
        if(r.left<split||r.right>rr.right+8||r.width<40||r.width>rr.width*.68)return false;
        return t===target || (t.startsWith(target) && t.length<target.length+140);
      });
      // Do not click Depart on a guessed selection: the game must display
      // the desired stage on the right, or we must have just clicked its row.
      if(rightSelected || rightBanner || recentSelection || selectedRow){
        if(press(depart,'已確認關卡 '+stageForCycle(cfg.stage,cfg.cycle)+'，點擊出發')){
          tick._selectedAt=0;
          tick._selectedStage='';
        }
        return;
      }
      if(leftTitle){
        let row=leftTitle;
        for(let i=0;i<6 && row.parentElement;i++){
          const p=row.parentElement, r=p.getBoundingClientRect();
          if(r.width>140 && r.width<rr.width*.55 && r.height>=45 && r.height<180){row=p;break;}
          row=p;
        }
        if(press(row,'點選左側關卡：'+cfg.stage)){
          tick._selectedStage=target;
          tick._selectedAt=now;
          return;
        }
      }
      // Scroll the LEFT stage list, never the right-hand details or the entire page.
      const scrollers=[...root.querySelectorAll('*')].filter(e=>{
        const r=e.getBoundingClientRect();
        if(r.left>=split||r.width<170||r.width>rr.width*.53||r.height<160)return false;
        return e.scrollHeight>e.clientHeight+30 && getComputedStyle(e).overflowY!=='hidden';
      }).sort((x,y)=>x.getBoundingClientRect().width-y.getBoundingClientRect().width);
      const sc=scrollers[0];
      if(sc){
        const key=target;
        if(tick._scrollTarget!==key){tick._scrollTarget=key;tick._scrollCount=0;sc.scrollTop=0;}
        else if((tick._scrollCount||0)>0){sc.scrollTop+=Math.max(100,sc.clientHeight*.65);}
        tick._scrollCount=(tick._scrollCount||0)+1;
        busyUntil=now+650;
        if(tick._scrollCount>25){setInfo('已搜尋關卡清單仍找不到「'+cfg.stage+'」，請確認是否解鎖');return;}
        setInfo('正在捲動左側關卡清單尋找：'+cfg.stage+'（'+tick._scrollCount+'）');
        return;
      }
      setInfo('出發等待確認：指定「'+target+'」；右側辨識='+(rightBanner?'是':'否')+'，左側辨識='+(leftTitle?'是':'否')+'，周目='+cfg.cycle+'。請回報此文字');
      return;
    }
    if(cfg.autoClear)expeditionSince=0;
    // Main city: only use Space when the renamed ship captain prompt is visible.
    if(now-returnedAt<3000)return;
    const prompt=[...document.querySelectorAll('button,span,div')].filter(shown).find(e=>{
      const t=text(e);return t.length<90&&/與船長交談|和船長說話|跟船長說話|船長/.test(t);
    });
    if(prompt){
      // Synthetic keyboard events may be rejected by game code; do not spam.
      busyUntil=now+2500;
      for(const type of ['keydown','keyup'])document.dispatchEvent(new KeyboardEvent(type,{key:' ',code:'Space',keyCode:32,which:32,bubbles:true,cancelable:true}));
      setInfo('嘗試與船長交談（Space）；若無反應需改用遊戲內部互動接口');
      return;
    }
    setInfo('等待主城船長提示／關卡視窗／結算畫面…');
  }
  function mount(){
    const host=document.querySelector('#hans-auto-loot-panel .hal-body');if(!host||section)return;
    section=document.createElement('details');section.className='hac-group';section.id='hans-auto-stage-v084';
    section.innerHTML=`<summary>自動選關與通關設定</summary><div class="has-body">
      <div class="has-subtitle">自動登入角色（跟隨自動選關開關）</div>
      <label>指定登入角色<select data-auto="characterName"><option value="">請先讀取角色姓名</option></select></label>
      <button type="button" data-read-characters>重新讀取角色姓名</button>
      <details class="has-mode-fold" id="has-farm-fold"><summary>🗺️ 循環刷關（固定關卡循環）</summary><div class="has-mode-body">
      <button type="button" class="has-stage-toggle off" data-stage-toggle aria-pressed="false">已暫停</button>
      <label>刷關章節／周目<select data-auto="cycle"><option value="1">第一章一周目</option><option value="2">第一章二周目</option><option value="3">第一章三周目</option><option value="4">第一章四周目</option><option value="5">第一章五周目</option><option value="6">第一章六周目</option><option value="7">第二章一周目</option><option value="8">第二章二周目</option><option value="9">第二章三周目</option><option value="10">第二章四周目</option><option value="11">第二章五周目</option><option value="12">第二章六周目</option></select></label>
      <label>刷關指定關卡<select data-auto="stage"></select></label>
      <label data-custom-stage-wrap style="display:none">自訂關卡名稱<input data-custom-stage type="text" placeholder="輸入該周目的完整關卡名稱"></label>
      <label><input type="checkbox" data-auto="loop"> 死亡／通關後持續循環</label>
      </div></details>
      <details class="has-mode-fold" id="has-clear-fold"><summary>🏁 自動通關（逐關推進）</summary><div class="has-mode-body">
      <button type="button" class="has-stage-toggle off" data-clear-toggle aria-pressed="false">已暫停</button>
      <label>通關起始章節／周目<select data-clear-cycle></select></label>
      <label>通關起始指定關卡<select data-clear-stage></select></label>
      <p class="hal-note">從指定關卡開始依序通關至第二章六周目；遠征畫面停留30秒無法繼續時，自動關閉通關並切換到上一關循環刷關。兩種模式不會同時執行。</p>
      </div></details>
      <label><input type="checkbox" id="hans-auto-battle-2x"> 進入關卡自動切換 2x 速度</label>
      <div class="has-subtitle">六項難度（100%～2000%，等級 1～20）</div>
      ${keys.map((k,i)=>`<label>${labels[i]}<input type="number" data-auto="${k}" min="${i===5?1:100}" max="${i===5?20:2000}" step="${i===5?1:100}"></label>`).join('')}
      <div class="has-actions"><button type="button" data-preset="min">全部最低</button><button type="button" data-preset="max">全部最高</button></div>
      <div class="has-status">未啟用；等待設定。</div>
      <p class="hal-note">只在畫面符合時操作；離線玩為唯一自動大廳選項。若找不到關卡或滑桿，會停止該步驟，避免誤點。此功能需遊戲內測試。</p>
      <label><input type="checkbox" data-auto="discardUnfinished"> 未完成的一局：勾選「捨棄」，未勾選「繼續」</label>
    </div>`;
    const css=document.createElement('style');css.textContent=`
      #hans-auto-stage-v084{border-top:1px solid rgba(255,255,255,.18);padding-top:8px}
      #hans-auto-stage-v084>summary{cursor:pointer;font-size:12px;font-weight:700;color:#f2d9a8}
      #hans-auto-stage-v084 .has-body{display:grid;gap:8px;padding-top:8px}
      #hans-auto-stage-v084 .has-mode-fold{border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:7px;background:rgba(255,255,255,.035)}
      #hans-auto-stage-v084 .has-mode-fold>summary{cursor:pointer;font-size:12px;font-weight:700;color:#f2d9a8;list-style:revert}
      #hans-auto-stage-v084 .has-mode-body{display:grid;gap:8px;padding-top:9px}
      #hans-auto-stage-v084 .has-mode-body>label{display:grid;gap:3px;font-size:11px}
      #hans-auto-stage-v084 .has-mode-body>label:has(input[type=checkbox]){display:flex;align-items:center;gap:6px}
      #hans-auto-stage-v084 .has-stage-toggle{width:100%;background:#8b4646;color:#fff;font-weight:700;padding:7px 9px}
      #hans-auto-stage-v084 .has-stage-toggle:not(.off){background:#347b50}
      #hans-auto-stage-v084 .has-body>label{display:grid;gap:3px;font-size:11px}
      #hans-auto-stage-v084 .has-body>label:has(input[type=checkbox]){display:flex;align-items:center;gap:6px}
      #hans-auto-stage-v084 input:not([type=checkbox]),#hans-auto-stage-v084 select{width:100%;background:#171b24;color:#fff;border:1px solid #596174;border-radius:5px;padding:5px;font:12px system-ui;user-select:text}
      #hans-auto-stage-v084 .has-subtitle{font-weight:700;font-size:11px;color:#e5d6ba}
      #hans-auto-stage-v084 .has-actions{display:flex;gap:5px}
      #hans-auto-stage-v084 .has-actions button{flex:1;background:#475a78;font-size:11px}
      #hans-auto-stage-v084 .has-status{background:rgba(255,255,255,.07);border-radius:5px;padding:6px;font-size:11px;color:#d7e5ff;overflow-wrap:anywhere}`;
    (document.head||document.documentElement).appendChild(css);host.appendChild(section);
    info=section.querySelector('.has-status');
    const characterSelect=section.querySelector('[data-auto="characterName"]');
    function readCharacterNames(){
      const cards=characterCards(),names=[...new Set(cards.map(c=>c.name))];
      // Cache discovered names across page reloads and between character screens.
      // Do not clear the cache merely because the character screen is hidden.
      if(names.length){cfg.characterNames=names;save();}
      const displayNames=names.length?names:(Array.isArray(cfg.characterNames)?cfg.characterNames:[]);
      characterSelect.replaceChildren();
      const blank=document.createElement('option');blank.value='';blank.textContent='請選擇角色';characterSelect.appendChild(blank);
      for(const name of displayNames){const opt=document.createElement('option');opt.value=name;opt.textContent=name;characterSelect.appendChild(opt);}
      if(cfg.characterName&&!displayNames.includes(cfg.characterName)){const opt=document.createElement('option');opt.value=cfg.characterName;opt.textContent=cfg.characterName+'（目前未顯示）';characterSelect.appendChild(opt);}
      characterSelect.value=cfg.characterName;
      setInfo(names.length?'已讀取並記憶角色：'+names.join('、'):(displayNames.length?'已載入已記憶角色：'+displayNames.join('、'):'未偵測到角色卡，請先進入角色選擇畫面'));
    }
    section.querySelector('[data-read-characters]').addEventListener('click',readCharacterNames);
    const stageSelect=section.querySelector('[data-auto="stage"]');
    const cycleSelect=section.querySelector('[data-auto="cycle"]');
    const customWrap=section.querySelector('[data-custom-stage-wrap]');
    const customInput=section.querySelector('[data-custom-stage]');
    const clearCycleSelect=section.querySelector('[data-clear-cycle]');
    const clearStageSelect=section.querySelector('[data-clear-stage]');
    const stageToggle=section.querySelector('[data-stage-toggle]');
    const clearToggle=section.querySelector('[data-clear-toggle]');
    const cycles=[...cycleSelect.options].map(o=>({value:o.value,label:o.textContent}));
    for(const entry of cycles){const o=document.createElement('option');o.value=entry.value;o.textContent=entry.label;clearCycleSelect.appendChild(o);}
    function fillStages(select,cycle,selected,allowCustom){
      select.replaceChildren();
      for(const base of stagesFor(cycle)){
        const opt=document.createElement('option');opt.value=base;
        opt.textContent=stageForCycle(base,cycle);select.appendChild(opt);
      }
      if(allowCustom){const other=document.createElement('option');other.value='__custom__';other.textContent='其他關卡（手動輸入）';select.appendChild(other);}
      select.value=allowCustom&&!stagesFor(cycle).includes(selected)?'__custom__':selected;
    }
    function syncStageSelection(){
      fillStages(stageSelect,cfg.farmCycle,cfg.farmStage,true);
      const custom=!stagesFor(cfg.farmCycle).includes(cfg.farmStage);
      customWrap.style.display=custom?'grid':'none';customInput.value=custom?cfg.farmStage:'';
      cycleSelect.value=String(cfg.farmCycle);
      clearCycleSelect.value=String(cfg.clearCycle);
      fillStages(clearStageSelect,cfg.clearCycle,cfg.clearStage,false);
    }
    const updateStageToggle=()=>{
      const farmOn=cfg.enabled&&!cfg.autoClear,clearOn=cfg.enabled&&cfg.autoClear;
      stageToggle.textContent=farmOn?'已啟用':'已暫停';
      stageToggle.classList.toggle('off',!farmOn);
      stageToggle.setAttribute('aria-pressed',String(farmOn));
      clearToggle.textContent=clearOn?'已啟用':'已暫停';
      clearToggle.classList.toggle('off',!clearOn);
      clearToggle.setAttribute('aria-pressed',String(clearOn));
    };
    syncClearUI=()=>{syncStageSelection();updateStageToggle();};
    syncClearUI();readCharacterNames();
    function resetAfterChange(){busyUntil=0;tick._cycleClicked=0;tick._cycleClickedAt=0;tick._selectedStage='';tick._selectedAt=0;tick._scrollTarget='';tick._scrollCount=0;}
    stageToggle.addEventListener('click',()=>{
      if(cfg.enabled&&!cfg.autoClear){cfg.enabled=false;save();}
      else switchMode(false);
      resetAfterChange();syncClearUI();setInfo(cfg.enabled?'循環刷關已啟用':'循環刷關已暫停');
    });
    clearToggle.addEventListener('click',()=>{
      if(cfg.enabled&&cfg.autoClear){saveActiveSelection();cfg.enabled=false;cfg.autoClear=false;cfg.cycle=cfg.farmCycle;cfg.stage=cfg.farmStage;save();}
      else switchMode(true);
      resetAfterChange();syncClearUI();setInfo(cfg.enabled?'自動通關已啟用：'+clearStatus():'自動通關已暫停');
    });
    cycleSelect.addEventListener('change',()=>{
      cfg.farmCycle=Number(cycleSelect.value);
      cfg.farmStage=normalizedStage(cfg.farmStage,cfg.farmCycle);
      if(!cfg.autoClear){cfg.cycle=cfg.farmCycle;cfg.stage=cfg.farmStage;}
      save();resetAfterChange();syncClearUI();setInfo('已設定刷關章節／周目');
    });
    stageSelect.addEventListener('change',()=>{
      cfg.farmStage=stageSelect.value==='__custom__'?customInput.value.trim():stageSelect.value;
      if(!cfg.autoClear)cfg.stage=cfg.farmStage;
      save();resetAfterChange();syncClearUI();setInfo('已設定刷關關卡：'+cfg.farmStage);
    });
    customInput.addEventListener('change',()=>{
      cfg.farmStage=customInput.value.trim();if(!cfg.autoClear)cfg.stage=cfg.farmStage;
      save();resetAfterChange();setInfo('自訂刷關關卡已儲存：'+cfg.farmStage);
    });
    clearCycleSelect.addEventListener('change',()=>{
      cfg.clearCycle=Number(clearCycleSelect.value);
      cfg.clearStage=normalizedStage(cfg.clearStage,cfg.clearCycle);
      if(cfg.autoClear){cfg.cycle=cfg.clearCycle;cfg.stage=cfg.clearStage;expeditionSince=0;}
      save();resetAfterChange();syncClearUI();setInfo('已設定通關起始周目');
    });
    clearStageSelect.addEventListener('change',()=>{
      cfg.clearStage=clearStageSelect.value;
      if(cfg.autoClear){cfg.stage=cfg.clearStage;expeditionSince=0;}
      save();resetAfterChange();syncClearUI();setInfo('已設定通關起始關卡：'+cfg.clearStage);
    });
    section.querySelectorAll('[data-auto]').forEach(el=>{
      const k=el.dataset.auto;
      if(k==='cycle'||k==='stage')return;
      if(el.type==='checkbox')el.checked=cfg[k];else el.value=cfg[k];
      el.addEventListener('change',()=>{
        cfg[k]=el.type==='checkbox'?el.checked:(typeof defaults[k]==='number'?Number(el.value):el.value);
        save();resetAfterChange();setInfo('設定已儲存');
      });
    });
    section.querySelectorAll('[data-preset]').forEach(el=>el.addEventListener('click',()=>{
      const max=el.dataset.preset==='max';keys.forEach((k,i)=>{cfg[k]=max?(i===5?20:2000):(i===5?1:100);section.querySelector(`[data-auto="${k}"]`).value=cfg[k];});save();setInfo(max?'六項難度已設為最大':'六項難度已設為最低');}));
  }
  setInterval(()=>{mount();try{tick();}catch(e){setInfo('自動選關例外：'+String(e.message||e).slice(0,90));}},500);
})();


/* ===== 戰鬥 HUD 倍速按鈕：每場自動由 1x 點擊一次 ===== */
(() => {
  'use strict';
  const SPEED_KEY = 'HANS_AUTO_BATTLE_2X_ENABLED';
  let speedEnabled = localStorage.getItem(SPEED_KEY) !== 'false';
  let clickedThisBattle = false;
  setInterval(() => {
    const toggle = document.getElementById('hans-auto-battle-2x');
    if (!toggle || toggle.dataset.boundSpeedToggle) return;
    toggle.dataset.boundSpeedToggle = '1';
    toggle.checked = speedEnabled;
    toggle.addEventListener('change', () => {
      speedEnabled = toggle.checked;
      try { localStorage.setItem(SPEED_KEY, String(speedEnabled)); } catch (_) {}
    });
  }, 500);
  let missingTicks = 0;
  let lastClick = 0;
  setInterval(() => {
    const candidates = [...document.querySelectorAll('button,[role="button"]')].filter(el => {
      if (!el.isConnected || !el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || el.disabled) return false;
      return /^1\s*[x×]$/i.test((el.innerText || el.textContent || '').trim());
    });
    // Reset only after the battle HUD has disappeared for a while.
    if (!candidates.length) {
      if (++missingTicks >= 8) clickedThisBattle = false;
      return;
    }
    missingTicks = 0;
    if (!speedEnabled || clickedThisBattle || Date.now() - lastClick < 1500) return;
    const btn = candidates.find(el => {
      const r = el.getBoundingClientRect();
      // The 1x control is beside the timer at the top of the battle HUD.
      const nearTop = r.top < Math.min(window.innerHeight * .30, 180);
      const nearTimer = [...document.querySelectorAll('div,span')].some(t => {
        if (!t.getClientRects().length) return false;
        const text = (t.innerText || '').trim();
        if (!/^\d{1,2}:\d{2}$/.test(text)) return false;
        const tr = t.getBoundingClientRect();
        return Math.abs(tr.top-r.top) < 35 && tr.left < r.left && r.left-tr.right < 160;
      });
      return nearTop && nearTimer;
    });
    if (!btn) return;
    clickedThisBattle = true;
    lastClick = Date.now();
    btn.click();
  }, 500);
})();
/* ===== v0.8.5 介面整理層：僅搬移既有控制項，不更動自動化邏輯 ===== */
(() => {
  'use strict';
  function organize() {
    const panel = document.getElementById('hans-auto-loot-panel');
    const host = panel?.querySelector('.hal-body');
    if (!host || host.dataset.uiV085 === 'ready') return;
    // 等待所有原版模組掛載，避免模組在初始化時找不到既有節點。
    const choice = host.querySelector('#hans-auto-choice-settings');
    const stage = host.querySelector('#hans-auto-stage-v084');
    const reroll = host.querySelector('#hans-reroll-unlimited-panel');
    if (!choice || !stage || !reroll) return;
    // Start with the entire panel collapsed; users can expand it manually.
    // All five category groups are also initially collapsed when expanded.
    panel.classList.add('collapsed');
    const collapseButton = panel.querySelector('.hal-collapse');
    if (collapseButton) collapseButton.textContent = '+';
    const pickup = document.createElement('details');
    pickup.className = 'hal-v085-group';
    pickup.open = false;
    pickup.innerHTML = '<summary>📦 掉落物與自動吸取</summary><div class="hal-v085-inner"></div>';
    const inner = pickup.querySelector('.hal-v085-inner');
    const toggle = host.querySelector(':scope > .hal-toggle');
    if (toggle) inner.appendChild(toggle);
    for (const el of [...host.children]) {
      if (el.matches('label:has([data-setting]), .hal-status, .hal-note')) inner.appendChild(el);
    }
    host.insertBefore(pickup, host.firstChild);

    const rerollGroup = document.createElement('details');
    rerollGroup.className = 'hal-v085-group';
    rerollGroup.innerHTML = '<summary>🎁 寶箱重抽設定</summary><div class="hal-v085-inner"></div>';
    rerollGroup.querySelector('.hal-v085-inner').appendChild(reroll);
    // 將較少使用的寶箱重抽設定固定放在所有主要設定之後。
    host.appendChild(rerollGroup);

    // 原有技能、放逐兩組已經是 details；只做標題統一與版面壓縮。
    const details = choice.querySelectorAll(':scope > details');
    if (details[0]) details[0].querySelector('summary').textContent = '⚔️ 技能與寶箱道具選擇';
    if (details[1]) details[1].querySelector('summary').textContent = '🚫 技能放逐規則';
    stage.querySelector(':scope > summary').textContent = '🗺️ 自動選關、難度與循環';
    // 初次載入時全部收合；之後不干涉使用者手動展開的狀態。
    host.querySelectorAll('details.hal-v085-group, details.hac-group').forEach(group => { group.open = false; });
    host.dataset.uiV085 = 'ready';
  }
  const css = document.createElement('style');
  css.textContent = `
    #hans-auto-loot-panel{width:320px;max-width:calc(100vw - 24px);max-height:min(78vh, 760px);display:flex;flex-direction:column;overflow:hidden}
    #hans-auto-loot-panel .hal-body{gap:2px;padding:7px 10px 10px;min-height:0;flex:1 1 auto;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#b99a5c #252a35}
    #hans-auto-loot-panel .hal-v085-group{border-top:1px solid rgba(255,255,255,.16);padding:7px 0 3px}
    #hans-auto-loot-panel .hal-v085-group>summary{cursor:pointer;font-weight:700;color:#f2d9a8;font-size:12px}
    #hans-auto-loot-panel .hal-v085-inner{display:grid;gap:7px;padding:8px 0 3px}
    #hans-auto-loot-panel .hal-v085-inner>label{display:flex;align-items:center;gap:7px;font-size:12px}
    #hans-auto-loot-panel details:not([open])>div{display:none}
    #hans-auto-loot-panel textarea{max-height:90px}
    #hans-auto-loot-panel .hal-note{font-size:10px;line-height:1.4}
    #hans-auto-loot-panel .hac-content,#hans-auto-loot-panel .has-body{gap:6px}
    #hans-auto-loot-panel .hru-section{border-top:0;margin:0;padding:0}
    #hans-auto-loot-panel .hac-section{border-top:0;padding-top:0;margin:0}
    #hans-auto-loot-panel #hans-auto-stage-v084{margin-top:2px}
  `;
  (document.head || document.documentElement).appendChild(css);
  // Keep mouse-wheel scrolling inside the settings panel instead of letting
  // the game canvas / document consume the wheel input.
  function protectPanelWheel() {
    const panel = document.getElementById('hans-auto-loot-panel');
    if (!panel || panel.dataset.wheelV085Fixed) return;
    panel.dataset.wheelV085Fixed = '1';
    panel.addEventListener('wheel', event => {
      if (panel.classList.contains('collapsed')) return;
      const body = panel.querySelector('.hal-body');
      if (!body || body.scrollHeight <= body.clientHeight) return;
      const target = event.target;
      if (target instanceof Element && target.closest('select')) return;
      const factor = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? body.clientHeight : 1;
      body.scrollTop += event.deltaY * factor;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, {capture:true, passive:false});
  }
  protectPanelWheel();
  const wheelTimer = setInterval(protectPanelWheel, 700);
  setTimeout(() => clearInterval(wheelTimer), 120000);
  const timer = setInterval(organize, 600);
  setTimeout(() => clearInterval(timer), 120000);
})();

/* ===== v0.8.5.3 遊戲新版本提示：自動點擊「重新整理」 ===== */
(() => {
  'use strict';
  let lastClickAt = 0;
  function checkGameUpdate() {
    const now = Date.now();
    if (now - lastClickAt < 15000) return;
    const visible = el => {
      if (!el || !el.isConnected || el.closest('#hans-auto-loot-panel')) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    // The update modal has a distinctive title, message, and refresh button.
    // Require all three within the same small container to avoid unrelated clicks.
    const titles = [...document.querySelectorAll('h1,h2,h3,h4,header,.title,strong,div,span')]
      .filter(el => visible(el) && (el.textContent || '').trim() === '新版本');
    for (const title of titles) {
      let root = title.parentElement;
      for (let i = 0; root && i < 7 && root !== document.body; i++, root = root.parentElement) {
        if (!visible(root)) continue;
        const content = (root.innerText || '').replace(/\s+/g, '');
        if (!/(?:遊戲有新版本|遊戲已推出新版本)/.test(content) || !/(?:重新整理頁面即可取得|請重新整理頁面)/.test(content)) continue;
        if (content.length > 700) continue;
        const refresh = [...root.querySelectorAll('button,[role="button"]')]
          .find(el => visible(el) && !el.disabled && (el.innerText || el.textContent || '').trim() === '重新整理');
        if (!refresh) continue;
        lastClickAt = now;
        refresh.click();
        return;
      }
    }
  }
  setInterval(() => { try { checkGameUpdate(); } catch (_) {} }, 800);
})();
