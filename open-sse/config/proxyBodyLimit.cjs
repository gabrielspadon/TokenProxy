// Shared with Next's proxy buffering option and the legacy h2c replay buffer.
function proxyClientMaxBodySize(env = process.env) {
  return env.TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE || "128mb";
}

function proxyClientMaxBodyBytes(env = process.env) {
  // Use the same bundled parser as Next's configuration normalization.
  const bytes = require("next/dist/compiled/bytes").parse(proxyClientMaxBodySize(env));
  if (!Number.isFinite(bytes) || bytes < 1) {
    throw new Error("TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE must be larger than 0 bytes");
  }
  return bytes;
}

module.exports = { proxyClientMaxBodySize, proxyClientMaxBodyBytes };
