-- 비주얼매거진 posts 테이블
create table posts (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

alter table posts enable row level security;

-- 누구나 읽기 가능 (공개 블로그)
create policy "posts are viewable by everyone"
  on posts for select
  using (true);

-- 누구나 쓰기 가능 (지금은 로그인 기능이 없으니 익명 작성 허용)
create policy "anyone can insert posts"
  on posts for insert
  with check (true);
