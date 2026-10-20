/**
 * Checks that a product question reads for a product owner: no developer words, no code, short
 * sentences, about an 8th-grade level. The PM tool bounces anything that fails, with the reasons.
 */

const MAX_QUESTION_WORDS = 45;
const MAX_SENTENCE_WORDS = 28;
const MAX_GRADE = 9.5;

/** Developer and systems words a product owner should never have to look up. */
const JARGON = [
  'api',
  'apis',
  'endpoint',
  'endpoints',
  'dto',
  'dtos',
  'payload',
  'json',
  'xml',
  'component',
  'components',
  'mapper',
  'mappers',
  'feature flag',
  'feature flags',
  'launchdarkly',
  'null',
  'undefined',
  'boolean',
  'enum',
  'enums',
  'string',
  'integer',
  'schema',
  'migration',
  'pr',
  'prs',
  'pull request',
  'branch',
  'commit',
  'merge',
  'merged',
  'lint',
  'backend',
  'frontend',
  'front-end',
  'back-end',
  'client-side',
  'server-side',
  'http',
  'https',
  'token',
  'jwt',
  'auth',
  'cache',
  'redis',
  'mulesoft',
  'mule',
  'nestjs',
  'nest',
  'angular',
  'kendo',
  'bff',
  'controller',
  'controllers',
  'query',
  'queries',
  'regex',
  'sdk',
  'cli',
  'repo',
  'repository',
  'library',
  'libs',
  'module',
  'modules',
  'typescript',
  'javascript',
  'css',
  'html',
  'dom',
  'refactor',
  'microflow',
  'nanoflow',
  'domain model',
  'entity',
  'entities',
  'attribute',
  'attributes',
  'parameter',
  'parameters',
  'param',
  'params',
  'config',
  'configuration',
  'env',
  'environment variable',
  'deploy',
  'deployment',
  'heroku',
  'azure',
  'onpush',
  'observable',
  'signal',
  'signals',
  'rxjs',
  'websocket',
  'socket',
  'timeout',
  'retry',
  'throttle',
  'validation',
  'validator',
  'serialize',
  'deserialize',
  'parse',
  'parser',
  'soap',
  'rfc',
  'bapi',
  'idoc',
  'wsdl',
  '4xx',
  '5xx',
  '400',
  '401',
  '403',
  '404',
  '500',
  '503',
];

const JARGON_RE = new RegExp(
  `\\b(${JARGON.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`,
  'gi',
);
/** Identifiers the way code writes them: camelCase, PascalCase with an inner capital, snake_case, SCREAMING_CASE. */
const CODE_WORD_RE =
  /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+|[A-Z]{2,}_[A-Z0-9_]+)\b/g;
const CODE_MARK_RE = /[`{}<>]|\.(ts|js|json|html|scss|md)\b|https?:\/\/|[A-Za-z]:\\|\/[a-z]+\/[a-z]/;
/** Short all-caps codes like ORDNO or CUSTID that only mean something inside one system. */
const FIELD_CODE_RE = /\b[A-Z]{4,6}\b/g;
/** Everyday all-caps words; a config's productTerms adds a company's own. */
const ALLOWED_CAPS = new Set(['ADO', 'PO', 'QA', 'UAT', 'USA']);

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A rough syllable count, good enough for a grade-level estimate. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch-Kincaid grade level; 8 reads like an eighth grader's textbook. */
export function gradeLevel(text: string): number {
  const ws = words(text);
  const ss = sentences(text);
  if (!ws.length || !ss.length) return 0;
  const syl = ws.reduce((n, w) => n + syllables(w), 0);
  return Math.round((0.39 * (ws.length / ss.length) + 11.8 * (syl / ws.length) - 15.59) * 10) / 10;
}

/** Every reason the text is not ready for a product owner; empty when it is. */
export function plainEnglishIssues(
  text: string,
  kind: 'question' | 'note' | 'option' = 'note',
  productTerms: Iterable<string> = [],
): string[] {
  const allowed = new Set([...ALLOWED_CAPS, ...productTerms]);
  const issues: string[] = [];
  const t = text.trim();
  if (!t) return kind === 'question' ? ['the question is empty'] : [];
  if (kind === 'question' && !/\?\s*$/.test(t)) issues.push('a question ends with a question mark');
  if (CODE_MARK_RE.test(t)) issues.push('no code, file names, paths, or links');
  const codeWords = [...new Set(t.match(CODE_WORD_RE) ?? [])];
  if (codeWords.length) issues.push(`no identifiers from the code: ${codeWords.slice(0, 4).join(', ')}`);
  const jargon = [...new Set((t.match(JARGON_RE) ?? []).map((w) => w.toLowerCase()))];
  if (jargon.length) issues.push(`no developer words: ${jargon.slice(0, 5).join(', ')}`);
  const fieldCodes = [...new Set((t.match(FIELD_CODE_RE) ?? []).filter((c) => !allowed.has(c)))];
  if (fieldCodes.length) issues.push(`no system field codes: ${fieldCodes.slice(0, 4).join(', ')}`);
  const ws = words(t);
  const maxWords = kind === 'question' ? MAX_QUESTION_WORDS : kind === 'option' ? 16 : 90;
  if (ws.length > maxWords) issues.push(`too long: ${ws.length} words, keep it under ${maxWords}`);
  const long = sentences(t).find((s) => words(s).length > MAX_SENTENCE_WORDS);
  if (long) issues.push(`a sentence runs past ${MAX_SENTENCE_WORDS} words; split it`);
  const grade = gradeLevel(t);
  if (grade > MAX_GRADE && ws.length >= 8)
    issues.push(`reads at about grade ${Math.round(grade)}; aim for grade 8 or lower`);
  return issues;
}
