-- T1: readShellyHeatingStatus() on the ESP32 now reports a tri-state
-- ON/OFF/UNKNOWN Shelly relay status instead of collapsing every read
-- failure (WiFi down, HTTP error, JSON parse failure, missing/non-boolean
-- output field) to OFF. UNKNOWN is sent as heating: null, so the column
-- must accept NULL - a status query that could not be answered is not the
-- same fact as a relay confirmed off.
--
-- This is a no-op (and safe to re-run) if the column already permits NULL.
alter table public.tank_readings
  alter column heating drop not null;
