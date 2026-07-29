-- '엇갈린 시선'/'놓친 이야기'용 사전 계산 캐시.
-- 방문자가 아코디언을 열 때 실시간으로 RSS를 뒤지는 대신, 백그라운드 작업(refresh-coverage
-- Edge Function, 주기 실행)이 미리 계산해서 여기 저장해두고, post.html은 그냥 읽기만 함.
create table world_coverage_cache (
  id bigint generated always as identity primary key,
  post_id bigint not null references posts(id) on delete cascade,
  region text not null,
  source text not null,
  matched boolean not null default false,
  item_title text,
  item_link text,
  updated_at timestamptz not null default now(),
  unique(post_id, region)
);
alter table world_coverage_cache enable row level security;

-- 누구나 읽기는 가능, 쓰기는 service_role(Edge Function)만
create policy "coverage cache viewable by everyone" on world_coverage_cache for select using (true);
