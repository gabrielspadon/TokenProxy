import { CLAUDE_CONFIG } from "../constants/oauth.js";
import { extractClaudeAccountInfo } from "../providerHelpers.js";

const claude = {
  config: CLAUDE_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      code: "true",
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: config.scopes.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod,
      state: state,
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier, state) => {
    // Parse code - may contain state after #
    let authCode = code;
    let codeState = "";
    if (authCode.includes("#")) {
      const parts = authCode.split("#");
      authCode = parts[0];
      codeState = parts[1] || "";
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        code: authCode,
        state: codeState || state,
        grant_type: "authorization_code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  },
  // The token response carries `account {uuid, email_address}` and
  // `organization {uuid, name}` beside the token. Dropping them is what left
  // every Claude row with a null email and no upstream id, so the typed name
  // was the only identity the row had. They are persisted now.
  //
  // The account uuid matters more than the email: one login routinely holds a
  // personal seat AND an organisation seat with independent quota windows, and
  // only the uuid tells those two apart.
  mapTokens: (tokens) => {
    const identity = extractClaudeAccountInfo(tokens);
    const mapped = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    };
    if (identity.email) mapped.email = identity.email;
    if (Object.keys(identity).length) mapped.providerSpecificData = identity;
    return mapped;
  },
};

export default claude;
