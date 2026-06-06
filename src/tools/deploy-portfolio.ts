import axios from 'axios';
import { z } from 'zod';

export const DeployPortfolioInputSchema = z.object({
  prompt: z.string().min(10).describe('Description of the person and their work for the AI to generate a portfolio'),
  style: z.enum(['modern', 'minimal', 'creative', 'executive']).optional().default('modern').describe('Visual style of the portfolio'),
  subdomain: z.string().min(3).max(30).regex(/^[a-z0-9-]+$/).describe('Desired subdomain e.g. "john-doe" → john-doe.seeqme.com'),
});

export type DeployPortfolioInput = z.infer<typeof DeployPortfolioInputSchema>;

interface DeployResult {
  url: string;
  subdomain: string;
  portfolioId: string;
  status: 'deployed' | 'deploying';
  message: string;
}

/**
 * Calls the SeeqMe backend to generate + deploy a portfolio.
 * This is called AFTER x402 payment has been verified.
 */
export async function executeDeployPortfolio(
  input: DeployPortfolioInput,
  agentSecret: string,
  backendUrl: string,
): Promise<DeployResult> {
  const { data } = await axios.post<DeployResult>(
    `${backendUrl}/api/v1/agent/deploy-portfolio`,
    input,
    {
      headers: {
        Authorization: `Bearer ${agentSecret}`,
        'X-Agent-Source': 'hedera-mcp-agent',
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    },
  );
  return data;
}
