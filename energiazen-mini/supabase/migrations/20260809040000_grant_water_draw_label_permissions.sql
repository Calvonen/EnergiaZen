-- RLS policies restrict rows, but authenticated also needs table privileges.
-- Keep these explicit instead of relying on project-specific default grants.
grant select, insert, update, delete on table public.water_draw_labels to authenticated;
