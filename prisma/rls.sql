-- Supabase is used ONLY as a Postgres host. The app connects with the table-owner role through Prisma (which bypasses RLS).
-- Supabase also exposes every public table over its REST API (PostgREST) to the anon/authenticated roles. We never use
-- that API, so lock it down: enable RLS on every table and create NO policies => anon/authenticated can read nothing.
-- Safe to re-run after every `prisma db push` (new tables need it too).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
-- Belt and braces: remove direct grants too.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
