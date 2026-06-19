#!/usr/bin/env node
/**
 * berget-adapter — a tiny loopback proxy that lets Berget AI's OpenAI-compatible
 * endpoint accept the tool / function-calling schemas that OpenClaw (and other
 * strict OpenAI clients) emit.
 *
 * THE PROBLEM
 *   Berget's /v1 request validator rejects JSON-Schema "type" fields written as a
 *   union / nullable array — e.g.  {"type": ["string", "null"]}  — even though that
 *   form is valid per the JSON Schema and OpenAI function-calling specs. OpenClaw
 *   emits exactly this for optional tool parameters, so tool calls fail upstream
 *   with an HTTP 400 before the model ever sees them.
 *
 * THE FIX
 *   Recursively walk the outgoing request body and collapse every array-valued
 *   "type" to its single non-null member:
 *       {"type": ["string", "null"]}  ->  {"type": "string"}
 *   Everything else is forwarded byte-for-byte. Point OpenClaw's provider baseUrl
 *   at this proxy instead of api.berget.ai and tool calling just works.
 *
 * SECURITY / PRIVACY
 *   - Binds to loopback (127.0.0.1) only — never exposed off-host.
 *   - Holds NO credentials. Your `Authorization: Bearer <key>` header is forwarded
 *     verbatim from the client to Berget; nothing is read, rewritten, or stored.
 *   - Never logs request or response bodies — only upstream error status codes.
 *
 * CONFIG (all optional, via environment):
 *   BERGET_ADAPTER_PORT   listen port      (default 8899)
 *   BERGET_ADAPTER_HOST   listen address   (default 127.0.0.1)
 *   BERGET_UPSTREAM       upstream host     (default api.berget.ai)
 *   BERGET_ADAPTER_LOG    log file path     (default: stderr)
 *
 * No dependencies — Node's stdlib only.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');

const PORT = Number(process.env.BERGET_ADAPTER_PORT || 8899);
const HOST = process.env.BERGET_ADAPTER_HOST || '127.0.0.1';
const UPSTREAM = process.env.BERGET_UPSTREAM || 'api.berget.ai';
const LOG_PATH = process.env.BERGET_ADAPTER_LOG || '';

const log = (s) => {
  const line = new Date().toISOString() + ' ' + s + '\n';
  if (LOG_PATH) {
    try { fs.appendFileSync(LOG_PATH, line); } catch (_) { /* ignore log failures */ }
  } else {
    process.stderr.write(line);
  }
};

// Collapse union / nullable JSON-Schema "type" arrays to a single non-null type.
function fixTypes(node) {
  if (Array.isArray(node)) {
    node.forEach(fixTypes);
  } else if (node && typeof node === 'object') {
    if (Array.isArray(node.type)) {
      node.type = node.type.find((t) => t !== 'null') || node.type[0];
    }
    for (const k in node) fixTypes(node[k]);
  }
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let out = body;
    try {
      const json = JSON.parse(body);
      fixTypes(json);
      out = JSON.stringify(json);
    } catch (_) {
      // non-JSON or empty body (e.g. GET /v1/models) — forward unchanged
    }
    const buf = Buffer.from(out);
    const headers = { ...req.headers, host: UPSTREAM, 'content-length': buf.length };
    const upstream = https.request(
      'https://' + UPSTREAM + req.url,
      { method: req.method, headers },
      (pres) => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
        if (pres.statusCode >= 400) log('UPSTREAM ' + pres.statusCode + ' ' + req.url);
      }
    );
    upstream.on('error', (e) => {
      log('ERR ' + e.message);
      try { res.writeHead(502); } catch (_) { /* headers already sent */ }
      res.end('adapter error');
    });
    upstream.write(buf);
    upstream.end();
  });
}).listen(PORT, HOST, () => log(`berget-adapter up ${HOST}:${PORT} -> ${UPSTREAM}`));
