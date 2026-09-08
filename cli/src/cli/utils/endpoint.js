/**
 * Get the local inference endpoint.
 * @param {number} port - Local server port
 * @returns {{endpoint: string}}
 */
function getEndpoint(port) {
  return { endpoint: `http://localhost:${port}/v1` };
}

module.exports = { getEndpoint };
