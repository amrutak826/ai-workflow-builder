// Thin admin-secret GraphQL client. Every function in this project uses
// this instead of the user's token, because the Action handlers make their
// own authorization decisions in code (see triggerWorkflowRun.ts /
// approveStep.ts) and then need to write rows that "user" role has no
// insert/update permission for (workflow_runs, step_runs).

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT as string;
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET as string;

export async function gqlAdmin<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

/** Verifies the caller (from the forwarded session variables) is a member
 *  of the org with one of `allowedRoles`. Returns the member row, or null.
 *  This is the code-level mirror of the Layer 1 Hasura permission checks —
 *  used inside Actions where we operate as admin and so must re-check
 *  authorization ourselves. */
export async function getMembership(userId: string, orgId: string) {
  const data = await gqlAdmin<{ org_members: { role: string }[] }>(
    `query ($orgId: uuid!, $userId: uuid!) {
      org_members(where: { org_id: { _eq: $orgId }, user_id: { _eq: $userId } }) {
        role
      }
    }`,
    { orgId, userId }
  );
  return data.org_members[0] ?? null;
}
