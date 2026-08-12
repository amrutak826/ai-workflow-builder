import { useQuery } from "urql";
import { nhost } from "./nhost";

const MY_ORGS = `
  query MyOrgs($userId: uuid!) {
    org_members(where: { user_id: { _eq: $userId } }) {
      role
      organization {
        id
        name
      }
    }
  }
`;

export type MyOrg = { id: string; name: string; role: "owner" | "editor" | "viewer" };

export function useMyOrgs() {
  const userId = nhost.auth.getUser()?.id;
  const [result] = useQuery({ query: MY_ORGS, variables: { userId }, pause: !userId });
  const orgs: MyOrg[] = (result.data?.org_members ?? []).map((m: any) => ({
    id: m.organization.id,
    name: m.organization.name,
    role: m.role,
  }));
  return { orgs, fetching: result.fetching, error: result.error };
}
