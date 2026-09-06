export const PASSWORD = process.env.SMOKE_PASSWORD || "123456";

export async function signIn(page) {
  const res = await page.request.post("/api/auth/login", { data: { password: PASSWORD } });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()} ${await res.text()}`);
}

export function json(status, body, headers = {}) {
  return { status, contentType: "application/json", headers, body: JSON.stringify(body) };
}
