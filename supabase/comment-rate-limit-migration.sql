-- 댓글 도배 방지용 테이블. Edge Function(service_role)만 접근 - RLS 켜두고 정책은 하나도 안 만들어서
-- anon/authenticated 키로는 읽기/쓰기 전부 차단됨.
create table comment_rate_limit (
  ip text primary key,
  last_at timestamptz not null default now()
);
alter table comment_rate_limit enable row level security;
