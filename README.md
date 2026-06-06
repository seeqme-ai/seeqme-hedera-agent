# SeeqMe Hedera Agent

> **MCP / x402 Agent — Hedera Track Hackathon Submission**  
> Live HBAR pricing · Mainnet · Hedera Agent Kit · x402 protocol

Deploy AI portfolios behind a real on-chain payment. Users pay HBAR equivalent to the plan's naira price — computed automatically from the live HBAR/NGN exchange rate. No static amounts.

---

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SeeqMe Platform                             │
│                                                                     │
│  Frontend (React/Vite)          Backend (Go/Gin + MongoDB)          │
│  ─────────────────────          ───────────────────────────         │
│  DeploymentPaymentModal         GET /hedera/config?plan=pro         │
│    │                              │ Fetches live HBAR/NGN rate       │
│    │  1. Fetch config             │ from CoinGecko (5-min cache)     │
│    │◄─────────────────────────────┤ Returns: amountHbar, amountNgn   │
│    │                              │         hbarNgnRate, network     │
│    │                                                                 │
│    │  2. User pays HBAR via wallet (HashPack or MetaMask)           │
│    │     HashPack  → TransferTransaction (native HBAR)              │
│    │     MetaMask  → eth_sendTransaction (Hedera EVM, chainId 295)  │
│    │                                                                 │
│    │  3. Encode x402 receipt                                         │
│    │     base64({ x402Version:1, scheme:"exact",                    │
│    │              network:"hedera-mainnet",                          │
│    │              payload:{ transactionId:"0.0.X@sec.nano",         │
│    │                        payer:"0.0.Y" } })                       │
│    │                                                                 │
│    │  4. POST /hedera/verify-payment { encodedPayment, planId }     │
│    │─────────────────────────────────►                               │
│    │                              │ a. blocky402.com/facilitate      │
│    │                              │    POST { payment, requirements }│
│    │                              │    → { isValid: true }           │
│    │                              │ b. (fallback) Mirror Node        │
│    │                              │    GET /api/v1/transactions/{id} │
│    │                              │    verify amount ≥ 70% of price  │
│    │                              │ c. Store in hedera_payments coll │
│    │◄─────────────────────────────┤    { txRef, planId, amountHbar,  │
│    │  { success: true }           │      used:false, expiresAt+30m } │
│    │                                                                 │
│    │  5. POST /deployment/deploy  (X-Hedera-Payment: <encoded>)     │
│    │─────────────────────────────────►                               │
│    │                              │ ConsumeHederaPayment():          │
│    │                              │   find by txRef + userId         │
│    │                              │   check used=false, not expired  │
│    │                              │   mark used=true (atomic)        │
│    │                              │ → GitHub push → Cloudflare Pages │
│    │◄─────────────────────────────┤ → WebSocket notification        │
│    │  { url: "sub.seeqme.com" }   │                                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      hedera-agent (standalone)                      │
│                                                                     │
│  HTTP x402 endpoint              MCP SSE server                     │
│  ──────────────────              ───────────────                    │
│  POST /deploy                    GET  /sse                          │
│    No X-PAYMENT header?            MCP tools:                       │
│    → 402 + requirements JSON       • get_payment_requirements       │
│                                    • deploy_portfolio               │
│    Has X-PAYMENT header?           • check_recipient_balance        │
│    → verifyViaBlocky402()                                           │
│    → verifyViaMirrorNode()       HederaAgentAPI (Agent Kit)         │
│    → executeDeployPortfolio()      accountBalanceQuery on /health   │
│      POST seeqme.com/api/v1/       and check_recipient_balance      │
│           agent/deploy-portfolio                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Dynamic HBAR Pricing

The HBAR amount is **never hardcoded**. It is computed automatically:

```
amountHbar = ceil( planNGN / hbarNgnRate × 100 ) / 100
```

| Plan    | NGN price | Example (1 HBAR ≈ ₦150) | Rounded up |
|---------|-----------|--------------------------|------------|
| Pro     | ₦2,000    | 13.33 HBAR               | **13.34**  |
| Premium | ₦5,000    | 33.33 HBAR               | **33.34**  |

- Rate source: CoinGecko `simple/price?ids=hedera-hashgraph&vs_currencies=ngn`
- Cache TTL: 5 minutes (one API call per 5 min per server instance)
- Fallback: ₦150/HBAR if CoinGecko is unreachable
- Verification tolerance: ±30% (accepts payment ≥ 70% of the displayed price)
  - Handles HBAR rate fluctuation between when the user sees the price and pays

The user sees: **"Pay 13.34 HBAR (≈ ₦2,000)"** — no manual env var needed.

---

## Payment Verification Flow

Two-stage verification ensures every payment is valid on Hedera mainnet:

### Stage 1 — blocky402.com (x402 facilitator)
```
POST https://blocky402.com/facilitate
{
  "payment": "<base64 encoded x402 receipt>",
  "paymentRequirements": {
    "scheme": "exact",
    "network": "hedera-mainnet",
    "maxAmountRequired": "1334000000",   ← tinybars (13.34 HBAR × 10^8)
    "payTo": "0.0.XXXXXX",
    ...
  }
}
→ { "isValid": true }
```

### Stage 2 — Hedera Mirror Node (fallback)
If blocky402 is unreachable:
```
# Native HBAR (HashConnect path)
GET https://mainnet-public.mirrornode.hedera.com/api/v1/transactions/0.0.12345-1704067200-123456789
→ verify transfers[].account == recipient && amount >= minTinybars

# EVM (MetaMask path)
GET https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/0x...
→ verify to == recipientEvmAddress && amount >= minTinybars
```

### Replay prevention
Each verified payment is stored in MongoDB `hedera_payments`:
```json
{
  "txRef": "0.0.12345@1704067200.123456789",
  "userId": "<objectId>",
  "planId": "pro",
  "amountHbar": 13.34,
  "used": false,
  "expiresAt": "+30 minutes"
}
```
`ConsumeHederaPayment()` atomically flips `used=true` when the deployment runs. A single HBAR payment = one deployment.

---

## Hedera Agent Kit Usage

The standalone agent uses `@hashgraph/hedera-agent-kit@4.0.0`:

```typescript
import { HederaAgentAPI, ToolDiscovery } from '@hashgraph/hedera-agent-kit';
import { AccountId, Client, PrivateKey } from '@hiero-ledger/sdk';

const client = Client.forMainnet();
client.setOperator(AccountId.fromString(operatorId), PrivateKey.fromStringDer(privateKey));

const context = { accountId: operatorId };
const tools = new ToolDiscovery().getAllTools(context);
const agent = new HederaAgentAPI(client, context, tools);

// Used in /health and check_recipient_balance MCP tool
const balance = await agent.run('accountBalanceQuery', { accountId: recipientId });
```

---

## Hackathon Requirements

| Requirement | Implementation | File |
|---|---|---|
| Hedera Agent Kit (JS) | `HederaAgentAPI` + `ToolDiscovery` | `hedera-agent/src/index.ts` |
| x402 payment protocol | `POST /deploy` → 402 → `X-PAYMENT` verify | `src/x402.ts`, `hedera_handler.go` |
| blocky402.com facilitator | `verifyViaBlocky402()` primary | `src/x402.ts:85` |
| Wallet — HashPack | HashConnect v3, `TransferTransaction` | `hederaPaymentService.ts` |
| Wallet — MetaMask | Hedera EVM, chainId `0x127` (mainnet) | `hederaPaymentService.ts` |
| Payment → execution | verify → `agent/deploy-portfolio` → GitHub + CF | `hedera_handler.go`, `deployment_handler.go` |
| MCP server (SSE) | `GET /sse` + `POST /message` | `hedera-agent/src/index.ts` |
| Mainnet | `HEDERA_NETWORK=mainnet`, Mirror Node `mainnet-public.mirrornode.hedera.com` | All layers |
| Dynamic pricing | CoinGecko NGN rate, no hardcoded HBAR amount | `hedera_handler.go`, `index.ts` |
| Hosted UI | SeeqMe on Cloudflare Pages | Frontend |

---

## Wallet Setup

### HashPack (recommended)
1. Install [HashPack](https://www.hashpack.app/) browser extension
2. Create or import a **mainnet** account
3. Fund with HBAR (buy on exchange, send to account ID `0.0.XXXXX`)

### MetaMask (fallback)
1. Open MetaMask → Settings → Networks → Add Network
2. Add Hedera Mainnet manually:
   - Network Name: `Hedera Mainnet`
   - RPC URL: `https://mainnet.hashio.io/api`
   - Chain ID: `295` (hex `0x127`)
   - Currency: `HBAR`
   - Explorer: `https://hashscan.io/mainnet/`
3. Import your Hedera account's EVM address

---

## Setup Guide

### 1. Create a Hedera mainnet account

1. Go to [portal.hedera.com](https://portal.hedera.com) → create mainnet account
2. Fund it (minimum a few HBAR for testing)
3. Note your **Account ID** (`0.0.XXXXXX`) and **DER-encoded private key** (`302e...`)

To get the DER key from HashPack: Settings → Export Private Key (select DER format)

### 2. Get your EVM address

Visit [hashscan.io/mainnet](https://hashscan.io/mainnet) → search your account ID → copy the **EVM Address** field.

### 3. Get a WalletConnect Project ID

1. [cloud.walletconnect.com](https://cloud.walletconnect.com) → create project
2. App URL: your SeeqMe frontend URL
3. Copy the **Project ID**

### 4. Configure the hedera-agent

```bash
cd hedera-agent
cp .env.example .env
```

```env
HEDERA_NETWORK=mainnet
HEDERA_PAYMENT_ACCOUNT_ID=0.0.XXXXXX
HEDERA_OPERATOR_ACCOUNT_ID=0.0.XXXXXX
HEDERA_OPERATOR_PRIVATE_KEY=302e...
SEEQME_BACKEND_URL=https://seeqme.com
SEEQME_AGENT_SECRET=$(openssl rand -hex 32)
BASE_URL=https://your-agent.railway.app
```

> `HEDERA_PAYMENT_AMOUNT_HBAR` is **not needed** — the amount is computed automatically from the live HBAR/NGN rate.

### 5. Configure the SeeqMe backend

```env
AGENT_SECRET=<same value as SEEQME_AGENT_SECRET>
HEDERA_NETWORK=mainnet
HEDERA_PAYMENT_ACCOUNT_ID=0.0.XXXXXX
HEDERA_PAYMENT_EVM_ADDRESS=0x...
# HEDERA_PAYMENT_AMOUNT_HBAR is not needed — computed from live rate
```

### 6. Configure the frontend

```env
VITE_HEDERA_NETWORK=mainnet
VITE_WALLETCONNECT_PROJECT_ID=<your WalletConnect project ID>
# No VITE_HEDERA_PAYMENT_HBAR needed — fetched from backend at runtime
```

### 7. Run

```bash
npm install
npm run dev      # development
npm run build && npm start  # production
```

### 8. Deploy to Railway

1. Push `hedera-agent/` to GitHub
2. Railway → New Project → Deploy from GitHub
3. Set all env vars in Railway dashboard
4. Railway assigns public URL → set as `BASE_URL`

---

## MCP Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "seeqme-hedera": {
      "transport": "sse",
      "url": "https://your-agent.railway.app/sse"
    }
  }
}
```

Available MCP tools:
| Tool | Description |
|---|---|
| `get_payment_requirements` | Returns live HBAR amount, recipient, network |
| `deploy_portfolio` | Verifies payment + deploys portfolio |
| `check_recipient_balance` | Queries HBAR balance via Hedera Agent Kit |

---

## x402 Receipt Format

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "hedera-mainnet",
  "payload": {
    "transactionId": "0.0.12345@1704067200.123456789",
    "payer": "0.0.67890"
  }
}
```

This JSON is base64-encoded and sent as the `X-PAYMENT` header (HTTP) or `paymentReceipt` field (MCP).

---

## Security

| Concern | Mitigation |
|---|---|
| Replay attacks | Each `txRef` stored in MongoDB, `used` flag flipped atomically on deploy |
| Expired payments | 30-minute expiry on payment records |
| Rate manipulation | ±30% tolerance but CoinGecko rate is server-side only (not user-supplied) |
| Agent endpoint auth | `AGENT_SECRET` bearer token, checked on every `/agent/deploy-portfolio` call |
| Stale rates | 5-min cache TTL; fallback to ₦150/HBAR if CoinGecko unreachable |

---

## Tech Stack

| Component | Package | Version |
|---|---|---|
| Hedera Agent Kit | `@hashgraph/hedera-agent-kit` | 4.0.0 |
| Hedera SDK | `@hiero-ledger/sdk` | ^2.84.0 |
| MCP SDK | `@modelcontextprotocol/sdk` | ^1.12.0 |
| x402 Facilitator | blocky402.com | — |
| Wallet (native) | HashConnect | v3.0.14 |
| Wallet (EVM) | MetaMask + `@hashgraph/sdk` | — |
| Rate feed | CoinGecko public API | — |
| Backend | Go 1.22 + Gin + MongoDB | — |
| Deployment | Cloudflare Pages + GitHub | — |
