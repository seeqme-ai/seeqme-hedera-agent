/**
 * x402 protocol helpers.
 * Spec: https://x402.org
 * Facilitator: https://blocky402.com
 */

import axios from 'axios';

export interface X402PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string; // in base units (tinybars for HBAR)
  resource: string;
  description: string;
  mimeType: string;
  payTo: string; // Hedera account ID e.g. "0.0.12345"
  maxTimeoutSeconds: number;
  asset: string;
  extra: {
    decimals: number;
    name: string;
    imageUrl?: string;
  };
}

export interface X402Response {
  x402Version: 1;
  accepts: X402PaymentRequirements[];
  error: string;
}

export interface X402PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: string;
  payload: {
    transactionId: string; // "0.0.XXXX@seconds.nanos"
    payer: string;         // "0.0.YYYY"
  };
}

/** Build the 402 response body that clients parse to know what to pay */
export function build402Response(
  resource: string,
  recipientAccountId: string,
  amountHbar: number,
  network: string,
): X402Response {
  const maxAmountRequired = String(Math.floor(amountHbar * 1e8)); // tinybars
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: `hedera-${network}`,
        maxAmountRequired,
        resource,
        description: `Deploy AI portfolio to live URL — ${amountHbar} HBAR`,
        mimeType: 'application/json',
        payTo: recipientAccountId,
        maxTimeoutSeconds: 300,
        asset: 'HBAR',
        extra: {
          decimals: 8,
          name: 'HBAR',
          imageUrl: 'https://hashscan.io/images/hbar.svg',
        },
      },
    ],
    error: 'Payment required. Please pay with HBAR to proceed.',
  };
}

/** Decode the base64-encoded X-PAYMENT header */
export function decodePaymentHeader(header: string): X402PaymentPayload | null {
  try {
    const json = Buffer.from(header, 'base64').toString('utf-8');
    return JSON.parse(json) as X402PaymentPayload;
  } catch {
    return null;
  }
}

/** Verify the payment via blocky402.com facilitator */
export async function verifyViaBlocky402(
  encodedPayment: string,
  requirements: X402PaymentRequirements,
  facilitatorUrl = 'https://blocky402.com',
): Promise<{ isValid: boolean; invalidReason?: string }> {
  try {
    const { data } = await axios.post(
      `${facilitatorUrl}/facilitate`,
      { payment: encodedPayment, paymentRequirements: requirements },
      { timeout: 15_000 },
    );
    return { isValid: !!data.isValid, invalidReason: data.invalidReason };
  } catch (err: any) {
    return { isValid: false, invalidReason: `Facilitator error: ${err.message}` };
  }
}

/** Fallback: verify directly on Hedera Mirror Node (used if blocky402 is unreachable) */
export async function verifyViaMirrorNode(
  transactionId: string,
  recipientAccountId: string,
  minAmountTinybars: number,
  network: string,
): Promise<{ isValid: boolean; invalidReason?: string }> {
  const base =
    network === 'mainnet'
      ? 'https://mainnet-public.mirrornode.hedera.com'
      : 'https://testnet.mirrornode.hedera.com';

  // Hedera tx ID: "0.0.12345@1234567890.123456789"
  // Mirror Node wants: "0.0.12345-1234567890-123456789"
  const normalized = transactionId
    .replace('@', '-')             // replace @ separator
    .replace(/(\d+)\.(\d+)$/, '$1-$2'); // replace dot in timestamp part only

  try {
    const url = `${base}/api/v1/transactions/${encodeURIComponent(normalized)}`;
    const { data } = await axios.get(url, { timeout: 10_000 });
    const tx = data.transactions?.[0];

    if (!tx) return { isValid: false, invalidReason: 'Transaction not found on Mirror Node' };
    if (tx.result !== 'SUCCESS') return { isValid: false, invalidReason: `Transaction failed: ${tx.result}` };

    const recipientTransfer = tx.transfers?.find(
      (t: any) => t.account === recipientAccountId && t.amount >= minAmountTinybars,
    );
    if (!recipientTransfer) {
      return {
        isValid: false,
        invalidReason: `Recipient ${recipientAccountId} did not receive ${minAmountTinybars} tinybars`,
      };
    }
    return { isValid: true };
  } catch (err: any) {
    return { isValid: false, invalidReason: `Mirror Node error: ${err.message}` };
  }
}
