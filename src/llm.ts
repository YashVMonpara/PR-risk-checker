import OpenAI from 'openai';
import { LLMOptions, LLMVerdict, RiskFinding, Severity } from './types';

/** Roughly 4 characters per token; keeps the diff context near ~1500 tokens. */
const DEFAULT_PROMPT_CHARS = 6000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = [
  'You are a senior code reviewer triaging static-analysis findings on a pull request.',
  'Judge ONLY the finding you are shown, using the diff context provided.',
  'If it is a genuine risk, set is_real_risk to true and write a concise, friendly,',
  'constructive inline review comment that names the risk and suggests a concrete fix.',
  'If it is a false positive, set is_real_risk to false.',
  'Never invent code that is not in the diff.',
].join(' ');

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    is_real_risk: { type: 'boolean' },
    severity: { type: 'string', enum: ['info', 'warning', 'error'] },
    comment: { type: 'string' },
  },
  required: ['is_real_risk', 'severity', 'comment'],
  additionalProperties: false,
} as const;

/** Trims text to a character budget, marking that it was cut. */
export function truncateForPrompt(text: string, maxChars = DEFAULT_PROMPT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (truncated)`;
}

export interface RawLLMInputs {
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * Decides which LLM backend to use, or none at all.
 *
 * Returns null when neither an API key nor a custom base URL is configured, in
 * which case the action runs deterministic rules only.
 */
export function buildLLMOptions(inputs: RawLLMInputs): LLMOptions | null {
  const apiKey = inputs.apiKey.trim();
  const baseURL = inputs.baseURL.trim();

  if (!apiKey && !baseURL) return null;

  return {
    // LM Studio ignores the key but the OpenAI SDK requires a non-empty string.
    apiKey: apiKey || 'lm-studio',
    baseURL: baseURL || undefined,
    model: inputs.model,
  };
}

/** Pulls a JSON object out of a model response that may be fenced or chatty. */
function parseVerdict(raw: string): LLMVerdict | null {
  const text = raw.trim();
  if (!text) return null;

  // Models that ignore the schema often answer with a bare SAFE.
  if (/^safe\.?$/i.test(text)) {
    return { is_real_risk: false, severity: 'info', comment: '' };
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (typeof parsed.is_real_risk !== 'boolean' || typeof parsed.comment !== 'string') {
      return null;
    }

    const severity: Severity = ['info', 'warning', 'error'].includes(parsed.severity)
      ? parsed.severity
      : 'warning';

    return { is_real_risk: parsed.is_real_risk, severity, comment: parsed.comment };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the LLM whether a static-analysis finding is a genuine risk.
 *
 * Returns null when the model is unavailable or unintelligible — the caller then
 * keeps the deterministic message.
 *
 * SAFETY: an error-level security finding is never dismissed or downgraded by the
 * model. A local model was observed answering "SAFE" to a textbook eval() injection,
 * so the LLM may enrich the wording of such findings but never suppress them.
 */
export async function assessRiskWithLLM(
  finding: RiskFinding,
  diffContext: string,
  filePath: string,
  options: LLMOptions
): Promise<LLMVerdict | null> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  const client = new OpenAI({
    apiKey: options.apiKey || 'lm-studio',
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: 0, // we handle retries ourselves for consistent logging
  });

  const userPrompt = [
    `FINDING: [${finding.category}] ${finding.message}`,
    `FILE: ${filePath}${finding.line ? `:${finding.line}` : ''}`,
    finding.snippet ? `OFFENDING LINE: ${finding.snippet}` : '',
    'DIFF CONTEXT:',
    truncateForPrompt(diffContext),
  ]
    .filter(Boolean)
    .join('\n');

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model: options.model,
        temperature: 0.1,
        max_tokens: 400,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'risk_verdict', strict: true, schema: VERDICT_SCHEMA },
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });

      const content = response.choices?.[0]?.message?.content ?? '';
      const verdict = parseVerdict(content);

      if (verdict) return applySafetyFloor(finding, verdict);

      lastError = new Error(`Unparseable LLM response: ${content.slice(0, 120)}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxRetries) {
      await sleep(2 ** (attempt - 1) * 500);
    }
  }

  console.warn(
    `LLM triage failed for ${finding.rule} on ${filePath} after ${maxRetries} attempt(s): ${lastError}`
  );
  return null;
}

/**
 * Prevents the model from suppressing or downplaying a high-severity security finding.
 * The model's wording is kept; only the verdict and severity are floored.
 */
/**
 * Asks the LLM to propose a *minimal, safe* fix for a single finding.
 *
 * Returns a structured patch (old_lines / new_lines / confidence / needs_user_input /
 * user_input_reason) or null when the model is unavailable or unintelligible.
 *
 * SAFETY MODEL (fail-closed):
 *  - The model must return strict JSON, not free text.
 *  - If the model says it is NOT confident, or flags the fix as needing user
 *    input, we return that as-is and the caller will NOT apply the patch.
 *  - The model is told never to fabricate code outside the file, never to
 *    remove unrelated lines, and never to rotate real secrets (it should say
 *    "needs_user_input" instead). The caller still verifies old_lines matches
 *    the file verbatim before applying anything.
 */
export interface FixProposal {
  /** The exact lines to replace (must appear verbatim in the file). */
  old_lines: string;
  /** The replacement lines. */
  new_lines: string;
  /** 0–1 confidence that this is correct and safe. */
  confidence: number;
  /**
   * When true, the model declined to auto-fix because it needs a human
   * decision (e.g. a real secret, a breaking change with external consumers,
   * ambiguous intent). `user_input_reason` explains what's needed.
   */
  needs_user_input: boolean;
  user_input_reason?: string;
  /** Short explanation of why the fix is safe. */
  rationale?: string;
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    old_lines: { type: 'string' },
    new_lines: { type: 'string' },
    confidence: { type: 'number' },
    needs_user_input: { type: 'boolean' },
    user_input_reason: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['old_lines', 'new_lines', 'confidence', 'needs_user_input'],
  additionalProperties: false,
} as const;

const FIX_SYSTEM_PROMPT = [
  'You are a senior engineer proposing a MINIMAL, SAFE fix for one static-analysis finding in a pull request.',
  'Rules:',
  '1. Return ONLY the exact lines that should be replaced (old_lines) and their replacement (new_lines).',
  '2. Keep the change as small as possible — do not refactor unrelated code.',
  '3. The new code must not break the surrounding file (matching indentation, imports, types).',
  '4. NEVER invent code outside this file. NEVER remove lines that are not part of the fix.',
  '5. If the issue is a real secret/credential, do NOT paste a new secret — set needs_user_input=true and',
  '   say the user must revoke it and load it from a secret manager / env var.',
  '6. If fixing requires a product decision, external API changes, or you are below 0.8 confidence, set',
  '   needs_user_input=true and explain what the user must decide.',
  '7. confidence is 0–1; be honest.',
].join(' ');

function parseFix(raw: string): FixProposal | null {
  const text = raw.trim();
  if (!text) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (typeof parsed.old_lines !== 'string' || typeof parsed.new_lines !== 'string') {
      return null;
    }
    const confidence =
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.5;
    return {
      old_lines: parsed.old_lines,
      new_lines: parsed.new_lines,
      confidence,
      needs_user_input: Boolean(parsed.needs_user_input),
      user_input_reason: parsed.user_input_reason || undefined,
      rationale: parsed.rationale || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Prevents the model from suppressing or downplaying a high-severity security finding.
 * The model's wording is kept; only the verdict and severity are floored.
 */
function applySafetyFloor(finding: RiskFinding, verdict: LLMVerdict): LLMVerdict {
  const isProtected = finding.category === 'security' && finding.level === 'error';
  if (!isProtected) return verdict;

  return {
    is_real_risk: true,
    severity: 'error',
    comment: verdict.comment,
  };
}

export async function generateFixWithLLM(
  finding: RiskFinding,
  fileContent: string,
  filePath: string,
  options: LLMOptions
): Promise<FixProposal | null> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  const client = new OpenAI({
    apiKey: options.apiKey || 'lm-studio',
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: 0,
  });

  const userPrompt = [
    `FINDING: [${finding.category}] ${finding.message}`,
    `FILE: ${filePath}${finding.line ? `:${finding.line}` : ''}`,
    finding.snippet ? `OFFENDING LINE: ${finding.snippet}` : '',
    'FULL FILE CONTENT (apply the fix here, keep everything else identical):',
    fileContent,
  ]
    .filter(Boolean)
    .join('\n');

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model: options.model,
        temperature: 0.1,
        max_tokens: 800,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'fix_proposal', strict: true, schema: FIX_SCHEMA },
        },
        messages: [
          { role: 'system', content: FIX_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });

      const content = response.choices?.[0]?.message?.content ?? '';
      const fix = parseFix(content);
      if (fix) return fix;
      lastError = new Error(`Unparseable fix response: ${content.slice(0, 120)}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxRetries) {
      await sleep(2 ** (attempt - 1) * 500);
    }
  }

  console.warn(`LLM fix failed for ${finding.rule} on ${filePath} after ${maxRetries} attempt(s): ${lastError}`);
  return null;
}
