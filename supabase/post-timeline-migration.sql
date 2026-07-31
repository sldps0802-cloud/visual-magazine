-- '사건 타임라인': 기사가 다루는 사건의 전후 배경을 시간순으로 보여준다.
-- 날짜는 LLM이 추측하지 않는다 -- 전부 구글 뉴스 RSS의 pubDate에서 그대로 가져오고,
-- LLM은 "여러 후보 중 인과적으로 의미 있는 마디만 고르고 한 줄 요약"만 한다.
-- 배경사건(과거)뿐 아니라 "지금 읽는 기사" 자신도 마지막 마디(is_current=true)로 같이
-- 저장해서, 프론트는 이 테이블 하나만 읽으면 전체 타임라인을 그릴 수 있다.
create table post_timeline (
  id bigint generated always as identity primary key,
  post_id bigint not null references posts(id) on delete cascade,
  event_date date not null,
  summary text not null,
  source text,
  source_url text,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  unique(post_id, event_date, summary)
);
alter table post_timeline enable row level security;

-- 누구나 읽기는 가능, 쓰기는 service_role(Edge Function)만
create policy "post timeline is viewable by everyone"
  on post_timeline for select using (true);

-- 글 하나당 타임라인 생성을 딱 한 번만 시도하기 위한 처리 기록. RSS 검색으로 배경사건이
-- 하나도 안 나온 글도(event_count=0) 여기 기록해서, 매 크론 실행마다 똑같이 헛수고로
-- 다시 검색하지 않게 한다. 다시 시도하고 싶으면 이 테이블에서 해당 post_id 행만 지우면 됨.
create table post_timeline_status (
  post_id bigint primary key references posts(id) on delete cascade,
  checked_at timestamptz not null default now(),
  event_count int not null default 0
);
alter table post_timeline_status enable row level security;
-- 공개 조회 정책 없음 -- 클라이언트는 이 테이블을 직접 읽지 않고 service_role만 쓴다.
