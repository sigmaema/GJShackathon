create table if not exists public.paintings (
    id bigint generated always as identity primary key,
    title text not null,
    artist text,
    year text,
    description text,
    image_url text,
    created_at timestamptz not null default now()
);

alter table public.paintings enable row level security;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'paintings'
          and policyname = 'Allow public read paintings'
    ) then
        create policy "Allow public read paintings"
        on public.paintings
        for select
        using (true);
    end if;
end $$;

-- Optional: seed data
insert into public.paintings (title, artist, year, description, image_url)
values
    ('The Night Watch', 'Rembrandt', '1642', 'Baroque group portrait.', null),
    ('Girl with a Pearl Earring', 'Johannes Vermeer', 'c.1665', 'Dutch Golden Age portrait.', null),
    ('The Storm on the Sea of Galilee', 'Rembrandt', '1633', 'Dramatic seascape.', null),
    ('The Concert', 'Johannes Vermeer', 'c.1664', 'Three musicians in an interior.', null),
    ('View of Auvers-sur-Oise', 'Paul Cezanne', '1873', 'Landscape near Paris.', null),
    ('Portrait of a Young Man', 'Raphael', '1513', 'Renaissance portrait.', null)
on conflict do nothing;
