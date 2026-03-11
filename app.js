// CLOBPredictionMarket ABI
const CLOB_MARKET_ABI = [
  "function admin() view returns (address)",
  "function marketCount() view returns (uint256)",
  "function orderCount() view returns (uint256)",
  "function getMarket(uint256) view returns (tuple(string title, uint256 endTime, uint8 winningOutcome, bool resolved, bool cancelled, uint256 totalMatchedShares, uint256 totalLocked, uint256 createdAt, uint256 feeDeducted, uint256 snapshotAdminFee, bool snapshotFeeEnabled))",
  "function getOrder(uint256) view returns (tuple(address trader, uint256 marketId, uint8 side, uint256 price, uint256 amount, uint256 filledAmount, uint8 status, uint256 createdAt))",
  "function getPosition(address, uint256, uint256) view returns (uint256)",
  "function getUserOrderIds(address) view returns (uint256[])",
  "function getMarketYesOrderIds(uint256) view returns (uint256[])",
  "function getMarketNoOrderIds(uint256) view returns (uint256[])",
  "function getUserLockedTokens(address, uint256) view returns (uint256)",
  "function calculatePayout(address, uint256) view returns (uint256)",
  "function claimed(address, uint256) view returns (bool)",
  "function adminFee() view returns (uint256)",
  "function feeEnabled() view returns (bool)",
  "function placeOrder(uint256 marketId, uint8 side, uint256 price, uint256 amount)",
  "function cancelOrder(uint256 orderId)",
  "function claimWinnings(uint256 marketId)",
  "function claimRefund(uint256 marketId)",
  "function createMarket(string title, uint256 endTime)",
  "function resolve(uint256 marketId, uint8 winningOutcome)",
  "function cancel(uint256 marketId)",
  "function setAdminFee(uint256 newFee)",
  "function setFeeEnabled(bool enabled)",
  "event MarketCreated(uint256 indexed marketId, string title, uint256 endTime)",
  "event OrderPlaced(uint256 indexed marketId, uint256 indexed orderId, address indexed trader, uint8 side, uint256 price, uint256 amount)",
  "event OrderMatched(uint256 indexed marketId, uint256 yesOrderId, uint256 noOrderId, uint256 executionPrice, uint256 matchedAmount, uint256 timestamp)",
  "event OrderCancelled(uint256 indexed orderId, address indexed trader, uint256 refundAmount)",
  "event MarketResolved(uint256 indexed marketId, uint8 winningOutcome)",
  "event MarketCancelled(uint256 indexed marketId)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

let provider, signer, marketContract, usdtContract, userAddress, isAdmin;
let priceChart = null;
let _walletConnecting = false;   // guard: prevent concurrent wallet connects
let _marketDetailLoading = null; // guard: track which market is loading

const PRICE_PRECISION = 10000;
const YES = 0;
const NO = 1;
const ORDER_STATUS = ["Open", "Partial", "Filled", "Cancelled"];

// ========== ROUTER ==========
function navigate(hash) {
  window.location.hash = hash;
}

function handleRoute() {
  const hash = window.location.hash || "#/";
  const mainContent = document.getElementById("mainContent");
  const marketDetail = document.getElementById("marketDetail");

  if (hash.startsWith("#/market/")) {
    const id = parseInt(hash.replace("#/market/", ""));
    mainContent.style.display = "none";
    marketDetail.style.display = "block";
    loadMarketDetail(id);
  } else {
    mainContent.style.display = "block";
    marketDetail.style.display = "none";
    loadMarkets();
  }
}

// ========== INIT ==========
async function init() {
  setupTabs();

  // Fallback read-only provider (no wallet connected yet)
  provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);

  // Listen for wallet changes dispatched by wallet-init.js (AppKit)
  document.addEventListener("wcAccountChanged", async (evt) => {
    const { address, isConnected } = evt.detail;
    if (isConnected && address) {
      await handleWalletConnected();
    } else {
      handleWalletDisconnected();
    }
  });

  window.addEventListener("hashchange", handleRoute);
  handleRoute();
}

// ========== WALLET ==========

/**
 * Opens AppKit multi-wallet modal (MetaMask, WalletConnect, Coinbase, etc.)
 * Falls back to direct window.ethereum if AppKit didn't load.
 * In MCW bridge mode (?walletBridge=swaponline in iframe): requests accounts via bridge.
 */
async function connectWallet() {
  // MCW Apps bridge mode — wallet already connected via postMessage bridge
  if (window.__bridgeActive) {
    if (!window.ethereum || !window.ethereum.isSwapWalletAppsBridge) {
      toast("Bridge not ready, try again", "error");
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts && accounts.length > 0) {
        document.dispatchEvent(new CustomEvent("wcAccountChanged", {
          detail: { address: accounts[0], isConnected: true },
        }));
      }
    } catch (err) {
      toast(err.message || "Bridge connection failed", "error");
    }
    return;
  }

  const modal = window.__wcModal;
  if (modal) {
    await modal.open();
    return; // connection handled asynchronously via wcAccountChanged event
  }
  // AppKit unavailable → direct MetaMask fallback
  await connectMetaMaskDirect();
}

/**
 * Called by wcAccountChanged event after AppKit or bridge connects a wallet.
 * Gets EIP-1193 provider from AppKit or bridge and initialises ethers contracts.
 */
async function handleWalletConnected() {
  if (_walletConnecting) return; // AppKit fires wcAccountChanged multiple times
  _walletConnecting = true;
  // Bridge mode: window.ethereum IS the bridge provider
  const walletProvider = window.__bridgeActive
    ? window.ethereum
    : window.__wcProvider || (window.__wcModal && window.__wcModal.getWalletProvider?.());
  if (!walletProvider) {
    _walletConnecting = false;
    setTimeout(handleWalletConnected, 500);
    return;
  }
  try {
    if (window.__bridgeActive) {
      // Bridge mode: use public BSC Testnet RPC for reads, bridge wallet for signing.
      // This avoids routing eth_call through the bridge which may not support it.
      const readProvider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
      const bridgeProvider = new ethers.BrowserProvider(walletProvider);
      provider = readProvider;
      signer = await bridgeProvider.getSigner();
      userAddress = await signer.getAddress();
      // Read-only contract for queries; sign-capable contract for writes
      const readMarket = new ethers.Contract(CONFIG.PREDICTION_MARKET_ADDRESS, CLOB_MARKET_ABI, readProvider);
      marketContract = new ethers.Contract(CONFIG.PREDICTION_MARKET_ADDRESS, CLOB_MARKET_ABI, signer);
      usdtContract = new ethers.Contract(CONFIG.USDT_ADDRESS, ERC20_ABI, signer);
      const adminAddr = await readMarket.admin();
      isAdmin = adminAddr.toLowerCase() === userAddress.toLowerCase();
    } else {
      provider = new ethers.BrowserProvider(walletProvider);
      signer = await provider.getSigner();
      userAddress = await signer.getAddress();
      marketContract = new ethers.Contract(CONFIG.PREDICTION_MARKET_ADDRESS, CLOB_MARKET_ABI, signer);
      usdtContract = new ethers.Contract(CONFIG.USDT_ADDRESS, ERC20_ABI, signer);
      const adminAddr = await marketContract.admin();
      isAdmin = adminAddr.toLowerCase() === userAddress.toLowerCase();
    }
    const btn = document.getElementById("connectBtn");
    btn.textContent = userAddress.slice(0, 6) + "..." + userAddress.slice(-4);
    btn.classList.add("connected");
    if (isAdmin) document.getElementById("adminTab").style.display = "block";
    updateUsdtBalance();
    handleRoute();
    toast("Wallet connected", "success");
  } catch (err) {
    console.error(err);
    toast(err.message || "Connection failed", "error");
  } finally {
    _walletConnecting = false;
  }
}

async function updateUsdtBalance() {
  const el = document.getElementById("usdtBalance");
  if (!el || !usdtContract || !userAddress) { if (el) el.style.display = "none"; return; }
  try {
    const bal = await usdtContract.balanceOf(userAddress);
    el.textContent = parseFloat(ethers.formatUnits(bal, 18)).toFixed(2) + " USDT";
    el.style.display = "inline-block";
  } catch { el.style.display = "none"; }
}

function handleWalletDisconnected() {
  userAddress = null;
  signer = null;
  marketContract = null;
  usdtContract = null;
  isAdmin = false;
  provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const balEl = document.getElementById("usdtBalance");
  if (balEl) balEl.style.display = "none";
  const btn = document.getElementById("connectBtn");
  btn.textContent = "Connect Wallet";
  btn.classList.remove("connected");
  document.getElementById("adminTab").style.display = "none";
  handleRoute();
}

/**
 * Direct MetaMask fallback when AppKit is not available.
 * Handles network switching / addEthereumChain manually.
 */
async function connectMetaMaskDirect() {
  if (!window.ethereum) {
    toast("Install MetaMask or another Web3 wallet", "error");
    return;
  }
  try {
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (parseInt(chainId, 16) !== CONFIG.CHAIN_ID) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x" + CONFIG.CHAIN_ID.toString(16) }],
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x" + CONFIG.CHAIN_ID.toString(16),
              chainName: CONFIG.CHAIN_NAME,
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: [CONFIG.RPC_URL],
              blockExplorerUrls: [CONFIG.BLOCK_EXPLORER],
            }],
          });
        } else {
          throw switchErr;
        }
      }
    }
    window.ethereum.on?.("accountsChanged", (accounts) => {
      if (accounts.length === 0) handleWalletDisconnected(); else connectMetaMaskDirect();
    });
    window.ethereum.on?.("chainChanged", () => location.reload());
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();
    marketContract = new ethers.Contract(CONFIG.PREDICTION_MARKET_ADDRESS, CLOB_MARKET_ABI, signer);
    usdtContract = new ethers.Contract(CONFIG.USDT_ADDRESS, ERC20_ABI, signer);
    const adminAddr = await marketContract.admin();
    isAdmin = adminAddr.toLowerCase() === userAddress.toLowerCase();
    const btn = document.getElementById("connectBtn");
    btn.textContent = userAddress.slice(0, 6) + "..." + userAddress.slice(-4);
    btn.classList.add("connected");
    if (isAdmin) document.getElementById("adminTab").style.display = "block";
    updateUsdtBalance();
    handleRoute();
    toast("Wallet connected", "success");
  } catch (err) {
    console.error(err);
    toast(err.message || "Connection failed", "error");
  }
}

// handleAccountChange removed — handled in connectMetaMaskDirect & wcAccountChanged

// ========== TABS ==========
function setupTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      if (window.location.hash.startsWith("#/market/")) {
        navigate("#/");
      }
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.panel).classList.add("active");
    });
  });
}

// ========== READ CONTRACT ==========
let _readProvider = null;
function getReadContract() {
  // Always use public RPC for reads — never route eth_call through the bridge/signer
  if (!_readProvider) {
    const rpcs = CONFIG.RPC_URLS || [CONFIG.RPC_URL];
    _readProvider = new ethers.JsonRpcProvider(rpcs[0], CONFIG.CHAIN_ID, { staticNetwork: true, pollingInterval: 0 });
  }
  return new ethers.Contract(CONFIG.PREDICTION_MARKET_ADDRESS, CLOB_MARKET_ABI, _readProvider);
}

// Обёртка: возвращает fallback если promise не выполнился за ms миллисекунд
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ========== MARKET IMAGES ==========
let _marketMeta = null;

async function loadMarketMeta() {
  if (_marketMeta) return _marketMeta;
  try {
    const resp = await fetch("images/market-meta.json");
    if (resp.ok) _marketMeta = await resp.json();
  } catch (_) {}
  return _marketMeta || [];
}

function getMarketImage(title) {
  if (!_marketMeta) return null;
  const entry = _marketMeta.find(m => m.title === title);
  return entry && entry.imagePath ? entry.imagePath : null;
}

// ========== MARKET LIST ==========
async function loadMarkets() {
  await loadMarketMeta();
  const rc = getReadContract();
  try {
    const count = await rc.marketCount();
    const marketsList = document.getElementById("marketsList");
    const myPositions = document.getElementById("myPositions");

    if (count === 0n) {
      marketsList.innerHTML = '<div class="empty-state">No markets yet</div>';
      myPositions.innerHTML = '<div class="empty-state">No positions</div>';
      return;
    }

    // Параллельная загрузка всех маркетов
    const ids = Array.from({ length: Number(count) }, (_, i) => Number(count) - 1 - i);
    const markets = await Promise.all(ids.map(i => rc.getMarket(i)));

    // Параллельная загрузка позиций (если кошелёк подключён)
    let positions = null;
    if (userAddress) {
      positions = await Promise.all(
        ids.flatMap(i => [
          rc.getPosition(userAddress, i, 0),
          rc.getPosition(userAddress, i, 1),
        ])
      );
    }

    let marketsHtml = "";
    let positionsHtml = "";

    for (let idx = 0; idx < ids.length; idx++) {
      const i = ids[idx];
      const m = markets[idx];
      if (m.cancelled) continue; // скрываем отменённые рынки из списка
      const now = Math.floor(Date.now() / 1000);
      const ended = now >= Number(m.endTime);
      const { status, badgeClass } = getMarketStatus(m, ended);

      // Показываем 50/50 по умолчанию — ордербук пуст, getMidPrice убран
      const yesPct = "50.0";
      const noPct = "50.0";

      const totalLockedFmt = ethers.formatUnits(m.totalLocked, 18);
      const endDate = new Date(Number(m.endTime) * 1000).toLocaleString();

      const outcomesPreview = `
        <div class="outcomes-preview">
          <div class="outcome-preview-item">
            <span class="outcome-preview-label">Yes</span>
            <span class="outcome-preview-pct" style="color:#58a6ff">${yesPct}%</span>
          </div>
          <div class="outcome-preview-item">
            <span class="outcome-preview-label">No</span>
            <span class="outcome-preview-pct" style="color:#f0883e">${noPct}%</span>
          </div>
        </div>`;

      const poolBar = `<div class="pool-bar">
        <div class="pool-segment" style="width:${yesPct}%"></div>
        <div class="pool-segment" style="width:${noPct}%"></div>
      </div>`;

      const marketImg = getMarketImage(m.title);
      const imgHtml = marketImg
        ? `<div class="card-banner"><img src="${marketImg}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
        : "";

      marketsHtml += `
        <div class="card card-clickable" onclick="navigate('#/market/${i}')">
          ${imgHtml}
          <div class="card-body">
            <div class="market-header">
              <h3>${m.title}</h3>
              <span class="badge ${badgeClass}">${status}</span>
            </div>
            <div class="market-meta">
              <span class="market-vol">${totalLockedFmt} USDT locked</span>
              <span class="sep">&middot;</span>
              <span class="market-end">${endDate}</span>
            </div>
            ${outcomesPreview}
          </div>
          <div class="card-footer">
            <span class="pool-total">Matched: <strong>${ethers.formatUnits(m.totalMatchedShares, 18)} shares</strong></span>
            ${poolBar}
          </div>
        </div>`;

      // Позиции из уже загруженных данных
      if (userAddress && positions) {
        const yesPos = positions[idx * 2];
        const noPos = positions[idx * 2 + 1];
        if (yesPos > 0n || noPos > 0n) {
          const hasClaimed = await rc.claimed(userAddress, i);
          let claimHtml = "";
          if (m.resolved && !hasClaimed) {
            const payout = await rc.calculatePayout(userAddress, i);
            if (payout > 0n) claimHtml = `<button class="btn btn-primary claim-btn" onclick="event.stopPropagation(); claimWinnings(${i})">Claim ${ethers.formatUnits(payout, 18)} USDT</button>`;
          } else if (m.cancelled && !hasClaimed) {
            claimHtml = `<button class="btn btn-blue claim-btn" onclick="event.stopPropagation(); claimRefundAction(${i})">Claim Refund</button>`;
          } else if (hasClaimed) {
            claimHtml = '<span style="color:#8b949e; font-size:12px;">Claimed</span>';
          }

          let posItems = "";
          if (yesPos > 0n) posItems += `<div class="user-position"><span class="pos-label">YES</span><span class="pos-amount">${ethers.formatUnits(yesPos, 18)} shares</span></div>`;
          if (noPos > 0n) posItems += `<div class="user-position"><span class="pos-label">NO</span><span class="pos-amount">${ethers.formatUnits(noPos, 18)} shares</span></div>`;

          positionsHtml += `
            <div class="card card-clickable" onclick="navigate('#/market/${i}')">
              <div class="card-body">
                <div class="market-header">
                  <h3>${m.title}</h3>
                  <span class="badge ${badgeClass}">${status}</span>
                </div>
                ${posItems}
                ${claimHtml}
              </div>
            </div>`;
        }
      }
    }

    marketsList.innerHTML = marketsHtml || '<div class="empty-state">No markets</div>';
    myPositions.innerHTML = positionsHtml || '<div class="empty-state">No positions. Connect wallet and trade.</div>';
  } catch (err) {
    console.error("Load markets error:", err);
    document.getElementById("marketsList").innerHTML =
      `<div class="empty-state">Error loading markets: ${err.message?.substring(0, 80) || "RPC connection failed"}. Try refreshing.</div>`;
  }
}

// ========== MID PRICE ==========
// Compute mid-price from already-fetched orders (no extra RPC calls)
function computeMidPrice(yesOrders, noOrders) {
  let bestYesBid = 0;
  for (const o of yesOrders) {
    if (o.status === 0n || o.status === 1n) {
      if (Number(o.price) > bestYesBid) bestYesBid = Number(o.price);
    }
  }
  let bestNoBid = 0;
  for (const o of noOrders) {
    if (o.status === 0n || o.status === 1n) {
      if (Number(o.price) > bestNoBid) bestNoBid = Number(o.price);
    }
  }
  if (bestYesBid === 0 && bestNoBid === 0) return null;
  if (bestYesBid === 0) return PRICE_PRECISION - bestNoBid;
  if (bestNoBid === 0) return bestYesBid;
  const yesAsk = PRICE_PRECISION - bestNoBid;
  return Math.round((bestYesBid + yesAsk) / 2);
}

// ========== MARKET DETAIL ==========
async function loadMarketDetail(marketId) {
  if (_marketDetailLoading === marketId) return; // already loading this market
  _marketDetailLoading = marketId;
  const _t0 = performance.now();
  console.log(`[Detail] loading market #${marketId}`);
  const container = document.getElementById("marketDetail");
  container.innerHTML = '<div class="empty-state">Loading market...</div>';

  const rc = getReadContract();
  try {
    const m = await rc.getMarket(marketId);
    console.log(`[Detail] getMarket done (${(performance.now() - _t0).toFixed(0)}ms)`);
    const now = Math.floor(Date.now() / 1000);
    const ended = now >= Number(m.endTime);
    const { status, badgeClass } = getMarketStatus(m, ended);
    const isOpen = !m.resolved && !m.cancelled && !ended;
    const totalLockedFmt = ethers.formatUnits(m.totalLocked, 18);
    const endDate = new Date(Number(m.endTime) * 1000).toLocaleString();
    const createdDate = new Date(Number(m.createdAt) * 1000).toLocaleString();
    const feeRate = Number(m.snapshotAdminFee) / 100;

    // Mid price will be computed from orderbook data (no extra RPC calls)
    let yesPct = "50.0";

    // Time remaining
    let timeRemaining = "";
    if (isOpen) {
      const diff = Number(m.endTime) - now;
      const days = Math.floor(diff / 86400);
      const hours = Math.floor((diff % 86400) / 3600);
      if (days > 0) timeRemaining = `${days}d ${hours}h remaining`;
      else if (hours > 0) timeRemaining = `${hours}h remaining`;
      else timeRemaining = `${Math.floor(diff / 60)}m remaining`;
    }

    // Probability display
    const probHtml = `
      <div class="detail-probability">
        <div class="prob-main">
          <span class="prob-pct" style="color:#58a6ff">${yesPct}%</span>
          <span class="prob-label">Yes</span>
        </div>
        <div class="prob-secondary">
          <span class="prob-other">No: <strong style="color:#f0883e">${(100 - parseFloat(yesPct)).toFixed(1)}%</strong></span>
        </div>
      </div>`;

    // Orderbook
    const orderbookHtml = `
      <div class="orderbook-section">
        <h3>Order Book</h3>
        <div class="orderbook">
          <div class="orderbook-side">
            <div class="orderbook-title yes-title">YES Bids</div>
            <div class="orderbook-header"><span>Price</span><span>Shares</span></div>
            <div id="yesBids" class="orderbook-rows"></div>
          </div>
          <div class="orderbook-side">
            <div class="orderbook-title no-title">NO Bids</div>
            <div class="orderbook-header"><span>Price</span><span>Shares</span></div>
            <div id="noBids" class="orderbook-rows"></div>
          </div>
        </div>
      </div>`;

    // Price chart
    const chartHtml = `
      <div class="chart-container">
        <h3>Price History</h3>
        <canvas id="priceChartCanvas"></canvas>
      </div>`;

    // Trading form
    let tradingHtml = "";
    if (isOpen) {
      const formDisabled = !userAddress ? "disabled" : "";
      const connectHint = !userAddress ? '<div class="connect-hint">Connect wallet to trade</div>' : "";

      tradingHtml = `
        <div class="trading-section">
          <h3>Trade</h3>
          ${connectHint}
          <div class="trading-form-wrap">
            <div class="side-toggle">
              <button class="side-btn side-yes active" onclick="selectSide(${marketId}, 0, this)">YES</button>
              <button class="side-btn side-no" onclick="selectSide(${marketId}, 1, this)">NO</button>
            </div>
            <div class="detail-bet-form">
              <div class="bet-input-group">
                <label>Price ($0.01 - $0.99)</label>
                <input type="number" id="orderPrice" placeholder="0.50" min="0.01" max="0.99" step="0.01" ${formDisabled}
                       oninput="updateTradeSummary(${marketId})">
              </div>
              <div class="bet-input-group">
                <label>Shares</label>
                <input type="number" id="orderAmount" placeholder="10" min="0" step="1" ${formDisabled}
                       oninput="updateTradeSummary(${marketId})">
              </div>
              <div id="tradeSummary" class="bet-summary" style="display:none;">
                <div class="summary-row"><span>Cost</span><span id="sumCost">-</span></div>
                <div class="summary-row"><span>Shares</span><span id="sumShares">-</span></div>
                <div class="summary-row"><span>Payout if win</span><span id="sumPayout" class="summary-highlight">-</span></div>
                <div class="summary-row"><span>Profit</span><span id="sumProfit" class="summary-green">-</span></div>
                <div class="summary-row"><span>ROI</span><span id="sumRoi" class="summary-green">-</span></div>
              </div>
              <button class="btn btn-primary btn-lg" id="placeOrderBtn" onclick="placeOrderAction(${marketId})" ${formDisabled}>
                Place Order
              </button>
            </div>
          </div>
        </div>`;
    }

    // My orders
    const myOrdersHtml = userAddress ? `
      <div class="my-orders-section">
        <h3>My Orders</h3>
        <div id="myOrdersList" class="my-orders"></div>
      </div>
      <div id="snapshotOrders" class="snapshot-orders-section"></div>` : "";

    // User positions — fetch YES/NO positions and claimed status in parallel
    let userPosHtml = "";
    if (userAddress) {
      console.log(`[Detail] fetching positions (${(performance.now() - _t0).toFixed(0)}ms)`);
      const [yesPos, noPos, hasClaimed] = await withTimeout(
        Promise.all([
          rc.getPosition(userAddress, marketId, 0),
          rc.getPosition(userAddress, marketId, 1),
          rc.claimed(userAddress, marketId),
        ]),
        8000,
        [0n, 0n, false]
      );
      console.log(`[Detail] positions done (${(performance.now() - _t0).toFixed(0)}ms)`);
      if (yesPos > 0n || noPos > 0n) {
        let claimHtml = "";
        if (m.resolved && !hasClaimed) {
          const payout = await rc.calculatePayout(userAddress, marketId);
          if (payout > 0n) claimHtml = `<button class="btn btn-primary" onclick="claimWinnings(${marketId})">Claim ${ethers.formatUnits(payout, 18)} USDT</button>`;
        } else if (m.cancelled && !hasClaimed) {
          claimHtml = `<button class="btn btn-blue" onclick="claimRefundAction(${marketId})">Claim Refund</button>`;
        } else if (hasClaimed) {
          claimHtml = '<span class="claimed-badge">Claimed</span>';
        }

        let posItems = "";
        if (yesPos > 0n) posItems += `<div class="detail-position-row"><span class="dp-color" style="background:#58a6ff"></span><span class="dp-label">YES</span><span class="dp-amount">${ethers.formatUnits(yesPos, 18)} shares</span></div>`;
        if (noPos > 0n) posItems += `<div class="detail-position-row"><span class="dp-color" style="background:#f0883e"></span><span class="dp-label">NO</span><span class="dp-amount">${ethers.formatUnits(noPos, 18)} shares</span></div>`;

        userPosHtml = `
          <div class="detail-positions">
            <h3>Your Positions</h3>
            ${posItems}
            ${claimHtml}
          </div>`;
      }
    }

    // How it works
    const howItWorks = `
      <div class="how-it-works">
        <h3>How CLOB Works</h3>
        <div class="hiw-grid">
          <div class="hiw-item">
            <div class="hiw-icon">1</div>
            <div class="hiw-text">
              <strong>Limit Orders</strong>
              <p>Place YES or NO orders at your desired price ($0.01-$0.99). Your order sits in the book until matched.</p>
            </div>
          </div>
          <div class="hiw-item">
            <div class="hiw-icon">2</div>
            <div class="hiw-text">
              <strong>Auto-matching</strong>
              <p>Orders match when YES price + NO price &ge; $1.00. Each matched pair creates one share.</p>
            </div>
          </div>
          <div class="hiw-item">
            <div class="hiw-icon">3</div>
            <div class="hiw-text">
              <strong>Payout</strong>
              <p>Winning shares pay $1.00 each${m.snapshotFeeEnabled ? ` (minus ${feeRate}% fee)` : ""}. Unmatched orders can be cancelled for refund.</p>
            </div>
          </div>
        </div>
      </div>`;

    // Sidebar
    const marketInfo = `
      <div class="detail-info">
        <h3>Market Info</h3>
        <div class="info-row"><span>Status</span><span class="badge ${badgeClass}">${status}</span></div>
        <div class="info-row"><span>Locked</span><strong>${totalLockedFmt} USDT</strong></div>
        <div class="info-row"><span>Matched</span><span>${ethers.formatUnits(m.totalMatchedShares, 18)} shares</span></div>
        <div class="info-row"><span>Type</span><span>Binary (YES/NO)</span></div>
        <div class="info-row"><span>Created</span><span>${createdDate}</span></div>
        <div class="info-row"><span>Ends</span><span>${endDate}</span></div>
        ${m.snapshotFeeEnabled ? `<div class="info-row"><span>Fee</span><span>${feeRate}%</span></div>` : ""}
        ${timeRemaining ? `<div class="info-row"><span>Time left</span><strong class="time-remaining">${timeRemaining}</strong></div>` : ""}
        <a class="contract-link-full" href="${CONFIG.BLOCK_EXPLORER}/address/${CONFIG.PREDICTION_MARKET_ADDRESS}" target="_blank">
          View Contract &rarr;
        </a>
      </div>`;

    container.innerHTML = `
      <div class="detail-header">
        <button class="back-btn" onclick="navigate('#/')">&#8592; Markets</button>
        <span class="detail-id">#${marketId}</span>
      </div>
      <h2 class="detail-title">${m.title}</h2>
      <div class="detail-badges">
        <span class="badge ${badgeClass}">${status}</span>
        ${timeRemaining ? `<span class="detail-time">${timeRemaining}</span>` : ""}
        <span class="detail-pool">${totalLockedFmt} USDT locked</span>
      </div>
      ${probHtml}
      <div class="detail-layout">
        <div class="detail-main">
          ${chartHtml}
          ${orderbookHtml}
          ${tradingHtml}
          ${myOrdersHtml}
          ${userPosHtml}
          ${howItWorks}
        </div>
        <div class="detail-sidebar">
          ${marketInfo}
        </div>
      </div>`;

    console.log(`[Detail] HTML rendered (${(performance.now() - _t0).toFixed(0)}ms)`);

    // Load dynamic data (parallel where possible)
    const obPromise = loadOrderbook(rc, marketId);
    loadPriceChart(rc, marketId);
    if (userAddress) loadMyOrders(rc, marketId);
    if (userAddress) loadUserSnapshotOrders(marketId);
    // Update probability display once orderbook loaded
    obPromise.then(midPrice => {
      if (midPrice !== null) {
        const pct = (midPrice / 100).toFixed(1);
        const probPctEl = document.querySelector(".prob-pct");
        const probOtherEl = document.querySelector(".prob-other strong");
        if (probPctEl) probPctEl.textContent = pct + "%";
        if (probOtherEl) probOtherEl.textContent = (100 - parseFloat(pct)).toFixed(1) + "%";
      }
    });
  } catch (err) {
    console.error("Load market detail error:", err);
    container.innerHTML = `<div class="empty-state">Error loading market: ${err.message?.substring(0, 80) || "RPC error"}. <a href="#/" style="color:#58a6ff;">Back to markets</a></div>`;
  } finally {
    _marketDetailLoading = null;
  }
}

// ========== ORDERBOOK ==========
// Returns midPrice (or null) after rendering, so detail page can update probability
async function loadOrderbook(rc, marketId) {
  const yesBidsEl = document.getElementById("yesBids");
  const noBidsEl = document.getElementById("noBids");
  if (!yesBidsEl) return null;

  try {
    // Fetch order IDs in parallel
    const [yesIds, noIds] = await Promise.all([
      rc.getMarketYesOrderIds(marketId),
      rc.getMarketNoOrderIds(marketId),
    ]);

    // Fetch ALL orders in parallel (single Promise.all instead of sequential loops)
    const allIds = [...yesIds, ...noIds];
    const allOrders = allIds.length > 0
      ? await Promise.all(allIds.map(id => rc.getOrder(id)))
      : [];
    const yesOrders = allOrders.slice(0, yesIds.length);
    const noOrders = allOrders.slice(yesIds.length);

    // Aggregate YES bids by price
    const yesAgg = {};
    for (const o of yesOrders) {
      if (o.status === 0n || o.status === 1n) {
        const price = Number(o.price);
        const remaining = o.amount - o.filledAmount;
        yesAgg[price] = (yesAgg[price] || 0n) + remaining;
      }
    }

    // Aggregate NO bids by price
    const noAgg = {};
    for (const o of noOrders) {
      if (o.status === 0n || o.status === 1n) {
        const price = Number(o.price);
        const remaining = o.amount - o.filledAmount;
        noAgg[price] = (noAgg[price] || 0n) + remaining;
      }
    }

    // YES bids: highest price first
    const yesSorted = Object.entries(yesAgg).sort((a, b) => b[0] - a[0]);
    yesBidsEl.innerHTML = yesSorted.length === 0
      ? '<div class="orderbook-empty">No bids</div>'
      : yesSorted.map(([price, amt]) => `
          <div class="orderbook-row yes-row">
            <span class="ob-price">$${(price / PRICE_PRECISION).toFixed(2)}</span>
            <span class="ob-amount">${parseFloat(ethers.formatUnits(amt, 18)).toFixed(2)}</span>
          </div>`).join("");

    // NO bids: highest price first
    const noSorted = Object.entries(noAgg).sort((a, b) => b[0] - a[0]);
    noBidsEl.innerHTML = noSorted.length === 0
      ? '<div class="orderbook-empty">No bids</div>'
      : noSorted.map(([price, amt]) => `
          <div class="orderbook-row no-row">
            <span class="ob-price">$${(price / PRICE_PRECISION).toFixed(2)}</span>
            <span class="ob-amount">${parseFloat(ethers.formatUnits(amt, 18)).toFixed(2)}</span>
          </div>`).join("");

    // Compute mid-price from fetched orders (no extra RPC calls)
    return computeMidPrice(yesOrders, noOrders);
  } catch (err) {
    console.error("Orderbook error:", err);
    yesBidsEl.innerHTML = '<div class="orderbook-empty">Error loading</div>';
    noBidsEl.innerHTML = '<div class="orderbook-empty">Error loading</div>';
    return null;
  }
}

// ========== PRICE CHART ==========

// Fetch OrderMatched events via external indexer (BSCScan-compatible API).
// Returns [{timestamp, price, volume}] or null if not configured / failed.
async function fetchEventsFromIndexer(marketId) {
  if (!CONFIG.EVENTS_API || !CONFIG.EVENTS_API_KEY) return null;
  try {
    const topic0 = ethers.id("OrderMatched(uint256,uint256,uint256,uint256,uint256,uint256)");
    // topic1 = indexed marketId padded to 32 bytes
    const topic1 = "0x" + BigInt(marketId).toString(16).padStart(64, "0");
    const url = new URL(CONFIG.EVENTS_API);
    url.searchParams.set("module", "logs");
    url.searchParams.set("action", "getLogs");
    url.searchParams.set("address", CONFIG.PREDICTION_MARKET_ADDRESS);
    url.searchParams.set("topic0", topic0);
    url.searchParams.set("topic0_1_opr", "and");
    url.searchParams.set("topic1", topic1);
    url.searchParams.set("fromBlock", String(CONFIG.DEPLOY_BLOCK || 0));
    url.searchParams.set("toBlock", "latest");
    url.searchParams.set("apikey", CONFIG.EVENTS_API_KEY);
    const resp = await fetch(url.toString());
    const json = await resp.json();
    if (json.status !== "1") {
      // status "0" with message "No records found" is valid (no trades yet)
      if (json.message === "No records found") return [];
      console.warn("[Chart] indexer returned:", json.message);
      return null;
    }
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    return json.result.map(log => {
      // data = [yesOrderId, noOrderId, executionPrice, matchedAmount, timestamp]
      const [, , executionPrice, matchedAmount, timestamp] =
        abiCoder.decode(["uint256","uint256","uint256","uint256","uint256"], log.data);
      return {
        timestamp: Number(timestamp),
        price: Number(executionPrice) / PRICE_PRECISION,
        volume: Number(matchedAmount),
      };
    });
  } catch (err) {
    console.warn("[Chart] indexer fetch failed:", err.message);
    return null;
  }
}

// Fetch OrderMatched events via direct RPC scanning (parallel chunks, skips pruned history).
// Returns [{timestamp, price, volume}].
async function fetchEventsFromRPC(marketId) {
  const rpcs = CONFIG.RPC_URLS || [CONFIG.RPC_URL];
  const logsProvider = new ethers.JsonRpcProvider(rpcs[0], CONFIG.CHAIN_ID, { staticNetwork: true });
  const logsContract = new ethers.Contract(CONFIG.PREDICTION_MARKET_ADDRESS, CLOB_MARKET_ABI, logsProvider);
  const filter = logsContract.filters.OrderMatched(marketId);
  const fromBlock = CONFIG.DEPLOY_BLOCK || 0;
  const latestBlock = await logsProvider.getBlockNumber();
  console.log(`[Chart] RPC getBlockNumber=${latestBlock}`);

  // publicnode.com free RPC prunes blocks older than ~50K blocks (~41h on BSC Testnet)
  const KEEP_BLOCKS = 50000;
  const safeFromBlock = Math.max(fromBlock, latestBlock - KEEP_BLOCKS);
  const CHUNK = 5000;
  const chunks = [];
  for (let start = safeFromBlock; start <= latestBlock; start += CHUNK) {
    chunks.push([start, Math.min(start + CHUNK - 1, latestBlock)]);
  }
  console.log(`[Chart] RPC ${chunks.length} chunks (${safeFromBlock}→${latestBlock}${safeFromBlock > fromBlock ? ", pruned history skipped" : ""})`);

  const CONCURRENCY = 5;
  let events = [];
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(([s, e]) => logsContract.queryFilter(filter, s, e))
    );
    for (const r of results) {
      if (r.status === "fulfilled") events = events.concat(r.value);
      else console.warn(`[Chart] RPC chunk failed: ${r.reason?.message}`);
    }
  }
  return events.map(ev => ({
    timestamp: Number(ev.args[5]),
    price: Number(ev.args[3]) / PRICE_PRECISION,
    volume: Number(ev.args[4]),
  }));
}

async function loadPriceChart(rc, marketId) {
  const canvas = document.getElementById("priceChartCanvas");
  if (!canvas) return;
  const _t0 = performance.now();
  console.log(`[Chart] start market #${marketId}`);

  try {
    let rawTrades = null;

    // Try external indexer first (full history, no pruning)
    if (CONFIG.EVENTS_API && CONFIG.EVENTS_API_KEY) {
      console.log("[Chart] trying indexer...");
      rawTrades = await fetchEventsFromIndexer(marketId);
      if (rawTrades !== null) {
        console.log(`[Chart] indexer: ${rawTrades.length} events (${(performance.now() - _t0).toFixed(0)}ms)`);
      } else {
        console.log("[Chart] indexer failed, falling back to RPC");
      }
    }

    // Fallback to RPC if indexer not configured or failed
    if (rawTrades === null) {
      const rpcEvents = await fetchEventsFromRPC(marketId);
      rawTrades = rpcEvents;
      console.log(`[Chart] RPC: ${rawTrades.length} events (${(performance.now() - _t0).toFixed(0)}ms)`);
    }

    rawTrades.sort((a, b) => a.timestamp - b.timestamp);

    if (rawTrades.length === 0) {
      canvas.parentElement.innerHTML = '<h3>Price History</h3><div class="orderbook-empty">No trades yet</div>';
      return;
    }

    const tMin = rawTrades[0].timestamp;
    const tMax = rawTrades[rawTrades.length - 1].timestamp;
    const span = tMax - tMin;

    let labels, data;

    // When span < 5 min or too few unique timestamps → show each trade as a point
    const uniqueTs = new Set(rawTrades.map(t => t.timestamp)).size;
    if (span < 300 || uniqueTs < 3) {
      // Individual trade points: use sequential index as X-axis label
      labels = rawTrades.map((t, i) => {
        const d = new Date(t.timestamp * 1000);
        return `#${i + 1} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      });
      data = rawTrades.map(t => t.price);
    } else {
      // Auto-pick bucket size based on time span
      let bucketSec, labelFn;
      if (span < 3600) {
        bucketSec = 60;
        labelFn = d => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else if (span < 86400) {
        bucketSec = 3600;
        labelFn = d => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else if (span < 7 * 86400) {
        bucketSec = 4 * 3600;
        labelFn = d => d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit" });
      } else {
        bucketSec = 86400;
        labelFn = d => d.toLocaleDateString([], { month: "short", day: "numeric" });
      }

      // Group trades into buckets → VWAP
      const buckets = new Map();
      for (const t of rawTrades) {
        const key = Math.floor(t.timestamp / bucketSec) * bucketSec;
        if (!buckets.has(key)) buckets.set(key, { sumPV: 0, sumV: 0 });
        const b = buckets.get(key);
        b.sumPV += t.price * t.volume;
        b.sumV += t.volume;
      }

      const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
      labels = sortedKeys.map(k => labelFn(new Date(k * 1000)));
      data = sortedKeys.map(k => {
        const b = buckets.get(k);
        return b.sumPV / b.sumV;
      });
    }

    if (priceChart) priceChart.destroy();

    priceChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Avg YES Price ($)",
          data,
          borderColor: "#58a6ff",
          backgroundColor: "rgba(88, 166, 255, 0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: data.length < 30 ? 4 : 2,
          pointBackgroundColor: "#58a6ff",
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => "$" + ctx.parsed.y.toFixed(4),
            },
          },
        },
        scales: {
          y: {
            min: 0, max: 1,
            ticks: { color: "#8b949e", callback: v => "$" + v.toFixed(2) },
            grid: { color: "#21262d" },
          },
          x: {
            ticks: { color: "#8b949e", maxTicksLimit: 10, maxRotation: 45 },
            grid: { color: "#21262d" },
          },
        },
      },
    });
  } catch (err) {
    console.error("Price chart error:", err);
    canvas.parentElement.innerHTML = '<h3>Price History</h3><div class="orderbook-empty">Error loading chart</div>';
  }
}

// ========== MY ORDERS ==========
async function loadMyOrders(rc, marketId) {
  const el = document.getElementById("myOrdersList");
  if (!el || !userAddress) return;

  try {
    const orderIds = await rc.getUserOrderIds(userAddress);
    // Fetch all orders in parallel
    const orders = orderIds.length > 0
      ? await Promise.all(orderIds.map(id => rc.getOrder(id)))
      : [];
    let html = "";
    let hasOrders = false;

    for (let idx = 0; idx < orderIds.length; idx++) {
      const oid = orderIds[idx];
      const o = orders[idx];
      if (Number(o.marketId) !== marketId) continue;
      hasOrders = true;

      const side = o.side === 0n ? "YES" : "NO";
      const sideClass = o.side === 0n ? "yes" : "no";
      const price = (Number(o.price) / PRICE_PRECISION).toFixed(2);
      const amount = parseFloat(ethers.formatUnits(o.amount, 18)).toFixed(2);
      const filled = parseFloat(ethers.formatUnits(o.filledAmount, 18)).toFixed(2);
      const statusText = ORDER_STATUS[Number(o.status)];
      const canCancel = o.status === 0n || o.status === 1n;

      html += `
        <div class="my-order-row">
          <span class="mo-side ${sideClass}">${side}</span>
          <span class="mo-price">$${price}</span>
          <span class="mo-fill">${filled}/${amount}</span>
          <span class="mo-status">${statusText}</span>
          ${canCancel ? `<button class="btn btn-danger btn-sm" onclick="cancelOrderAction(${oid})">Cancel</button>` : '<span class="mo-done"></span>'}
        </div>`;
    }

    el.innerHTML = hasOrders ? html : '<div class="orderbook-empty">No orders in this market</div>';
  } catch (err) {
    console.error("My orders error:", err);
    el.innerHTML = '<div class="orderbook-empty">Error loading orders</div>';
  }
}

// ========== SIDE TOGGLE ==========
let selectedSide = 0; // YES by default

function selectSide(marketId, side, btn) {
  selectedSide = side;
  document.querySelectorAll(".side-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  updateTradeSummary(marketId);
}

// ========== TRADE SUMMARY ==========
function updateTradeSummary(marketId) {
  const priceInput = document.getElementById("orderPrice");
  const amountInput = document.getElementById("orderAmount");
  const summary = document.getElementById("tradeSummary");
  if (!priceInput || !amountInput || !summary) return;

  const price = parseFloat(priceInput.value);
  const amount = parseFloat(amountInput.value);

  if (!price || !amount || price < 0.01 || price > 0.99 || amount <= 0) {
    summary.style.display = "none";
    return;
  }

  const cost = price * amount;
  const payout = amount; // each share pays $1.00
  const profit = payout - cost;
  const roi = (profit / cost) * 100;

  summary.style.display = "block";
  document.getElementById("sumCost").textContent = `${cost.toFixed(2)} USDT`;
  document.getElementById("sumShares").textContent = `${amount} shares`;
  document.getElementById("sumPayout").textContent = `${payout.toFixed(2)} USDT`;
  document.getElementById("sumProfit").textContent = `+${profit.toFixed(2)} USDT`;
  document.getElementById("sumRoi").textContent = `${roi.toFixed(1)}%`;
}

// ========== SNAPSHOT-HUB INTEGRATION ==========
// Logic lives in snapshot-storage.js — loaded before this script in index.html.
// Globals: snapshotSignAndSubmit(signer, address, orderData), snapshotLoadAndRender(address, marketId)

async function loadUserSnapshotOrders(marketId) {
  if (typeof snapshotLoadAndRender === 'function') {
    snapshotLoadAndRender(userAddress, marketId);
  }
}

// ========== ACTIONS ==========
async function placeOrderAction(marketId) {
  if (!signer) { toast("Connect wallet first", "error"); return; }

  const priceVal = parseFloat(document.getElementById("orderPrice").value);
  const amountVal = document.getElementById("orderAmount").value;
  if (!priceVal || priceVal < 0.01 || priceVal > 0.99) { toast("Enter valid price ($0.01-$0.99)", "error"); return; }
  if (!amountVal || parseFloat(amountVal) <= 0) { toast("Enter valid amount", "error"); return; }

  const priceBp = Math.round(priceVal * PRICE_PRECISION);
  const amount = ethers.parseUnits(amountVal, 18);
  const deposit = (BigInt(priceBp) * amount) / BigInt(PRICE_PRECISION);

  try {
    const allowance = await usdtContract.allowance(userAddress, CONFIG.PREDICTION_MARKET_ADDRESS);
    if (allowance < deposit) {
      toast("Approving USDT...", "info");
      const approveTx = await usdtContract.approve(CONFIG.PREDICTION_MARKET_ADDRESS, ethers.MaxUint256);
      await approveTx.wait();
      toast("USDT approved", "success");
    }
    toast("Placing order...", "info");
    const tx = await marketContract.placeOrder(marketId, selectedSide, priceBp, amount);
    await tx.wait();
    toast("Order placed!", "success");
    // Non-blocking: sign + submit to snapshot-hub for off-chain order history
    if (typeof snapshotSignAndSubmit === 'function') {
      snapshotSignAndSubmit(signer, userAddress, {
        marketId, side: selectedSide, price: priceBp, amount, txHash: tx.hash
      });
    }
    loadMarketDetail(marketId);
  } catch (err) {
    console.error(err);
    toast(parseError(err), "error");
  }
}

async function cancelOrderAction(orderId) {
  if (!signer) return;
  try {
    toast("Cancelling order...", "info");
    const tx = await marketContract.cancelOrder(orderId);
    await tx.wait();
    toast("Order cancelled!", "success");
    handleRoute();
  } catch (err) {
    toast(parseError(err), "error");
  }
}

async function claimWinnings(marketId) {
  if (!signer) return;
  try {
    toast("Claiming winnings...", "info");
    const tx = await marketContract.claimWinnings(marketId);
    await tx.wait();
    toast("Winnings claimed!", "success");
    handleRoute();
  } catch (err) {
    toast(parseError(err), "error");
  }
}

async function claimRefundAction(marketId) {
  if (!signer) return;
  try {
    toast("Claiming refund...", "info");
    const tx = await marketContract.claimRefund(marketId);
    await tx.wait();
    toast("Refund claimed!", "success");
    handleRoute();
  } catch (err) {
    toast(parseError(err), "error");
  }
}

// ========== ADMIN ==========
async function createMarket() {
  if (!signer || !isAdmin) return;
  const title = document.getElementById("newTitle").value.trim();
  const endTimeStr = document.getElementById("newEndTime").value;
  if (!title) { toast("Enter market title", "error"); return; }
  if (!endTimeStr) { toast("Select end time", "error"); return; }
  const endTime = Math.floor(new Date(endTimeStr).getTime() / 1000);
  if (endTime <= Math.floor(Date.now() / 1000)) { toast("End time must be in the future", "error"); return; }
  try {
    toast("Creating market...", "info");
    const tx = await marketContract.createMarket(title, endTime);
    await tx.wait();
    toast("Market created!", "success");
    document.getElementById("newTitle").value = "";
    loadMarkets();
  } catch (err) {
    toast(parseError(err), "error");
  }
}

async function resolveMarket() {
  if (!signer || !isAdmin) return;
  const id = parseInt(document.getElementById("resolveId").value);
  const outcome = parseInt(document.getElementById("resolveOutcome").value);
  try {
    toast("Resolving market...", "info");
    const tx = await marketContract.resolve(id, outcome);
    await tx.wait();
    toast("Market resolved!", "success");
    loadMarkets();
  } catch (err) {
    toast(parseError(err), "error");
  }
}

async function cancelMarket() {
  if (!signer || !isAdmin) return;
  const id = parseInt(document.getElementById("cancelId").value);
  try {
    toast("Cancelling market...", "info");
    const tx = await marketContract.cancel(id);
    await tx.wait();
    toast("Market cancelled!", "success");
    loadMarkets();
  } catch (err) {
    toast(parseError(err), "error");
  }
}

// ========== UTILS ==========
function getMarketStatus(m, ended) {
  if (m.cancelled) return { status: "Cancelled", badgeClass: "cancelled" };
  if (m.resolved) {
    const winner = m.winningOutcome === 1n || m.winningOutcome === 1 ? "YES" : "NO";
    return { status: `Resolved: ${winner}`, badgeClass: "resolved" };
  }
  if (ended) return { status: "Ended", badgeClass: "ended" };
  return { status: "Open", badgeClass: "open" };
}

function parseError(err) {
  const msg = err?.reason || err?.data?.message || err?.message || "Transaction failed";
  const match = msg.match(/reverted with reason string '(.+?)'/);
  return match ? match[1] : msg.substring(0, 100);
}

let toastTimer;
function toast(msg, type) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 4000);
}

// ========== THEME ==========
function initTheme() {
  const params = new URLSearchParams(window.location.search);
  const urlTheme = params.get("theme");
  const saved = localStorage.getItem("pf-theme");
  const theme = urlTheme || saved || "dark";
  if (theme === "light") document.body.classList.add("light");
  if (urlTheme) localStorage.setItem("pf-theme", urlTheme);
  // Remove the no-flash helper class from <html>
  document.documentElement.classList.remove("light-pending");
  updateThemeBtn();
}

function toggleTheme() {
  const isLight = document.body.classList.toggle("light");
  localStorage.setItem("pf-theme", isLight ? "light" : "dark");
  updateThemeBtn();
}

function updateThemeBtn() {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  btn.textContent = document.body.classList.contains("light") ? "🌙" : "☀️";
}

document.addEventListener("DOMContentLoaded", () => { initTheme(); init(); });
