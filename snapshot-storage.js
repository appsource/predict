/**
 * snapshot-storage.js — Universal Web3 off-chain storage via snapshot-hub
 *
 * Reusable across all PolyFactory ecosystem products (PolyFactory, DAOwidget, etc.)
 * Configure via window.PolyFactory_ before loading this script:
 *
 *   window.PolyFactory_ = {
 *     SNAPSHOT_HUB_URL: 'http://localhost:3700',  // default
 *     SNAPSHOT_SPACE:   'polyfactory.wpmix.net',  // default
 *   };
 *
 * Depends on: ethers (v6, UMD), CONFIG (from config.js), userAddress + signer (from app.js)
 * All functions are non-fatal — errors are logged but never block the main UI.
 *
 * See: /root/snapshot-hub/INTEGRATION.md for full integration guide
 */

// ─── Config ───────────────────────────────────────────────────────────────────

function _hubUrl() {
  return (
    (window.PolyFactory_ && window.PolyFactory_.SNAPSHOT_HUB_URL) ||
    (typeof CONFIG !== 'undefined' && CONFIG.SNAPSHOT_HUB_URL) ||
    'http://localhost:3700'
  ).replace(/\/$/, '');
}

function _space() {
  return (
    (window.PolyFactory_ && window.PolyFactory_.SNAPSHOT_SPACE) ||
    (typeof CONFIG !== 'undefined' && CONFIG.SNAPSHOT_SPACE) ||
    'polyfactory.eth'
  );
}

function _chainId() {
  return String((typeof CONFIG !== 'undefined' && CONFIG.CHAIN_ID) || 97);
}

// ─── EIP-712 types (must match snapshot-hub src/writer/order.ts) ──────────────

const SNAPSHOT_ORDER_DOMAIN = { name: 'snapshot', version: '0.1.4' };

const SNAPSHOT_ORDER_TYPES = {
  Order: [
    { name: 'from',      type: 'address' },
    { name: 'space',     type: 'string'  },
    { name: 'timestamp', type: 'uint64'  },
    { name: 'marketId',  type: 'string'  },
    { name: 'side',      type: 'string'  },
    { name: 'price',     type: 'string'  },
    { name: 'amount',    type: 'string'  },
    { name: 'txHash',    type: 'string'  },
    { name: 'network',   type: 'string'  },
  ]
};

// ─── Sign & submit ────────────────────────────────────────────────────────────

/**
 * Sign an order with EIP-712 and submit to snapshot-hub.
 * Call AFTER tx.wait() so txHash is available.
 * Non-fatal: on any error logs to console.warn only.
 *
 * @param {object} signer    — ethers v6 Signer (connected wallet)
 * @param {string} address   — signer address (from userAddress global)
 * @param {object} orderData — { marketId, side, price, amount, txHash }
 */
async function snapshotSignAndSubmit(signer, address, orderData) {
  try {
    const hubUrl    = _hubUrl();
    const space     = _space();
    const timestamp = Math.floor(Date.now() / 1000);

    const message = {
      from:      address,
      space,
      timestamp, // ethers v6 signTypedData converts to BigInt automatically for uint64
      marketId:  String(orderData.marketId),
      side:      String(orderData.side),
      price:     String(orderData.price),
      amount:    String(orderData.amount),
      txHash:    orderData.txHash,
      network:   _chainId(),
    };

    // ethers v6: signer.signTypedData(domain, types, value)
    const sig = await signer.signTypedData(SNAPSHOT_ORDER_DOMAIN, SNAPSHOT_ORDER_TYPES, message);

    const envelope = {
      address,
      sig,
      data: { domain: SNAPSHOT_ORDER_DOMAIN, types: SNAPSHOT_ORDER_TYPES, message },
    };

    const resp = await fetch(`${hubUrl}/api/msg`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(envelope),
    });

    if (!resp.ok) {
      console.warn('[snapshot-hub] submit failed:', await resp.text());
    } else {
      const result = await resp.json();
      console.log('[snapshot-hub] order recorded:', result.id);
    }
  } catch (e) {
    // Non-fatal — order is already confirmed on-chain
    console.warn('[snapshot-hub] snapshotSignAndSubmit error:', e);
  }
}

// ─── Read orders via GraphQL ──────────────────────────────────────────────────

/**
 * Load signed order history from snapshot-hub for a user + market.
 * Returns [] on any error.
 *
 * @param {string} voter    — wallet address
 * @param {string|number} marketId
 * @param {number} [first]  — max results (default 50)
 */
async function snapshotLoadOrders(voter, marketId, first = 50) {
  try {
    const hubUrl = _hubUrl();
    const space  = _space();

    const query = `{
      orders(
        where: { voter: "${voter.toLowerCase()}", market_id: "${marketId}", space: "${space}" }
        orderBy: "created"
        orderDirection: desc
        first: ${first}
      ) {
        id voter created space marketId side price amount txHash network
      }
    }`;

    const resp = await fetch(`${hubUrl}/graphql`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
    });
    const data = await resp.json();
    return (data && data.data && data.data.orders) ? data.data.orders : [];
  } catch (e) {
    console.warn('[snapshot-hub] snapshotLoadOrders error:', e);
    return [];
  }
}

// ─── Render helpers ───────────────────────────────────────────────────────────

/**
 * Render signed order history into a DOM container.
 *
 * @param {HTMLElement} container
 * @param {Array}       orders     — from snapshotLoadOrders()
 */
function snapshotRenderOrders(container, orders) {
  if (!orders || orders.length === 0) {
    container.innerHTML = '<p class="text-muted small">No signed orders recorded yet.</p>';
    return;
  }

  const explorerBase = (typeof CONFIG !== 'undefined' && CONFIG.BLOCK_EXPLORER) || '';

  const rows = orders.map(function(o) {
    const sideNum   = parseInt(String(o.side));
    const sideLabel = sideNum === 0
      ? '<span class="badge badge-yes-sm">YES</span>'
      : '<span class="badge badge-no-sm">NO</span>';
    const priceDisplay = (parseInt(String(o.price)) / 100).toFixed(2) + '%';
    let amountDisplay  = '—';
    try { amountDisplay = parseFloat(ethers.formatEther(String(o.amount))).toFixed(2); } catch(e) {}
    const date    = new Date(o.created * 1000).toLocaleString();
    const txShort = String(o.txHash).slice(0, 10) + '…';
    const txLink  = explorerBase
      ? `<a href="${explorerBase}/tx/${o.txHash}" target="_blank" rel="noopener" class="text-muted">${txShort}</a>`
      : `<span class="text-muted">${txShort}</span>`;
    return `<tr><td>${sideLabel}</td><td>${priceDisplay}</td><td>${amountDisplay}</td><td>${txLink}</td><td class="text-muted small">${date}</td></tr>`;
  }).join('');

  container.innerHTML = `
    <h6 class="snapshot-orders-title">My Signed Orders</h6>
    <div class="table-responsive">
    <table class="table table-sm snapshot-orders-table mb-0">
      <thead><tr><th>Side</th><th>Price</th><th>Amount</th><th>Tx</th><th>Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

/**
 * Convenience: load + render signed orders for a market into #snapshotOrders element.
 * Used by loadMarketDetail() in app.js.
 *
 * @param {string} address  — current user address
 * @param {string|number} marketId
 */
async function snapshotLoadAndRender(address, marketId) {
  const container = document.getElementById('snapshotOrders');
  if (!container || !address) return;
  const orders = await snapshotLoadOrders(address, marketId);
  snapshotRenderOrders(container, orders);
}
