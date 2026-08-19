/**
 * NIP-50 `search` filter parsing + SIP-01 operator semantics.
 *
 * NIP-50 defines the `search` filter field and sanctions `key:value`
 * extension pairs (relays SHOULD ignore extensions they don't support).
 * SIP-01 §15 defines the meaning of the web-search operators on aware
 * relays: site:, domain:, url:, inurl:, title:, topic:, type:, platform:,
 * category:, network:, country:, mime:, filetype:, source:, lang:, before:,
 * after:, distinct:domain — each with a negated `-op:` form.
 *
 * Semantics are aligned with the SIP-01 relay profile (UNCAGED-Index-Relay):
 *   - repeated operators of the same kind OR together (site:a site:b);
 *   - `title:`/`inurl:` tokens AND;
 *   - `url:`/`before:`/`after:` take the first usable token;
 *   - `before:`/`after:` filter on the page's claimed publication time
 *     (the `published` tag) — documents without one never match the positive
 *     form; observation time stays available via the NIP-01 since/until
 *     filter fields;
 *   - `language:` is accepted as an alias of `lang:`;
 *   - unusable operator values add no clause (never an error).
 *
 * This relay additionally supports the relay-profile operators `indexer:`,
 * `x:` and `d:` (documented in docs/API.md). Unknown operators are ignored
 * per NIP-50, so mixed-reality query fan-out stays safe.
 *
 * Plain ES module JavaScript: shared by the Worker (SQL building), the
 * browser UI (query preview), and the Node test suite.
 *
 * @module shared/search-query
 */

import { normalizeIndexUrl, searchHostValue } from './sip01.js';

/** Operators this relay implements (advertised in NIP-11 `uncaged_index.filters`). */
export const SUPPORTED_NIP50_OPERATORS = /** @type {const} */ ([
  'site', 'domain', 'url', 'inurl', 'title', 'topic', 'type', 'platform',
  'category', 'network', 'country', 'mime', 'filetype', 'source', 'lang',
  'before', 'after', 'indexer', 'x', 'd', 'distinct:domain',
]);

/**
 * @typedef {Object} SearchOp
 * @property {string} op       Operator name (lowercased; `language` aliased to `lang`).
 * @property {string} value    Raw operator value.
 * @property {boolean} negated True for the `-op:value` form.
 */

/**
 * @typedef {Object} ParsedSearchQuery
 * @property {string[]} keywords  Plain lowercase terms (AND semantics).
 * @property {string[]} phrases   Exact quoted phrases (AND semantics).
 * @property {SearchOp[]} ops     Recognized operators in order.
 * @property {string[]} ignored   `key:value` pairs that are not supported
 *                                (kept for transparency; ignored per NIP-50).
 * @property {boolean} distinctDomain  `distinct:domain` present.
 * @property {string} raw         Original query string.
 */

const KNOWN_OPS = new Set([...SUPPORTED_NIP50_OPERATORS.filter((op) => op !== 'distinct:domain'), 'language']);

/**
 * Parse a NIP-50 search string. Grammar:
 *
 *   query    := token*
 *   token    := phrase | operator | word
 *   phrase   := '"' ... '"'                (exact substring)
 *   operator := ['-'] name ':' value       (value may be "quoted")
 *   word     := bare whitespace-delimited text (case-insensitive substring)
 *
 * @param {string} input
 * @returns {ParsedSearchQuery}
 */
export function parseSearchQuery(input) {
  const raw = String(input ?? '');
  /** @type {ParsedSearchQuery} */
  const out = { keywords: [], phrases: [], ops: [], ignored: [], distinctDomain: false, raw };

  // Tokenizer: op:"quoted value" stays one token, bare "quoted phrases" stay
  // whole, everything else splits on whitespace.
  const tokens = [];
  const re = /(-?[a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z]+)?:"[^"]*")|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ text: m[1], quoted: false }); // operator with quoted value
    } else if (m[2] !== undefined) {
      tokens.push({ text: m[2], quoted: true });
    } else {
      tokens.push({ text: m[3], quoted: false });
    }
  }

  for (const token of tokens) {
    const text = token.text;
    if (!text) continue;

    // Operator shape: [-]name:value (`distinct:domain` tokenizes as
    // op `distinct` + value `domain`).
    const opMatch = /^(-?)([a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z]+)?):(.+)$/.exec(text);
    if (!token.quoted && opMatch) {
      const negated = opMatch[1] === '-';
      let op = opMatch[2].toLowerCase();
      let value = opMatch[3];
      // Strip surrounding quotes from values like site:"github.com".
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      if (op === 'distinct:domain' || op === 'distinct') {
        if (op === 'distinct:domain' || (op === 'distinct' && value === 'domain')) {
          if (!negated) out.distinctDomain = true;
        } else {
          out.ignored.push(`${op}:${value}`);
        }
        continue;
      }
      // NIP-50's own registered `language:` extension aliases to `lang:`.
      if (op === 'language') op = 'lang';
      if (KNOWN_OPS.has(op)) {
        out.ops.push({ op, value, negated });
      } else {
        out.ignored.push(`${op}:${value}`);
      }
      continue;
    }

    // Bare `distinct:domain` without value.
    if (!token.quoted && /^(-?)distinct:domain$/.test(text)) {
      if (!text.startsWith('-')) out.distinctDomain = true;
      continue;
    }

    if (token.quoted) {
      out.phrases.push(text);
    } else {
      out.keywords.push(text.toLowerCase());
    }
  }

  return out;
}

/**
 * Parse a before:/after: value: unix seconds or an ISO calendar date
 * (YYYY-MM-DD, UTC midnight). Anything else returns null and adds no clause —
 * matching the reference relay profile.
 * @param {string} value
 * @returns {number | null}
 */
export function parseDateValue(value) {
  const v = String(value).trim();
  if (/^\d{1,16}$/.test(v)) return Number.parseInt(v, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Common filetype → MIME aliases (the `filetype:` operator). */
export const FILETYPE_MIME_MAP = /** @type {const} */ ({
  pdf: 'application/pdf',
  html: 'text/html',
  txt: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  md: 'text/markdown',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
});

/** Escape a string for use inside a SQL LIKE ... ESCAPE '\'. */
export function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/* ------------------------------------------------------------------ */
/* Operator grouping — one shared definition of how ops combine        */
/* ------------------------------------------------------------------ */

/** Operators that OR across repeated values (`terms` semantics). */
export const OR_OPERATORS = new Set([
  'site', 'domain', 'topic', 'type', 'platform', 'category', 'network',
  'country', 'lang', 'mime', 'filetype', 'source', 'indexer', 'x', 'd',
]);

/** Text operators that AND across repeated tokens (one clause each). */
export const AND_TEXT_OPERATORS = new Set(['title', 'inurl']);

/** Operators where only the first usable token applies. */
export const FIRST_ONLY_OPERATORS = new Set(['url', 'before', 'after']);

/**
 * @typedef {Object} GroupedOps
 * @property {{ op: string, values: string[], negated: boolean }[]} orGroups
 * @property {{ op: 'title'|'inurl', value: string, negated: boolean }[]} andText
 * @property {SearchOp[]} firstOnly   url:/before:/after: winners (per op+polarity)
 */

/**
 * Group parsed operators exactly the way both execution paths (SQL and the
 * in-memory matcher) combine them. Parity here is the whole point: live
 * subscription delivery must return the same set the stored query returns.
 *
 * @param {ParsedSearchQuery} parsed
 * @returns {GroupedOps}
 */
export function groupSearchOps(parsed) {
  /** @type {GroupedOps} */
  const out = { orGroups: [], andText: [], firstOnly: [] };

  /** @type {Map<string, { op: string, values: string[], negated: boolean }>} */
  const orMap = new Map();
  /** @type {Set<string>} */
  const firstSeen = new Set();

  for (const op of parsed.ops) {
    const key = `${op.negated ? '-' : ''}${op.op}`;
    if (OR_OPERATORS.has(op.op)) {
      const group = orMap.get(key) || { op: op.op, values: [], negated: op.negated };
      group.values.push(op.value);
      orMap.set(key, group);
    } else if (AND_TEXT_OPERATORS.has(op.op)) {
      out.andText.push({ op: /** @type {'title'|'inurl'} */ (op.op), value: op.value, negated: op.negated });
    } else if (FIRST_ONLY_OPERATORS.has(op.op)) {
      if (!firstSeen.has(key)) {
        firstSeen.add(key);
        out.firstOnly.push(op);
      }
    }
    // anything else was already filtered by the parser
  }

  out.orGroups = [...orMap.values()];
  return out;
}

/* ------------------------------------------------------------------ */
/* In-memory matcher (live subscription delivery + tests)              */
/* ------------------------------------------------------------------ */

/**
 * Evaluate one grouped OR operation against extracted fields.
 * Returns undefined when no usable value exists (→ adds no clause),
 * otherwise true/false for "the document matches these values".
 */
function matchOrGroup(group, fields) {
  const host = (fields.url_host || '').toLowerCase();
  const url = (fields.url || '').toLowerCase();
  const topics = fields.topics || [];
  let sawUsable = false;
  let any = false;

  for (const value of group.values) {
    let hit;
    switch (group.op) {
      case 'site': {
        const h = searchHostValue(value);
        if (h === undefined) continue;
        sawUsable = true;
        hit = host === h || host.endsWith('.' + h);
        break;
      }
      case 'domain': {
        const h = searchHostValue(value);
        if (h === undefined) continue;
        sawUsable = true;
        hit = host === h;
        break;
      }
      case 'topic':
        sawUsable = true;
        hit = topics.includes(value.toLowerCase());
        break;
      case 'type':
        sawUsable = true;
        hit = fields.doc_type === value.toLowerCase();
        break;
      case 'platform':
        sawUsable = true;
        hit = fields.platform === value.toLowerCase();
        break;
      case 'category':
        sawUsable = true;
        hit = fields.category === value.toLowerCase();
        break;
      case 'network':
        sawUsable = true;
        hit = fields.network === value.toLowerCase();
        break;
      case 'country':
        sawUsable = true;
        hit = fields.country === value.toUpperCase();
        break;
      case 'lang':
        sawUsable = true;
        hit = fields.language === value.toLowerCase();
        break;
      case 'mime':
        sawUsable = true;
        hit = (fields.content_type || '') === value.toLowerCase();
        break;
      case 'filetype': {
        sawUsable = true;
        const ft = value.replace(/^\./, '').toLowerCase();
        const alias = FILETYPE_MIME_MAP[ft];
        hit = fields.file_ext === ft || (alias !== undefined && fields.content_type === alias);
        break;
      }
      case 'source':
        sawUsable = true;
        hit = fields.source === value || fields.software === value;
        break;
      case 'indexer':
        sawUsable = true;
        hit = fields.indexer === value.toLowerCase();
        break;
      case 'x':
        sawUsable = true;
        hit = fields.content_hash === value.toLowerCase();
        break;
      case 'd':
        sawUsable = true;
        hit = fields.d === value;
        break;
      default:
        continue;
    }
    if (hit) any = true;
  }

  return sawUsable ? any : undefined;
}

/**
 * In-memory match of a parsed query against extracted SIP-01 fields — the
 * exact semantics of the SQL path (used for live subscription delivery in
 * the Durable Object and by tests).
 *
 * @param {ParsedSearchQuery} parsed
 * @param {import('./sip01.js').Sip01Fields & { indexer?: string, last_seen?: number }} fields
 *   Document fields. `indexer` (event pubkey) enables the indexer: operator;
 *   `published_at` drives before:/after: (page-claimed publication time).
 * @returns {boolean}
 */
export function matchSip01Search(parsed, fields) {
  const title = (fields.title || '').toLowerCase();
  const description = (fields.description || '').toLowerCase();
  const url = (fields.url || '').toLowerCase();

  const textHit = (needleRaw) => {
    const needle = needleRaw.toLowerCase();
    return title.includes(needle) || description.includes(needle) || url.includes(needle);
  };

  for (const kw of parsed.keywords) if (!textHit(kw)) return false;
  for (const ph of parsed.phrases) if (!textHit(ph)) return false;

  const grouped = groupSearchOps(parsed);

  // OR groups: a group with no usable value adds no clause.
  for (const group of grouped.orGroups) {
    const result = matchOrGroup(group, fields);
    if (result === undefined) continue;
    if (group.negated ? result : !result) return false;
  }

  // title:/inurl: AND per token.
  for (const { op, value, negated } of grouped.andText) {
    const haystack = op === 'title' ? title : url;
    const hit = haystack.includes(value.toLowerCase());
    if (negated ? hit : !hit) return false;
  }

  // First-only operators.
  for (const { op, value, negated } of grouped.firstOnly) {
    if (op === 'url') {
      const n = normalizeIndexUrl(value);
      // Reference behavior: an unparseable value falls back to the raw string
      // (which simply matches nothing for the positive form).
      const hit = n !== null ? fields.url === n : url === value.toLowerCase();
      if (negated ? hit : !hit) return false;
    } else {
      const ts = parseDateValue(value);
      if (ts === null) continue; // unusable → no clause
      const published = fields.published_at;
      // Positive: documents without a published date never match.
      // Negated:  only documents *with* a matching date are excluded.
      const hit = published !== undefined && published !== null &&
        (op === 'before' ? published < ts : published >= ts);
      if (negated ? hit : !hit) return false;
    }
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* SQL building (Worker side; pure string logic, unit-tested in Node)  */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} SqlFragment
 * @property {string} sql
 * @property {any[]} params
 */

/**
 * SQL WHERE fragments for one OR group over `sip01_documents` (alias `doc`)
 * and, for event-level operators, the observations join (alias `o`).
 * Returns null when no usable value exists (→ adds no clause).
 */
function sqlForOrGroup(group) {
  /** @type {string[]} */
  const clauses = [];
  /** @type {any[]} */
  const params = [];

  const usable = [];
  for (const value of group.values) {
    if ((group.op === 'site' || group.op === 'domain')) {
      const h = searchHostValue(value);
      if (h !== undefined) usable.push(h);
    } else {
      usable.push(value);
    }
  }
  if (usable.length === 0) return null;

  const lower = usable.map((v) => v.toLowerCase());
  const inList = (n) => `(${Array(n).fill('?').join(',')})`;

  switch (group.op) {
    case 'site': {
      for (const h of usable) {
        clauses.push(`(doc.url_host = ? OR doc.url_host LIKE '%.' || ?)`);
        params.push(h, h);
      }
      break;
    }
    case 'domain':
      clauses.push(`doc.url_host IN ${inList(usable.length)}`);
      params.push(...usable);
      break;
    case 'topic':
      clauses.push(`EXISTS (SELECT 1 FROM json_each(doc.topics) je WHERE je.value IN ${inList(usable.length)})`);
      params.push(...lower);
      break;
    case 'type':
      clauses.push(`doc.doc_type IN ${inList(usable.length)}`);
      params.push(...lower);
      break;
    case 'platform':
      clauses.push(`doc.platform IN ${inList(usable.length)}`);
      params.push(...lower);
      break;
    case 'category':
      clauses.push(`doc.category IN ${inList(usable.length)}`);
      params.push(...lower);
      break;
    case 'network':
      clauses.push(`doc.network IN ${inList(usable.length)}`);
      params.push(...lower);
      break;
    case 'country':
      clauses.push(`doc.country IN ${inList(usable.length)}`);
      params.push(...usable.map((v) => v.toUpperCase()));
      break;
    case 'lang':
      clauses.push(`doc.language IN ${inList(usable.length)}`);
      params.push(...lower);
      break;
    case 'mime':
      clauses.push(`doc.content_type IN ${inList(usable.length)}`);
      params.push(...lower);
      break;
    case 'filetype': {
      for (const raw of usable) {
        const ft = raw.replace(/^\./, '').toLowerCase();
        const alias = FILETYPE_MIME_MAP[ft];
        if (alias) {
          clauses.push(`(doc.file_ext = ? OR doc.content_type = ?)`);
          params.push(ft, alias);
        } else {
          clauses.push(`doc.file_ext = ?`);
          params.push(ft);
        }
      }
      break;
    }
    case 'source':
      // event-level: this observation's crawler software
      clauses.push(`o.source IN ${inList(usable.length)}`);
      params.push(...usable);
      break;
    case 'indexer':
      // event-level: this observation's indexer pubkey
      clauses.push(`o.pubkey IN ${inList(usable.length)}`);
      params.push(...lower);
      break;
    case 'x':
      clauses.push(`o.content_hash IN ${inList(usable.length)}`);
      params.push(...lower);
      break;
    case 'd':
      clauses.push(`doc.d IN ${inList(usable.length)}`);
      params.push(...usable);
      break;
    default:
      return null;
  }

  const joined = clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
  return { sql: group.negated ? `NOT (${joined})` : `(${joined})`, params };
}

/**
 * Build the WHERE conditions for a parsed query, split by the relation they
 * target: `doc.*` (document index, applied in the inner query) and
 * `o.*`/`e.*` (observation/event level, applied after the join).
 *
 * @param {ParsedSearchQuery} parsed
 * @returns {{ docConditions: string[], docParams: any[], eventConditions: string[], eventParams: any[] }}
 */
export function buildSip01SearchConditions(parsed) {
  /** @type {string[]} */
  const docConditions = [];
  /** @type {any[]} */
  const docParams = [];
  /** @type {string[]} */
  const eventConditions = [];
  /** @type {any[]} */
  const eventParams = [];

  const pushText = (needleRaw, negated) => {
    const needle = `%${escapeLike(needleRaw.toLowerCase())}%`;
    const clause =
      `(lower(doc.title) LIKE ? ESCAPE '\\' OR lower(doc.description) LIKE ? ESCAPE '\\' OR lower(doc.canonical_url) LIKE ? ESCAPE '\\')`;
    docConditions.push(negated ? `NOT ${clause}` : clause);
    docParams.push(needle, needle, needle);
  };

  for (const kw of parsed.keywords) pushText(kw, false);
  for (const ph of parsed.phrases) pushText(ph, false);

  const grouped = groupSearchOps(parsed);

  for (const group of grouped.orGroups) {
    const fragment = sqlForOrGroup(group);
    if (!fragment) continue; // no usable values → no clause
    // Event-level groups (source:/indexer:/x:) join the outer query.
    if (group.op === 'source' || group.op === 'indexer' || group.op === 'x') {
      eventConditions.push(fragment.sql);
      eventParams.push(...fragment.params);
    } else {
      docConditions.push(fragment.sql);
      docParams.push(...fragment.params);
    }
  }

  for (const { op, value, negated } of grouped.andText) {
    const column = op === 'title' ? 'doc.title' : 'doc.canonical_url';
    const clause = `lower(${column}) LIKE ? ESCAPE '\\'`;
    docConditions.push(negated ? `NOT (${clause})` : `(${clause})`);
    docParams.push(`%${escapeLike(value.toLowerCase())}%`);
  }

  for (const { op, value, negated } of grouped.firstOnly) {
    if (op === 'url') {
      const n = normalizeIndexUrl(value);
      // Reference behavior: unparseable values fall back to the raw string
      // (which matches nothing in the positive form).
      const clause = `doc.canonical_url = ?`;
      docConditions.push(negated ? `NOT (${clause})` : `(${clause})`);
      docParams.push(n ?? value);
    } else {
      const ts = parseDateValue(value);
      if (ts === null) continue; // unusable → no clause
      // before:/after: filter the page's claimed publication time
      // (`published` tag). Positive: docs without published_at never match
      // (NULL comparison is not true). Negated: only docs *with* a matching
      // date are excluded, so NULL rows are kept explicitly.
      const range = op === 'before' ? `doc.published_at < ?` : `doc.published_at >= ?`;
      docConditions.push(negated ? `(doc.published_at IS NULL OR NOT (${range}))` : `(${range})`);
      docParams.push(ts);
    }
  }

  return { docConditions, docParams, eventConditions, eventParams };
}

/**
 * Rank expression for SIP-01 search results (higher is better). NIP-50:
 * results are returned in descending order of quality, not created_at.
 *
 * Signals: keyword coverage of the title/description, independent indexer
 * agreement (the core SIP-01 signal), and freshness as a tiebreak. Kept as
 * pure SQL so D1 evaluates it inside the index scan.
 *
 * @param {ParsedSearchQuery} parsed
 * @returns {{ rankSql: string, params: any[] }}
 */
export function buildSip01Rank(parsed) {
  /** @type {any[]} */
  const params = [];
  const parts = [];

  // +4 per keyword/phrase present in the title, +2 in the description.
  for (const termRaw of [...parsed.keywords, ...parsed.phrases]) {
    const term = `%${escapeLike(termRaw.toLowerCase())}%`;
    parts.push(`(CASE WHEN lower(doc.title) LIKE ? ESCAPE '\\' THEN 4 ELSE 0 END)`);
    params.push(term);
    parts.push(`(CASE WHEN lower(doc.description) LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END)`);
    params.push(term);
  }

  // Independent indexer agreement: bounded boost (capped at +8).
  parts.push(`(CASE WHEN doc.indexer_count >= 8 THEN 8 ELSE doc.indexer_count END)`);

  // Recency tiebreak, small bounded term (newer last_seen → up to +2).
  parts.push(`(CASE WHEN doc.last_seen > 0 THEN 2.0 * (doc.last_seen % 1000000) / 1000000.0 ELSE 0 END)`);

  const rankSql = parts.length > 0 ? parts.join(' + ') : '0';
  return { rankSql, params };
}

/**
 * Assemble the full SIP-01 search statement: ranked matching documents
 * joined through observations to the underlying kind 39697 events, so a
 * search returns real Nostr events (one per indexer observation) in rank
 * order — exactly what search engines need to compute independent agreement.
 *
 * @param {ParsedSearchQuery} parsed
 * @param {number} limit Max events to return (already clamped by the caller).
 * @param {{ extraConditions?: string[], extraParams?: any[] }} [extras]
 *   Additional event-level restrictions (alias `e`): authors, ids,
 *   since/until, `#tag` EXISTS clauses — the NIP-50 "other filter fields".
 * @returns {SqlFragment}
 */
export function buildSip01SearchSql(parsed, limit, extras = {}) {
  const { docConditions, docParams, eventConditions, eventParams } = buildSip01SearchConditions(parsed);
  const { rankSql, params: rankParams } = buildSip01Rank(parsed);

  const where = docConditions.length > 0 ? `WHERE ${docConditions.join(' AND ')}` : '';

  const docSelect = `
    SELECT doc.d AS d, doc.last_seen AS last_seen, (${rankSql}) AS rank
    FROM sip01_documents doc
    ${where}
  `;

  // distinct:domain — best-ranked row per host (SQLite bare-column + MAX
  // aggregate semantics: bare columns come from a row with the max value).
  const docSet = parsed.distinctDomain
    ? `
    SELECT d, MAX(rank) AS rank, MAX(last_seen) AS last_seen FROM (
      SELECT doc.d AS d, doc.url_host AS url_host, doc.last_seen AS last_seen, (${rankSql}) AS rank
      FROM sip01_documents doc
      ${where}
    ) GROUP BY url_host
  `
    : docSelect;

  const outerConditions = [...eventConditions, ...(extras.extraConditions ?? [])];
  const outerWhere = outerConditions.length > 0 ? `WHERE ${outerConditions.join(' AND ')}` : '';

  const sql = `
    SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig, r.rank
    FROM (${docSet}) r
    JOIN sip01_observations o ON o.d = r.d
    JOIN events e ON e.id = o.event_id
    ${outerWhere}
    ORDER BY r.rank DESC, e.created_at DESC
    LIMIT ?
  `;

  // Parameter order follows textual order in the assembled statement:
  // rank expression (SELECT list), document WHERE, outer WHERE, LIMIT.
  const baseParams = [...rankParams, ...docParams, ...eventParams, ...(extras.extraParams ?? []), limit];

  return { sql, params: baseParams };
}
