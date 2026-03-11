/**
 * PolyFactory — WalletConnect / Reown AppKit init
 * Loaded as <script type="module"> — executes after regular scripts but before DOMContentLoaded.
 * Exposes: window.__wcModal, window.__wcProvider
 * Fires:   CustomEvent "wcAccountChanged" on document
 *
 * Get your free Project ID at https://cloud.reown.com
 *
 * NOTE: Skipped entirely when window.__bridgeActive === true
 * (MCW Apps bridge mode, see wallet-bridge-init.js)
 */

// Bridge mode: wallet-bridge-init.js handles the connection via postMessage
if (!window.__bridgeActive) {
  const { createAppKit } = await import('https://esm.sh/@reown/appkit@1.8.18')
  const { EthersAdapter } = await import('https://esm.sh/@reown/appkit-adapter-ethers@1.8.18')

  // ---- BSC Testnet (AppKit custom network format) ----
  const bscTestnet = {
    id: 97,
    caipNetworkId: 'eip155:97',
    chainNamespace: 'eip155',
    name: 'BNB Smart Chain Testnet',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: {
      default: { http: [CONFIG.RPC_URL] },
      public:  { http: CONFIG.RPC_URLS || [CONFIG.RPC_URL] },
    },
    blockExplorers: {
      default: { name: 'BscScan Testnet', url: CONFIG.BLOCK_EXPLORER },
    },
    testnet: true,
  }

  // ---- Init ----
  let modal
  try {
    modal = createAppKit({
      adapters: [new EthersAdapter()],
      networks: [bscTestnet],
      defaultNetwork: bscTestnet,
      projectId: CONFIG.WC_PROJECT_ID,
      metadata: {
        name: 'PolyFactory',
        description: 'Prediction Markets on BNB Smart Chain',
        url: window.location.origin,
        icons: [window.location.origin + '/favicon.ico'],
      },
      features: {
        analytics: false,
        email: false,
        socials: false,
        swaps: false,
        onramp: false,
      },
      themeMode: 'dark',
      themeVariables: {
        '--w3m-border-radius-master': '8px',
      },
    })
  } catch (e) {
    console.warn('[AppKit] Failed to init:', e)
  }

  if (!modal) {
    // AppKit init failed — site falls back to direct window.ethereum
    console.warn('[AppKit] Modal unavailable, falling back to MetaMask')
  } else {
    window.__wcModal = modal

    // Track EIP-1193 provider (set when user connects)
    modal.subscribeProviders(state => {
      window.__wcProvider = state['eip155'] || null
    })

    // Notify app.js of account/connection changes
    modal.subscribeAccount(state => {
      document.dispatchEvent(new CustomEvent('wcAccountChanged', {
        detail: {
          address: state.address || null,
          isConnected: !!state.isConnected,
        },
      }))
    })
  }
}
