-- '오늘의 예측': 다음 거래일 코스피 방향에 대한 하루 1표 투표 + 그날의 코멘트 스레드.
-- humanindicator.kr/today를 참고했지만, 유튜버 "최근 콜"을 오늘의 진영으로 묶을 때
-- 지평(장기 콜 제외)·신선도(3일 이내만) 필터를 걸어서 지평 불일치 문제를 피한다
-- (Edge Function의 computeTodayCamps 참고).

create table daily_votes (
  id bigint generated always as identity primary key,
  vote_date date not null,
  ip text not null,
  direction text not null check (direction in ('up','down')),
  created_at timestamptz not null default now(),
  unique (vote_date, ip)
);
alter table daily_votes enable row level security;
-- 정책을 하나도 안 만든다 -- comment_rate_limit과 같은 패턴. ip를 공개 조회 가능하게 두면
-- 방문자 IP가 그대로 노출되므로, 집계 결과는 Edge Function(service_role)이 계산해서
-- 개수만 내려준다(원본 행은 절대 클라이언트에 안 나감).

create table today_comments (
  id bigint generated always as identity primary key,
  vote_date date not null,
  nickname text not null,
  avatar_seed text not null,
  body text not null,
  ip_prefix text,
  country text,
  hidden boolean not null default false,
  hidden_reason text,
  created_at timestamptz not null default now()
);
alter table today_comments enable row level security;

create policy "visible today comments are viewable by everyone"
  on today_comments for select
  using (hidden = false);

create policy "approved editors can view all today comments"
  on today_comments for select
  using (is_approved_editor());

create policy "approved editors can update today comments"
  on today_comments for update
  using (is_approved_editor());

create policy "approved editors can delete today comments"
  on today_comments for delete
  using (is_approved_editor());
