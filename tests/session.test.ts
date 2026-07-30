import { expect, test } from "bun:test";

const baseUrl = process.env.SUBPOLAR_TEST_URL;
const email = process.env.SUBPOLAR_TEST_EMAIL;
const password = process.env.SUBPOLAR_TEST_PASSWORD;

if (!baseUrl || !email || !password) {
  test.skip("session lifecycle requires SUBPOLAR_TEST_URL, SUBPOLAR_TEST_EMAIL, and SUBPOLAR_TEST_PASSWORD", () => {});
} else {
  test("session is issued, authorizes requests, and is revoked at sign-out", async () => {
    const signIn = await fetch(`${baseUrl}/api/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status).toBe(200);
    const { token } = (await signIn.json()) as { token: string };
    expect(token).toStartWith("sps_");

    const me = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);

    const signOut = await fetch(`${baseUrl}/api/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(signOut.status).toBe(200);

    const revoked = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(revoked.status).toBe(401);
  });
}
