-- Keep the original channel as the remote authorization scope.
ALTER TABLE build_requests ADD COLUMN thread_id TEXT;
ALTER TABLE build_requests ADD COLUMN thread_attempted INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX build_requests_thread ON build_requests(thread_id) WHERE thread_id IS NOT NULL;
