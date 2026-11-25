-- SaKu untuk Supabase: penyimpanan kunci-nilai (JSON) milik Edge Function "api".
-- Jalankan SEKALI: Dashboard Supabase -> SQL Editor -> tempel seluruh berkas ini -> Run.
-- Aman dijalankan ulang (tidak menghapus data).
--
-- Keamanan: tabel dikunci dengan Row Level Security tanpa kebijakan, dan semua fungsi hanya bisa dipanggil
-- oleh service_role (kunci rahasia yang hanya dimiliki Edge Function). Kunci publik (anon/publishable)
-- tidak bisa membaca atau menulis apa pun di sini.

create table if not exists public.saku_kv (
  store      text        not null,                       -- 'meta' (akun, pengaturan) atau 'ledger' (buku kas per pengguna)
  k          text        not null,
  v          jsonb       not null,
  ver        bigint      not null,                       -- nomor versi unik untuk compare-and-swap (tidak pernah dipakai ulang)
  updated_at timestamptz not null default now(),
  primary key (store, k)
);

create sequence if not exists public.saku_kv_ver;

alter table public.saku_kv enable row level security;     -- tanpa kebijakan = tidak ada akses lewat API publik
revoke all on public.saku_kv from public, anon, authenticated;
revoke all on sequence public.saku_kv_ver from public, anon, authenticated;

-- Baca satu kunci -> {"v": ..., "ver": n}, atau null bila tidak ada.
create or replace function public.saku_kv_get(p_store text, p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('v', t.v, 'ver', t.ver) from public.saku_kv t where t.store = p_store and t.k = p_key;
$$;

-- Tulis satu kunci.
--   p_mode = 'any'   : timpa/buat tanpa syarat
--   p_mode = 'new'   : hanya bila kunci belum ada
--   p_mode = 'match' : hanya bila versi sekarang = p_ver (compare-and-swap)
-- Hasil: {"modified": true, "ver": n} atau {"modified": false}.
create or replace function public.saku_kv_put(p_store text, p_key text, p_val jsonb, p_mode text, p_ver bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  nv bigint := nextval('public.saku_kv_ver');
  hit bigint;
begin
  if p_mode = 'new' then
    insert into public.saku_kv (store, k, v, ver) values (p_store, p_key, p_val, nv)
    on conflict (store, k) do nothing
    returning ver into hit;
  elsif p_mode = 'match' then
    update public.saku_kv set v = p_val, ver = nv, updated_at = now()
    where store = p_store and k = p_key and ver = p_ver
    returning ver into hit;
  elsif p_mode = 'any' then
    insert into public.saku_kv (store, k, v, ver) values (p_store, p_key, p_val, nv)
    on conflict (store, k) do update set v = excluded.v, ver = excluded.ver, updated_at = now()
    returning ver into hit;
  else
    raise exception 'mode tidak dikenal: %', p_mode using errcode = '22023';
  end if;
  if hit is null then return jsonb_build_object('modified', false); end if;
  return jsonb_build_object('modified', true, 'ver', hit);
end;
$$;

create or replace function public.saku_kv_del(p_store text, p_key text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with d as (delete from public.saku_kv t where t.store = p_store and t.k = p_key returning 1)
  select jsonb_build_object('deleted', (select count(*) from d));
$$;

-- Daftar kunci berawalan p_prefix -> ["kunci1", "kunci2", ...]
create or replace function public.saku_kv_list(p_store text, p_prefix text default '')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(t.k order by t.k), '[]'::jsonb) from public.saku_kv t where t.store = p_store and starts_with(t.k, p_prefix);
$$;

-- Hanya service_role (Edge Function) yang boleh memanggil.
revoke all on function public.saku_kv_get(text, text) from public, anon, authenticated;
revoke all on function public.saku_kv_put(text, text, jsonb, text, bigint) from public, anon, authenticated;
revoke all on function public.saku_kv_del(text, text) from public, anon, authenticated;
revoke all on function public.saku_kv_list(text, text) from public, anon, authenticated;
grant execute on function public.saku_kv_get(text, text) to service_role;
grant execute on function public.saku_kv_put(text, text, jsonb, text, bigint) to service_role;
grant execute on function public.saku_kv_del(text, text) to service_role;
grant execute on function public.saku_kv_list(text, text) to service_role;
