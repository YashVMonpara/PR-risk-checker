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
function applySafetyFloor(finding: RiskFinding, verdict: LLMVerdict): LLMVerdict {
  const isProtected = finding.category === 'security' && finding.level === 'error';
  if (!isProtected) return verdict;

  return {
    is_real_risk: true,
    severity: 'error',
    comment: verdict.comment,
  };
}
