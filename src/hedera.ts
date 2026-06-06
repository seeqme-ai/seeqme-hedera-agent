import {
  Client,
  AccountId,
  PrivateKey,
} from '@hiero-ledger/sdk';
import axios from 'axios';

const MIRROR_NODE_TESTNET = 'https://testnet.mirrornode.hedera.com';
const MIRROR_NODE_MAINNET = 'https://mainnet-public.mirrornode.hedera.com';

export function createHederaClient(): Client {
  const network = process.env.HEDERA_NETWORK ?? 'testnet';
  const accountId = AccountId.fromString(process.env.HEDERA_OPERATOR_ACCOUNT_ID!);
  const privateKey = PrivateKey.fromStringDer(process.env.HEDERA_OPERATOR_PRIVATE_KEY!);

  const client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(accountId, privateKey);
  return client;
}

export interface MirrorTransaction {
  consensus_timestamp: string;
  transaction_id: string;
  transfers: Array<{ account: string; amount: number }>;
  result: string;
  name: string;
}

/** Verify a payment transaction on Hedera Mirror Node */
export async function verifyPayment(
  txId: string,
  expectedRecipient: string,
  expectedAmountTinybars: number,
): Promise<{ valid: boolean; reason?: string }> {
  const network = process.env.HEDERA_NETWORK ?? 'testnet';
  const base = network === 'mainnet' ? MIRROR_NODE_MAINNET : MIRROR_NODE_TESTNET;

  // Mirror Node expects: "0.0.XXXXX-seconds-nanos" (replace @ and timestamp dot with -)
  const normalized = txId
    .replace('@', '-')
    .replace(/(\d+)\.(\d+)$/, '$1-$2');

  try {
    const url = `${base}/api/v1/transactions/${encodeURIComponent(normalized)}`;
    const { data } = await axios.get<{ transactions: MirrorTransaction[] }>(url, {
      timeout: 10_000,
    });

    const tx = data.transactions?.[0];
    if (!tx) return { valid: false, reason: 'Transaction not found' };
    if (tx.result !== 'SUCCESS') return { valid: false, reason: `Transaction failed: ${tx.result}` };

    // Verify the recipient received the expected amount
    const recipientTransfer = tx.transfers.find(
      (t) => t.account === expectedRecipient && t.amount >= expectedAmountTinybars,
    );
    if (!recipientTransfer) {
      return {
        valid: false,
        reason: `Recipient ${expectedRecipient} did not receive ${expectedAmountTinybars} tinybars`,
      };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Mirror node error: ${err.message}` };
  }
}

/** Verify via blocky402 facilitator (preferred when available) */
export async function verifyViaFacilitator(
  paymentPayload: string,
  paymentRequirements: object,
): Promise<{ valid: boolean; reason?: string }> {
  const facilitatorUrl = process.env.BLOCKY402_URL ?? 'https://blocky402.com';
  try {
    const { data } = await axios.post(
      `${facilitatorUrl}/facilitate`,
      { payment: paymentPayload, paymentRequirements },
      { timeout: 15_000 },
    );
    if (data.isValid) return { valid: true };
    return { valid: false, reason: data.invalidReason ?? 'Facilitator rejected payment' };
  } catch (err: any) {
    // Fall back to direct mirror node verification
    return { valid: false, reason: `Facilitator error: ${err.message}` };
  }
}
