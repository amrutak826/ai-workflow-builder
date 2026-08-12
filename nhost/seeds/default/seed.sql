-- Run this AFTER creating two user accounts through the frontend's sign-up
-- form (e.g. owner-a@demo.com and viewer-b@demo.com). Then replace the
-- placeholder UUIDs below with the real auth.users.id values, which you
-- can find with:
--   select id, email from auth.users;

insert into public.organizations (id, name, quota_limit) values
  ('00000000-0000-0000-0000-00000000000a', 'Org A', 100),
  ('00000000-0000-0000-0000-00000000000b', 'Org B', 100);

-- Org A: owner + editor
insert into public.org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', '<ORG_A_OWNER_USER_ID>', 'owner'),
  ('00000000-0000-0000-0000-00000000000a', '<ORG_A_EDITOR_USER_ID>', 'editor');

-- Org B: a completely separate owner, used to prove cross-org isolation
insert into public.org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000000b', '<ORG_B_OWNER_USER_ID>', 'owner');
