/**
 * PolyFactory — MCW Apps Bridge auto-connect
 *
 * Активируется ТОЛЬКО когда:
 *   1. URL содержит ?walletBridge=swaponline
 *   2. Страница открыта в iframe (window.parent !== window)
 *
 * Загружает bridge-клиент с swaponline.github.io, ждёт handshake,
 * диспетчит CustomEvent "wcAccountChanged" — тот же event что слушает app.js.
 * wallet-init.js пропускает AppKit если window.__bridgeActive === true.
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  if (params.get('walletBridge') !== 'swaponline' || window.parent === window) {
    return;
  }

  window.__bridgeActive = true;
  console.log('[PolyFactory] Bridge mode: loading MCW bridge client');

  var BRIDGE_CLIENT_URL = 'https://appsource.github.io/wallet/wallet-apps-bridge-client.js';

  function setupBridgeListeners() {
    if (!window.ethereum || !window.ethereum.isSwapWalletAppsBridge) {
      console.warn('[PolyFactory Bridge] Provider not found after script load');
      window.__bridgeActive = false;
      return;
    }

    // accountsChanged вызывается bridge-client при BRIDGE_READY (если есть аккаунты)
    // и при последующих изменениях (disconnect, account switch)
    window.ethereum.on('accountsChanged', function (accounts) {
      document.dispatchEvent(new CustomEvent('wcAccountChanged', {
        detail: {
          address: accounts && accounts.length > 0 ? accounts[0] : null,
          isConnected: !!(accounts && accounts.length > 0),
        },
      }));
    });

    // Race-condition fix: BRIDGE_READY may have arrived before this listener was registered.
    // If accounts are already set on the provider, dispatch wcAccountChanged immediately.
    var preloaded = window.ethereum.selectedAddress;
    if (preloaded) {
      document.dispatchEvent(new CustomEvent('wcAccountChanged', {
        detail: { address: preloaded, isConnected: true },
      }));
    }

    console.log('[PolyFactory Bridge] Listeners registered, waiting for handshake...');
  }

  var script = document.createElement('script');
  script.src = BRIDGE_CLIENT_URL;
  script.onload = setupBridgeListeners;
  script.onerror = function () {
    console.error('[PolyFactory Bridge] Failed to load bridge client:', BRIDGE_CLIENT_URL);
    window.__bridgeActive = false;
  };
  document.head.appendChild(script);
})();
