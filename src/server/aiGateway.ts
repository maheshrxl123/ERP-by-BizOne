import { GoogleGenAI, Type, type Schema } from '@google/genai';
import crypto from 'node:crypto';
import net from 'node:net';
import { hasCapability, type UserRole } from '../core/permissions.ts';

export type AiProviderKind =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'grok'
  | 'custom';

export interface AiToolDefinition {
  name: string;
  kind: 'read' | 'propose_write';
  requiredModules: string[];
  allowedRoles: UserRole[];
  requiresProfitCapability?: boolean;
  description: string;
}

export const AI_TOOL_ALLOWLIST: Record<string, AiToolDefinition> = {
  get_sales_summary: {
    name: 'get_sales_summary',
    kind: 'read',
    requiredModules: ['billing'],
    allowedRoles: ['owner', 'manager', 'cashier', 'accountant', 'viewer'],
    description: 'Read today/month sales totals and top invoices.',
  },
  get_overdue_parties: {
    name: 'get_overdue_parties',
    kind: 'read',
    requiredModules: ['parties'],
    allowedRoles: ['owner', 'manager', 'cashier', 'accountant'],
    description: 'List parties with overdue receivable or payable balances.',
  },
  get_stock_alerts: {
    name: 'get_stock_alerts',
    kind: 'read',
    requiredModules: ['inventory'],
    allowedRoles: ['owner', 'manager', 'cashier', 'storekeeper', 'accountant', 'viewer'],
    description: 'List low-stock and out-of-stock items.',
  },
  get_expense_summary: {
    name: 'get_expense_summary',
    kind: 'read',
    requiredModules: ['expenses'],
    allowedRoles: ['owner', 'manager', 'accountant'],
    description: 'Summarize operating expenses by category.',
  },
  get_gst_summary: {
    name: 'get_gst_summary',
    kind: 'read',
    requiredModules: ['tax', 'reports'],
    allowedRoles: ['owner', 'manager', 'accountant'],
    description: 'Summarize output GST, input GST credit, and net liability.',
  },
  get_near_expiry_items: {
    name: 'get_near_expiry_items',
    kind: 'read',
    requiredModules: ['inventory', 'batch_expiry'],
    allowedRoles: ['owner', 'manager', 'storekeeper', 'accountant'],
    description: 'List batches expiring within 60 days.',
  },
  get_dead_slow_stock: {
    name: 'get_dead_slow_stock',
    kind: 'read',
    requiredModules: ['inventory', 'reports'],
    allowedRoles: ['owner', 'manager', 'storekeeper', 'accountant'],
    description: 'Identify slow-moving or dead stock items.',
  },
  get_profit_summary: {
    name: 'get_profit_summary',
    kind: 'read',
    requiredModules: ['reports'],
    allowedRoles: ['owner', 'manager', 'accountant'],
    requiresProfitCapability: true,
    description: 'Read gross margin, COGS estimate, and net profit.',
  },
  get_accounting_summary: {
    name: 'get_accounting_summary',
    kind: 'read',
    requiredModules: ['accounting'],
    allowedRoles: ['owner', 'manager', 'accountant'],
    requiresProfitCapability: true,
    description: 'Read double-entry trial balance, P&L, and balance sheet totals.',
  },
  propose_payment_reminder: {
    name: 'propose_payment_reminder',
    kind: 'propose_write',
    requiredModules: ['parties'],
    allowedRoles: ['owner', 'manager', 'cashier', 'accountant'],
    description: 'Prepare a WhatsApp/SMS payment reminder draft for Owner approval.',
  },
  propose_reorder_po: {
    name: 'propose_reorder_po',
    kind: 'propose_write',
    requiredModules: ['inventory', 'purchases'],
    allowedRoles: ['owner', 'manager', 'storekeeper'],
    description: 'Prepare a supplier purchase order draft for Owner approval.',
  },
  propose_draft_quotation: {
    name: 'propose_draft_quotation',
    kind: 'propose_write',
    requiredModules: ['billing'],
    allowedRoles: ['owner', 'manager', 'cashier', 'accountant'],
    description: 'Prepare a customer quotation draft for Owner approval.',
  },
  propose_stock_adjustment_draft: {
    name: 'propose_stock_adjustment_draft',
    kind: 'propose_write',
    requiredModules: ['inventory'],
    allowedRoles: ['owner', 'manager', 'storekeeper'],
    description: 'Prepare a stock adjustment proposal for Owner approval.',
  },
  propose_accounting_voucher_draft: {
    name: 'propose_accounting_voucher_draft',
    kind: 'propose_write',
    requiredModules: ['accounting'],
    allowedRoles: ['owner', 'manager', 'accountant'],
    description: 'Prepare a balanced double-entry journal voucher draft for Owner approval.',
  },
};

const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpOrHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return true;
  }
  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    return isPrivateIpv4(host);
  }
  if (ipVer === 6) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
      return true;
    }
    if (host.startsWith('::ffff:')) {
      const v4Part = host.slice('::ffff:'.length);
      if (net.isIP(v4Part) === 4) return isPrivateIpv4(v4Part);
    }
  }
  return false;
}

export function validateExternalHttpsUrl(rawUrl: string): { valid: boolean; normalized?: string; error?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'Provider URL is required.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid provider URL format.' };
  }
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTPS provider URLs are permitted.' };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Embedded credentials in URL are not allowed.' };
  }
  if (isPrivateIpOrHost(parsed.hostname)) {
    return {
      valid: false,
      error: 'Private, loopback, link-local, or internal hostnames are blocked for security.',
    };
  }
  return { valid: true, normalized: parsed.toString().replace(/\/$/, '') };
}

export function isToolAllowedForContext(
  toolName: string,
  role: UserRole,
  enabledModules: Set<string> | string[]
): { allowed: boolean; reason?: string } {
  const def = AI_TOOL_ALLOWLIST[toolName];
  if (!def) {
    return { allowed: false, reason: `Tool "${toolName}" is not in the BizOne AI allowlist.` };
  }
  const mods = enabledModules instanceof Set ? enabledModules : new Set(enabledModules);
  for (const reqMod of def.requiredModules) {
    if (!mods.has(reqMod)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" requires module "${reqMod}" to be enabled.`,
      };
    }
  }
  if (!def.allowedRoles.includes(role)) {
    return {
      allowed: false,
      reason: `Role "${role}" is not authorized for tool "${toolName}".`,
    };
  }
  if (def.requiresProfitCapability && !hasCapability(role, 'view_profit')) {
    return {
      allowed: false,
      reason: `Role "${role}" does not have profit/financial viewing permissions.`,
    };
  }
  return { allowed: true };
}

const SENSITIVE_PROFIT_KEYS = new Set([
  'purchase_price',
  'purchase_rate',
  'unit_cost',
  'cogs_estimate',
  'gross_profit',
  'estimated_net_profit',
  'margin_pct',
  'stock_value',
  'stock_cost_value',
]);

const ALWAYS_STRIPPED_KEYS = new Set([
  'encrypted_secret',
  'encrypted_key',
  'access_token_enc',
  'refresh_token_enc',
  'approval_token_hash',
  'password',
  'service_role_key',
]);

export function maskRecordForRole<T>(role: UserRole, value: T): T {
  const canSeeProfit = hasCapability(role, 'view_profit');

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(visit);
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const lower = k.toLowerCase();
        if (ALWAYS_STRIPPED_KEYS.has(lower)) {
          continue;
        }
        if (!canSeeProfit && SENSITIVE_PROFIT_KEYS.has(lower)) {
          out[k] = '[RESTRICTED]';
          continue;
        }
        out[k] = visit(v);
      }
      return out;
    }
    return node;
  };

  return visit(value) as T;
}

export function sanitizeUntrustedText(text: string): string {
  return String(text || '')
    .replace(/<\/?UNTRUSTED_BUSINESS_DATA>/gi, '')
    .replace(/\u0000/g, '')
    .slice(0, 600);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computePayloadHash(payload: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function generateProposalApprovalToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

export function verifyProposalApproval(params: {
  actorUserId: string;
  actorRole: string;
  status: string;
  expiresAt: string;
  storedPayload: unknown;
  storedPayloadHash: string;
  storedTokenHash: string;
  providedToken?: string;
}): { ok: boolean; error?: string } {
  if (params.actorRole !== 'owner' || params.actorUserId === 'ai_agent') {
    return { ok: false, error: 'Only an authenticated human Owner can approve AI proposals.' };
  }
  if (params.status !== 'pending') {
    return { ok: false, error: `Proposal is already ${params.status}.` };
  }
  if (new Date(params.expiresAt).getTime() <= Date.now()) {
    return { ok: false, error: 'Proposal approval window has expired.' };
  }
  const actualHash = computePayloadHash(params.storedPayload);
  if (actualHash !== params.storedPayloadHash) {
    return { ok: false, error: 'Proposal payload integrity check failed (hash mismatch).' };
  }
  if (params.providedToken) {
    const providedHash = crypto.createHash('sha256').update(params.providedToken).digest('hex');
    const a = Buffer.from(providedHash, 'hex');
    const b = Buffer.from(params.storedTokenHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: 'Invalid proposal approval token.' };
    }
  }
  return { ok: true };
}

export function redactSecretsFromText(input: string): string {
  return input
    .replace(/sk-[a-zA-Z0-9_-]{12,}/g, 'sk-[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

export function getDefaultEndpointForProvider(provider: AiProviderKind, customBaseUrl?: string | null): string {
  if (provider === 'custom') {
    return customBaseUrl?.trim() || '';
  }
  if (customBaseUrl && customBaseUrl.trim()) {
    return customBaseUrl.trim();
  }
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'grok':
      return 'https://api.x.ai/v1';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com';
    default:
      return '';
  }
}

export async function callConfiguredAiProvider(params: {
  provider: AiProviderKind;
  apiKey: string;
  model: string;
  baseUrl?: string | null;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ text: string; tokensUsed: number }> {
  const { provider, apiKey, model, baseUrl, systemPrompt, userPrompt } = params;
  if (!apiKey.trim()) {
    throw new Error('AI API key is not configured.');
  }

  if (provider === 'gemini') {
    const chosenModel = model.trim() || 'gemini-4-hydrogen';
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
    const response = await ai.models.generateContent({
      model: chosenModel,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.2,
      },
    });
    const text = response.text || '';
    const tokensUsed = Number(response.usageMetadata?.totalTokenCount || 0);
    return { text, tokensUsed };
  }

  const endpointBase = getDefaultEndpointForProvider(provider, baseUrl);
  const urlCheck = validateExternalHttpsUrl(endpointBase);
  if (!urlCheck.valid || !urlCheck.normalized) {
    throw new Error(urlCheck.error || 'Invalid AI provider URL.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    if (provider === 'anthropic') {
      const res = await fetch(`${urlCheck.normalized}/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model.trim() || 'claude-3-5-sonnet-latest',
          max_tokens: 1400,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      const data = (await res.json()) as {
        content?: Array<{ text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(redactSecretsFromText(data.error?.message || `Anthropic error (${res.status})`));
      }
      const text = (data.content || []).map((c) => c.text || '').join('\n');
      const tokensUsed = Number(data.usage?.input_tokens || 0) + Number(data.usage?.output_tokens || 0);
      return { text, tokensUsed };
    }

    const res = await fetch(`${urlCheck.normalized}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.trim() || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(redactSecretsFromText(data.error?.message || `Provider error (${res.status})`));
    }
    const text = data.choices?.[0]?.message?.content || '';
    const tokensUsed = Number(data.usage?.total_tokens || 0);
    return { text, tokensUsed };
  } finally {
    clearTimeout(timeout);
  }
}

export { Type as GeminiSchemaType };

function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export async function callAiStructuredJson<T>(params: {
  provider: AiProviderKind;
  apiKey: string;
  model: string;
  baseUrl?: string | null;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: Schema;
  attachment?: { mimeType: string; base64Data: string } | null;
}): Promise<{ data: T; tokensUsed: number }> {
  const {
    provider,
    apiKey,
    model,
    baseUrl,
    systemPrompt,
    userPrompt,
    responseSchema,
    attachment,
  } = params;

  if (!apiKey.trim()) {
    throw new Error('AI API key is not configured.');
  }

  if (provider === 'gemini') {
    const chosenModel = model.trim() || 'gemini-4-hydrogen';
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const parts: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [];
    if (attachment?.base64Data) {
      parts.push({
        inlineData: {
          mimeType: attachment.mimeType,
          data: attachment.base64Data,
        },
      });
    }
    parts.push({ text: userPrompt });

    const response = await ai.models.generateContent({
      model: chosenModel,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema,
      },
    });

    const text = stripJsonCodeFences(response.text || '{}');
    const tokensUsed = Number(response.usageMetadata?.totalTokenCount || 0);
    return {
      data: JSON.parse(text) as T,
      tokensUsed,
    };
  }

  if (attachment?.base64Data) {
    throw new Error(
      'Image/PDF document scanning requires Google Gemini (built-in or configured in Settings → Integrations).'
    );
  }

  const out = await callConfiguredAiProvider({
    provider,
    apiKey,
    model,
    baseUrl,
    systemPrompt: `${systemPrompt}\nReturn ONLY valid JSON matching the requested schema. No markdown fences or extra commentary.`,
    userPrompt,
  });

  const cleaned = stripJsonCodeFences(out.text);
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  const jsonSlice =
    firstBrace >= 0 && lastBrace > firstBrace
      ? cleaned.slice(firstBrace, lastBrace + 1)
      : cleaned;
  return {
    data: JSON.parse(jsonSlice) as T,
    tokensUsed: out.tokensUsed,
  };
}

