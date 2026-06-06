/**
 * SeeqMe Hedera Agent
 *
 * Dual-mode server built with Hedera Agent Kit (@hashgraph/hedera-agent-kit):
 *  • HTTP  — x402-protected POST /deploy endpoint (pay → execute)
 *  • MCP   — Model Context Protocol server (Claude / AI agent clients via SSE)
 *
 * Payment amount is computed dynamically from the live HBAR/NGN exchange rate,
 * matching the Pro plan price (₦2,000) on Hedera mainnet.
 *
 * Payment flow: client hits /deploy → 402 response → client pays HBAR on Hedera
 * → client retries with X-PAYMENT header → agent verifies via blocky402.com →
 * portfolio deployed live on seeqme.com
 *
 * Hackathon: MCP / x402 Agent — Hedera Track
 */

import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

import { HederaAgentAPI, ToolDiscovery } from '@hashgraph/hedera-agent-kit';
import { AccountId, Client, PrivateKey } from '@hiero-ledger/sdk';
import axios from 'axios';

import {
  build402Response,
  decodePaymentHeader,
  verifyViaBlocky402,
  verifyViaMirrorNode,
  type X402PaymentRequirements,
} from './x402.js';
import { DeployPortfolioInputSchema, executeDeployPortfolio } from './tools/deploy-portfolio.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3100);
const HEDERA_NETWORK = (process.env.HEDERA_NETWORK ?? 'mainnet') as 'testnet' | 'mainnet';
const RECIPIENT_ACCOUNT_ID = process.env.HEDERA_PAYMENT_ACCOUNT_ID ?? '';
const OPERATOR_ACCOUNT_ID = process.env.HEDERA_OPERATOR_ACCOUNT_ID ?? '';
const OPERATOR_PRIVATE_KEY = process.env.HEDERA_OPERATOR_PRIVATE_KEY ?? '';
const BLOCKY402_URL = process.env.BLOCKY402_URL ?? 'https://blocky402.com';
const SEEQME_BACKEND_URL = process.env.SEEQME_BACKEND_URL ?? 'https://seeqme.com';
const AGENT_SECRET = process.env.SEEQME_AGENT_SECRET ?? '';
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

// Pro plan NGN price — agent charges the equivalent of Pro plan (₦2,000) per deploy
const PRO_PLAN_NGN = 2000;
const HBAR_RATE_FALLBACK = 150; // ₦150/HBAR conservative fallback

if (!RECIPIENT_ACCOUNT_ID) {
  console.error('❌  HEDERA_PAYMENT_ACCOUNT_ID is required'); process.exit(1);
}
if (!AGENT_SECRET) {
  console.error('❌  SEEQME_AGENT_SECRET is required'); process.exit(1);
}

// ─── Live HBAR/NGN rate (CoinGecko, 5-min cache) ─────────────────────────────

let rateCache = { rate: 0, expiresAt: 0 };

async function getHbarNgnRate(): Promise<number> {
  if (Date.now() < rateCache.expiresAt && rateCache.rate > 0) {
    return rateCache.rate;
  }
  try {
    const { data } = await axios.get<Record<string, Record<string, number>>>(
      'https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=ngn',
      { timeout: 8_000 },
    );
    const rate = data['hedera-hashgraph']?.['ngn'];
    if (rate && rate > 0) {
      rateCache = { rate, expiresAt: Date.now() + 5 * 60 * 1000 };
      console.log(`[Rate] HBAR/NGN refreshed: ${rate.toFixed(2)} NGN/HBAR`);
      return rate;
    }
  } catch (e: any) {
    console.warn(`[Rate] CoinGecko fetch failed (${e.message}), using fallback ${HBAR_RATE_FALLBACK} NGN/HBAR`);
  }
  return HBAR_RATE_FALLBACK;
}

async function hbarAmountForPlan(ngnPrice: number): Promise<{ amountHbar: number; rate: number; liveRate: boolean }> {
  const rate = await getHbarNgnRate();
  const liveRate = rateCache.rate > 0;
  // Round up to nearest 0.01 HBAR to ensure full NGN coverage
  const amountHbar = Math.ceil((ngnPrice / rate) * 100) / 100;
  return { amountHbar, rate, liveRate };
}

// ─── Hedera Agent Kit setup ───────────────────────────────────────────────────

function buildHederaClient(): Client {
  const client = HEDERA_NETWORK === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  if (OPERATOR_ACCOUNT_ID && OPERATOR_PRIVATE_KEY) {
    client.setOperator(
      AccountId.fromString(OPERATOR_ACCOUNT_ID),
      PrivateKey.fromStringDer(OPERATOR_PRIVATE_KEY),
    );
  }
  return client;
}

let hederaAgent: HederaAgentAPI | null = null;

function getHederaAgent(): HederaAgentAPI {
  if (!hederaAgent) {
    const client = buildHederaClient();
    const context = { accountId: OPERATOR_ACCOUNT_ID };
    const tools = new ToolDiscovery().getAllTools(context);
    hederaAgent = new HederaAgentAPI(client, context, tools);
  }
  return hederaAgent;
}

// ─── x402 helpers ────────────────────────────────────────────────────────────

function buildPaymentRequirements(resource: string, amountHbar: number): X402PaymentRequirements {
  return {
    scheme: 'exact',
    network: `hedera-${HEDERA_NETWORK}`,
    maxAmountRequired: String(Math.floor(amountHbar * 1e8)),
    resource,
    description: `Deploy AI portfolio — ${amountHbar} HBAR (≈ ₦${PRO_PLAN_NGN.toLocaleString()})`,
    mimeType: 'application/json',
    payTo: RECIPIENT_ACCOUNT_ID,
    maxTimeoutSeconds: 300,
    asset: 'HBAR',
    extra: { decimals: 8, name: 'HBAR', imageUrl: 'https://hashscan.io/images/hbar.svg' },
  };
}

async function verifyPayment(
  encodedPayment: string,
  amountHbar: number,
): Promise<{ ok: boolean; reason?: string }> {
  const reqs = buildPaymentRequirements(`${BASE_URL}/deploy`, amountHbar);

  //  blocky402.com facilitator (authoritative x402 verifier for Hedera)
  const r = await verifyViaBlocky402(encodedPayment, reqs, BLOCKY402_URL);
  if (r.isValid) return { ok: true };

  //  Mirror Node fallback — accept ≥ 70% of display amount (30% rate tolerance)
  const decoded = decodePaymentHeader(encodedPayment);
  if (!decoded) return { ok: false, reason: 'Cannot decode payment payload' };

  const txId = decoded.payload.transactionId;
  if (!txId) return { ok: false, reason: r.invalidReason ?? 'No transactionId in payload' };

  const minTinybars = Math.floor(amountHbar * 0.70 * 1e8);
  const mr = await verifyViaMirrorNode(txId, RECIPIENT_ACCOUNT_ID, minTinybars, HEDERA_NETWORK);
  return mr.isValid ? { ok: true } : { ok: false, reason: mr.invalidReason };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMCPServer(): Server {
  const server = new Server(
    { name: 'seeqme-hedera-agent', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_payment_requirements',
        description:
          'Get the current HBAR payment requirements to deploy a portfolio via SeeqMe. ' +
          'The HBAR amount is computed from the live NGN exchange rate. ' +
          'Call this first, send the HBAR, then call deploy_portfolio with the receipt.',
        inputSchema: { type: 'object', properties: {} as Record<string, unknown>, required: [] },
      },
      {
        name: 'deploy_portfolio',
        description:
          'Generate and deploy a professional AI portfolio to a live URL on seeqme.com. ' +
          'Requires HBAR payment via the x402 protocol. ' +
          'Call get_payment_requirements first, pay the HBAR, then call this with the encoded receipt.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Describe the person — role, skills, projects, tone.' },
            style: { type: 'string', enum: ['modern', 'minimal', 'creative', 'executive'] },
            subdomain: { type: 'string', description: 'e.g. "john-doe" → john-doe.seeqme.com' },
            paymentReceipt: { type: 'string', description: 'Base64-encoded x402 payment receipt' },
          },
          required: ['prompt', 'subdomain', 'paymentReceipt'],
        },
      },
      {
        name: 'check_recipient_balance',
        description: 'Query the live HBAR balance of the SeeqMe payment recipient via Hedera Agent Kit.',
        inputSchema: { type: 'object', properties: {} as Record<string, unknown>, required: [] },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'get_payment_requirements') {
      const { amountHbar, rate, liveRate } = await hbarAmountForPlan(PRO_PLAN_NGN);
      const reqs = buildPaymentRequirements(`${BASE_URL}/deploy`, amountHbar);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            amountHbar,
            amountNgn: PRO_PLAN_NGN,
            hbarNgnRate: rate,
            liveRate,
            rateSource: liveRate ? 'coingecko' : 'fallback',
            recipient: RECIPIENT_ACCOUNT_ID,
            network: HEDERA_NETWORK,
            instructions: `Send ${amountHbar} HBAR to ${RECIPIENT_ACCOUNT_ID} on Hedera ${HEDERA_NETWORK}. Encode the tx receipt as base64 x402 JSON, then call deploy_portfolio with paymentReceipt.`,
            paymentRequirements: reqs,
            hashScan: `https://hashscan.io/${HEDERA_NETWORK}/account/${RECIPIENT_ACCOUNT_ID}`,
          }, null, 2),
        }],
      };
    }

    if (name === 'check_recipient_balance') {
      try {
        const agent = getHederaAgent();
        const result = await agent.run('accountBalanceQuery', { accountId: RECIPIENT_ACCOUNT_ID });
        return {
          content: [{ type: 'text', text: JSON.stringify({ account: RECIPIENT_ACCOUNT_ID, balance: result }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ account: RECIPIENT_ACCOUNT_ID, error: err.message }) }],
        };
      }
    }

    if (name === 'deploy_portfolio') {
      const { paymentReceipt, ...deployArgs } = args as Record<string, string>;
      if (!paymentReceipt) {
        throw new McpError(ErrorCode.InvalidParams, 'paymentReceipt is required. Call get_payment_requirements first.');
      }

      const { amountHbar } = await hbarAmountForPlan(PRO_PLAN_NGN);
      const { ok, reason } = await verifyPayment(paymentReceipt, amountHbar);
      if (!ok) {
        throw new McpError(ErrorCode.InvalidRequest, `Payment verification failed: ${reason}`);
      }

      const parsed = DeployPortfolioInputSchema.safeParse(deployArgs);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, parsed.error.message);
      }

      const result = await executeDeployPortfolio(parsed.data, AGENT_SECRET, SEEQME_BACKEND_URL);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            url: result.url,
            subdomain: result.subdomain,
            message: `Portfolio deploying! Live at: ${result.url} (ready in ~2 min)`,
          }, null, 2),
        }],
      };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  });

  return server;
}

// ─── Express HTTP server ──────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/health', async (_req: Request, res: Response): Promise<void> => {
  const { amountHbar, rate, liveRate } = await hbarAmountForPlan(PRO_PLAN_NGN);

  let recipientBalance: string | null = null;
  try {
    const agent = getHederaAgent();
    recipientBalance = await agent.run('accountBalanceQuery', { accountId: RECIPIENT_ACCOUNT_ID });
  } catch { /* non-fatal */ }

  res.json({
    status: 'ok',
    agent: 'seeqme-hedera-agent',
    version: '1.0.0',
    agentKit: '@hashgraph/hedera-agent-kit@4.0.0',
    network: HEDERA_NETWORK,
    recipient: RECIPIENT_ACCOUNT_ID,
    pricing: {
      planNgn: PRO_PLAN_NGN,
      amountHbar,
      hbarNgnRate: rate,
      liveRate,
      rateSource: liveRate ? 'coingecko' : 'fallback',
    },
    recipientBalance,
    endpoints: {
      x402:   `${BASE_URL}/deploy`,
      mcp:    `${BASE_URL}/sse`,
      health: `${BASE_URL}/health`,
    },
  });
});

/** x402-protected HTTP deploy endpoint */
app.post('/deploy', async (req: Request, res: Response): Promise<void> => {
  const payment = req.headers['x-payment'] as string | undefined;

  // Always compute a fresh amount from live rate
  const { amountHbar } = await hbarAmountForPlan(PRO_PLAN_NGN);

  if (!payment) {
    res.status(402).json(build402Response('/deploy', RECIPIENT_ACCOUNT_ID, amountHbar, HEDERA_NETWORK));
    return;
  }

  const { ok, reason } = await verifyPayment(payment, amountHbar);
  if (!ok) {
    res.status(402).json({ error: `Payment verification failed: ${reason}` });
    return;
  }

  const parsed = DeployPortfolioInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = await executeDeployPortfolio(parsed.data, AGENT_SECRET, SEEQME_BACKEND_URL);
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('[Agent] Deploy failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** MCP over SSE */
const sseTransports = new Map<string, SSEServerTransport>();

app.get('/sse', async (_req: Request, res: Response): Promise<void> => {
  const transport = new SSEServerTransport('/message', res);
  sseTransports.set(transport.sessionId, transport);
  res.on('close', () => sseTransports.delete(transport.sessionId));
  const server = buildMCPServer();
  await server.connect(transport);
});

app.post('/message', async (req: Request, res: Response): Promise<void> => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
  await transport.handlePostMessage(req, res);
});

// ─── Entry point ──────────────────────────────────────────────────────────────

const isStdio = process.argv.includes('--stdio');

if (isStdio) {
  const server = buildMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('SeeqMe Hedera Agent — stdio MCP mode');
} else {
  // Warm up the rate cache on startup
  getHbarNgnRate().then((rate) => {
    const { amountHbar } = { amountHbar: Math.ceil((PRO_PLAN_NGN / rate) * 100) / 100 };
    app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════════════════════╗
║        SeeqMe Hedera Agent  v1.0.0                       ║
║        Built with @hashgraph/hedera-agent-kit            ║
╠══════════════════════════════════════════════════════════╣
║  Network   : Hedera ${HEDERA_NETWORK.padEnd(37)}║
║  Recipient : ${RECIPIENT_ACCOUNT_ID.padEnd(43)}║
║  Pricing   : ${`₦${PRO_PLAN_NGN.toLocaleString()} = ${amountHbar} HBAR @ ₦${rate.toFixed(0)}/HBAR`.padEnd(43)}║
╠══════════════════════════════════════════════════════════╣
║  x402 HTTP : ${`POST ${BASE_URL}/deploy`.padEnd(43)}║
║  MCP (SSE) : ${`GET  ${BASE_URL}/sse`.padEnd(43)}║
║  Health    : ${`GET  ${BASE_URL}/health`.padEnd(43)}║
╚══════════════════════════════════════════════════════════╝
`);
    });
  });
}
