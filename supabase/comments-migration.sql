-- 댓글 + 좋아요 기능
-- 댓글 작성/좋아요 증가는 클라이언트에서 직접 못 하고 Edge Function(submit-comment)을 통해서만 가능하게 함
-- (VPN 여부, IP 국가를 서버에서 검증한 뒤 service_role 키로 넣기 위함 - 클라이언트가 값을 조작 못 하게)

create table comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references posts(id) on delete cascade,
  nickname text not null,
  avatar_seed text not null,
  body text not null,
  ip_prefix text,
  country text,
  created_at timestamptz not null default now()
);

alter table comments enable row level security;

-- 누구나 댓글 읽기는 가능
create policy "comments are viewable by everyone" on comments for select using (true);

-- insert/update/delete 정책을 일부러 안 만듦: anon/authenticated 키로는 직접 쓰기 불가
-- (RLS가 켜져 있고 매칭되는 정책이 없으면 기본 거부됨 - service_role만 우회 가능)

alter table posts add column likes bigint not null default 0;

-- Edge Function(service_role)에서만 호출 - 원자적으로 증가시키기 위한 함수
create or replace function increment_likes(post_id bigint)
returns void
language sql
as $$
  update posts set likes = likes + 1 where id = post_id;
$$;
