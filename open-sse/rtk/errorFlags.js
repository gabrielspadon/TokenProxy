// Explicit error evidence only. Text mentioning an error is not a status flag.
export function isErrorResult(node) {
  return !!node && typeof node === "object" && (
    node.is_error === true || node.isError === true || node.error === true ||
    node.status === "error" || node.status === "failed"
  );
}
