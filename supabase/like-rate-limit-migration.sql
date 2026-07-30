-- comment_rate_limit과 같은 이유·같은 패턴: 좋아요도 IP당 짧은 쿨다운을 둔다.
-- increment-likes-lockdown-migration.sql로 RPC 직접 호출은 막았지만, Edge Function의
-- 'like' 액션 자체에는 원래 쿨다운이 없어서(VPN 판별만 함) 스크립트로 계속 호출하면
-- 여전히 무제한으로 좋아요를 쌓을 수 있었다.
create table like_rate_limit (
  ip text primary key,
  last_at timestamptz not null default now()
);
alter table like_rate_limit enable row level security;
-- comment_rate_limit과 동일: RLS만 켜고 정책은 안 만들어서 anon/authenticated는 전부 차단,
-- service_role(Edge Function)만 접근 가능.
