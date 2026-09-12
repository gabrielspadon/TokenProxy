import { delimiter, dirname } from "node:path";

export function isolatedToolchainEnvironment() {
  const host = process.env.PATH || "/usr/bin:/bin";
  const own = dirname(process.execPath);
  return {
    PATH: host.split(delimiter)[0] === own ? host : `${own}${delimiter}${host}`,
    // A private npm prefix must not rebuild the host version manager's shims.
    // The selected runtime's npm executable may itself be a mise wrapper.
    MISE_SKIP_RESHIM: "1",
  };
}
