-- Pelkkä "grant ... to service_role" ei tee taulusta service-role-vain -
-- se vain lisää yhden sallitun roolin, muuttamatta mitään anon/
-- authenticated-rooleille oletuksena myönnettyjä oikeuksia Supabasen
-- julkisessa public-skeemassa. Ilman RLS:ää appin/Shellyn julkisella
-- avaimella (anon) olisi voinut päivittää is_stale-tilan suoraan REST-
-- rajapinnan kautta - tukahduttaa oikean hälytyksen tai laukaista
-- toistuvia. RLS otetaan käyttöön ilman client-policyja, jolloin anon/
-- authenticated eivät näe/voi muokata riviä lainkaan; service_role
-- ohittaa RLS:n aina, joten Edge Function toimii muuttumattomana.
alter table public.device_monitor_state enable row level security;
