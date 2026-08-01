-- 엇갈린 시선(world_coverage)과 사건 타임라인(post_timeline)을 미리 다 준비해 놓고
-- 나서야 글이 독자에게 보이게 한다. 지금까지는 저장 즉시 공개되고 그 두 기능은
-- 비동기로 나중에 채워져서, 막 올라온 글은 잠깐 빈 화면/로딩 상태로 보였다.
--
-- published 컬럼 하나로 "공개 여부"를 표현한다. 기존 글은 전부 이미 공개돼 있던
-- 것들이라 true로 백필하고, 앞으로 새로 쓰는 글만 기본값 false로 시작해서
-- prepare-post 액션(엇갈린 시선 + 타임라인을 다 채운 뒤 published를 true로 뒤집음)을
-- 거치게 한다.
alter table posts add column if not exists published boolean not null default true;
alter table posts alter column published set default false;

drop policy if exists "posts are viewable by everyone" on posts;
create policy "posts are viewable when published or by editors"
  on posts for select
  using (published = true or is_approved_editor());

-- posts 테이블을 만지는 김에: auth-migration.sql 시절의 "본인 글만" 정책이
-- admin-only-migration.sql이 같은 이름으로 드롭을 시도했는데도(정책명이 실제로는
-- 안 맞아서) 안 지워지고 남아 있었다 -- is_approved_editor() 정책과 공존하면서
-- "로그인한 아무나 자기 user_id로 글을 쓰거나 지울 수 있는" 구멍이 계속 열려
-- 있었다. 지금 정리한다.
drop policy if exists "authenticated users can insert their own posts" on posts;
drop policy if exists "users can update their own posts" on posts;
drop policy if exists "users can delete their own posts" on posts;

-- 이제 발행 자체가 prepare-post 액션(에디터 세션에서 직접 호출, 엇갈린 시선+타임라인을
-- 다 채운 뒤 published를 뒤집음)을 거치므로, INSERT 시점에 비동기로 타임라인만 따로
-- 트리거하던 웹훅은 이중 작업이라 필요 없어졌다.
drop trigger if exists post_timeline_on_insert on public.posts;
