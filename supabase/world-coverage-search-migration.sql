-- '엇갈린 시선'을 "고정된 지역별 언론사 RSS에 있나 없나" 방식에서
-- "그 사건을 실제로 검색해서 찾은 기사들이 각각 뭘 강조했나" 방식으로 바꾸면서,
-- 더 이상 지역 하나당 한 자리(post_id, region)가 아니라 찾은 만큼 여러 언론사가 들어갈 수 있게 됨.
-- Supabase SQL Editor에서 실행하세요.

alter table world_coverage_cache drop constraint if exists world_coverage_cache_post_id_region_key;
