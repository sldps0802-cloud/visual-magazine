-- 조회수 기반 "지금 많이 보는 콘텐츠" 랭킹을 위한 컬럼 + 증가 함수

alter table posts add column views bigint not null default 0;

-- anon 사용자도 조회수만 안전하게 올릴 수 있도록 security definer 함수로 분리
-- (RLS의 update 정책은 본인 글만 허용하므로, 조회수 증가는 별도 함수로 우회)
create or replace function increment_views(post_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update posts set views = views + 1 where id = post_id;
$$;

grant execute on function increment_views(bigint) to anon, authenticated;
