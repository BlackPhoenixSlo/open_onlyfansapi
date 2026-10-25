// Loopback-only network guard for the slop stack's Node processes (TS API, Vite), loaded with
// NODE_OPTIONS=--require <this file>. Patches net.Socket#connect and dns.lookup in that process: a host that is not
// localhost / a loopback literal is refused (the socket errors with ECONNREFUSED-like "slop guard") and appended to
// $SLOP_GUARD_LOG as JSONL. Unix sockets and pipes pass. Not service code: a hook outside it.
'use strict';
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');

const LOG = process.env.SLOP_GUARD_LOG;
const NAMES = new Set(['localhost', 'localhost.', '::1', '[::1]']);

function loopback(host) {
  if (host === undefined || host === null || host === '') return true;
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (NAMES.has(h)) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  if (net.isIPv6(h)) return h === '::1' || h.startsWith('::ffff:127.');
  return false;
}

// Resolving the wildcard address (Vite does while picking its listen host) reaches nothing: a lookup may pass.
// A connect to it still must be loopback.
const WILDCARD = new Set(['0.0.0.0', '::', '0000:0000:0000:0000:0000:0000:0000:0000']);
const lookupOk = (host) => loopback(host) || WILDCARD.has(String(host).replace(/^\[|\]$/g, '').toLowerCase());

function refuse(kind, host) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({ t: Date.now() / 1000, pid: process.pid, kind, host: String(host) }) + '\n');
  } catch {}
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0]; // internal normalized form
  let host;
  if (opts && typeof opts === 'object') {
    if (opts.path) return realConnect.apply(this, args);
    host = opts.host;
  } else if (typeof opts === 'string' && isNaN(Number(opts))) {
    return realConnect.apply(this, args); // a pipe path
  } else if (typeof args[1] === 'string') {
    host = args[1];
  }
  if (host !== undefined && !loopback(host)) {
    refuse('connect', host);
    const err = Object.assign(new Error(`slop guard: connect to ${host} is off-host`), { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return realConnect.apply(this, args);
};

const realLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  if (!lookupOk(hostname)) {
    refuse('lookup', hostname);
    const err = Object.assign(new Error(`slop guard: ${hostname} is off-host`), { code: 'ENOTFOUND', hostname });
    process.nextTick(() => cb(err));
    return {};
  }
  return realLookup.apply(this, arguments);
};
const realPLookup = dns.promises.lookup;
dns.promises.lookup = async function (hostname, ...rest) {
  if (!lookupOk(hostname)) {
    refuse('lookup', hostname);
    throw Object.assign(new Error(`slop guard: ${hostname} is off-host`), { code: 'ENOTFOUND', hostname });
  }
  return realPLookup.call(this, hostname, ...rest);
};
