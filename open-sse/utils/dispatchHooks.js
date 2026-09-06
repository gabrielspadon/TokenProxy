// A response whose accounting hook failed is not handed to a downstream reader.
// Start cancellation immediately without letting a slow cancellation promise
// replace or delay the original failure.
export async function notifyDispatchResponse(afterDispatch, response, nonacceptance) {
  if (!afterDispatch) return;
  try { await afterDispatch({ response, ...(nonacceptance ? { nonacceptance } : {}) }); }
  catch (error) {
    try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
    throw error;
  }
}
