-- 비저너리 발언 자동 정리(7일 보관 후 삭제)에 필요한 컬럼.
-- 판정 시각을 남겨둬야 "판정된 다음 날 지운다"는 예외 규칙을 계산할 수 있다
-- (주말이 껴서 7일째에 아직 판정 전인 경우, 판정될 때까지 기다렸다가 지우기 위함).
alter table visionary_calls add column if not exists judged_at timestamptz;
