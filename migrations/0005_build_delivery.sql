-- Preserve existing intake records while adding remote orchestration metadata.
ALTER TABLE build_requests ADD COLUMN remote_status TEXT;
ALTER TABLE build_requests ADD COLUMN result_url TEXT;
ALTER TABLE build_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE build_requests ADD COLUMN last_polled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE build_requests ADD COLUMN notice_id TEXT;
ALTER TABLE build_requests ADD COLUMN notice_attempted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX build_requests_poll ON build_requests(last_polled);
