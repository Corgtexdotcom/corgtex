const railwayEndpoint = "https://backboard.railway.com/graphql/v2";

export function railwayCredential(target, env) {
  if (target.group === "ops" && env.OPS_RAILWAY_PROJECT_TOKEN?.trim()) {
    return { "Project-Access-Token": env.OPS_RAILWAY_PROJECT_TOKEN.trim() };
  }
  const bearer = env.RAILWAY_API_TOKEN?.trim();
  return bearer ? { authorization: `Bearer ${bearer}` } : null;
}

export function railwayApiRequest(target, env) {
  const headers = railwayCredential(target, env);
  if (!headers) throw new Error("RAILWAY_API_TOKEN is required.");
  const endpoint = env.RAILWAY_GRAPHQL_ENDPOINT?.trim() || railwayEndpoint;
  if (Object.hasOwn(headers, "Project-Access-Token") && endpoint !== railwayEndpoint) {
    throw new Error("Unexpected Ops Railway API endpoint.");
  }
  return { headers, endpoint };
}
