-- '놓친 이야기'를 지역 단위가 아니라 핵심 주장(클레임) 단위로 비교하기 위한 테이블.
-- refresh-coverage가 매칭된 기사가 2곳 이상일 때 오픈소스 LLM(Groq)으로 핵심 주장을 뽑아 채움.
create table world_coverage_claims (
  id bigint generated always as identity primary key,
  post_id bigint not null references posts(id) on delete cascade,
  claim text not null,
  outlets_covered text[] not null default '{}',
  outlets_missed text[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table world_coverage_claims enable row level security;
create policy "coverage claims viewable by everyone" on world_coverage_claims for select using (true);
